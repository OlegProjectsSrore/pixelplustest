import test from 'node:test';
import assert from 'node:assert/strict';
import { initialAuditState, type AuditAnswer, type AuditEvent, type Json } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { advanceAudit, deriveFacts, nextQuestion, validateAnswers } from '../src/audit/engine.ts';
import { mergeStructuredValues, runtimeSchemaForFact, validateRuntimeValue } from '../src/audit/value-schemas.ts';
import { buildChatContext } from '../src/chat/build-context.ts';
import { parseClassification } from '../src/chat/validation.ts';

const now = 1000, preview = { allowDraft: true };
const event: AuditEvent = { id: 'user', source: 'chat', source_key: 'user', source_revision: 0, local_order: 0, role: 'user', kind: 'utterance',
  text: 'Сообщённые сведения', occurred_at: now, received_at: now };
function answer(factId: string, value: Json, id = 'answer'): AuditAnswer {
  const question = library.questions.find(item => item.fact_ids.includes(factId))!;
  return { id, fact_id: factId, question_id: question.id, state: 'known', value, channel: 'chat', method: 'classification', confirmation: 'explicit',
    library_version: library.version, created_at: now, event_ids: [event.id] };
}
function classify(factId: string, value: Json) {
  const q = library.questions.find(item => item.fact_ids.includes(factId))!;
  const context = buildChatContext({ lib: library, state: initialAuditState(library.version, 'chat', now), events: [event], existingAnswers: [], currentQuestion: q,
    sourceEvents: [event], allowDraft: true, allowedQuestionIds: [q.id], allowedAttemptIds: { [factId]: ['attempt-one', 'attempt-two'] } });
  return parseClassification({ intent: 'answer', answers: [{ question_id: q.id, fact_id: factId, state: 'known', value, event_ids: [event.id], evidence: [{ event_id: event.id, text: event.text }] }],
    clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null }, context).answers[0]!;
}

test('every currently declared structured fact has a formal core schema independent of examples', () => {
  for (const fact of library.facts.filter(fact => ['object', 'money', 'number', 'period'].includes(fact.value_type))) assert.ok(fact.runtime_schema, fact.id);
  const unmodeled = { ...library.facts.find(fact => fact.id === 'strategy_goal.details')!, id: 'unmodeled', runtime_schema: undefined };
  assert.equal(runtimeSchemaForFact(unmodeled), undefined);
  assert.equal(runtimeSchemaForFact({ ...unmodeled, id: 'new.details', required_fields: ['invented_field'] }), undefined);
});

test('money partials preserve supplied amount without inferring currency, units, period or approximation', () => {
  const value = { min: 20_000, max: 30_000 };
  assert.deepEqual(classify('context.budget', value).value, value);
  validateAnswers([answer('context.budget', value)], [event], [], library, preview);
  assert.deepEqual(value, { min: 20_000, max: 30_000 });
  assert.throws(() => classify('context.budget', { ...value, invented_currency: 'RUB' }));
  assert.throws(() => validateAnswers([answer('context.budget', { min: 30, max: 20 })], [event], [], library, preview), /range/);
  const parts = [answer('context.budget', value), answer('context.budget', { currency: 'RUB', unit: 'бюджет', period: 'месяц', approximate: true }, 'dimensions')];
  assert.deepEqual(deriveFacts(parts).facts['context.budget'].value, { ...value, currency: 'RUB', unit: 'бюджет', period: 'месяц', approximate: true });
});

test('period wording and scale dimensions retain original meaning without a manufactured calendar', () => {
  assert.equal(classify('context.goal_period', 'к концу следующего квартала').value, 'к концу следующего квартала');
  assert.throws(() => classify('context.goal_period', { start: '2026-01-01', guessed: true }));
  const value = { metric: 'обращения', min: 20, max: 30, unit: 'обращения', period: 'месяц', approximate: true };
  assert.deepEqual(classify('context.scale', value).value, value);
  validateAnswers([answer('context.scale', value)], [event], [], library, preview);
  const scalarDefinition = { ...library.facts.find(fact => fact.id === 'context.budget')!, id: 'number', value_type: 'number' };
  assert.doesNotThrow(() => validateRuntimeValue({ value: 20, unit: 'обращения' }, runtimeSchemaForFact(scalarDefinition)!));
});

