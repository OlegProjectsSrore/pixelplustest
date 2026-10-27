import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuditState, type AuditAnswer, type AuditEvent, type AuditSnapshot, type Json } from '../src/audit/contracts.ts';
import { advanceAudit, analyzeAudit, deriveFacts, elapsedInterviewMs, interviewSufficiency, nextQuestion, validateAnswers } from '../src/audit/engine.ts';
import { compileVoiceBlocks, getLibrary, library, ruleChecksForVersion, validateLibrary, validateLibraryManifest, type AuditLibrary } from '../src/audit/library.ts';
import { evaluateRule, validateRule } from '../src/audit/rules.ts';
import { selectHumorReply } from '../src/audit/humor.ts';
import { validateAuditResult, validateAuditState } from '../src/audit/validation.ts';
import ruleChecksData from '../src/audit/data/rule-checks.json' with { type: 'json' };

const now = Date.parse('2026-10-22T20:00:00Z');
const preview = { allowDraft: true };
function event(id = 'event-1', kind: AuditEvent['kind'] = 'utterance'): AuditEvent {
  return { id, source: 'chat', source_key: id, source_revision: 0, local_order: 1, role: 'user', kind, text: 'Слова посетителя', occurred_at: now, received_at: now };
}
function answer(fact = 'context.business', value: AuditAnswer['value'] = 'Магазин', id = 'answer-1'): AuditAnswer {
  const question = library.questions.find(item => item.fact_ids.includes(fact));
  assert.ok(question);
  return { id, question_id: question.id, fact_id: fact, state: 'known', value, event_ids: ['event-1'], channel: 'chat', method: 'classification', confirmation: 'explicit', library_version: library.version, created_at: now };
}
const introduction = () => [
  answer('context.name', 'Олег', 'intro-name'),
  answer('context.position', 'Директор', 'intro-position'),
  answer('context.company_name', 'Мебельная фабрика «Дуб»', 'intro-company'),
  answer('context.website', 'mebel-dub.ru', 'intro-website'),
  answer('context.responsibilities', 'Отвечаю за продажи', 'intro-responsibilities'),
  answer('context.company_size', '50 сотрудников', 'intro-size'),
];

test('a key question without a usable answer is asked again with its reason, at most twice; other questions move on', () => {
  const rules = library.scenario.required_for_report!;
  assert.equal(rules.max_reasks, 2);
  const keys = library.questions.filter(question => question.required_for_report);
  assert.equal(keys.length, 357);
  assert.deepEqual(['context_company_name', 'context_website'].map(id => library.questions.find(question => question.id === id)!.required_for_report), ['company', 'website']);
  assert.deepEqual(['context_business', 'context_goal', 'context_priority'].map(id => library.questions.find(question => question.id === id)!.required_for_report), ['business', 'goal', 'topics']);
  assert.equal(library.questions.find(question => question.id === 'context_name')!.required_for_report, undefined);
  const uncertain = (fact: string, state: AuditAnswer['state'], id: string): AuditAnswer => ({ ...answer(fact, null, id), state });
  let answers = [...introduction()];
  let state = advanceAudit(initialAuditState(library.version, 'chat', now), answers, now, library);
  assert.equal(state.current_question_id, 'context_business');
  const replies: AuditAnswer['state'][] = ['unknown', 'declined', 'unknown'];
  for (const [index, reply] of replies.entries()) {
    answers = [...answers, uncertain('context.business', reply, `business-${index}`)];
    state = advanceAudit(state, answers, now, library);
    const question = nextQuestion(state, now, library);
    // «Don't know» then a refusal is not a contradiction: the visitor simply has not answered yet.
    assert.deepEqual(state.contradictions, []);
    if (index < 2) assert.deepEqual([question?.id, question?.reask], ['context_business', { attempt: index + 1, reason: rules.reasons.business }]);
    else assert.ok(question && question.id !== 'context_business' && !question.reask, 'after two re-asks the survey moves on');
  }
  // A real answer ends the re-asks at once.
  const answered = advanceAudit(state, [...introduction(), uncertain('context.business', 'unknown', 'b1'), answer('context.business', 'Продаём мебель на заказ', 'b2')], now, library);
  assert.notEqual(nextQuestion(answered, now, library)?.id, 'context_business');
  // A question that is not key moves on after «don't know».
  const assets = advanceAudit({ ...answered, current_question_id: 'context_assets' }, [...introduction(), answer('context.business', 'Мебель', 'b3'), uncertain('context.assets', 'unknown', 'a1')], now, library);
  assert.notEqual(nextQuestion({ ...assets, current_question_id: 'context_assets' }, now, library)?.id, 'context_assets');
});

