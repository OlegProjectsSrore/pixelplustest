import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuditState, MAX_CROSS_CHECKS, type AuditAnswer, type AuditSnapshot, type Json } from '../src/audit/contracts.ts';
import { advanceAudit, analyzeAudit, nextQuestion } from '../src/audit/engine.ts';
import { getLibrary, library } from '../src/audit/library.ts';
import { orderPairs } from '../src/audit/priority.ts';
import { buildReportContent } from '../src/report/content.ts';

const now = Date.parse('2026-10-27T10:00:00Z');
let counter = 0;
function answer(fact: string, value: Json, state: AuditAnswer['state'] = 'known'): AuditAnswer {
  const question = library.questions.find(item => item.fact_ids.includes(fact));
  assert.ok(question, fact);
  return { id: `a${++counter}`, question_id: question.id, fact_id: fact, state, value: state === 'known' ? value : null, event_ids: ['event-1'], channel: 'chat', method: 'classification', confirmation: 'explicit', library_version: library.version, created_at: now };
}
const told = (fields: string[]) => Object.fromEntries(fields.map(field => [field, { state: 'known', value: 'Пример посетителя' }])) as Json;
const hypothesis = told(['object', 'observation', 'period', 'context']);
const notTried = { attempts_status: 'not_tried', attempts: [] } as Json;
const intro = (topics: string[], funnel = 'few_leads') => [
  answer('context.name', 'Алексей'), answer('context.position', 'Директор'), answer('context.company_name', 'Кухни «Дуб»'), answer('context.website', 'dub.ru'),
  answer('context.responsibilities', 'Продажи'), answer('context.company_size', '40 сотрудников'), answer('context.business', 'Кухни на заказ'), answer('context.goal', 'Больше заказов'),
  answer('context.products', 'Кухни на заказ'), answer('context.audience', 'Частные покупатели'), answer('context.channels', ['Яндекс Директ']), answer('context.geography', ['Москва']),
  answer('context.revenue_year', 'Около 100 млн рублей'), answer('context.revenue_3y', 'Около 250 млн рублей'), answer('context.average_check', 'Около 200 тысяч рублей'),
  answer('context.deal_cycle', 'Две недели'), answer('context.goal_period', null, 'declined'), answer('context.main_problem', 'Мало заказов'),
  answer('context.assets', 'Сайт и amoCRM'), answer('context.priority', topics), answer('context.funnel', funnel), answer('context.resources', 'Маркетолог'), answer('context.constraints', 'Нет'),
];
// A confirmed complaint «the right request costs more than agreed», with its own questions answered.
const adsCost = () => [...intro(['advertising']), answer('advertising.applicable', true), answer('ads_cost.signal', 'target'), answer('ads_cost.details', hypothesis),
  answer('advertising.impact', { level: 'loss_or_delay', description: 'Переплачиваем за рекламу', period: 'месяц' }), answer('advertising.history', notTried)];
const advance = (answers: AuditAnswer[]) => advanceAudit(initialAuditState(library.version, 'chat', now), answers, now, library);

test('a confirmed complaint checks its other possible causes in order, at most two, with a short lead-in', () => {
  const answers = adsCost();
  let state = advance(answers);
  let question = nextQuestion(state, now, library);
  assert.equal(question?.id, 'crm_response_screen');
  assert.match(question!.text, /^Проверю ещё одну возможную причину\. /);
  assert.deepEqual(state.cross_checked, ['crm_response']);
  answers.push(answer('crm_response.signal', 'alternative'));
  state = advanceAudit(state, answers, now, library);
  assert.equal(nextQuestion(state, now, library)?.id, 'ux_contact_screen');
  assert.deepEqual(state.cross_checked, ['crm_response', 'ux_contact']);
  answers.push(answer('ux_contact.signal', 'alternative'));
  state = advanceAudit(state, answers, now, library);
  assert.notEqual(nextQuestion(state, now, library)?.id, 'analytics_sales_screen', 'the third link is not checked');
  assert.deepEqual(state.cross_checked, ['crm_response', 'ux_contact']);
});

