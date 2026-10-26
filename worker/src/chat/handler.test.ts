import assert from 'node:assert/strict';
import test from 'node:test';
import { initialAuditState, INTERVIEW_BUDGET_MS, type AuditAnswer, type AuditEvent, type AuditState, type Json } from '../audit/contracts.ts';
import { deriveFacts, nextQuestion, validateAnswers } from '../audit/engine.ts';
import { library } from '../audit/library.ts';
import type { AdapterContext } from '../integration.ts';
import type { StoredSession } from '../storage/types.ts';
import { HttpError, requestHash } from '../security.ts';
import { createChatHandler, type ChatHandlerDependencies, type PreparedChatTurn } from './handler.ts';
import type { Classification, ClassifierContext, ProviderExchange } from './types.ts';

const NOW = 10000;
const TOKEN = 'a'.repeat(43);
type Provider = (context: ClassifierContext, count: number) => unknown | Promise<unknown>;
const classification = (intent: Classification['intent'] = 'unknown'): Classification => ({ intent, answers: [], clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null });
const response = (content: unknown) => ({ id: 'provider-1', choices: [{ finish_reason: 'stop', message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } });

function candidate(ctx: ClassifierContext, factId = 'context.business', value: Json = 'Продаём мебель') {
  const question = ctx.questions.find(q => q.fact_ids.includes(factId)); assert.ok(question);
  const source = ctx.source_events[0]; assert.ok(source?.text);
  const option = ctx.allowed_answers.find(a => a.question_id === question.id && a.fact_id === factId && a.value === value);
  return { question_id: question.id, fact_id: factId, state: 'known' as const, value, ...(option ? { answer_id: option.id } : {}), event_ids: [source.id], evidence: [{ event_id: source.id, text: source.text }] };
}

function setup(provider: Provider = () => classification(), configure?: (state: AuditState) => void) {
  const state = initialAuditState(library.version, 'chat', NOW);
  state.revision = 3; state.channel_revision = 2; configure?.(state);
  const session: StoredSession = { id: 'session-1', tokenHash: 'not-used-by-stub', createdAt: NOW, accessExpiresAt: NOW + 86400000, state, activeCallId: null, reportId: 'report-1', closedAt: null };
  const counters = { auth: 0, runtime: [] as number[], fetch: 0, commit: 0, views: 0, meters: [] as ProviderExchange[] };
  const saved: { turn: PreparedChatTurn | null; previous: { requestHash: string | null; result: Json; event?: AuditEvent } | null; answers: AuditAnswer[]; events: AuditEvent[] } = { turn: null, previous: null, answers: [], events: [] };
  let clock = NOW;
  const fakeCore = {
    now: () => clock,
    engineOptions: { allowDraft: true },
    authenticate: async (request: Request, id: string) => {
      counters.auth++;
      if (request.headers.get('Authorization') !== `Bearer ${TOKEN}` || id !== session.id || session.accessExpiresAt <= clock) throw new HttpError(401, 'unauthorized', 'Нет доступа');
      return structuredClone(session);
    },
    store: {
      getOperation: async () => saved.previous,
      listAnswers: async () => saved.answers,
      listEvents: async () => saved.events,
    },
    view: async () => { counters.views++; return { revision: session.state.revision, status: session.state.status }; },
    accept: async () => { throw new Error('Handler must use atomic commitTurn instead of direct core.accept'); },
  };
  const dependencies: ChatHandlerDependencies = {
    runtime: async (_context, _session, _operation, attempt) => {
      counters.runtime.push(attempt);
      return {
        api_key: 'fake-provider-key', max_tokens: 2048, timeout_ms: 1000,
        fetch: async (_url, init) => {
          counters.fetch++;
          const body = JSON.parse(init?.body as string);
          const ctx = JSON.parse(body.messages[1].content) as ClassifierContext;
          const value = await provider(ctx, counters.fetch);
          return value instanceof Response ? value : new Response(JSON.stringify(response(value)));
        },
        runAuthorized: async (_request, call) => { const result = await call(); counters.meters.push(result); return result; },
      };
    },
    commitTurn: async (_request, _context, _session, turn) => {
      // The stub checks the actual core validator, without claiming to emulate a D1 transaction.
      validateAnswers(turn.answers, [...saved.events, turn.event], saved.answers, library, { allowDraft: true });
      counters.commit++; saved.turn = structuredClone(turn);
      return { kind: 'accepted', action: turn.action };
    },
  };
  const question = () => nextQuestion(session.state, clock, library, { allowDraft: true });
  const body = (input: Record<string, unknown> = { kind: 'text', text: 'Продаём мебель' }) => ({ api_version: '1', session_id: session.id, operation_id: 'operation-1', expected_revision: session.state.revision, channel_revision: session.state.channel_revision, library_version: library.version, question_id: question()?.id ?? null, input });
  const execute = (data: Record<string, unknown> = body(), token = TOKEN) => {
    const request = new Request('https://worker.example/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    const ctx = { core: fakeCore, env: { ALLOW_DRAFT_LIBRARY: 'true' }, execution: {}, body: data, session: { id: 'forged-session' } } as unknown as AdapterContext;
    return createChatHandler(dependencies)(request, ctx);
  };
  return { session, counters, saved, dependencies, question, body, execute, setTime: (now: number) => { clock = now; } };
}
async function rejectsCode(run: Promise<unknown>, code: string) {
  await assert.rejects(run, error => error instanceof HttpError && error.code === code);
}
function enumState(state: AuditState) {
  for (const id of library.scenario.mandatory_entry_questions ?? []) {
    const fact = library.questions.find(question => question.id === id)!.fact_ids[0];
    state.facts[fact] = { fact_id: fact, state: 'known', value: 'recorded', confirmation: 'explicit', answer_ids: [`prior-${fact}`] };
  }
  state.facts['strategy_goal.signal'] = { fact_id: 'strategy_goal.signal', state: 'known', value: 'target', confirmation: 'unconfirmed', answer_ids: ['prior'] };
}

test('standard enum selection validates against real library and never calls runtime/LLM', async () => {
  const harness = setup(undefined, enumState);
  assert.ok(harness.question()?.fact_ids.includes('strategy_goal.signal'));
  await harness.execute(harness.body({ kind: 'selection', option_ids: ['target'] }));
  assert.equal(harness.counters.fetch, 0); assert.deepEqual(harness.counters.runtime, []); assert.equal(harness.counters.commit, 1);
  const turn = harness.saved.turn!;
  assert.equal(turn.classification, null); assert.equal(turn.answers[0].confirmation, 'explicit'); assert.equal(turn.answers[0].method, 'selection');
  assert.equal(turn.answers[0].value, 'target'); assert.equal(turn.event.kind, 'answer');
  assert.deepEqual(turn.event.data, { question_id: harness.question()!.id, option_ids: ['target'] });
  assert.equal(turn.request_hash, await requestHash(harness.body({ kind: 'selection', option_ids: ['target'] })));
});

test('priority selection is one factual list and does not invent a diagnosis', async () => {
  const harness = setup(undefined, state => {
    for (const qid of library.scenario.entry_questions) {
      if (qid === 'context_priority') continue;
      for (const id of library.questions.find(q => q.id === qid)!.fact_ids) state.facts[id] = { fact_id: id, state: 'known', value: 'recorded', answer_ids: ['existing'], confirmation: 'explicit' };
    }
  });
  assert.equal(harness.question()?.id, 'context_priority');
  const id = library.domains[0].id;
  await harness.execute(harness.body({ kind: 'selection', option_ids: [id] }));
  assert.equal(harness.counters.fetch, 0); assert.deepEqual(harness.saved.turn!.answers[0].value, [id]); assert.equal(harness.saved.turn!.answers[0].fact_id, 'context.priority');
  await rejectsCode(harness.execute(harness.body({ kind: 'selection', option_ids: [id, id] })), 'invalid_selection');
});

test('HTTP handler commits all selected priority IDs and labels without a scalar answer ID or LLM call', async () => {
  const harness = setup(undefined, state => {
    for (const qid of library.scenario.entry_questions) {
      if (qid === 'context_priority') continue;
      for (const id of library.questions.find(q => q.id === qid)!.fact_ids) state.facts[id] = { fact_id: id, state: 'known', value: 'recorded', answer_ids: ['existing'], confirmation: 'explicit' };
    }
  });
  const question = harness.question(); assert.equal(question?.id, 'context_priority');
  const selected = question!.options.slice(0, 2); assert.equal(selected.length, 2);
  const optionIds = selected.map(option => option.id);
  const result = await harness.execute(harness.body({ kind: 'selection', option_ids: optionIds }));
  assert.deepEqual(result, { kind: 'accepted', action: 'answer' });
  assert.equal(harness.counters.fetch, 0); assert.deepEqual(harness.counters.runtime, []); assert.equal(harness.counters.commit, 1);
  const turn = harness.saved.turn!;
  assert.equal(turn.classification, null); assert.equal(turn.answers.length, 1);
  assert.equal(turn.answers[0].fact_id, 'context.priority'); assert.deepEqual(turn.answers[0].value, optionIds);
  assert.equal(turn.answers[0].answer_id, undefined); assert.equal(turn.answers[0].confirmation, 'explicit');
  assert.equal(turn.event.kind, 'answer'); assert.equal(turn.event.text, selected.map(option => option.text).join(', '));
  assert.deepEqual(turn.event.data, { question_id: 'context_priority', option_ids: optionIds });
});

test('bad selections and mutually exclusive input fields fail without a provider call', async () => {
  for (const input of [{ kind: 'selection', option_ids: ['invented'] }, { kind: 'selection', option_ids: ['target', 'alternative'] }, { kind: 'selection', option_ids: ['target'], text: 'unexpected' }]) {
    const harness = setup(undefined, enumState);
    await assert.rejects(harness.execute(harness.body(input)), HttpError);
    assert.equal(harness.counters.fetch, 0); assert.equal(harness.counters.commit, 0);
  }
  for (const input of [{ kind: 'text', text: '' }, { kind: 'text', text: ' ' }, { kind: 'text', text: 'x'.repeat(10001) }, { kind: 'text', text: 'valid', option_ids: [] }, { kind: 'text', text: 'valid', answers: [] }, { kind: 'invented', text: 'valid' }]) {
    const harness = setup(); await assert.rejects(harness.execute(harness.body(input)), HttpError);
    assert.equal(harness.counters.fetch, 0); assert.equal(harness.counters.commit, 0);
  }
});

test('auth does not trust context.session and fails before history, runtime or provider', async () => {
  const harness = setup(); await rejectsCode(harness.execute(harness.body(), 'invalid'), 'unauthorized');
  assert.equal(harness.counters.auth, 1); assert.equal(harness.counters.fetch, 0); assert.deepEqual(harness.counters.runtime, []); assert.equal(harness.counters.commit, 0);
});

test('revision, pinned version, question, channel, closed session and time failures precede provider', async () => {
  const cases: [string, (h: ReturnType<typeof setup>, body: Record<string, unknown>) => void][] = [
    ['revision_conflict', (_h, b) => { b.expected_revision = 0; }],
    ['revision_conflict', (_h, b) => { b.channel_revision = 0; }],
    ['library_mismatch', (_h, b) => { b.library_version = 'different'; }],
    ['question_conflict', (_h, b) => { b.question_id = 'different-question'; }],
    ['channel_conflict', h => { h.session.state.active_channel = 'voice'; }],
    ['interview_closed', h => { h.session.state.status = 'closing'; }],
    ['time_limit', h => { h.session.state.elapsed_ms = INTERVIEW_BUDGET_MS; }],
    ['unauthorized', h => { h.session.accessExpiresAt = NOW; }],
  ];
  for (const [code, modify] of cases) {
    const harness = setup(), body = harness.body(); modify(harness, body);
    await rejectsCode(harness.execute(body), code);
    assert.equal(harness.counters.fetch, 0, code); assert.deepEqual(harness.counters.runtime, [], code); assert.equal(harness.counters.commit, 0, code);
  }
});

test('replay compares the request body and returns its prior result before current revision/channel checks', async () => {
  const harness = setup(); const body = harness.body();
  harness.saved.previous = { requestHash: await requestHash(body), result: { original: true } };
  harness.session.state.revision++; harness.session.state.active_channel = 'voice'; harness.session.state.status = 'closing';
  const result = await harness.execute(body) as Record<string, unknown>;
  assert.equal(result.kind, 'duplicate'); assert.deepEqual(result.operation, { original: true }); assert.equal(harness.counters.fetch, 0); assert.equal(harness.counters.commit, 0);
  await rejectsCode(harness.execute({ ...body, input: { kind: 'text', text: 'changed body' } }), 'operation_reused');
  assert.equal(harness.counters.fetch, 0);
});

test('mixed reply preserves sourced facts and approved FAQ in one atomic commit without a joke', async () => {
  const harness = setup(ctx => ({ ...classification('mixed'), answers: [candidate(ctx)], faq_id: 'duration' }));
  harness.dependencies.context = async () => ({ faqs: [{ id: 'duration', question: 'Сколько времени?', answer: 'Опрос ограничен 15 минутами.' }] });
  await harness.execute(harness.body({ kind: 'text', text: 'Продаём мебель. Сколько времени займёт опрос?' }));
  assert.equal(harness.counters.fetch, 1); assert.equal(harness.counters.commit, 1);
  const turn = harness.saved.turn!;
  assert.equal(turn.action, 'answer'); assert.equal(turn.service_text, 'Опрос ограничен 15 минутами.'); assert.equal(turn.answers.length, 1);
  assert.equal(turn.answers[0].confirmation, 'unconfirmed'); assert.equal(Object.hasOwn(turn.answers[0], 'evidence'), false);
  assert.equal(turn.classification?.answers[0].evidence[0].event_id, turn.event.id); assert.equal(turn.classification?.joke_category_id, null);
});

test('decline with an evidenced candidate is preserved; intent-only decline never fabricates facts', async () => {
  const supplied = setup(ctx => ({ ...classification('decline'), answers: [{ ...candidate(ctx), state: 'declined', value: null }] }));
  await supplied.execute(supplied.body({ kind: 'text', text: 'Не хочу отвечать на этот вопрос.' }));
  assert.equal(supplied.saved.turn!.answers.length, 1); assert.equal(supplied.saved.turn!.answers[0].state, 'declined');
  const intentOnly = setup(() => classification('decline'));
  await intentOnly.execute(intentOnly.body({ kind: 'text', text: 'Пока не хочу.' }));
  assert.deepEqual(intentOnly.saved.turn!.answers, []); assert.equal(intentOnly.saved.turn!.action, 'clarify'); assert.ok(intentOnly.saved.turn!.service_text);
});

test('pause, resume and finish are core actions without synthetic answers or next questions', async () => {
  for (const intent of ['pause', 'resume', 'finish'] as const) {
    const harness = setup(() => classification(intent), state => { if (intent === 'resume') { state.paused = true; state.active_since = null; } });
    await harness.execute();
    assert.equal(harness.saved.turn!.action, intent); assert.deepEqual(harness.saved.turn!.answers, []); assert.equal(harness.saved.turn!.service_text, null); assert.equal(harness.counters.commit, 1);
  }
  const pausedFinish = setup(() => classification('finish'), state => { state.paused = true; state.active_since = null; });
  await pausedFinish.execute(); assert.equal(pausedFinish.saved.turn!.action, 'finish');
  const pausedAnswer = setup(ctx => ({ ...classification('answer'), answers: [candidate(ctx)] }), state => { state.paused = true; state.active_since = null; });
  await rejectsCode(pausedAnswer.execute(), 'session_paused'); assert.equal(pausedAnswer.counters.commit, 0);
});

test('off-topic and humor preference reach the atomic service handler, without choosing joke text', async () => {
  const harness = setup(ctx => ({ ...classification('off_topic'), joke_category_id: ctx.joke_categories[0].id }));
  await harness.execute(); assert.equal(harness.saved.turn!.action, 'off_topic'); assert.deepEqual(harness.saved.turn!.answers, []); assert.equal(harness.saved.turn!.service_text, null);
  const preference = setup(() => ({ ...classification('humor_preference'), humor_preference: 'decline' }));
  await preference.execute(); assert.equal(preference.saved.turn!.classification!.humor_preference, 'decline'); assert.deepEqual(preference.saved.turn!.answers, []);
});

test('invalid completed output permits exactly one separately metered retry', async () => {
  const recovered = setup((ctx, count) => count === 1 ? '{invalid-json' : { ...classification('answer'), answers: [candidate(ctx)] });
  await recovered.execute(); assert.deepEqual(recovered.counters.runtime, [0, 1]); assert.equal(recovered.counters.fetch, 2); assert.equal(recovered.counters.meters.length, 2); assert.equal(recovered.saved.turn!.answers.length, 1);
  const exhausted = setup(() => ({ unsupported: true }));
  await exhausted.execute(); assert.deepEqual(exhausted.counters.runtime, [0, 1]); assert.equal(exhausted.counters.fetch, 2); assert.equal(exhausted.counters.commit, 1);
  assert.equal(exhausted.saved.turn!.action, 'clarify'); assert.deepEqual(exhausted.saved.turn!.answers, []); assert.ok(exhausted.saved.turn!.service_text);
});

test('network and HTTP provider failures never retry or commit fabricated results', async () => {
  for (const provider of [() => { throw new Error('connection lost'); }, () => new Response('private provider error', { status: 503 }), () => new Response('rate limited', { status: 429 })]) {
    const harness = setup(provider);
    await rejectsCode(harness.execute(), 'provider_unavailable');
    assert.deepEqual(harness.counters.runtime, [0]); assert.equal(harness.counters.fetch, 1); assert.equal(harness.counters.commit, 0);
  }
});

test('provider timeout does not retry and keeps uncertain spend in the metering callback', async () => {
  const harness = setup(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('\n')); } })));
  const original = harness.dependencies.runtime;
  harness.dependencies.runtime = async (...args) => ({ ...await original(...args), timeout_ms: 10 });
  await rejectsCode(harness.execute(), 'provider_timeout');
  assert.deepEqual(harness.counters.runtime, [0]); assert.equal(harness.counters.commit, 0); assert.equal(harness.counters.meters[0].outcome, 'unknown'); assert.equal(harness.counters.meters[0].usage, null);
});