test('mandatory introduction has the same order and saved progress across repeated channel switches', () => {
  const expected = [
    ['context_name', 'Как Вас зовут?'],
    ['context_position', 'Какая Ваша должность в компании?'],
    ['context_company_name', 'Как называется Ваша компания?'],
    ['context_website', 'Какой адрес сайта Вашей компании? Если сайта пока нет, так и напишите.'],
    ['context_responsibilities', 'Какой у Вас функционал в компании, за что Вы отвечаете?'],
    ['context_company_size', 'Какой размер компании?'],
  ];
  for (const start of ['chat', 'voice'] as const) {
    let state = { ...initialAuditState(library.version, start, now), paused: false };
    const accepted: AuditAnswer[] = [];
    for (const [index, [id, text]] of expected.entries()) {
      assert.equal(interviewSufficiency(state, now).sufficient, false);
      for (const channel of ['chat', 'voice', 'chat', 'voice'] as const) {
        state = { ...state, active_channel: channel, channel_revision: state.channel_revision + 1 };
        const question = nextQuestion(state, now)!;
        // The chat text is listed above; the voice wording of a question may differ (the website question says «скажите»).
        assert.equal(question.id, id); assert.equal(question.text, channel === 'chat' ? text : library.questions.find(item => item.id === id)!.voice);
      }
      const reply = { ...introduction()[index], channel: state.active_channel, method: 'voice_batch' as const };
      validateAnswers([reply], [{ ...event(), source: 'voice' }], accepted);
      accepted.push(reply);
      state = advanceAudit(state, accepted, now);
    }
    assert.equal(nextQuestion(state, now)?.id, 'context_business');
    assert.equal(state.facts['context.responsibilities'].value, 'Отвечаю за продажи');
    assert.equal(state.facts['context.company_size'].value, '50 сотрудников');
  }
});

test('mandatory questions precede adaptive clarification and accept explicit refusals without loops', () => {
  const business = { ...answer(), confirmation: 'unconfirmed' as const };
  const accepted: AuditAnswer[] = [business];
  let state = advanceAudit(initialAuditState(library.version, 'chat', now), accepted, now);
  for (const [index, reply] of introduction().entries()) {
    assert.equal(nextQuestion(state, now)?.id, reply.question_id);
    accepted.push({ ...reply, state: index % 2 ? 'unknown' : 'declined', value: null });
    state = advanceAudit(state, accepted, now);
  }
  assert.equal(nextQuestion(state, now)?.id, 'context_business');
  assert.match(nextQuestion(state, now)!.text, /верно ли записаны сведения/);
  assert.equal(nextQuestion({ ...state, status: 'closing' }, now), null);
});

test('each mandatory voice question is a separate save boundary with no optional branch', () => {
  const blocks = compileVoiceBlocks(library);
  for (const reply of introduction()) {
    const block = Object.values(blocks).find(block => block.questions.some(question => question.id === reply.question_id))!;
    assert.equal(block.questions.length, 1);
    assert.equal(block.questions[0].id, reply.question_id);
  }
});

test('library validation rejects missing or reordered mandatory entry questions', () => {
  const invalid = structuredClone(library);
  invalid.scenario.entry_questions.reverse();
  assert.ok(validateLibrary(invalid).errors.some(error => error.includes('Invalid mandatory entry question')));
});

test('previously created sessions keep their pinned questions and report library', () => {
  const previous = getLibrary('0.1.3');
  assert.equal(nextQuestion(initialAuditState(previous.version, 'chat', now), now, previous)?.id, 'context_business');
  assert.equal(previous.questions.some(question => question.id === 'context_name'), false);
  assert.deepEqual(validateLibrary(previous, { ruleChecks: ruleChecksForVersion(ruleChecksData, previous.version) }).errors, []);
  // 0.1.4 keeps its sixteen topics, 140 problems and the services and texts it had.
  const before = getLibrary('0.1.4');
  assert.deepEqual(validateLibrary(before, { ruleChecks: ruleChecksForVersion(ruleChecksData, before.version) }).errors, []);
  assert.equal(before.domains.length, 16); assert.equal(before.solutions.length, 140); assert.equal(before.services.length, 44);
  assert.equal(before.domains.find(domain => domain.id === 'marketplace')!.title, 'Маркетплейсы');
  assert.equal(before.solutions.find(block => block.id === 'seo_ai_visibility')!.domain, 'seo');
  assert.deepEqual(before.solutions.find(block => block.id === 'ads_cost')!.services, ['ads', 'analytics']);
  assert.equal(before.questions.find(question => question.id === 'seo_scope')!.chat, 'Относится ли к вашей задаче эта тема: обычный поиск и видимость в ответах AI?');
  assert.equal(before.questions.some(question => question.id === 'context_funnel'), false);
  assert.equal(before.relationships.some(relation => relation.relation === 'alternative_cause'), false);
  assert.equal(before.scenario.funnel, undefined);
  assert.equal(nextQuestion(initialAuditState(before.version, 'chat', now), now, before)?.id, 'context_name');
  assert.equal(getLibrary().version, '0.2.0');
  assert.equal(library.domains.length, 17); assert.equal(library.solutions.length, 159); assert.equal(library.services.length, 76);
});
function snapshot(answers: AuditAnswer[]): AuditSnapshot {
  const state = advanceAudit(initialAuditState(library.version, 'chat', now), answers, now, library, preview);
  return { id: 'snapshot-1', session_id: 'session-1', library_version: library.version, created_at: now, through_seq: 1, answers, state, limitations: [] };
}
function approvedForTest(): AuditLibrary {
  const lib = structuredClone(library);
  lib.status = 'approved';
  for (const item of [...lib.facts, ...lib.questions, ...lib.solutions]) { item.status = 'approved'; item.reviewer = 'test fixture'; item.approved_at = '2026-10-22'; }
  return lib;
}