test('a confirmed other cause opens its topic, enters the report and is solved first; a closed topic is skipped', () => {
  const answers = adsCost();
  let state = advance(answers);
  answers.push(answer('crm_response.signal', 'target'));
  state = advanceAudit(state, answers, now, library);
  assert.ok(state.candidate_blocks.includes('crm_response'), 'the cause needs no separate topic question');
  assert.equal(nextQuestion(state, now, library)?.id, 'crm_response_detail');
  answers.push(answer('crm_response.details', told(['object', 'observation', 'period'])), answer('crm.impact', { level: 'loss_or_delay', description: 'Заявки ждут', period: 'неделя' }), answer('crm.history', notTried));
  state = advanceAudit(state, answers, now, library);
  assert.notEqual(nextQuestion(state, now, library)?.id, 'crm_scope', 'the opened topic is not asked about again');
  assert.equal(nextQuestion(state, now, library)?.id, 'ux_contact_screen', 'the second link is checked next');
  const snapshot: AuditSnapshot = { id: 'snap', session_id: 's', library_version: library.version, created_at: now, through_seq: 1, answers, state, limitations: [] };
  const result = analyzeAudit(snapshot, library);
  assert.deepEqual(result.solutions.map(solution => solution.id).sort(), ['ads_cost', 'crm_response']);
  assert.deepEqual(orderPairs(['ads_cost', 'crm_response'], library), [['crm_response', 'ads_cost']]);
  const html = buildReportContent(result, snapshot, library).html;
  assert.match(html, /Эту ситуацию нашли, проверяя другую возможную причину проблемы «Стоимость подходящего обращения превышает согласованный ориентир»; её стоит решить раньше\./);
  // With the same level, the other cause comes before the complaint: in the cards and in the prioritisation.
  const crm = library.solutions.find(block => block.id === 'crm_response')!.pdf.heading as string;
  assert.match(html, new RegExp(`Проблема №1\\. ${crm}`));
  const scores = html.slice(html.indexOf('<h1>Приоритизация</h1>'));
  assert.ok(scores.indexOf(crm) < scores.indexOf('Стоимость подходящего обращения'));
  // The visitor said request handling is not their topic: that cause is skipped and the next one is checked.
  const closed = advance([...adsCost(), answer('crm.applicable', false)]);
  assert.equal(nextQuestion(closed, now, library)?.id, 'ux_contact_screen');
});

test('no more than four other causes are checked in one interview', () => {
  const state = { ...advance(adsCost()), cross_checked: ['rep_root', 'crm_handoff', 'seo_commercial', 'seo_index'] };
  assert.equal(state.cross_checked.length, MAX_CROSS_CHECKS);
  assert.notEqual(nextQuestion(state, now, library)?.id, 'crm_response_screen');
});

test('where clients are lost adds request handling or repeat sales after the named topics', () => {
  let state = advance(intro(['strategy'], 'leads_not_converting'));
  assert.equal(nextQuestion(state, now, library)?.id, 'strategy_scope');
  state = advance([...intro(['strategy'], 'leads_not_converting'), answer('strategy.applicable', false)]);
  assert.equal(nextQuestion(state, now, library)?.id, 'crm_scope');
  state = advance([...intro(['strategy'], 'customers_not_returning'), answer('strategy.applicable', false)]);
  assert.equal(nextQuestion(state, now, library)?.id, 'retention_scope');
  assert.deepEqual(library.questions.find(question => question.id === 'context_funnel')!.fact_ids, ['context.funnel']);
});

test('a problem offering an audit and ongoing work shows the audit after earlier work and ongoing work otherwise', () => {
  const base = [...intro(['advertising']), answer('advertising.applicable', true), answer('ads_quality.signal', 'target'), answer('ads_quality.details', hypothesis)];
  const run = (history: Json) => {
    const answers = [...base, answer('advertising.history', history)];
    return analyzeAudit({ id: 'snap', session_id: 's', library_version: library.version, created_at: now, through_seq: 1, answers, state: advance(answers), limitations: [] }, library);
  };
  const fresh = run(notTried);
  assert.deepEqual(fresh.solutions[0].service_ids, ['ads_direct', 'ads_google']);
  assert(fresh.tariffs.some(tariff => tariff.id === 'ads_direct_start') && !fresh.tariffs.some(tariff => tariff.details.service_id === 'ads'));
  const repeated = run({ attempts_status: 'tried', result: 'no_result', attempts: [{ attempt_id: 'x', work: { state: 'known', value: 'Сами вели Директ' } }] });
  assert.deepEqual(repeated.solutions[0].service_ids, ['ads']);
  assert(repeated.tariffs.some(tariff => tariff.details.service_id === 'ads') && !repeated.tariffs.some(tariff => tariff.details.service_id === 'ads_direct'));
});

test('possible causes listed both ways are not ordered; no pair of problems is ordered both ways', () => {
  assert.deepEqual(orderPairs(['seo_sanctions', 'geo_zero_click'], library), []);
  const pairs = orderPairs(library.solutions.map(block => block.id), library);
  for (const [a, b] of pairs) assert(!pairs.some(([c, d]) => c === b && d === a), `${a} ↔ ${b}`);
});

test('a cause outside digital services is named once in the goal section; a free course says so', () => {
  const answers = [...intro(['seo']), answer('context.external_cause', 'не хватает производственных мощностей'), answer('seo.applicable', true),
    answer('seo_inhouse.signal', 'target'), answer('seo_inhouse.details', told(['task', 'current_way', 'constraint'])), answer('seo.history', notTried)];
  const state = advance(answers), snapshot: AuditSnapshot = { id: 'snap', session_id: 's', library_version: library.version, created_at: now, through_seq: 1, answers, state, limitations: [] };
  const result = analyzeAudit(snapshot, library);
  assert.deepEqual(result.solutions.map(solution => solution.id), ['seo_inhouse']);
  const html = buildReportContent(result, snapshot, library).html;
  assert.match(html, /Вы также назвали причину, которая лежит вне маркетинга и цифровых систем: не хватает производственных мощностей\. Её решение не входит в этот аудит/);
  assert.match(html, /<td><strong>бесплатно<\/strong>/);
  assert.equal(result.solutions.some(solution => solution.id.includes('external')), false);
});

