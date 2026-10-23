import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { CoreServices } from '../src/core.ts';
import { createVoiceAdapters, normalizeVoiceAnswers, type VoiceBridgeOptions } from '../src/channel-voice.ts';
import { initialAuditState, type AuditEvent, type Json } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { hashToken, HttpError } from '../src/security.ts';
import type { AdapterContext, AdapterHandler } from '../src/integration.ts';
import type { Env } from '../src/env.ts';
import type { VoiceAnswerCandidate } from '../src/voice/types.ts';
import { SqliteD1 } from './helpers/d1.ts';
import { voiceConfigHash } from '../src/voice-accounts.ts';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const PROVIDER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'a'.repeat(43), JOIN = 'wss://voice.example/connect?token=secret-test-only';
const obj = (value: unknown) => value as Record<string, any>;
const code = (expected: string) => (error: unknown) => error instanceof HttpError && error.code === expected;
const rawCall = (ended: number | null = null) => ({ callId: PROVIDER_ID, created: new Date(NOW).toISOString(), joined: new Date(NOW).toISOString(), ended: ended === null ? null : new Date(ended).toISOString(), endReason: ended === null ? null : 'hangup', billedDuration: null, billingStatus: 'BILLING_STATUS_PENDING', joinUrl: JOIN });

async function fixture(options: VoiceBridgeOptions = {}) {
  const db = new SqliteD1(); let now = NOW;
  const requests: { url: string; init?: RequestInit }[] = [], tasks: Promise<unknown>[] = [];
  let respond: (url: string, init?: RequestInit) => Promise<Response> | Response = (_url, init) => Response.json(rawCall(), { status: init?.method === 'POST' ? 201 : 200 });
  const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true',
    PUBLIC_WORKER_URL: 'https://worker.example', ULTRAVOX_KEY_1: 'test-private-key', ULTRAVOX_MODEL: 'approved-model', ULTRAVOX_VOICE: 'approved-voice',
    ULTRAVOX_WEBHOOK_SECRET: 'test-signing-secret', VOICE_REPLAY_SECRET: Buffer.alloc(32, 3).toString('base64url'),
    BUDGETS_JSON: JSON.stringify({ voice_starts: 20, voice_seconds: 10000 }) };
  const core = new CoreServices(env, () => now, (async (url, init) => { requests.push({ url: String(url), init }); return respond(String(url), init); }) as typeof fetch);
  const state = initialAuditState(library.version, 'voice', now); state.current_question_id = 'context_business';
  await core.store.createSession({ id: 'session-1', tokenHash: await hashToken(TOKEN), reportId: 'report-1', reportTokenHash: 'read-hash', state, now });
  await core.store.updateVoiceSlot({ id: '1', availableMs: 900_000, maxConcurrency: 1, now });
  await db.prepare('UPDATE ultravox_slots SET config_hash=? WHERE id=?').bind(await voiceConfigHash(core, '1'), '1').run();
  const adapters = createVoiceAdapters({ refreshAccounts: async () => {}, ...options });
  const request = () => new Request('https://worker.example/api/voice/test', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
  const context = (body?: Record<string, unknown>): AdapterContext => ({ core, env, body, execution: { waitUntil(promise: Promise<unknown>) { tasks.push(promise); } } as ExecutionContext });
  const body = async (operation: string, extra: Record<string, unknown> = {}) => { const session = await core.store.requireSession('session-1'); return { session_id: session.id, operation_id: operation,
    expected_revision: session.state.revision, channel_revision: session.state.channel_revision, library_version: library.version, ...extra }; };
  const invoke = async (handler: AdapterHandler, payload: Record<string, unknown>) => obj(await handler(request(), context(payload)));
  const start = async (operation = 'start-1') => invoke(adapters.voiceStart!, await body(operation));
  const transcript = async (callId: string, operation: string, lines: { text: string; role?: 'user' | 'assistant'; order: number; revision?: number; final?: boolean }[]) => invoke(adapters.voiceTranscript!, await body(operation, { call_id: callId, events: lines.map(line => ({
    id: `client:${callId}:${line.order}`, source: 'voice', source_key: `${callId}:${line.order}`, source_revision: line.revision ?? 0,
    local_order: line.order, call_id: callId, role: line.role ?? 'user', kind: 'utterance', text: line.text,
    occurred_at: now, data: { is_final: line.final ?? true, medium: 'voice' },
  })) }));
  return { db, core, env, adapters, requests, tasks, request, context, body, invoke, start, transcript,
    tick: (milliseconds: number) => { now = NOW + milliseconds; }, respond: (handler: typeof respond) => { respond = handler; } };
}