function draftForTest(): AuditLibrary {
  const lib = structuredClone(library);
  lib.status = 'draft';
  for (const item of [...lib.facts, ...lib.questions, ...lib.solutions]) { item.status = 'draft'; item.reviewer = null; item.approved_at = null; }
  return lib;
}

test('approved library has valid links while a draft fixture remains closed', () => {
  const result = validateLibrary(library, { ruleChecks: ruleChecksData });
  assert.deepEqual(result.errors, []);
  assert.equal(result.productionReady, true);
  assert.ok(result.counts.solutions > 100);
  assert.throws(() => nextQuestion(initialAuditState(library.version, 'chat', now), now, draftForTest()), /LIBRARY_NOT_APPROVED/);
  // The approved order of work: 4–6 steps per problem, mirrored in the PDF block.
  for (const block of library.solutions) {
    assert.ok(block.solution.steps.length >= 4 && block.solution.steps.length <= 6, block.id);
    assert.deepEqual(block.solution.steps.map(step => step.order), block.solution.steps.map((_, index) => index + 1));
    assert.deepEqual(block.pdf.next_steps, block.solution.steps.map(step => step.text));
  }
  const noSection = structuredClone(library); noSection.report.sections.splice(5, 1);
  assert.match(validateLibrary(noSection).errors.join(), /Invalid report template/);
  const missingPath = structuredClone(library); missingPath.priorAttemptPaths.items.pop();
  assert.match(validateLibrary(missingPath).errors.join(), /Invalid prior-attempt paths/);
  const otherResults = structuredClone(library); (otherResults.facts.find(fact => fact.id === 'seo.history')!.fields as Record<string, unknown>).result = ['ongoing'];
  assert.match(validateLibrary(otherResults).errors.join(), /seo\.history: prior-attempt results differ/);
});

test('unknown evidence is not false, including under negation', () => {
  assert.equal(evaluateRule({ not: { fact: 'test', op: 'eq', value: true } }, {}), 'unknown');
  assert.equal(evaluateRule({ fact: 'test', op: 'eq', value: false }, { test: { state: 'unknown', value: null } }), 'unknown');
  assert.equal(evaluateRule({ fact: 'test', op: 'eq', value: false }, { test: { state: 'known', value: false, confirmation: 'explicit' } }), true);
  assert.equal(evaluateRule({ fact: 'test', op: 'eq', value: true }, { test: { state: 'known', value: true, confirmation: 'unconfirmed' } }), 'unknown');
  assert.equal(evaluateRule({ any: [{ fact: 'test', op: 'eq', value: true }, { fact: 'test', op: 'state', value: 'not_asked' }] }, {}), true);
});

test('rules reject executable strings, unknown operations and invalid numeric operands', () => {
  for (const rule of ['process.exit()', { fact: 'test', op: 'eval', value: '1' }, { fact: 'test', op: 'gt', value: 100 }, { all: [] }, { not: { fact: 'missing', op: 'eq', value: true } }]) assert.throws(() => validateRule(rule, new Set(['test'])));
  const comparison = { fact: 'volume', op: 'gt', value: 10, unit: 'orders', period: 'month' } as const;
  validateRule(comparison);
  assert.equal(evaluateRule(comparison, { volume: { state: 'known', value: { value: 15, unit: 'orders', period: 'week' } } }), 'unknown');
  assert.equal(evaluateRule(comparison, { volume: { state: 'known', value: { min: 5, max: 15, unit: 'orders', period: 'month' } } }), 'unknown');
  assert.equal(evaluateRule(comparison, { volume: { state: 'known', value: 15, parameters: { unit: 'orders', period: 'month', approximate: false } } }), true);
  assert.equal(evaluateRule(comparison, { volume: { state: 'known', value: 15, parameters: { unit: 'orders', period: 'month', approximate: true } } }), 'unknown');
});

test('answer validation requires delivered user evidence and exact question vocabulary', () => {
  const valid = answer();
  assert.doesNotThrow(() => validateAnswers([valid], [event()], [], library, preview));
  assert.throws(() => validateAnswers([valid], [], [], library, preview), /evidence/);
  assert.throws(() => validateAnswers([valid], [{ ...event(), kind: 'service' }], [], library, preview), /evidence/);
  assert.throws(() => validateAnswers([{ ...valid, fact_id: 'strategy_goal.signal' }], [event()], [], library, preview), /pair/);
  assert.throws(() => validateAnswers([answer('strategy_goal.signal', 'made_up')], [event()], [], library, preview), /vocabulary/);
  assert.throws(() => validateAnswers([{ ...valid, state: 'not_asked', value: null }], [event()], [], library, preview), /cannot be submitted/);
  assert.throws(() => validateAnswers([{ ...valid, library_version: 'future' }], [event()], [], library, preview), /version/);
});