test('content filtering uses a safe clarification without a repeated provider attempt', async () => {
  const filtered = response(''); filtered.choices[0].finish_reason = 'content_filter';
  const harness = setup(() => new Response(JSON.stringify(filtered)));
  await harness.execute(); assert.deepEqual(harness.counters.runtime, [0]); assert.equal(harness.saved.turn!.action, 'clarify'); assert.deepEqual(harness.saved.turn!.answers, []);
});

test('time and revision are checked again before a second external attempt', async () => {
  for (const change of ['time', 'revision'] as const) {
    const harness = setup(() => {
      if (change === 'time') harness.session.state.elapsed_ms = INTERVIEW_BUDGET_MS; else harness.session.state.revision++;
      return '{invalid-json';
    });
    await rejectsCode(harness.execute(), change === 'time' ? 'time_limit' : 'revision_conflict');
    assert.deepEqual(harness.counters.runtime, [0]); assert.equal(harness.counters.fetch, 1); assert.equal(harness.counters.commit, 0);
  }
});

test('slow chat preparation does not consume voice time', async () => {
  const slowContext = setup();
  slowContext.dependencies.context = async () => { slowContext.setTime(NOW + INTERVIEW_BUDGET_MS); return {}; };
  await slowContext.execute();
  assert.deepEqual(slowContext.counters.runtime, [0]); assert.equal(slowContext.counters.fetch, 1);
  const slowRuntime = setup(), original = slowRuntime.dependencies.runtime;
  slowRuntime.dependencies.runtime = async (...args) => { const runtime = await original(...args); slowRuntime.setTime(NOW + INTERVIEW_BUDGET_MS); return runtime; };
  await slowRuntime.execute();
  assert.deepEqual(slowRuntime.counters.runtime, [0]); assert.equal(slowRuntime.counters.fetch, 1); assert.equal(slowRuntime.counters.commit, 1);
});