test('voice start requires explicit configuration and a fresh verified slot before any provider request', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  delete f.env.VOICE_REPLAY_SECRET;
  await assert.rejects(f.start(), code('not_configured'));
  f.env.VOICE_REPLAY_SECRET = Buffer.alloc(32, 3).toString('base64url');
  f.db.sqlite.prepare('UPDATE ultravox_slots SET checked_at=?').run(NOW - 301000);
  await assert.rejects(f.start(), code('voice_unavailable'));
  assert.equal(f.requests.length, 0);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM usage_reservations').get()!.n, 0);
});

test('production voice start refreshes account, validates shared voice/model, and creates only after reservation', async t => {
  const f = await fixture({ refreshAccounts: undefined }); t.after(() => f.db.close());
  f.env.ULTRAVOX_VOICE = '83b2a94f-8078-4321-935c-a0798b2ac621';
  f.respond((url, init) => {
    if (url.includes('/voices/')) return Response.json({ voiceId: f.env.ULTRAVOX_VOICE, billingStyle: 'VOICE_BILLING_STYLE_INCLUDED' });
    if (url.includes('/models')) return Response.json({ results: [{ name: 'approved-model' }], next: null });
    if (url.includes('/accounts/me')) return Response.json({ accountId: PROVIDER_ID, freeTimeRemaining: '1800s', activeCalls: 0, allowedConcurrentCalls: 2 });
    assert.equal(init?.method, 'POST');
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM ultravox_calls WHERE status='reserved'").get()!.n, 1);
    assert.equal(JSON.parse(String(init?.body)).voice, f.env.ULTRAVOX_VOICE);
    return Response.json(rawCall(), { status: 201 });
  });
  const input = await f.body('start-1');
  const result = await f.invoke(f.adapters.voiceStart!, input); assert.equal(result.provider_call_id, PROVIDER_ID);
  assert.equal(f.requests.length, 4);
  await f.invoke(f.adapters.voiceStart!, input); assert.equal(f.requests.length, 4, 'replay performs no provider requests');
});

test('start reserves before provider, attaches before join URL, and encrypted replay has no extra cost', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.respond(async (_url, init) => {
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE state='reserved'").get()!.n, 2);
    const calls = await f.core.store.listCalls('session-1'); assert.equal(calls[0].status, 'reserved');
    const config = JSON.parse(String(init?.body)); assert.equal(config.maxDuration, '900s');
    assert.equal(config.model, 'approved-model'); assert.equal(config.voice, 'approved-voice');
    assert.ok(config.systemPrompt.includes('context_model'), 'the prompt contains the full current block');
    return Response.json(rawCall(), { status: 201 });
  });
  const input = await f.body('start-1'), result = await f.invoke(f.adapters.voiceStart!, input);
  assert.equal(result.join_url, JOIN); assert.equal((await f.core.store.getCall(result.call_id))!.status, 'active');
  const stored = f.db.sqlite.prepare('SELECT payload_json,result_json FROM audit_events').all();
  assert.equal(JSON.stringify(stored).includes(JOIN), false); assert.equal(JSON.stringify(stored).includes('test-private-key'), false);
  assert.ok(JSON.stringify(stored).includes('ciphertext')); assert.ok(JSON.stringify(stored).includes('question_ids'));
  const replay = await f.invoke(f.adapters.voiceStart!, input);
  assert.equal(replay.kind, 'duplicate'); assert.equal(replay.join_url, JOIN); assert.equal(f.requests.length, 1);
  await assert.rejects(f.invoke(f.adapters.voiceStart!, { ...input, extra: 'changed' }), code('operation_payload_conflict'));
  assert.equal(f.requests.length, 1);
});

test('returning to an already spoken voice question waits for the visitor instead of repeating it', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const first = await f.start();
  const firstRequest = JSON.parse(String(f.requests[0].init?.body));
  const question = firstRequest.firstSpeakerSettings.agent.text;
  await f.transcript(first.call_id, 'spoken-question', [{ text: question, role: 'assistant', order: 0 }]);
  f.tick(5000);
  await f.core.store.confirmCallStopped(first.call_id, f.core.now());
  await f.core.channel(f.request(), await f.body('to-chat', { action: 'switch', channel: 'chat' }), f.adapters.pollVoice);
  await f.core.channel(f.request(), await f.body('to-voice', { action: 'switch', channel: 'voice' }), f.adapters.pollVoice);
  const secondProviderId = '22222222-2222-4222-8222-222222222222';
  f.respond(() => Response.json({ ...rawCall(), callId: secondProviderId }, { status: 201 }));
  await f.start('start-2');
  const second = f.requests.at(-1)!;
  assert.equal(new URL(second.url).searchParams.get('priorCallId'), PROVIDER_ID);
  assert.deepEqual(JSON.parse(String(second.init?.body)).firstSpeakerSettings, { user: {} });
});

