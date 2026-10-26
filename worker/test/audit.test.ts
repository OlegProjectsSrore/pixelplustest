import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuditState, type AuditAnswer, type AuditEvent, type AuditSnapshot } from '../src/audit/contracts.ts';
import { advanceAudit, analyzeAudit, deriveFacts, elapsedInterviewMs, interviewSufficiency, nextQuestion, validateAnswers } from '../src/audit/engine.ts';
import { compileVoiceBlocks, getLibrary, library, validateLibrary, validateLibraryManifest, type AuditLibrary } from '../src/audit/library.ts';
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
  answer('context.responsibilities', 'Отвечаю за продажи', 'intro-responsibilities'),
  answer('context.company_size', '50 сотрудников', 'intro-size'),
];

test('mandatory introduction has the same order and saved progress across repeated channel switches', () => {
  const expected = [
    ['context_name', 'Как Вас зовут?'],
    ['context_position', 'Какая Ваша должность в компании?'],
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
        assert.equal(question.id, id); assert.equal(question.text, text);
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
  assert.deepEqual(validateLibrary(previous, { ruleChecks: ruleChecksData }).errors, []);
  assert.equal(getLibrary().version, '0.1.4');
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
  const late = { ...state, elapsed_ms: 14 * 60_000, active_since: null };
  assert.equal(nextQuestion(late, now, library, preview)?.id, 'context_confirmation');
  assert.equal(nextQuestion({ ...state, elapsed_ms: 900_000, active_since: null }, now, library, preview), null);
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

test('approved rules separate sufficiency from significance and block repeated work', () => {
  const lib = approvedForTest();
  const answers = [answer('strategy.applicable', true), answer('strategy_goal.signal', 'target', 'answer-2'), answer('strategy_goal.details', { description: { state: 'known', value: 'Показатель не определён' } }, 'answer-3')];
  let result = analyzeAudit(snapshot(answers), lib);
  assert.equal(result.situations[0].evidence_status, 'supported');
  assert.equal(result.situations[0].significance.level, 'unknown');
  assert.equal(result.solutions.length, 0);
  answers.push(answer('strategy.history', { attempts_status: 'not_tried', attempts: [] }, 'answer-4'));
  result = analyzeAudit(snapshot(answers), lib);
  assert.equal(result.solutions.length, 1);
  assert.deepEqual(result.actions[1].after, [result.actions[0].id]);
  assert.equal(result.tariffs.length, 0);
});

test('approved tariffs become preliminary options only for a supported service and matching evidence', () => {
  const base = [answer('analytics.applicable', true), answer('analytics_sales.signal', 'target', 'answer-2'),
    answer('analytics_sales.details', { description: { state: 'known', value: 'Продажи не связаны с источниками' } }, 'answer-3')];
  const missingHistory = analyzeAudit(snapshot(base), library);
  assert.deepEqual(missingHistory.tariffs, []);
  const ready = snapshot([...base, answer('analytics.history', { attempts_status: 'not_tried', attempts: [] }, 'answer-4')]);
  const result = analyzeAudit(ready, library);
  assert.deepEqual(result.tariffs.map(tariff => tariff.id), ['analytics_once', 'analytics_month', 'analytics_advanced']);
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
  assert.equal(nextQuestion(state, now, library, preview)?.id, 'strategy_scope');
  entries.push(answer('strategy.applicable', true, 'applicable'), answer('strategy_goal.signal', 'target', 'signal'));
  state = advanceAudit(state, entries, now, library, preview);
  assert.equal(nextQuestion(state, now, library, preview)?.id, 'strategy_goal_detail');
  assert.deepEqual(state.candidate_blocks, ['strategy_goal']);
});
