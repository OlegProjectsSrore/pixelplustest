import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/d1.ts';
import { CoreServices } from '../src/core.ts';
import { createChatAdapter, createChatRuntime } from '../src/channel-runtime.ts';
import { initialAuditState, type AuditAnswer, type AuditEvent, type Json } from '../src/audit/contracts.ts';
import { advanceAudit } from '../src/audit/engine.ts';
import { library } from '../src/audit/library.ts';
import { hashToken, HttpError } from '../src/security.ts';
import type { Env } from '../src/env.ts';
import type { AdapterContext } from '../src/integration.ts';
import type { Classification, ClassifierContext } from '../src/chat/types.ts';
import { reserveDeepseekMicros } from '../src/deepseek-cost.ts';

const now = Date.parse('2026-10-22T20:00:00Z');
const bearer = 'a'.repeat(43);
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const intent = (kind: Classification['intent']): Classification => ({ intent: kind, answers: [], clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null });
function reportFromText(context: ClassifierContext, kind: 'answer' | 'mixed' = 'answer'): Classification {
  const source = context.source_events[0];
  return { ...intent(kind), answers: [{ question_id: 'context_name', fact_id: 'context.name', state: 'known', value: source.text!, event_ids: [source.id], evidence: [{ event_id: source.id, text: source.text! }] }] };
}
async function fixture(respond: (context: ClassifierContext, call: number) => unknown | Promise<unknown> = context => reportFromText(context)) {
  const db = new SqliteD1(); let calls = 0;
  const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true', DEEPSEEK_API_KEY: 'test-key', BUDGETS_JSON: JSON.stringify({ deepseek_usd_micros: 20_000_000, deepseek_calls: 20, deepseek_tokens: 2_000_000 }) };
  const core = new CoreServices(env, () => now, (async (_url, init) => {
    calls++;
    const request = JSON.parse(String(init?.body));
    const context = JSON.parse(request.messages[1].content) as ClassifierContext;
    const content = await respond(context, calls);
    return Response.json({ id: `provider-${calls}`, usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  }) as typeof fetch);
  const session = await core.store.createSession({ id: 'chat-session', tokenHash: await hashToken(bearer), reportId: 'report-1', reportTokenHash: await hashToken('report-token'), state: initialAuditState(library.version, 'chat', now), now });
  const handler = createChatAdapter();
  const request = new Request('https://example.test/api/chat', { method: 'POST', headers: { Authorization: `Bearer ${bearer}` } });
  const body = (operation = 'turn-1', revision = 0, input: Record<string, unknown> = { kind: 'text', text: 'Олег' }, question = 'context_name') => ({ api_version: '1', session_id: session.id, operation_id: operation, expected_revision: revision, channel_revision: 0, library_version: library.version, question_id: question, input });
  const context = (value: Record<string, unknown>): AdapterContext => ({ core, env, execution, body: value });
  return { db, core, env, session, request, body, context, handler, calls: () => calls };
}

test('chat text uses delivered evidence, becomes explicit written evidence and advances once', async () => {
  const f = await fixture();
  try {
    const body = f.body(), response = await f.handler(f.request, f.context(body));
    assert.equal((response as { kind: string }).kind, 'accepted');
    const answers = await f.core.store.listAnswers(f.session.id);
    assert.equal(answers.length, 1); assert.equal(answers[0].confirmation, 'explicit'); assert.equal(answers[0].method, 'classification');
    const session = await f.core.store.requireSession(f.session.id);
    assert.equal(session.state.current_question_id, 'context_position');
    const repeated = await f.handler(f.request, f.context(body));
    assert.equal((repeated as { kind: string }).kind, 'duplicate'); assert.equal(f.calls(), 1);
    const tokens = await f.core.store.getUsageReservation('deepseek_tokens:chat-session:turn-1:0');
    assert.equal(tokens?.state, 'settled'); assert.equal(tokens?.actual, 100);
    assert.equal((await f.core.store.getUsageReservation('deepseek_usd_micros:chat-session:turn-1:0'))?.actual, 48);
  } finally { f.db.close(); }
});

test('standard selection never calls the model and only accepts offered options', async () => {
  const f = await fixture();
  try {
    const event: AuditEvent = { id: 'seed-event', source: 'chat', source_key: 'seed', source_revision: 0, local_order: 0, role: 'user', kind: 'utterance', text: 'Сообщённый контекст', occurred_at: now, received_at: now };
    const seed: AuditAnswer[] = [ ['context.name', 'Олег'], ['context.position', 'Директор'], ['context.responsibilities', 'Продажи'], ['context.company_size', '50 сотрудников'], ['context.business', 'Магазин'], ['context.goal', 'Развитие'], ['context.assets', ['Сайт']] ].map(([id, value], i) => ({ id: `seed-${i}`, question_id: library.questions.find(question => question.fact_ids.includes(id as string))!.id, fact_id: id as string, state: 'known', value: value as Json, event_ids: [event.id], channel: 'chat', method: 'selection', confirmation: 'explicit', library_version: library.version, created_at: now }));
    await f.core.store.commit({ sessionId: f.session.id, operationId: 'seed', expectedRevision: 0, channelRevision: 0, event, answers: seed, state: advanceAudit(f.session.state, seed, now, library, { allowDraft: true }), now });
    const selected = f.body('selection-1', 1, { kind: 'selection', option_ids: ['strategy'] }, 'context_priority');
    await f.handler(f.request, f.context(selected));
    assert.equal(f.calls(), 0);
    assert.deepEqual((await f.core.store.listAnswers(f.session.id)).find(answer => answer.fact_id === 'context.priority')?.value, ['strategy']);
    await assert.rejects(() => f.handler(f.request, f.context({ ...selected, operation_id: 'invalid', expected_revision: 2, question_id: 'strategy_scope', input: { kind: 'selection', option_ids: ['invented'] } })), (error: unknown) => error instanceof HttpError && error.code === 'invalid_selection');
  } finally { f.db.close(); }
});

test('mixed facts and no-humor preference commit atomically without a joke', async () => {
  const f = await fixture(context => ({ ...reportFromText(context, 'mixed'), humor_preference: 'decline' }));
  try {
    await f.handler(f.request, f.context(f.body()));
    const session = await f.core.store.requireSession(f.session.id);
    assert.equal(session.state.revision, 1); assert.equal(session.state.humor.enabled, false);
    assert.equal(session.state.humor.reserved_ids.length, 0); assert.equal((await f.core.store.listAnswers(f.session.id)).length, 1);
    assert.equal((await f.core.store.listEvents(f.session.id)).length, 1);
  } finally { f.db.close(); }
});

test('off-topic replay keeps one reservation and a later turn selects another joke', async () => {
  const f = await fixture(() => ({ ...intent('off_topic'), joke_category_id: 'weather' }));
  try {
    const body = f.body();
    await f.handler(f.request, f.context(body)); await f.handler(f.request, f.context(body));
    let session = await f.core.store.requireSession(f.session.id);
    assert.deepEqual(session.state.humor.reserved_ids, ['weather_01']); assert.equal(f.calls(), 1);
    await f.handler(f.request, f.context(f.body('turn-2', 1)));
    session = await f.core.store.requireSession(f.session.id);
    assert.deepEqual(session.state.humor.reserved_ids, ['weather_01', 'weather_02']);
    assert.equal((await f.core.store.listAnswers(f.session.id)).length, 0);
  } finally { f.db.close(); }
});

test('old reserved usage cannot authorize another external request', async () => {
  const f = await fixture();
  try {
    await f.core.reserve('deepseek_calls', 1, 'chat-session:turn-1:0');
    await assert.rejects(() => f.handler(f.request, f.context(f.body())), (error: unknown) => error instanceof HttpError && ['provider_attempt_exists', 'operation_already_reserved'].includes(error.code));
    assert.equal(f.calls(), 0);
  } finally { f.db.close(); }
});

test('unknown provider outcomes retain tokens and are never retried under the same operation', async () => {
  const f = await fixture(() => { throw new Error('Network connection lost'); });
  try {
    await assert.rejects(() => f.handler(f.request, f.context(f.body())));
    assert.equal((await f.core.store.getUsageReservation('deepseek_tokens:chat-session:turn-1:0'))?.state, 'unknown');
    assert.equal((await f.core.store.getUsageReservation('deepseek_usd_micros:chat-session:turn-1:0'))?.state, 'unknown');
    await assert.rejects(() => f.handler(f.request, f.context(f.body())));
    assert.equal(f.calls(), 1); assert.equal((await f.core.store.listAnswers(f.session.id)).length, 0);
  } finally { f.db.close(); }
});

test('completed invalid output allows one separately metered retry', async () => {
  const f = await fixture((context, call) => call === 1 ? { invalid: true } : reportFromText(context));
  try {
    await f.handler(f.request, f.context(f.body()));
    assert.equal(f.calls(), 2);
    assert.equal((await f.core.store.getUsageReservation('deepseek_calls:chat-session:turn-1:1'))?.actual, 1);
    assert.equal((await f.core.store.listAnswers(f.session.id)).length, 1);
  } finally { f.db.close(); }
});

test('provider budget denial prevents fetch and releases the unused call reservation', async () => {
  const f = await fixture();
  try {
    f.env.BUDGETS_JSON = JSON.stringify({ deepseek_usd_micros: 20_000_000, deepseek_calls: 20, deepseek_tokens: 1 });
    await assert.rejects(() => f.handler(f.request, f.context(f.body())));
    assert.equal(f.calls(), 0);
    assert.equal((await f.core.store.getUsageReservation('deepseek_calls:chat-session:turn-1:0'))?.state, 'released');
  } finally { f.db.close(); }
});

test('pause and finish preserve the original request hash for idempotent chat replay', async () => {
  for (const action of ['pause', 'finish'] as const) {
    const f = await fixture(() => intent(action));
    try {
      const body = f.body(); await f.handler(f.request, f.context(body));
      const replay = await f.handler(f.request, f.context(body));
      assert.equal((replay as { kind: string }).kind, 'duplicate'); assert.equal(f.calls(), 1);
      const session = await f.core.store.requireSession(f.session.id);
      if (action === 'pause') assert.equal(session.state.paused, true); else assert.equal(session.state.status, 'closing');
    } finally { f.db.close(); }
  }
});

test('stale channel revision after an external call cannot commit its candidates', async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async context => {
    await f.core.store.pause({ sessionId: f.session.id, operationId: 'concurrent-pause', expectedRevision: 0, channelRevision: 0, now });
    return reportFromText(context);
  });
  try {
    await assert.rejects(() => f.handler(f.request, f.context(f.body())), (error: unknown) => error instanceof HttpError && error.code === 'revision_conflict');
    assert.equal((await f.core.store.listAnswers(f.session.id)).length, 0);
    assert.equal((await f.core.store.getUsageReservation('deepseek_tokens:chat-session:turn-1:0'))?.state, 'settled');
  } finally { f.db.close(); }
});