test('concurrent start authorizes one external create and retains unknown outcome without retry', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.respond(() => { throw new Error('network unavailable'); });
  const body = await f.body('race');
  const results = await Promise.allSettled([f.invoke(f.adapters.voiceStart!, body), f.invoke(f.adapters.voiceStart!, body)]);
  assert.ok(results.some(result => result.status === 'rejected')); assert.equal(f.requests.length, 1);
  for (const result of results) if (result.status === 'fulfilled') assert.equal(result.value.kind, 'duplicate');
  const call = (await f.core.store.listCalls('session-1'))[0]; assert.equal(call.status, 'unknown');
  assert.equal((await f.invoke(f.adapters.voiceStart!, body)).status, 'unknown'); assert.equal(f.requests.length, 1);
  assert.deepEqual(f.db.sqlite.prepare('SELECT state FROM usage_reservations').all().map(item => item.state), ['unknown', 'unknown']);
  assert.equal(f.db.sqlite.prepare('SELECT active_calls FROM ultravox_slots').get()!.active_calls, 1);
});

test('definite provider rejection releases reservations and disables unauthorized slot', async t => {
  const f = await fixture(); t.after(() => f.db.close()); f.respond(() => new Response('', { status: 401 }));
  await assert.rejects(f.start(), code('voice_provider_unavailable'));
  assert.equal((await f.core.store.listCalls('session-1'))[0].status, 'failed');
  assert.deepEqual(f.db.sqlite.prepare('SELECT state FROM usage_reservations').all().map(row => row.state), ['released', 'released']);
  const slot = f.db.sqlite.prepare('SELECT state,active_calls,reserved_ms FROM ultravox_slots').get()!;
  assert.deepEqual([slot.state, slot.active_calls, slot.reserved_ms], ['disabled', 0, 0]);
});

test('transcript batches preserve revised source IDs, exact acknowledgments and operation replay', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const started = await f.start();
  const one = await f.transcript(started.call_id, 't1', [{ text: 'Продаём', order: 1, final: false }]);
  const two = await f.transcript(started.call_id, 't2', [{ text: 'Продаём цветы', order: 1, revision: 1 }]);
  assert.notEqual(one.through_event_id, two.through_event_id);
  assert.deepEqual(two.accepted_events, [{ event_id: two.through_event_id, source_key: `${started.call_id}:1`, source_revision: 1 }]);
  const stored = await f.core.store.listEvents('session-1'); assert.equal(stored.filter(event => event.kind === 'utterance').length, 2);
  const previous = await f.core.store.getOperation('session-1', 't2'); assert.deepEqual(obj(previous!.result).accepted_events, two.accepted_events);
  await assert.rejects(f.transcript(started.call_id, 't3', [{ text: 'Другой текст', order: 1, revision: 1 }]), code('source_event_conflict'));
  await assert.rejects(f.transcript(started.call_id, 't4', [{ text: 'Продаём', order: 1, final: true }]), code('source_event_conflict'));
  await assert.rejects(f.transcript(started.call_id, 't5', [{ text: 'Первое', order: 2 }, { text: 'Другое', order: 2 }]), code('source_event_conflict'));
});

test('lost transcript CAS inserts no evidence and cannot overwrite a concurrent change', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start();
  const before = (await f.core.store.listEvents('session-1')).length;
  f.db.beforeBatch = () => { f.db.beforeBatch = null; f.db.sqlite.prepare('UPDATE audit_sessions SET revision=revision+1').run(); };
  await assert.rejects(f.transcript(start.call_id, 'lost', [{ text: 'Не потерять', order: 0 }]), code('revision_conflict'));
  assert.equal((await f.core.store.listEvents('session-1')).length, before);
});

test('answers require delivered final user evidence; candidate confirmation is never sufficient', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start(), call = (await f.core.store.getCall(start.call_id))!;
  await f.transcript(call.id, 'sources', [{ text: 'Продаём цветы', role: 'assistant', order: 0 }, { text: 'Продаём мебель', order: 1, final: false }, { text: 'Продаём книги', order: 2 }]);
  const candidate = (quote: string): VoiceAnswerCandidate => ({ question_id: 'context_business', fact_id: 'context.business', state: 'known', value: quote, source_quotes: [quote], confirmation_candidate: 'explicit' });
  const session = await f.core.store.requireSession('session-1');
  for (const quote of ['Продаём цветы', 'Продаём мебель']) await assert.rejects(normalizeVoiceAnswers(f.core, session, call, [candidate(quote)]), code('pending_evidence'));
  const result = await normalizeVoiceAnswers(f.core, session, call, [candidate('Продаём книги')]);
  assert.equal(result[0].confirmation, 'unconfirmed');
  assert.equal((await f.core.store.listEvents('session-1')).find(event => event.id === result[0].event_ids[0])!.role, 'user');
});

