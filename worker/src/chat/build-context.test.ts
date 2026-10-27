import assert from 'node:assert/strict';
import test from 'node:test';
import { initialAuditState, type AuditAnswer, type AuditEvent } from '../audit/contracts.ts';
import { library, type AuditLibrary } from '../audit/library.ts';
import { buildChatContext, buildClassifierContext } from './build-context.ts';
import { parseClassification, ClassificationValidationError } from './classifier.ts';

const event = (): AuditEvent => ({ id: 'new-1', source: 'chat', source_key: 'turn-1', source_revision: 0, local_order: 1, role: 'user', kind: 'utterance', text: 'Пока говорим просто надо расти, срок и показатель не выбрали.', occurred_at: 1, received_at: 1 });
const state = () => initialAuditState(library.version, 'chat', 1);
const questionFor = (fact: string, lib = library) => {
  const q = lib.questions.find(q => q.fact_ids.includes(fact)); assert.ok(q); return q;
};
const payload = (factId: string, questionId: string, value: unknown, state = 'known', answerId?: string) => ({
  intent: 'answer', answers: [{ question_id: questionId, fact_id: factId, state, value, ...(answerId ? { answer_id: answerId } : {}), event_ids: ['new-1'], evidence: [{ event_id: 'new-1', text: 'срок и показатель не выбрали' }] }],
  clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null,
});

test('projects real answer-options IDs and retains entailment, paraphrases and boundary examples', () => {
  const currentQuestion = questionFor('strategy_goal.signal');
  const context = buildChatContext({ lib: library, state: state(), events: [], existingAnswers: [], currentQuestion, sourceEvents: [event()], allowDraft: true, allowedQuestionIds: [currentQuestion.id] });
  const option = context.allowed_answers.find(a => a.fact_id === 'strategy_goal.signal' && a.id === 'target');
  assert.ok(option); assert.equal(option.value, 'target'); assert.ok(option.entailment); assert.ok(option.examples?.length); assert.ok(option.counterexamples?.length);
  assert.equal(parseClassification(payload('strategy_goal.signal', currentQuestion.id, 'target', 'known', 'target'), context).answers[0].value, 'target');
  for (const key of ['solutions', 'tariffs', 'sources', 'services', 'cases']) assert.equal(Object.hasOwn(context, key), false);
});

test('production context refuses draft question/fact; explicit draft mode is required', () => {
  const approved = structuredClone(library);
  const question = questionFor('strategy_goal.signal', approved);
  Object.assign(question, { status: 'draft', reviewer: null, approved_at: null });
  assert.throws(() => buildClassifierContext(approved, state(), [], [], question, 'chat', [event()]), /not approved/);
  Object.assign(question, { status: 'approved', reviewer: 'test-reviewer', approved_at: '2026-10-22T00:00:00Z' });
  const fact = approved.facts.find(f => f.id === 'strategy_goal.signal')!;
  Object.assign(fact, { status: 'draft', reviewer: null, approved_at: null });
  assert.throws(() => buildChatContext({ lib: approved, state: state(), events: [], existingAnswers: [], currentQuestion: question, sourceEvents: [event()] }), /not approved/);
  const group = approved.answers.find(group => group.fact_id === 'strategy_goal.signal')!;
  Object.assign(group, { status: 'draft', reviewer: null, approved_at: null });
  Object.assign(fact, { status: 'approved', reviewer: 'test-reviewer', approved_at: '2026-10-22T00:00:00Z' });
  const context = buildChatContext({ lib: approved, state: state(), events: [], existingAnswers: [], currentQuestion: question, sourceEvents: [event()], allowedQuestionIds: [question.id] });
  assert.deepEqual(context.facts.map(f => f.id), ['strategy_goal.signal']);
  // The draft option group must not leak authored examples into approved input.
  assert.equal(context.allowed_answers[0].examples, undefined);
});

test('unmodeled facts cannot use example_schema, prose fields or a missing money schema as a type declaration', () => {
  for (const id of ['strategy_goal.details', 'strategy.history', 'strategy.impact', 'context.budget']) {
    const lib = structuredClone(library), original = lib.facts.find(fact => fact.id === id)!;
    const q = questionFor(id, lib), unmodeledId = `unmodeled.${id}`;
    original.id = unmodeledId; delete original.runtime_schema; q.fact_ids = [unmodeledId];
    const context = buildChatContext({ lib, state: state(), events: [], existingAnswers: [], currentQuestion: q, sourceEvents: [event()], allowDraft: true, allowedQuestionIds: [q.id] });
    const fact = context.facts.find(f => f.id === unmodeledId)!;
    assert.ok(fact); assert.equal(fact.states.includes('known'), false); assert.deepEqual(fact.value_schema, { type: 'null' });
    assert.throws(() => parseClassification(payload(unmodeledId, q.id, { invented: true }), context), ClassificationValidationError);
    assert.equal(parseClassification(payload(unmodeledId, q.id, event().text, 'other'), context).answers[0].state, 'other');
  }
});

test('does not manufacture option IDs for the real string-only context.model vocabulary', () => {
  const q = questionFor('context.model');
  const context = buildChatContext({ lib: library, state: state(), events: [], existingAnswers: [], currentQuestion: q, sourceEvents: [event()], allowDraft: true, allowedQuestionIds: [q.id] });
  assert.equal(context.facts[0].states.includes('known'), false);
  assert.equal(context.allowed_answers.length, 0);
});