test('a concurrent completed operation is replayed before the second provider attempt', async () => {
  const harness = setup(async () => { harness.saved.previous = { requestHash: await requestHash(body), result: { winner: true } }; return '{invalid-json'; });
  const body = harness.body();
  const result = await harness.execute(body) as Record<string, unknown>;
  assert.equal(result.kind, 'duplicate'); assert.deepEqual(result.operation, { winner: true }); assert.equal(harness.counters.fetch, 1); assert.equal(harness.counters.commit, 0);
});

test('atomic commitTurn is mandatory at construction; its conflict is propagated without partial writes', async () => {
  assert.throws(() => createChatHandler({ runtime: async () => { throw new Error('should not execute'); } } as unknown as ChatHandlerDependencies), /atomic commitTurn/);
  const harness = setup(ctx => ({ ...classification('answer'), answers: [candidate(ctx)] }));
  harness.dependencies.commitTurn = async () => { throw new HttpError(409, 'revision_conflict', 'Concurrent change'); };
  await rejectsCode(harness.execute(), 'revision_conflict'); assert.equal(harness.counters.fetch, 1); assert.equal(harness.saved.turn, null);
});

test('budget denial makes zero provider calls and performs no commit', async () => {
  const harness = setup(); const original = harness.dependencies.runtime;
  harness.dependencies.runtime = async (...args) => ({ ...await original(...args), runAuthorized: async () => { throw new HttpError(429, 'budget_exhausted', 'No budget'); } });
  await rejectsCode(harness.execute(), 'budget_exhausted'); assert.equal(harness.counters.fetch, 0); assert.equal(harness.counters.commit, 0);
});