test('explicit voice confirmation requires an exact adjacent recap and rejects reversed negation', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start(), call = (await f.core.store.getCall(start.call_id))!;
  await f.transcript(call.id, 'confirmations', [
    { text: 'Продаём книги', order: 0 }, { text: 'Правильно ли я понял: Продаём книги?', order: 1, role: 'assistant' }, { text: 'Да, верно.', order: 2 },
    { text: 'Не продаём цветы', order: 3 }, { text: 'Правильно ли я понял: продаём цветы?', order: 4, role: 'assistant' }, { text: 'Да.', order: 5 },
    { text: 'Продаём мебель', order: 6 }, { text: 'Правильно ли я понял: не продаём мебель?', order: 7, role: 'assistant' }, { text: 'Да.', order: 8 },
    { text: 'Не продаём игрушки', order: 9 }, { text: 'Правильно ли я понял: не продаём игрушки?', order: 10, role: 'assistant' }, { text: 'Да.', order: 11 },
  ]);
  const candidates = ['Продаём книги', 'Не продаём цветы', 'Продаём мебель'].map(text => ({ question_id: 'context_business', fact_id: 'context.business', state: 'known', value: text, source_quotes: [text], confirmation_candidate: 'explicit' })) as VoiceAnswerCandidate[];
  const results = await normalizeVoiceAnswers(f.core, await f.core.store.requireSession('session-1'), call, candidates);
  assert.deepEqual(results.map(answer => answer.confirmation), ['explicit', 'unconfirmed', 'unconfirmed']);
  assert.equal(results[0].event_ids.length, 2); assert.equal(results[1].event_ids.length, 1);
  const fragment = await normalizeVoiceAnswers(f.core, await f.core.store.requireSession('session-1'), call,
    [{ ...candidates[0], value: 'игрушки', source_quotes: ['Не продаём игрушки'] }]);
  assert.equal(fragment[0].confirmation, 'unconfirmed');
});

test('literal quantities preserve digits, range, unit, currency, period and explicit approximation', async t => {
  const cases: { value: Json; original: string; recap?: string; explicit: boolean }[] = [
    { value: { value: 1000, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: true }, original: 'Примерно 1000 рублей RUB в месяц', explicit: true },
    { value: { value: 12.5, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: false }, original: 'Ровно 12,5 рублей RUB за месяц', explicit: true },
    { value: { min: 100, max: 200, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: false }, original: 'Точно от 100 до 200 рублей RUB в месяц', explicit: true },
    { value: { value: 100, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: true }, original: 'Примерно 1000 рублей RUB в месяц', explicit: false },
    { value: { value: 1000, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: false }, original: 'Примерно 1000 рублей RUB в месяц', explicit: false },
    { value: { value: 1000, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: true }, original: 'Примерно 1000 рублей в месяц', explicit: false },
    { value: { value: 1000, unit: 'рублей', currency: 'RUB', period: 'месяц', approximate: true }, original: 'Примерно 1000 рублей RUB в месяц', recap: 'Примерно 1000 рублей RUB в год', explicit: false },
  ];
  for (const [index, item] of cases.entries()) {
    const f = await fixture(); t.after(() => f.db.close()); const started = await f.start(), call = (await f.core.store.getCall(started.call_id))!;
    const question = library.questions.find(question => question.id === 'context_budget')!;
    await f.transcript(call.id, `numbers-${index}`, [{ text: question.voice, role: 'assistant', order: 0 }, { text: item.original, order: 1 },
      { text: `Правильно ли я понял: ${item.recap ?? item.original}?`, role: 'assistant', order: 2 }, { text: 'Да, верно.', order: 3 }]);
    const result = await normalizeVoiceAnswers(f.core, await f.core.store.requireSession('session-1'), call, [{ question_id: question.id, fact_id: 'context.budget', state: 'known', value: item.value, source_quotes: [item.original], confirmation_candidate: 'explicit' }]);
    assert.equal(result[0].confirmation, item.explicit ? 'explicit' : 'unconfirmed', `quantity case ${index}`);
    assert.deepEqual(result[0].value, item.value);
  }
});