test('the marketplace topic asks where the visitor sells, then only that platform\'s questions', () => {
  const base = [...intro(['marketplace']), answer('marketplace.applicable', true)];
  const view = nextQuestion(advance(base), now, library);
  assert.equal(view?.id, 'marketplace_platforms');
  assert.equal(view!.text, 'Где Вы продаёте: на маркетплейсах вроде Ozon и Wildberries, на Авито или и там и там?');
  assert.deepEqual(view!.options.map(option => option.text), ['На маркетплейсах вроде Ozon и Wildberries', 'На Авито', 'И там и там']);
  const market = library.solutions.filter(block => block.domain === 'marketplace' && !block.id.startsWith('avito_')).map(block => block.id);
  const screens = (platforms: AuditAnswer[]) => {
    const answers = [...base, ...platforms], asked: string[] = [];
    for (let i = 0; i < 20; i++) {
      const next = nextQuestion(advance(answers), now, library);
      if (!next || !next.id.endsWith('_screen')) break;
      asked.push(next.id); answers.push(answer(next.fact_ids[0]!, 'alternative'));
    }
    return asked;
  };
  assert.deepEqual(screens([answer('marketplace.platforms', 'avito')]), ['avito_leads_screen', 'avito_cost_screen']);
  assert.deepEqual(screens([answer('marketplace.platforms', 'marketplaces')]), market.map(id => `${id}_screen`));
  assert.deepEqual(screens([answer('marketplace.platforms', 'both')]), [...market.map(id => `${id}_screen`), 'avito_leads_screen', 'avito_cost_screen']);
  assert.deepEqual(screens([answer('marketplace.platforms', null, 'unknown')]), [...market.map(id => `${id}_screen`), 'avito_leads_screen', 'avito_cost_screen'], 'not said: every platform');
  const before = getLibrary('0.1.4');
  assert.equal(before.questions.some(question => question.id === 'marketplace_platforms'), false);
  assert.equal(before.questions.find(question => question.id === 'market_entry_screen')!.condition, null);
});

test('the AI topic asks whether AI is already in use, then only that branch\'s questions', () => {
  const base = [...intro(['ai']), answer('ai.applicable', true)];
  const view = nextQuestion(advance(base), now, library);
  assert.equal(view?.id, 'ai_stage');
  assert.equal(view!.text, 'Вы уже используете AI в работе или только хотите его применить?');
  assert.deepEqual(view!.options.map(option => option.text), ['Уже используем', 'Только хотим применить', 'И то и другое']);
  const screens = (stage: AuditAnswer[]) => {
    const answers = [...base, ...stage], asked: string[] = [];
    for (let i = 0; i < 20; i++) {
      const next = nextQuestion(advance(answers), now, library);
      if (!next || !next.id.endsWith('_screen')) break;
      asked.push(next.id.replace('_screen', '')); answers.push(answer(next.fact_ids[0]!, 'alternative'));
    }
    return asked;
  };
  const planning = ['ai_process', 'ai_routine', 'ai_repeat_questions', 'ai_doc_search', 'ai_speech', 'ai_prediction'], using = ['ai_knowledge', 'ai_handoff', 'ai_actions', 'ai_eval', 'ai_access'];
  assert.deepEqual(screens([answer('ai.stage', 'planning')]), planning, 'the automation questions come right after the first one');
  assert.deepEqual(screens([answer('ai.stage', 'using')]), using);
  const all = ['ai_process', 'ai_routine', 'ai_repeat_questions', 'ai_doc_search', 'ai_knowledge', 'ai_handoff', 'ai_actions', 'ai_eval', 'ai_speech', 'ai_prediction', 'ai_access'];
  assert.deepEqual(screens([answer('ai.stage', 'both')]), all);
  assert.deepEqual(screens([answer('ai.stage', null, 'unknown')]), all, 'not said: every question');
  const before = getLibrary('0.1.4');
  assert.equal(before.questions.some(question => question.id === 'ai_stage'), false);
  assert.equal(before.questions.find(question => question.id === 'ai_handoff_screen')!.condition, null);
});

test('every new service has priced tariffs and a problem; every new problem asks its own questions', () => {
  const added = library.services.filter(service => service.introduced_in === '0.2.0');
  assert.equal(added.length, 32);
  for (const service of added) {
    assert(service.block_ids.length > 0, service.id);
    assert(library.tariffs.some(tariff => tariff.service_id === service.id), service.id);
  }
  const problems = library.solutions.filter(block => block.introduced_in === '0.2.0');
  assert.equal(problems.length, 19);
  for (const block of problems) for (const suffix of ['screen', 'detail']) assert(library.questions.some(question => question.id === `${block.id}_${suffix}`), `${block.id}_${suffix}`);
  assert.deepEqual(library.solutions.filter(block => block.domain === 'ai_search').map(block => block.id), ['geo_competitors', 'geo_negative', 'geo_zero_click', 'seo_ai_visibility', 'seo_ai_accuracy']);
});