test('LLM statements remain unconfirmed, and real engine requests confirmation before using them', async () => {
  const harness = setup(ctx => ({ ...classification('answer'), answers: [candidate(ctx)] }));
  await harness.execute(); const turn = harness.saved.turn!;
  assert.equal(turn.answers[0].confirmation, 'unconfirmed');
  const derived = deriveFacts(turn.answers);
  const state = { ...harness.session.state, ...derived };
  for (const id of library.scenario.mandatory_entry_questions ?? []) {
    const fact = library.questions.find(question => question.id === id)!.fact_ids[0];
    state.facts[fact] = { fact_id: fact, state: 'known', value: 'recorded', confirmation: 'explicit', answer_ids: [`prior-${fact}`] };
  }
  const question = nextQuestion(state, NOW, library, { allowDraft: true });
  assert.equal(question?.id, turn.answers[0].question_id); assert.match(question!.text, /верно ли записаны сведения/);
  // This test does not fabricate a text-confirmation hook: the core must provide it.
});

test('explicit standard selection confirms the same previously unconfirmed enum value', async () => {
  const harness = setup(undefined, enumState), question = harness.question()!;
  const old: AuditAnswer = { id: 'prior', question_id: question.id, fact_id: 'strategy_goal.signal', state: 'known', value: 'target', event_ids: ['old-event'], channel: 'chat', method: 'classification', confirmation: 'unconfirmed', library_version: library.version, created_at: 1 };
  harness.saved.answers = [old];
  await harness.execute(harness.body({ kind: 'selection', option_ids: ['target'] }));
  const derived = deriveFacts([old, ...harness.saved.turn!.answers]);
  assert.equal(derived.facts['strategy_goal.signal'].confirmation, 'explicit'); assert.deepEqual(derived.contradictions, []);
});