test('boolean and unknown confirmation bind the literal answer to the actual pinned question', async t => {
  for (const expected of [true, false]) {
    const f = await fixture(); t.after(() => f.db.close()); const started = await f.start(), call = (await f.core.store.getCall(started.call_id))!;
    const question = library.questions.find(question => question.id === 'strategy_scope')!, reply = expected ? 'Да' : 'Нет';
    await f.transcript(call.id, 'boolean', [{ text: question.voice, role: 'assistant', order: 0 }, { text: reply, order: 1 },
      { text: `Правильно ли я понял: ${question.voice} Ответ: ${reply}.`, role: 'assistant', order: 2 }, { text: 'Подтверждаю.', order: 3 }]);
    const candidate: VoiceAnswerCandidate = { question_id: question.id, fact_id: 'strategy.applicable', state: 'known', value: expected, source_quotes: [reply], source_ordinals: [1], confirmation_candidate: 'explicit' };
    const session = await f.core.store.requireSession('session-1');
    assert.equal((await normalizeVoiceAnswers(f.core, session, call, [candidate]))[0].confirmation, 'explicit');
    assert.equal((await normalizeVoiceAnswers(f.core, session, call, [{ ...candidate, value: !expected }]))[0].confirmation, 'unconfirmed');
    assert.equal((await normalizeVoiceAnswers(f.core, session, call, [{ ...candidate, question_id: 'analytics_scope', fact_id: 'analytics.applicable' }]))[0].confirmation, 'unconfirmed');
  }
  const f = await fixture(); t.after(() => f.db.close()); const started = await f.start(), call = (await f.core.store.getCall(started.call_id))!;
  const question = library.questions.find(question => question.id === 'context_budget')!;
  await f.transcript(call.id, 'unknown', [{ text: question.voice, role: 'assistant', order: 0 }, { text: 'Не знаю', order: 1 }, { text: 'Правильно ли я понял: не знаю?', role: 'assistant', order: 2 }, { text: 'Да.', order: 3 }]);
  const result = await normalizeVoiceAnswers(f.core, await f.core.store.requireSession('session-1'), call, [{ question_id: question.id, fact_id: 'context.budget', state: 'unknown', value: null, source_quotes: ['Не знаю'], confirmation_candidate: 'explicit' }]);
  assert.equal(result[0].confirmation, 'explicit'); assert.equal(result[0].state, 'unknown'); assert.equal(result[0].value, null);
});

test('literal structured history keeps field associations, unknown states and negative results', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const started = await f.start(), call = (await f.core.store.getCall(started.call_id))!;
  const question = library.questions.find(question => question.fact_ids.includes('strategy.history'))!;
  const original = 'Попытки: пробовали; работа: SEO; результат: роста не было; измерение: не измеряли';
  await f.transcript(call.id, 'history-confirm', [{ text: question.voice, role: 'assistant', order: 0 }, { text: original, order: 1 },
    { text: `Правильно ли я понял: ${original}?`, role: 'assistant', order: 2 }, { text: 'Да, всё верно.', order: 3 }]);
  const attempt = { attempt_id: 'attempt-1', work: { state: 'known', value: 'SEO' }, outcome: { state: 'known', value: 'роста не было' }, measurement: { state: 'not_measured', value: null } };
  const candidate: VoiceAnswerCandidate = { question_id: question.id, fact_id: 'strategy.history', state: 'known', value: { attempts_status: 'tried', attempts: [attempt] }, source_quotes: [original], confirmation_candidate: 'explicit' };
  const session = await f.core.store.requireSession('session-1');
  const accepted = (await normalizeVoiceAnswers(f.core, session, call, [candidate]))[0];
  assert.equal(accepted.confirmation, 'explicit'); assert.deepEqual(accepted.value, candidate.value);
  for (const wrong of [
    { ...attempt, work: attempt.outcome, outcome: attempt.work },
    { ...attempt, outcome: { state: 'known', value: 'рост был' } },
    { ...attempt, measurement: { state: 'known', value: 'не измеряли' } },
    { ...attempt, applies_to_block_ids: ['strategy_goal'] },
  ]) {
    const result = await normalizeVoiceAnswers(f.core, session, call, [{ ...candidate, value: { attempts_status: 'tried', attempts: [wrong] } }]);
    assert.equal(result[0].confirmation, 'unconfirmed');
  }
});