test('unknown, not measured, refusal and explicit no stay distinct', () => {
  const values: AuditAnswer[] = [
    { ...answer('context.business'), state: 'unknown', value: null },
    { ...answer('context.goal', null, 'answer-2'), state: 'declined' },
    answer('strategy.applicable', false, 'answer-3'),
    { ...answer('strategy_goal.signal', null, 'answer-4'), state: 'not_measured' },
  ];
  validateAnswers(values, [event()], [], library, preview);
  const { facts } = deriveFacts(values);
  assert.equal(facts['context.business'].state, 'unknown');
  assert.equal(facts['context.goal'].state, 'declined');
  assert.equal(facts['strategy.applicable'].value, false);
  assert.equal(facts['strategy_goal.signal'].state, 'not_measured');
});

test('quantity parameters must preserve period, units, range and uncertainty', () => {
  assert.throws(() => validateAnswers([answer('context.budget', 1000)], [event()], [], library, preview), /Quantity/);
  const valid = answer('context.budget', { min: 20_000, max: 30_000, unit: 'budget', currency: 'RUB', period: 'month', approximate: true });
  validateAnswers([valid], [event()], [], library, preview);
  assert.throws(() => validateAnswers([answer('context.budget', { min: 30, max: 20, unit: 'budget', currency: 'RUB', period: 'month', approximate: true })], [event()], [], library, preview));
});

test('conflicting answers are never resolved by arrival order, correction preserves history', () => {
  const first = answer(), second = answer('context.business', 'Услуги', 'answer-2');
  const forward = deriveFacts([first, second]), reverse = deriveFacts([second, first]);
  assert.equal(forward.facts['context.business'].state, 'conflicting');
  assert.equal(reverse.facts['context.business'].state, 'conflicting');
  const corrected = { ...second, replaces_answer_id: first.id };
  assert.throws(() => validateAnswers([corrected], [event()], [first], library, preview), /explicit correction/);
  validateAnswers([corrected], [event('event-1', 'correction')], [first], library, preview);
  const resolved = deriveFacts([first, corrected]);
  assert.deepEqual(resolved.contradictions, []);
  assert.equal(resolved.facts['context.business'].value, 'Услуги');
  assert.equal(first.value, 'Магазин');
  assert.throws(() => validateAnswers([{ ...corrected, id: 'answer-3' }], [event('event-1', 'correction')], [first, corrected], library, preview), /active answer/);
});

test('new evidence may fill an earlier unknown without falsely treating unknown as a contradiction', () => {
  const unknown = { ...answer(), state: 'unknown' as const, value: null };
  const learned = answer('context.business', 'Магазин', 'learned');
  assert.equal(deriveFacts([unknown, learned]).facts['context.business'].state, 'known');
  assert.deepEqual(deriveFacts([unknown, learned]).contradictions, []);
  assert.equal(unknown.state, 'unknown');
  const notApplicable = { ...unknown, state: 'not_applicable' as const };
  assert.equal(deriveFacts([notApplicable, learned]).facts['context.business'].state, 'conflicting');
});

test('selection skips collected context and does not infer domain applicability', () => {
  const state = advanceAudit(initialAuditState(library.version, 'chat', now), [...introduction(), answer()], now, library, preview);
  assert.notEqual(nextQuestion(state, now, library, preview)?.id, 'context_business');
  assert.equal(state.candidate_blocks.length, 0);
  const late = { ...state, elapsed_ms: 24 * 60_000, active_since: null };
  assert.equal(nextQuestion(late, now, library, preview)?.id, 'context_confirmation');
  assert.equal(nextQuestion({ ...state, elapsed_ms: 1_500_000, active_since: null }, now, library, preview), null);
  assert.equal(nextQuestion({ ...state, paused: true }, now, library, preview), null);
});

test('chat holds accumulated voice time; only an active voice interval spends it', () => {
  const state = { ...initialAuditState(library.version, 'chat', now), elapsed_ms: 120_000 };
  assert.equal(elapsedInterviewMs(state, now + 60_000), 120_000);
  const voice = { ...state, active_channel: 'voice' as const, active_since: now, paused: false };
  assert.equal(elapsedInterviewMs(voice, now + 60_000), 180_000);
  assert.equal(elapsedInterviewMs({ ...voice, paused: true }, now + 600_000), 120_000);
  assert.equal(elapsedInterviewMs({ ...voice, active_channel: 'chat' }, now + 600_000), 120_000);
});