test('identical option IDs in different facts are scoped by question and fact', () => {
  const a = questionFor('strategy_goal.signal'), b = questionFor('strategy_channels.signal');
  const context = buildChatContext({ lib: library, state: state(), events: [], existingAnswers: [], currentQuestion: a, sourceEvents: [event()], allowDraft: true, allowedQuestionIds: [a.id, b.id] });
  assert.ok(context.allowed_answers.filter(a => a.id === 'target').length >= 2);
  const result = parseClassification(payload('strategy_channels.signal', b.id, 'target', 'known', 'target'), context);
  assert.equal(result.answers[0].fact_id, 'strategy_channels.signal');
});

test('core supplied explicit field declarations support partials without invented default values', () => {
  const lib: AuditLibrary = structuredClone(library);
  const fact = lib.facts.find(f => f.id === 'strategy.impact')!;
  delete fact.runtime_schema;
  fact.fields = { description: 'string', level: ['low', 'high'] };
  const q = questionFor(fact.id, lib);
  const context = buildChatContext({ lib, state: state(), events: [], existingAnswers: [], currentQuestion: q, sourceEvents: [event()], allowDraft: true, allowedQuestionIds: [q.id] });
  const result = parseClassification(payload(fact.id, q.id, { description: 'срок и показатель не выбрали' }), context);
  assert.deepEqual(result.answers[0].value, { description: 'срок и показатель не выбрали' });
});

test('a typed answer to a screening question gets its option ID; a description drops parts it does not declare', () => {
  const screen = questionFor('ads_quality.signal');
  const screening = buildChatContext({ lib: library, state: state(), events: [], existingAnswers: [], currentQuestion: screen, sourceEvents: [event()] });
  const typed = parseClassification(payload('ads_quality.signal', screen.id, 'alternative'), screening);
  assert.equal(typed.answers[0].answer_id, 'alternative'); assert.equal(typed.answers[0].value, 'alternative');
  assert.throws(() => parseClassification(payload('ads_quality.signal', screen.id, 'invented'), screening), ClassificationValidationError);
  // crm_response.details declares object, observation and period; «context» from another description is dropped.
  const detail = questionFor('crm_response.details');
  const describing = buildChatContext({ lib: library, state: state(), events: [], existingAnswers: [], currentQuestion: detail, sourceEvents: [event()] });
  const part = (value: string) => ({ state: 'known', value });
  const sent = { object: part('Заявки с сайта'), observation: part('Первый звонок через 4–5 часов'), period: part('Сентябрь'), context: part('первый звонок клиенту') };
  const parsed = parseClassification(payload('crm_response.details', detail.id, sent), describing);
  assert.deepEqual(Object.keys(parsed.answers[0].value as object), ['object', 'observation', 'period']);
  assert.equal(Object.hasOwn(sent, 'context'), true, 'the caller object is not changed');
  assert.throws(() => parseClassification(payload('crm_response.details', detail.id, { context: part('только чужое поле') }), describing), ClassificationValidationError, 'nothing declared is left');
});

test('a button question joins the context only when asked or answered; free-text questions keep the external cause', () => {
  const goal = questionFor('context.goal'), funnel = questionFor('context.funnel');
  const asking = (current: typeof goal, existingAnswers: AuditAnswer[] = []) => buildChatContext({ lib: library, state: state(), events: [], existingAnswers, currentQuestion: current, sourceEvents: [event()] });
  const atGoal = asking(goal);
  assert.equal(atGoal.allowed_answers.length, 0, 'no options next to the goal question');
  assert(atGoal.questions.some(q => q.id === 'context_external_cause'));
  assert(asking(funnel).allowed_answers.some(a => a.question_id === 'context_funnel' && a.id === 'leads_not_converting'));
  const answered: AuditAnswer = { id: 'f-1', question_id: 'context_funnel', fact_id: 'context.funnel', state: 'known', value: 'few_leads', event_ids: ['old'], channel: 'chat', method: 'selection', confirmation: 'explicit', library_version: library.version, created_at: 1 };
  assert(asking(goal, [answered]).questions.some(q => q.id === 'context_funnel'), 'an answered button question can still be corrected');
});

test('only active same-version answers can be corrected', () => {
  const q = questionFor('strategy_goal.signal');
  const first: AuditAnswer = { id: 'old-1', question_id: q.id, fact_id: 'strategy_goal.signal', state: 'known', value: 'alternative', event_ids: ['old-event'], channel: 'chat', method: 'classification', confirmation: 'explicit', library_version: library.version, created_at: 0 };
  const second = { ...first, id: 'old-2', replaces_answer_id: 'old-1', value: 'target' };
  const context = buildChatContext({ lib: library, state: state(), events: [], existingAnswers: [first, second, { ...first, id: 'other-version', library_version: 'old-version' }], currentQuestion: q, sourceEvents: [event()], allowDraft: true });
  assert.deepEqual(context.correctable_answers.map(a => a.id), ['old-2']);
});

test('wrong library version, channel and assistant evidence are rejected before prompting', () => {
  const q = questionFor('strategy_goal.signal');
  const input = { lib: library, state: state(), events: [], existingAnswers: [], currentQuestion: q, sourceEvents: [event()], allowDraft: true };
  assert.throws(() => buildChatContext({ ...input, state: { ...state(), library_version: 'not-pinned' } }), /version mismatch/);
  assert.throws(() => buildChatContext({ ...input, sourceEvents: [{ ...event(), role: 'assistant' }] }), /source events/);
  assert.throws(() => buildChatContext({ ...input, sourceEvents: [{ ...event(), source: 'voice' }] }), /source events/);
  const context = buildChatContext({ ...input, mode: 'voice_recovery', sourceEvents: [{ ...event(), source: 'webhook' }] });
  assert.equal(context.mode, 'voice_recovery');
});