test('literal confirmed correction replaces exactly one current answer and preserves its source history', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const started = await f.start();
  await f.transcript(started.call_id, 'original', [{ text: 'Продаём книги', order: 0 }, { text: 'Правильно ли я понял: продаём книги?', role: 'assistant', order: 1 }, { text: 'Да.', order: 2 }]);
  const candidate: VoiceAnswerCandidate = { question_id: 'context_business', fact_id: 'context.business', state: 'known', value: 'Продаём книги', source_quotes: ['Продаём книги'], confirmation_candidate: 'explicit' };
  await f.invoke(f.adapters.voiceAnswers!, await f.body('original-answer', { call_id: started.call_id, answers: [candidate] }));
  const old = (await f.core.store.listAnswers('session-1'))[0];
  await f.transcript(started.call_id, 'correction', [{ text: 'Исправляю: Продаём мебель', order: 3 }, { text: 'Правильно ли я понял: продаём мебель?', role: 'assistant', order: 4 }, { text: 'Да, верно.', order: 5 }]);
  const revised: VoiceAnswerCandidate = { ...candidate, value: 'Продаём мебель', source_quotes: ['Исправляю: Продаём мебель'], is_correction: true };
  await f.invoke(f.adapters.voiceAnswers!, await f.body('corrected-answer', { call_id: started.call_id, answers: [revised] }));
  const answers = await f.core.store.listAnswers('session-1'); assert.equal(answers.length, 2);
  const correction = answers.find(answer => answer.replaces_answer_id === old.id)!;
  assert.ok(correction); assert.equal(correction.confirmation, 'explicit'); assert.equal(correction.value, 'Продаём мебель');
  assert.equal((await f.core.store.listEvents('session-1')).find(event => event.text === 'Исправляю: Продаём мебель')!.kind, 'correction');
  assert.equal((await f.core.store.requireSession('session-1')).state.facts['context.business'].value, 'Продаём мебель');
});

test('a correction claim without explicit correction speech or with multiple current targets stays disputed', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const started = await f.start(), call = (await f.core.store.getCall(started.call_id))!;
  await f.transcript(call.id, 'correction-input', [{ text: 'Продаём мебель', order: 0 }, { text: 'Правильно ли я понял: продаём мебель?', role: 'assistant', order: 1 }, { text: 'Да.', order: 2 }]);
  const candidate: VoiceAnswerCandidate = { question_id: 'context_business', fact_id: 'context.business', state: 'known', value: 'Продаём мебель', source_quotes: ['Продаём мебель'], confirmation_candidate: 'explicit', is_correction: true };
  let result = (await normalizeVoiceAnswers(f.core, await f.core.store.requireSession('session-1'), call, [candidate]))[0];
  assert.equal(result.confirmation, 'disputed'); assert.equal(result.replaces_answer_id, undefined);
  await f.invoke(f.adapters.voiceAnswers!, await f.body('first-target', { call_id: call.id, answers: [{ ...candidate, is_correction: false }] }));
  await f.invoke(f.adapters.voiceAnswers!, await f.body('second-target', { call_id: call.id, answers: [{ ...candidate, is_correction: false }] }));
  await f.transcript(call.id, 'ambiguous-correction', [{ text: 'Исправляю: Продаём книги', order: 3 }, { text: 'Правильно ли я понял: продаём книги?', role: 'assistant', order: 4 }, { text: 'Да.', order: 5 }]);
  result = (await normalizeVoiceAnswers(f.core, await f.core.store.requireSession('session-1'), call, [{ ...candidate, value: 'Продаём книги', source_quotes: ['Исправляю: Продаём книги'] }]))[0];
  assert.equal(result.confirmation, 'disputed'); assert.equal(result.replaces_answer_id, undefined);
});

test('client off-topic category cannot authorize a joke or pause; literal saved commands can', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start();
  await f.transcript(start.call_id, 'sensitive', [{ text: 'У нас случилось горе', order: 0 }]);
  const body = await f.body('unsafe', { call_id: start.call_id, tool: 'offTopicReply', kind: 'off_topic', certain: true, safe_category_ids: library.jokes.categories.map(item => item.id) });
  const neutral = await f.invoke(f.adapters.voiceAnswers!, body);
  assert.equal(obj(neutral.operation).joke_id, null); assert.equal((await f.core.store.requireSession('session-1')).state.humor.reserved_ids.length, 0);
  await f.transcript(start.call_id, 'command', [{ text: 'Без шуток', order: 1 }]);
  await f.invoke(f.adapters.voiceAnswers!, await f.body('disable', { call_id: start.call_id, tool: 'offTopicReply', kind: 'off_topic', certain: true, safe_category_ids: [] }));
  assert.equal((await f.core.store.requireSession('session-1')).state.humor.enabled, false);
  await f.transcript(start.call_id, 'pause-command', [{ text: 'Пауза', order: 2 }]);
  const pauseBody = await f.body('pause', { call_id: start.call_id, tool: 'offTopicReply', kind: 'pause', certain: true, safe_category_ids: [] });
  const pause = await f.invoke(f.adapters.voiceAnswers!, pauseBody); assert.equal(pause.stop_required, true);
  assert.equal((await f.core.store.getCall(start.call_id))!.status, 'stopping'); assert.notEqual((await f.core.store.requireSession('session-1')).state.active_since, null);
  assert.equal((await f.invoke(f.adapters.voiceAnswers!, pauseBody)).kind, 'duplicate');
});