test('draft blocks and tariffs cannot appear in a report, even after complete interview evidence', () => {
  const facts = [answer('strategy.applicable', true), answer('strategy_goal.signal', 'target', 'answer-2'), answer('strategy_goal.details', { description: { state: 'known', value: 'Показатель не определён' } }, 'answer-3')];
  const result = analyzeAudit(snapshot(facts), draftForTest(), preview);
  assert.deepEqual(result.situations, []);
  assert.deepEqual(result.solutions, []);
  assert.deepEqual(result.tariffs, []);
  assert.match(result.limitations.join(' '), /экспертной проверке/);
});

test('approved rules separate sufficiency from significance and open repeated work with an approved path', () => {
  const lib = approvedForTest();
  const answers = [answer('strategy.applicable', true), answer('strategy_goal.signal', 'target', 'answer-2'), answer('strategy_goal.details', { description: { state: 'known', value: 'Показатель не определён' } }, 'answer-3')];
  let result = analyzeAudit(snapshot(answers), lib);
  assert.equal(result.situations[0].evidence_status, 'supported');
  // The approved code priority: no consequences and no named topic — the usual level with the confirmed-problem reason.
  assert.deepEqual(result.situations[0].significance, { level: 'low', reason: 'Обычный: проблема подтверждена Вашими ответами.' });
  // No history yet: the «unknown» path restores it first; the history stays among the gaps.
  assert.deepEqual(result.solutions[0].prior_attempts, { result: 'unknown', intro: 'Перед новыми работами восстановим, что уже делалось по этой теме.' });
  assert.deepEqual(result.actions.slice(0, 2).map(action => [action.text, action.after]), [
    ['Восстановить сведения о прошлых работах по теме: что делали, с каким результатом и почему остановили', []],
    [lib.solutions.find(block => block.id === 'strategy_goal')!.solution.steps[0].text, ['strategy.history:unknown:1']]]);
  assert.ok(result.gaps.includes('strategy.history'));
  // Unapproved paths keep repeated work blocked, as before.
  const unapproved = structuredClone(lib); unapproved.priorAttemptPaths.status = 'draft';
  assert.equal(analyzeAudit(snapshot(answers), unapproved).solutions.length, 0);
  answers.push(answer('strategy.history', { attempts_status: 'not_tried', attempts: [] }, 'answer-4'));
  result = analyzeAudit(snapshot(answers), lib);
  assert.equal(result.solutions.length, 1);
  assert.equal(result.solutions[0].prior_attempts, undefined);
  assert.ok(result.actions.length >= 4 && result.actions.length <= 6);
  assert.deepEqual(result.actions[0].after, []);
  assert.deepEqual(result.actions[1].after, [result.actions[0].id]);
  // Prices everywhere: a strategy problem shows the complex-marketing range that includes the audit and the strategy.
  assert.deepEqual(result.tariffs.map(tariff => [tariff.id, (tariff.details.price as Record<string, unknown>).min, (tariff.details.price as Record<string, unknown>).max]), [['marketing_audit_complex', 99500, 515610]]);
});

test('earlier work picks the approved path by its result; problems of one topic share its steps', () => {
  const details = (blockId: string) => Object.fromEntries(library.facts.find(fact => fact.id === `${blockId}.details`)!.required_fields!.map(field => [field, { state: 'known', value: 'Пример из ответа' }]));
  const base = [answer('analytics.applicable', true), answer('analytics_sales.signal', 'target', 'answer-2'), answer('analytics_sales.details', details('analytics_sales'), 'answer-3'),
    answer('analytics_goals.signal', 'target', 'answer-5'), answer('analytics_goals.details', details('analytics_goals'), 'answer-6')];
  const attempt = { attempt_id: 'attempt-1', work: { state: 'known', value: 'Настраивали аналитику' } };
  for (const path of library.priorAttemptPaths.items) {
    const history: Json = { attempts_status: 'tried', ...(path.id === 'unknown' ? {} : { result: path.id }), attempts: [attempt] };
    const ready = snapshot([...base, answer('analytics.history', history, 'answer-4')]);
    const result = analyzeAudit(ready, library);
    assert.equal(result.solutions.length, 2);
    assert.ok(result.solutions.every(solution => solution.prior_attempts?.result === path.id && solution.prior_attempts.intro === path.intro));
    const shared = path.steps.map((_, index) => `analytics.history:${path.id}:${index + 1}`);
    assert.deepEqual(result.actions.filter(action => action.id.startsWith('analytics.history:')).map(action => action.text), path.steps);
    for (const solution of result.solutions) {
      assert.deepEqual(solution.action_ids.slice(0, shared.length), shared);
      assert.deepEqual(result.actions.find(action => action.id === solution.action_ids[shared.length])!.after, [shared.at(-1)]);
    }
    assert.equal(result.gaps.includes('analytics.history'), path.id === 'unknown');
    assert.ok(result.tariffs.length > 0);
    const altered = structuredClone(result); altered.solutions[0].prior_attempts!.intro = 'Свой текст';
    assert.throws(() => validateAuditResult(altered, library, ready), /prior-attempt path is not approved/);
    const reordered = structuredClone(result); reordered.solutions[0].action_ids.reverse();
    assert.throws(() => validateAuditResult(reordered, library, ready), /prior-attempt steps/);
  }
  // A not-tried history carries no result; unknown or declined history takes the «unknown» path.
  assert.throws(() => validateAnswers([answer('analytics.history', { attempts_status: 'not_tried', result: 'ongoing', attempts: [] })], [event()], [], library));
  for (const status of ['unknown', 'declined']) assert.equal(analyzeAudit(snapshot([...base, answer('analytics.history', { attempts_status: status, attempts: [] }, 'answer-4')]), library).solutions[0].prior_attempts?.result, 'unknown');
});