test('an authorized callback cannot be obtained with no fresh reservation', async () => {
  const f = await fixture();
  try {
    const runtime = await createChatRuntime(f.context(f.body()), f.session, 'runtime-test', 0);
    let executed = 0;
    await runtime.runAuthorized({ provider: 'deepseek', model: 'deepseek-flash', input_utf8_bytes: 100, max_tokens: 100 }, async () => { executed++; return { outcome: 'completed', status: 200, body: {}, usage: null, error: null }; });
    await assert.rejects(() => runtime.runAuthorized({ provider: 'deepseek', model: 'deepseek-flash', input_utf8_bytes: 100, max_tokens: 100 }, async () => { executed++; throw new Error('Should not execute'); }));
    assert.equal(executed, 1);
  } finally { f.db.close(); }
});

test('money limit is mandatory and denies fetch while releasing unused call/token holds', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  for (const [index, money] of [undefined, 1].entries()) {
    f.env.BUDGETS_JSON = JSON.stringify({ deepseek_calls: 20, deepseek_tokens: 2_000_000, deepseek_usd_micros: money });
    const operation = `denied-${index}`;
    const runtime = await createChatRuntime(f.context(f.body()), f.session, operation, 0);
    await assert.rejects(runtime.runAuthorized({ provider: 'deepseek', model: 'deepseek-flash', input_utf8_bytes: 1000, max_tokens: 4096 }, async () => { throw new Error('Must not reach provider'); }),
      (e: unknown) => e instanceof HttpError && ['budget_exhausted', 'budget_not_configured'].includes(e.code));
    assert.equal((await f.core.store.getUsageReservation(`deepseek_calls:chat-session:${operation}:0`))!.state, 'released');
    assert.equal((await f.core.store.getUsageReservation(`deepseek_tokens:chat-session:${operation}:0`))!.state, 'released');
  }
});