test('channel switch polls confirmed stop, preserves budget and never silently accepts an unrelated revision', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start(); f.tick(10000);
  const input = await f.body('switch', { action: 'switch', channel: 'chat' });
  await assert.rejects(f.core.channel(f.request(), input, f.adapters.pollVoice), code('voice_stop_pending'));
  assert.equal((await f.core.store.requireSession('session-1')).state.active_channel, 'voice');
  f.respond(() => Response.json(rawCall(NOW + 9000)));
  const result = obj(await f.core.channel(f.request(), input, f.adapters.pollVoice)); assert.equal(result.session.active_channel, 'chat');
  const call = (await f.core.store.getCall(start.call_id))!; assert.equal(call.stoppedRevision, input.expected_revision + 1);
  assert.equal(result.session.elapsed_ms, 9000); assert.equal(result.session.channel_revision, 1);
  assert.equal(obj(await f.core.channel(f.request(), input, f.adapters.pollVoice)).kind, 'duplicate');
});

test('stop during request permits only its causal revision; concurrent data change rejects transition', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start(); f.tick(10000);
  const input = await f.body('switch-race', { action: 'switch', channel: 'chat' });
  f.respond(async () => {
    const session = await f.core.store.requireSession('session-1');
    await f.core.store.appendLateEvent({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: 0, operationId: 'concurrent', event: f.core.serviceEvent('concurrent', 'service', {}), now: f.core.now() });
    return Response.json(rawCall(NOW + 9000));
  });
  await assert.rejects(f.core.channel(f.request(), input, f.adapters.pollVoice), code('revision_conflict'));
  assert.equal((await f.core.store.getCall(start.call_id))!.status, 'active');
  assert.equal((await f.core.store.requireSession('session-1')).state.active_channel, 'voice');
});

test('previous stop marker admits one stale revision but an intervening write cannot reuse it', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start();
  const input = await f.body('switch-marker', { action: 'switch', channel: 'chat' }); f.tick(5000);
  await f.core.store.confirmCallStopped(start.call_id, f.core.now());
  const session = await f.core.store.requireSession('session-1');
  await f.core.store.appendLateEvent({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: 0, operationId: 'later', event: f.core.serviceEvent('later', 'service', {}), now: f.core.now() });
  await assert.rejects(f.core.channel(f.request(), { ...input, expected_revision: input.expected_revision + 1 }, f.adapters.pollVoice), code('revision_conflict'));
  assert.equal((await f.core.store.requireSession('session-1')).state.active_channel, 'voice');
});

test('the one persisted stop revision alone may advance a pending channel request', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start();
  const input = await f.body('switch-after-stop', { action: 'switch', channel: 'chat' }); f.tick(5000);
  await f.core.store.confirmCallStopped(start.call_id, f.core.now());
  const result = obj(await f.core.channel(f.request(), input, f.adapters.pollVoice));
  assert.equal(result.session.active_channel, 'chat'); assert.equal(result.session.channel_revision, 1);
  assert.equal(f.requests.length, 1, 'no extra provider request is needed after the atomic stop');
});

test('webhook validates raw signature before lookup, stops owned call and deduplicates delivery', async t => {
  const f = await fixture(); t.after(async () => { await Promise.allSettled(f.tasks); f.db.close(); }); const start = await f.start(); f.tick(10000);
  f.respond(url => Response.json(url.includes('/messages') ? { results: [], next: null } : rawCall(NOW + 9000)));
  const text = JSON.stringify({ event: 'call.ended', call: rawCall(NOW + 9000) }), timestamp = new Date(f.core.now()).toISOString();
  const signature = createHmac('sha256', String(f.env.ULTRAVOX_WEBHOOK_SECRET)).update(text + timestamp).digest('hex');
  const request = (signed: boolean) => new Request('https://worker.example/api/webhooks/ultravox', { method: 'POST', body: text, headers: { 'X-Ultravox-Webhook-Timestamp': timestamp, 'X-Ultravox-Webhook-Signature': signed ? signature : '0'.repeat(64) } });
  await assert.rejects(f.adapters.ultravoxWebhook!(request(false), f.context()), code('invalid_webhook'));
  assert.equal((await f.core.store.getCall(start.call_id))!.status, 'active');
  assert.equal(obj(await f.adapters.ultravoxWebhook!(request(true), f.context())).accepted, true);
  assert.equal((await f.core.store.getCall(start.call_id))!.status, 'stopped');
  assert.equal(obj(await f.adapters.ultravoxWebhook!(request(true), f.context())).replayed, true);
  assert.equal(f.db.sqlite.prepare("SELECT state FROM usage_reservations WHERE kind='voice_seconds'").get()!.state, 'settled');
});