test('approved tariffs become preliminary options only for a supported service and matching evidence', () => {
  const base = [answer('analytics.applicable', true), answer('analytics_sales.signal', 'target', 'answer-2'),
    answer('analytics_sales.details', { description: { state: 'known', value: 'Продажи не связаны с источниками' } }, 'answer-3')];
  const ready = snapshot([...base, answer('analytics.history', { attempts_status: 'not_tried', attempts: [] }, 'answer-4')]);
  const result = analyzeAudit(ready, library);
  // Missing history opens with restoring it, but the problem keeps the same priced options.
  const missingHistory = analyzeAudit(snapshot(base), library);
  assert.equal(missingHistory.solutions[0].prior_attempts?.result, 'unknown');
  assert.deepEqual(missingHistory.tariffs, result.tariffs);
  // The problem's services are analytics and CRM integration: options of both are offered.
  assert.deepEqual(result.tariffs.map(tariff => tariff.id), ['analytics_once', 'analytics_month', 'analytics_advanced', 'crm_integration_bitrix']);
  assert.ok(result.tariffs.every(tariff => tariff.details.selection_status === 'option_requires_scope_confirmation'));
  assert.ok(result.tariffs.every(tariff => tariff.source_urls.length === 1 && tariff.source_urls[0].startsWith('https://')));
  const altered = structuredClone(result);
  (altered.tariffs[0].details.price as Record<string, unknown>).amount = 1;
  assert.throws(() => validateAuditResult(altered, library, ready), /approved catalog/);
  const wrongSource = structuredClone(result);
  wrongSource.tariffs[0].source_urls = [library.sources.find(source => source.id !== 'analytics' && source.url)!.url!];
  assert.throws(() => validateAuditResult(wrongSource, library, ready), /tariff source/);
  const wrongTax = structuredClone(result);
  wrongTax.tariffs[0].details.tax = null;
  assert.throws(() => validateAuditResult(wrongTax, library, ready), /tariff tax/);
});

test('each approved tariff option has a rule supported by a positive service example', () => {
  for (const tariff of library.tariffs) {
    assert.ok(tariff.selection_rule, tariff.id);
    assert.equal(tariff.auto_selectable, false, tariff.id);
    const serviceBlocks = library.solutions.filter(block => block.services.includes(tariff.service_id));
    const example = ruleChecksData.items.find(item => item.kind === 'positive' && serviceBlocks.some(block => block.id === item.block_id));
    assert.ok(example, tariff.id);
    const facts = Object.fromEntries(example.fact_fixture.map(fact => [fact.fact_id, { state: fact.state, value: fact.value, confirmation: 'explicit' }]));
    assert.equal(evaluateRule(tariff.selection_rule, facts), true, tariff.id);
  }
});

test('humor is deterministic, excludes reservations, does not alter facts or time', () => {
  const state = initialAuditState(library.version, 'chat', now);
  const question = nextQuestion(state, now, library, preview)!;
  const intent = { kind: 'off_topic' as const, certain: true, safe_category_ids: ['weather', 'general'], now };
  const before = JSON.stringify(state);
  const first = selectHumorReply(state, intent, question);
  assert.equal(first.joke_id, 'weather_01');
  assert.equal(JSON.stringify(state), before);
  state.humor.reserved_ids.push(first.joke_id!);
  assert.equal(selectHumorReply(state, intent, question).joke_id, 'weather_02');
  state.humor.reserved_ids = library.jokes.categories.flatMap(category => category.jokes.map(joke => joke.id));
  assert.equal(selectHumorReply(state, intent, question).joke_id, null);
});

test('return phrases take turns as jokes are used; neutral replies describe the consultant role', () => {
  const state = initialAuditState(library.version, 'chat', now);
  const question = nextQuestion(state, now, library, preview)!;
  const intent = { kind: 'off_topic' as const, certain: true, safe_category_ids: ['weather'], now };
  const endings: (string | undefined)[] = [];
  for (let i = 0; i <= library.jokes.return_phrases.length; i++) {
    const reply = selectHumorReply(state, intent, question);
    endings.push(library.jokes.return_phrases.find(phrase => reply.text.endsWith(` ${phrase}`)));
    state.humor.reserved_ids.push(reply.joke_id!);
  }
  assert.deepEqual(endings, [...library.jokes.return_phrases, library.jokes.return_phrases[0]]);
  state.humor.reserved_ids = library.jokes.categories.flatMap(category => category.jokes.map(joke => joke.id));
  assert.match(selectHumorReply(state, intent, question).text, /вопросы об услугах Pixel Plus и провожу экспресс-диагностику/);
  assert.match(selectHumorReply(state, { ...intent, kind: 'role_change' }, question).text, /ответить на вопросы об услугах Pixel Plus или продолжить экспресс-диагностику/);
});