test('partial detail fields validate independently and later compatible fields merge without defaults', () => {
  const one = { object: { state: 'known', value: 'Лендинг' } };
  const two = { observation: { state: 'known', value: 'Контактная форма не отправляется' }, period: { state: 'unknown', value: null } };
  assert.deepEqual(classify('strategy_channels.details', one).value, one);
  const answers = [answer('strategy_channels.details', one), answer('strategy_channels.details', two, 'next')];
  validateAnswers(answers, [event], [], library, preview);
  const forward = deriveFacts(answers), reverse = deriveFacts([...answers].reverse());
  assert.deepEqual(forward.facts['strategy_channels.details'].value, { ...one, ...two });
  assert.deepEqual(reverse.facts['strategy_channels.details'].value, forward.facts['strategy_channels.details'].value);
  assert.deepEqual(forward.contradictions, []); assert.deepEqual(answers[0]!.value, one);
  assert.throws(() => validateAnswers([answer('strategy_channels.details', { object: { state: 'known', value: null } })], [event], [], library, preview));
  assert.throws(() => validateAnswers([answer('strategy_channels.details', { observation: { state: 'not_asked', value: null } })], [event], [], library, preview));
  assert.throws(() => validateAnswers([answer('strategy_channels.details', { period: { state: 'known', value: { value: 20 } } })], [event], [], library, preview));
});

test('history merges by server-reserved attempt ID and never requires invented answers for later questions', () => {
  const first = { attempts_status: 'tried', attempts: [{ attempt_id: 'attempt-one', work: { state: 'known', value: 'Настраивали аналитику' } }] };
  const second: Json = { attempts: [{ attempt_id: 'attempt-two', work: { state: 'known', value: 'Меняли сайт' } },
    { attempt_id: 'attempt-one', outcome: { state: 'unknown', value: null } }] };
  assert.deepEqual(classify('strategy.history', first).value, first);
  assert.deepEqual(classify('strategy.history', second).value, second);
  const answers = [answer('strategy.history', first), answer('strategy.history', second, 'next')];
  validateAnswers(answers, [event], [], library, preview);
  const merged = deriveFacts(answers).facts['strategy.history'].value as any;
  assert.deepEqual(merged.attempts.map((attempt: any) => attempt.attempt_id), ['attempt-one', 'attempt-two']);
  assert.equal(merged.attempts[0].work.value, 'Настраивали аналитику'); assert.deepEqual(merged.attempts[0].outcome, { state: 'unknown', value: null });
  assert.equal('goal' in merged.attempts[0], false); assert.equal('outcome' in merged.attempts[1], false);
  assert.throws(() => classify('strategy.history', { attempts: [{ attempt_id: 'model-invented', work: { state: 'known', value: 'Работы' } }] }));
  assert.throws(() => validateAnswers([answer('strategy.history', { attempts_status: 'not_tried', attempts: first.attempts })], [event], [], library, preview));
});

test('a history result is classified within the pinned values and the newer summary replaces the older', () => {
  const first = { attempts_status: 'tried', result: 'unknown', attempts: [{ attempt_id: 'attempt-one', work: { state: 'known', value: 'Настраивали аналитику' } }] };
  const second = { result: 'partial_or_stopped', attempts: [{ attempt_id: 'attempt-one', stop_reason: { state: 'known', value: 'Закончился бюджет' } }] };
  assert.deepEqual(classify('strategy.history', first).value, first);
  assert.throws(() => classify('strategy.history', { ...first, result: 'success' }));
  const answers = [answer('strategy.history', first), answer('strategy.history', second, 'next')];
  validateAnswers(answers, [event], [], library, preview);
  const fact = deriveFacts(answers).facts['strategy.history'];
  assert.equal(fact.state, 'known');
  assert.equal((fact.value as any).result, 'partial_or_stopped');
  // «Unknown» never erases a known result; «no result» stays when the work was abandoned later; otherwise the newer wins.
  assert.equal((deriveFacts([...answers].reverse()).facts['strategy.history'].value as any).result, 'partial_or_stopped');
  assert.deepEqual(mergeStructuredValues({ result: 'no_result' }, { result: 'partial_or_stopped' }), { result: 'no_result' });
  assert.deepEqual(mergeStructuredValues({ result: 'partial_or_stopped' }, { result: 'no_result' }), { result: 'no_result' });
  assert.deepEqual(mergeStructuredValues({ result: 'ongoing' }, { result: 'unknown' }), { result: 'ongoing' });
  assert.deepEqual(mergeStructuredValues({ result: 'ongoing' }, { result: 'partial_or_stopped' }), { result: 'partial_or_stopped' });
  // Other differing fields still conflict.
  assert.throws(() => mergeStructuredValues({ attempts_status: 'tried' }, { attempts_status: 'not_tried' }));
});