test('concurrent operations cannot collectively exceed dollar budget; missing usage retains the cost hold', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const input = { provider: 'deepseek' as const, model: 'deepseek-flash' as const, input_utf8_bytes: 1000, max_tokens: 4096 };
  const maximum = reserveDeepseekMicros(input);
  f.env.BUDGETS_JSON = JSON.stringify({ deepseek_calls: 20, deepseek_tokens: 2_000_000, deepseek_usd_micros: maximum });
  const runtimes = await Promise.all(['race-1', 'race-2'].map(operation => createChatRuntime(f.context(f.body()), f.session, operation, 0)));
  let requests = 0;
  const results = await Promise.allSettled(runtimes.map(runtime => runtime.runAuthorized(input, async () => {
    requests++; return { outcome: 'completed', status: 200, body: {}, usage: null, error: null };
  })));
  assert.equal(requests, 1); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const row = f.db.sqlite.prepare("SELECT used,reserved FROM usage_counters WHERE kind='deepseek_usd_micros'").get()!;
  assert.equal(row.used, 0); assert.equal(row.reserved, maximum);
});

test('usage arriving after UTC midnight settles the original day without consuming the next day', async t => {
  const f = await fixture(); t.after(() => f.db.close()); let time = now;
  const core = new CoreServices(f.env, () => time);
  const context = { ...f.context(f.body()), core };
  const input = { provider: 'deepseek' as const, model: 'deepseek-flash' as const, input_utf8_bytes: 1000, max_tokens: 4096 };
  const runtime = await createChatRuntime(context, f.session, 'midnight', 0);
  await runtime.runAuthorized(input, async () => {
    time += 86400000;
    return { outcome: 'completed', status: 200, body: {}, usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, error: null };
  });
  const rows = f.db.sqlite.prepare("SELECT period,used,reserved FROM usage_counters WHERE kind='deepseek_usd_micros'").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].period, '2026-10-22'); assert.equal(rows[0].used, 48); assert.equal(rows[0].reserved, 0);
});