test('mixed, sensitive, uncertain and pause intents do not get a joke', () => {
  const state = initialAuditState(library.version, 'chat', now);
  const question = nextQuestion(state, now, library, preview)!;
  for (const kind of ['mixed', 'sensitive', 'clarification', 'complaint', 'answer', 'ambiguous', 'pause', 'finish'] as const) assert.equal(selectHumorReply(state, { kind, certain: true, safe_category_ids: ['weather'], now }, question).joke_id, null);
  const paused = selectHumorReply(state, { kind: 'pause', certain: true, safe_category_ids: ['weather'], now }, question);
  assert.equal(paused.question_id, null);
  state.humor.enabled = false;
  assert.equal(selectHumorReply(state, { kind: 'off_topic', certain: true, safe_category_ids: ['weather'], now }, question).joke_id, null);
});

test('previous-topic jokes require recorded compatibility and no category is guessed', () => {
  const state = initialAuditState(library.version, 'chat', now), question = nextQuestion(state, now, library, preview)!;
  const intent = { kind: 'off_topic' as const, certain: true, safe_category_ids: ['context_sales'], now };
  assert.equal(selectHumorReply(state, intent, question).joke_id, null);
  assert.ok(selectHumorReply(state, { ...intent, previous_topic_category_ids: ['context_sales'] }, question).joke_id);
});

test('runtime state validation rejects unknown IDs, phantom facts and malformed humor operations', () => {
  const state = initialAuditState(library.version, 'chat', now);
  validateAuditState(state);
  assert.throws(() => validateAuditState({ ...state, elapsed_ms: -1 }));
  assert.throws(() => validateAuditState({ ...state, extracted_through_seq: 5 }));
  assert.throws(() => validateAuditState({ ...state, current_question_id: 'invented-question' }));
  assert.throws(() => validateAuditState({ ...state, facts: { phantom: deriveFacts([answer()]).facts['context.business'] } }));
  assert.throws(() => validateAuditState({ ...state, humor: { ...state.humor, reserved_ids: ['invented-joke'] } }));
  assert.throws(() => validateAuditState({ ...state, arbitrary_setting: true }));
});

test('result validation rejects cycles, missing evidence and draft recommendations', () => {
  const data = snapshot([answer()]), result = analyzeAudit(data, library, preview);
  validateAuditResult(result, library, data);
  assert.throws(() => validateAuditResult({ ...result, snapshot_id: 'other' }, library, data));
  assert.throws(() => validateAuditResult({ ...result, actions: [{ id: 'a', text: 'A', after: ['b'], parallel_with: [], deferred_reason: null }, { id: 'b', text: 'B', after: ['a'], parallel_with: [], deferred_reason: null }] }));
  const draft = draftForTest();
  assert.throws(() => validateAuditResult({ ...result, solutions: [{ id: draft.solutions[0].id, title: 'A', text: 'B', service_ids: [], action_ids: [], limitations: [] }] }, draft), /not approved/);
});

test('voice compilation excludes recommendations and requires explicit draft preview', () => {
  assert.throws(() => compileVoiceBlocks(draftForTest()), /LIBRARY_NOT_APPROVED/);
  const compiled = compileVoiceBlocks(library);
  assert.ok(Object.values(compiled).some(block => block.questions.some(question => question.id === 'context_business')));
  for (const block of Object.values(compiled)) {
    assert.equal(block.library_version, library.version);
    for (const question of block.questions) assert.deepEqual(Object.keys(question), ['id', 'text', 'fact_ids', 'options']);
  }
});

test('a release fails on unknown operations, broken references, cycles and missing expert examples', () => {
  const lib = structuredClone(library);
  lib.solutions[0].inclusion = { fact: 'strategy.applicable', op: 'execute', value: true } as never;
  lib.questions[0].transitions = { loop: lib.questions[0].id };
  lib.solutions[0].services = ['nonexistent'];
  lib.scenario.phases[0].next = lib.scenario.phases[0].id;
  const errors = validateLibrary(lib).errors.join('\n');
  assert.match(errors, /Unsupported rule operation/);
  assert.match(errors, /unknown reference nonexistent/);
  assert.match(errors, /loop/);
  assert.match(errors, /terminal/);
  const release = approvedForTest(), releaseErrors = validateLibrary(release).errors.join('\n');
  assert.match(releaseErrors, /test_cases/);
  release.schemas.state.required = [];
  assert.match(validateLibrary(release).errors.join(), /Editorial state schema/);
});