test('chunked oversized webhook is rejected before parsing, signature work, or state mutation', async t => {
  const f = await fixture(); t.after(() => f.db.close()); let canceled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(66000)); }, cancel() { canceled = true; } });
  const request = new Request('https://worker.example/api/webhooks/ultravox', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
  await assert.rejects(f.adapters.ultravoxWebhook!(request, f.context()), code('body_too_large'));
  assert.equal(canceled, true); assert.equal(f.requests.length, 0); assert.equal((await f.core.store.requireSession('session-1')).state.revision, 0);
});

test('server history imports every page and records no invented facts without a recovery classifier', async t => {
  const f = await fixture(); t.after(() => f.db.close()); await f.start(); f.tick(10000);
  const session = await f.core.store.requireSession('session-1');
  await f.core.store.finish({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: 0, operationId: 'finish', state: session.state, event: f.core.serviceEvent('finish', 'finish', {}), reason: 'visitor_request', now: f.core.now() });
  f.respond(url => {
    if (!url.includes('/messages')) return Response.json(rawCall(NOW + 9000));
    const page = url.includes('cursor=2');
    return Response.json({ results: [{ role: page ? 'MESSAGE_ROLE_USER' : 'MESSAGE_ROLE_AGENT', text: page ? 'Продаём книги' : 'Чем занимается компания?', medium: 'MESSAGE_MEDIUM_VOICE', callStageId: page ? 'stage-2' : 'stage-1', callStageMessageIndex: 0, wallClockTimespan: { start: '1s', end: '2s' } }], next: page ? null : `/api/calls/${PROVIDER_ID}/messages?cursor=2` });
  });
  const result = await f.adapters.reconcile!(await f.core.store.requireSession('session-1'), f.core.now(), f.core);
  assert.equal(result.complete, false); assert.ok(result.limitations.some(text => text.includes('не настроено')));
  const history = (await f.core.store.listEvents('session-1')).filter(event => event.kind === 'utterance'); assert.equal(history.length, 2);
  assert.deepEqual(history.map(event => event.source), ['webhook', 'webhook']); assert.equal(history[1].local_order, 1);
  assert.equal(obj(history[1].data).provenance.call_stage_message_index, 0); assert.equal(history[1].occurred_at, NOW);
  assert.deepEqual(await f.core.store.listAnswers('session-1'), []);
});

test('successful empty recovery is durably marked and never repeatedly classified', async t => {
  let classified = 0;
  const f = await fixture({ recoverAnswers: async () => { classified++; return []; } }); t.after(() => f.db.close()); await f.start(); f.tick(10000);
  const session = await f.core.store.requireSession('session-1');
  await f.core.store.finish({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: 0, operationId: 'finish', state: session.state, event: f.core.serviceEvent('finish', 'finish', {}), reason: 'visitor_request', now: f.core.now() });
  f.respond(url => Response.json(url.includes('/messages') ? { results: [{ role: 'MESSAGE_ROLE_USER', text: 'Спасибо', medium: 'MESSAGE_MEDIUM_VOICE', callStageId: 'stage-1', callStageMessageIndex: 0 }], next: null } : rawCall(NOW + 9000)));
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await f.adapters.reconcile!(await f.core.store.requireSession('session-1'), f.core.now(), f.core)).complete, true);
  assert.equal(classified, 1); assert.equal((await f.core.store.listEvents('session-1')).filter(event => Array.isArray(obj(event.data ?? {}).processed_event_ids)).length, 1);
});

test('Cron performs bounded status recovery and retains unknown calls without provider IDs', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const start = await f.start(); f.tick(10000);
  f.respond(() => Response.json(rawCall(NOW + 9000)));
  assert.deepEqual(await f.adapters.recoverVoice!(f.core), { checked: 1, stopped: 1 });
  assert.equal((await f.core.store.getCall(start.call_id))!.status, 'stopped');
  assert.deepEqual(await f.adapters.recoverVoice!(f.core), { checked: 0, stopped: 0 });
  assert.equal(f.requests.filter(request => request.init?.method === 'POST').length, 1);
});