test('a history answer gives its question\'s fields and new details; repeats of saved details in other words are dropped', () => {
  const known = (value: string) => ({ state: 'known', value });
  const reply = (question: number, value: Json, id: string): AuditAnswer => ({ ...answer('strategy.history', value, id), question_id: `strategy_history_${question}` });
  // The live DeepSeek case: the executor said in passing, then asked directly; the work restated in other words with every answer.
  const answers = [
    reply(1, { attempts_status: 'tried', result: 'unknown', attempts: [{ attempt_id: 'a', work: known('Работали с агентством по аналитике'), period_and_duration: known('Полгода'), executor_and_resources: known('Агентство по аналитике') }] }, 'one'),
    reply(2, { attempts_status: 'tried', result: 'unknown', attempts: [{ attempt_id: 'a', work: known('Работа с агентством'), period_and_duration: known('Полгода'), executor_and_resources: known('Агентство'), goal: known('Ждали отчёт по каналам') }] }, 'two'),
    reply(3, { result: 'partial_or_stopped', attempts: [{ attempt_id: 'a', work: known('Аналитика с агентством'), outcome: known('Часть отчётов настроили') }] }, 'three'),
    reply(4, { attempts: [{ attempt_id: 'a', current_status: { state: 'unknown', value: null }, stop_reason: known('Закончился бюджет') }] }, 'four'),
  ];
  validateAnswers(answers, [event], [], library, preview);
  const derived = deriveFacts(answers), fact = derived.facts['strategy.history'];
  assert.deepEqual(derived.contradictions, []);
  assert.equal(fact.state, 'known');
  assert.deepEqual(fact.value, { attempts_status: 'tried', result: 'partial_or_stopped', attempts: [{ attempt_id: 'a', work: known('Работали с агентством по аналитике'), period_and_duration: known('Полгода'),
    executor_and_resources: known('Агентство'), goal: known('Ждали отчёт по каналам'), outcome: known('Часть отчётов настроили'), current_status: { state: 'unknown', value: null }, stop_reason: known('Закончился бюджет') }] });
  // A direct answer replaces a passing mention, but «unknown» never erases a known detail.
  const later = reply(4, { attempts: [{ attempt_id: 'a', stop_reason: { state: 'unknown', value: null }, current_status: known('Остановили') }] }, 'five');
  const updated = deriveFacts([...answers, later]).facts['strategy.history'].value as any;
  assert.deepEqual([updated.attempts[0].stop_reason, updated.attempts[0].current_status], [known('Закончился бюджет'), known('Остановили')]);
  // A new attempt ID is another piece of work; tried against not tried is still a contradiction.
  assert.equal((deriveFacts([...answers, reply(1, { attempts: [{ attempt_id: 'b', work: known('Меняли сайт') }] }, 'six')]).facts['strategy.history'].value as any).attempts.length, 2);
  assert.equal(deriveFacts([answers[0], reply(1, { attempts_status: 'not_tried', attempts: [] }, 'seven')]).facts['strategy.history'].state, 'conflicting');
});

test('overlapping structured facts and histories conflict when their reported values disagree', () => {
  const one = answer('strategy_channels.details', { object: { state: 'known', value: 'Сайт A' } });
  const two = answer('strategy_channels.details', { object: { state: 'known', value: 'Сайт B' } }, 'other');
  assert.equal(deriveFacts([one, two]).facts[one.fact_id].state, 'conflicting');
  assert.equal(deriveFacts([two, one]).facts[one.fact_id].state, 'conflicting');
  assert.throws(() => mergeStructuredValues(['first'], ['second']));
  assert.throws(() => mergeStructuredValues({ attempts: [{ attempt_id: 'same', work: { state: 'known', value: 'A' } }] }, { attempts: [{ attempt_id: 'same', work: { state: 'known', value: 'B' } }] }));
  const mixedConfirmation = deriveFacts([one, { ...answer(one.fact_id, { period: { state: 'known', value: 'Вчера' } }, 'unchecked'), confirmation: 'unconfirmed' }]);
  assert.equal(mixedConfirmation.facts[one.fact_id].confirmation, 'unconfirmed');
});

test('a partial detail fact remains askable until each requested field has been supplied', () => {
  const lib = structuredClone(library), q = lib.questions.find(question => question.fact_ids.includes('strategy_channels.details'))!;
  lib.questions = [q];
  const base = [answer('strategy.applicable', true, 'applies'), answer('strategy_channels.signal', 'target', 'signal')];
  const first = answer('strategy_channels.details', { object: { state: 'known', value: 'Сайт' } });
  const partial = advanceAudit(initialAuditState(lib.version, 'chat', now), [...base, first], now, lib, preview);
  assert.equal(nextQuestion(partial, now, lib, preview)?.id, q.id);
  const rest = answer('strategy_channels.details', { observation: { state: 'known', value: 'Форма не работает' }, period: { state: 'unknown', value: null } }, 'rest');
  const complete = advanceAudit(partial, [...base, first, rest], now, lib, preview);
  assert.equal(nextQuestion(complete, now, lib, preview), null);
});