const worded = { reply: 'Приятно познакомиться, Олег.', question: 'Подскажите, какую должность Вы занимаете в компании?' };
const composing = (answer: unknown = worded) => (context: ClassifierContext) => 'next_question' in context ? answer : reportFromText(context);

test('with the composer on, DeepSeek words the reaction and the next question after classification', async () => {
  const seen: Record<string, Json>[] = [];
  const f = await fixture(context => { if ('next_question' in context) seen.push(context as unknown as Record<string, Json>); return composing()(context); });
  f.env.CHAT_COMPOSER_ENABLED = 'true';
  try {
    const body = f.body(), response = await f.handler(f.request, f.context(body)) as { operation: Record<string, Json> };
    assert.equal(response.operation.text, worded.reply); assert.equal(response.operation.question_id, 'context_position');
    assert.equal(response.operation.question_text, worded.question);
    assert.equal(f.calls(), 2); assert.equal(seen[0].visitor_message, 'Олег');
    const next = seen[0].next_question as { text: string };
    assert.equal(next.text, library.questions.find(question => question.id === 'context_position')!.chat);
    assert.equal((await f.core.store.getUsageReservation('deepseek_calls:chat-session:turn-1:2'))?.actual, 1);
    const answerEvent = (await f.core.store.listEvents(f.session.id, 0, 100)).find(event => event.text === 'Олег');
    assert.equal(JSON.stringify(answerEvent?.data ?? null).includes(worded.reply), false, 'the reaction does not rewrite the answer event');
    const replay = await f.handler(f.request, f.context(body)) as { kind: string; operation: Record<string, Json> };
    assert.equal(replay.kind, 'duplicate'); assert.equal(replay.operation.question_text, worded.question); assert.equal(f.calls(), 2);
  } finally { f.db.close(); }
});

test('wording that fails the code checks falls back to library texts without blocking the answer', async () => {
  const f = await fixture(composing({ reply: 'Советую тариф «Старт».', question: 'Должность' }));
  f.env.CHAT_COMPOSER_ENABLED = 'true';
  try {
    const response = await f.handler(f.request, f.context(f.body())) as { operation: Record<string, Json> };
    assert.equal(response.operation.text, null); assert.equal(response.operation.question_text, null);
    assert.equal(response.operation.question_id, 'context_position'); assert.equal((await f.core.store.listAnswers(f.session.id)).length, 1);
  } finally { f.db.close(); }
});

test('a selected option gets a worded next question with exactly one model call', async () => {
  const f = await fixture(composing({ reply: '', question: 'Какое направление сейчас для Вас главное?' }));
  f.env.CHAT_COMPOSER_ENABLED = 'true';
  try {
    const event: AuditEvent = { id: 'seed-event', source: 'chat', source_key: 'seed', source_revision: 0, local_order: 0, role: 'user', kind: 'utterance', text: 'Сообщённый контекст', occurred_at: now, received_at: now };
    const seed: AuditAnswer[] = [ ['context.name', 'Олег'], ['context.position', 'Директор'], ['context.responsibilities', 'Продажи'], ['context.company_size', '50 сотрудников'], ['context.business', 'Магазин'], ['context.goal', 'Развитие'], ['context.assets', ['Сайт']] ].map(([id, value], i) => ({ id: `seed-${i}`, question_id: library.questions.find(question => question.fact_ids.includes(id as string))!.id, fact_id: id as string, state: 'known', value: value as Json, event_ids: [event.id], channel: 'chat', method: 'selection', confirmation: 'explicit', library_version: library.version, created_at: now }));
    await f.core.store.commit({ sessionId: f.session.id, operationId: 'seed', expectedRevision: 0, channelRevision: 0, event, answers: seed, state: advanceAudit(f.session.state, seed, now, library, { allowDraft: true }), now });
    const response = await f.handler(f.request, f.context(f.body('selection-1', 1, { kind: 'selection', option_ids: ['strategy'] }, 'context_priority'))) as { operation: Record<string, Json> };
    assert.equal(f.calls(), 1); assert.equal(response.operation.text, null);
    assert.equal(response.operation.question_text, 'Какое направление сейчас для Вас главное?');
  } finally { f.db.close(); }
});