test('manifest validation covers exact bytes and missing/extra inputs', async () => {
  const bytes = new TextEncoder().encode('{"version":1}');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  const manifest = { library_version: library.version, files: [{ path: 'facts.json', sha256 }] };
  assert.deepEqual(await validateLibraryManifest(manifest, { 'facts.json': bytes }), []);
  assert.match((await validateLibraryManifest(manifest, { 'facts.json': new TextEncoder().encode('{"version":2}') })).join(), /hash mismatch/);
  assert.match((await validateLibraryManifest(manifest, {})).join(), /Missing manifest input/);
  assert.match((await validateLibraryManifest(manifest, { 'facts.json': bytes, 'extra.json': bytes })).join(), /absent from manifest/);
});

test('the interview follows named topics and stops screening a domain after selecting a substantive branch', () => {
  const entries = [...introduction(), answer('context.business'), answer('context.goal', 'Улучшить измеримость', 'goal'), answer('context.assets', ['site'], 'assets'), answer('context.priority', ['strategy'], 'priority')];
  let state = advanceAudit(initialAuditState(library.version, 'chat', now), entries, now, library, preview);
  assert.equal(nextQuestion(state, now, library, preview)?.id, 'context_funnel');
  entries.push(answer('context.funnel', 'few_leads', 'funnel'));
  state = advanceAudit(state, entries, now, library, preview);
  assert.equal(nextQuestion(state, now, library, preview)?.id, 'strategy_scope');
  entries.push(answer('strategy.applicable', true, 'applicable'), answer('strategy_goal.signal', 'target', 'signal'));
  state = advanceAudit(state, entries, now, library, preview);
  assert.equal(nextQuestion(state, now, library, preview)?.id, 'strategy_goal_detail');
  assert.deepEqual(state.candidate_blocks, ['strategy_goal']);
});

test('questions mode asks no survey question, keeps sufficiency honest and still jokes with its own return phrases', () => {
  const state = initialAuditState(library.version, 'chat', now, 'questions');
  assert.equal(nextQuestion(state, now, library, preview), null, 'the survey waits for the visitor to ask for the diagnostic');
  assert.equal(interviewSufficiency(state, now, library, preview).sufficient, false);
  validateAuditState(state);
  const intent = { kind: 'off_topic' as const, certain: true, safe_category_ids: ['weather'], now };
  const first = selectHumorReply(state, intent, null);
  assert.equal(first.joke_id, 'weather_01'); assert.equal(first.question_id, null);
  assert(first.text.endsWith(` ${library.jokes.questions_return_phrases![0]}`), first.text);
  assert(!library.jokes.return_phrases.some(phrase => first.text.endsWith(phrase)), 'no «back to the survey» while no survey runs');
  state.humor.reserved_ids.push(first.joke_id!);
  assert(selectHumorReply(state, intent, null).text.endsWith(` ${library.jokes.questions_return_phrases![1]}`));
  const diagnostic = { ...state, mode: 'diagnostic' as const };
  assert.equal(nextQuestion(diagnostic, now, library, preview)?.id, 'context_name', 'the diagnostic starts with the first question');
  assert.throws(() => validateAuditState({ ...state, mode: 'other' }), /state\.mode/);
  const old = structuredClone(diagnostic) as Partial<typeof diagnostic>; delete old.mode;
  assert.equal(nextQuestion(old as typeof diagnostic, now, library, preview)?.id, 'context_name', 'sessions saved before the mode existed stay in the diagnostic');
});

test('a voice interview asks at most 50 distinct questions, the last being the confirmation; chat has no such cap', () => {
  const voice = { ...initialAuditState(library.version, 'voice', now), paused: false };
  const answers: AuditAnswer[] = ['context_name', 'context_position', 'context_company_name', 'context_website', 'context_responsibilities', 'context_company_size'].map((questionId, index) => ({
    id: `a${index}`, question_id: questionId, fact_id: questionId.replace('context_', 'context.'), state: 'known', value: 'Тест', event_ids: ['e'],
    channel: 'voice', method: 'voice_batch', confirmation: 'explicit', library_version: library.version, created_at: now }));
  const advanced = advanceAudit(voice, answers, now, library, preview);
  assert.equal(advanced.questions_answered, 6, 'distinct questions answered are counted');
  assert.notEqual(nextQuestion(advanced, now, library, preview)?.id, 'context_confirmation');
  assert.equal(nextQuestion({ ...advanced, questions_answered: 49 }, now, library, preview)?.id, 'context_confirmation', 'the 50th place is kept for the confirmation');
  assert.equal(nextQuestion({ ...advanced, questions_answered: 50 }, now, library, preview), null);
  const chat = { ...advanced, active_channel: 'chat' as const, questions_answered: 60 };
  assert.notEqual(nextQuestion(chat, now, library, preview), null, 'chat is not capped');
  assert.equal(library.scenario.clock.max_seconds, 1500); assert.equal(library.scenario.clock.no_new_deep_branch_after, 1320); assert.equal(library.scenario.clock.closing_from, 1440);
});
