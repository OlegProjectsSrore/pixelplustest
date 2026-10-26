import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreServices } from '../src/core.ts';
import { createRealtimeAdapters, realtimeTools } from '../src/channel-realtime.ts';
import { quoteMatches } from '../src/channel-voice.ts';
import type { AuditEvent } from '../src/audit/contracts.ts';
import { initialAuditState } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { hashToken, HttpError } from '../src/security.ts';
import { presentPayload } from '../src/http-view.ts';
import type { AdapterHandler, AdapterContext } from '../src/integration.ts';
import type { Env } from '../src/env.ts';
import { SqliteD1 } from './helpers/d1.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z'), TOKEN = 'a'.repeat(43), SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const obj = (v: unknown) => v as Record<string, any>;
const code = (name: string) => (e: unknown) => e instanceof HttpError && e.code === name;
async function fixture() {
  const db = new SqliteD1(); let now = NOW, sequence = 0;
  const requests: { url: string; init?: RequestInit }[] = [];
  let respond = async (_url: string, _init?: RequestInit): Promise<Response> => new Response(SDP, { status: 201, headers: { Location: `/v1/realtime/calls/rtc_${++sequence}` } });
  const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true',
    OPENAI_API_KEY: 'test-private-key', OPENAI_REALTIME_MODEL: 'gpt-realtime-2.1-mini',
    VOICE_REPLAY_SECRET: Buffer.alloc(32, 3).toString('base64url'), BUDGETS_JSON: JSON.stringify({ voice_starts: 14, voice_seconds: 7200 }) };
  const core = new CoreServices(env, () => now, (async (url, init) => { requests.push({ url: String(url), init }); return respond(String(url), init); }) as typeof fetch);
  await core.store.createSession({ id: 's1', tokenHash: await hashToken(TOKEN), reportId: 'r1', reportTokenHash: 'read-only', state: initialAuditState(library.version, 'voice', now), now });
  const adapters = createRealtimeAdapters();
  const request = (token = TOKEN) => new Request('https://worker.example/test', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  const context = (body: Record<string, unknown>): AdapterContext => ({ core, env, body, execution: { waitUntil() {} } as unknown as ExecutionContext });
  const body = async (operation = crypto.randomUUID(), extra = {}) => { const s = await core.store.requireSession('s1'); return { session_id: s.id, operation_id: operation, library_version: library.version, expected_revision: s.state.revision, channel_revision: s.state.channel_revision, ...extra }; };
  const invoke = async (fn: AdapterHandler, input: Record<string, unknown>) => obj(await fn(request(), context(input)));
  const start = async () => invoke(adapters.voiceStart!, await body(undefined, { sdp: SDP }));
  return { db, env, core, adapters, request, context, body, invoke, start, requests, tick: (ms: number) => { now += ms; }, respond: (fn: typeof respond) => { respond = fn; } };
}

test('Realtime reserves before OpenAI, uses exact model/speed, replays encrypted SDP without another call', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.respond(async (url, init) => {
    assert.equal(url, 'https://api.openai.com/v1/realtime/calls');
    assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) n FROM usage_reservations WHERE state='reserved'").get()!.n, 2);
    const form = init!.body as FormData, config = JSON.parse(String(form.get('session')));
    assert.equal(form.get('sdp'), SDP); assert.equal(config.model, 'gpt-realtime-2.1-mini');
    assert.equal(config.audio.output.speed, 1); assert.equal(config.audio.output.voice, 'ash');
    assert.equal(config.audio.input.transcription.language, 'ru');
    assert.match(config.instructions, /Как Вас зовут/);
    assert.match(config.instructions, /вызывай saveAnswers молча/);
    assert.match(config.instructions, /Форматы фактов текущего вопроса:\n\[\{"fact_id":"context\.name","value_type":"text"/);
    assert.doesNotMatch(config.instructions, /\{\{\w+\}\}/);
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer test-private-key');
    return new Response(SDP, { status: 201, headers: { Location: '/v1/realtime/calls/rtc_test' } });
  });
  const body = await f.body(undefined, { sdp: SDP }), first = await f.invoke(f.adapters.voiceStart!, body);
  assert.equal(first.sdp_answer, SDP); assert.equal(first.first_message, 'Как Вас зовут?');
  const replay = await f.invoke(f.adapters.voiceStart!, body); assert.equal(replay.sdp_answer, SDP); assert.equal(f.requests.length, 1);
  const persisted = JSON.stringify(await f.core.store.getOperation('s1', body.operation_id));
  assert(!persisted.includes('m=audio')); assert(!persisted.includes('test-private-key'));
  const publicResult = obj(await presentPayload(f.core, first)); assert.equal(publicResult.sdp_answer, SDP); assert.equal(publicResult.provider, 'openai');
});

test('Realtime tools retain strict answer evidence schema and finish/pause semantics', () => {
  const tools = realtimeTools().map(obj); assert.deepEqual(tools.map(t => t.name), ['saveAnswers', 'finishAudit', 'offTopicReply', 'hangUp', 'searchKnowledge']);
  const answer = tools[0].parameters.properties.answers.items;
  assert(answer.required.includes('source_quotes')); assert.equal(answer.additionalProperties, false);
});

test('Missing key, malformed SDP and stale revision never start a paid call', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  delete f.env.OPENAI_API_KEY; await assert.rejects(f.start(), code('not_configured'));
  f.env.OPENAI_API_KEY = 'test-key';
  await assert.rejects(f.invoke(f.adapters.voiceStart!, await f.body(undefined, { sdp: 'not SDP' })), code('invalid_sdp'));
  await assert.rejects(f.invoke(f.adapters.voiceStart!, await f.body(undefined, { sdp: SDP, expected_revision: 100 })), code('revision_conflict'));
  assert.equal(f.requests.length, 0);
});

test('Rejected OpenAI credentials release reservations, do not create a phantom active call', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  f.respond(async () => Response.json({ error: { code: 'invalid_api_key' } }, { status: 401 }));
  await assert.rejects(f.start(), code('voice_provider_unavailable'));
  assert.equal((await f.core.store.requireSession('s1')).activeCallId, null);
  assert.equal((await f.core.store.listCalls('s1'))[0].status, 'failed');
  assert(f.db.sqlite.prepare('SELECT actual FROM usage_reservations').all().every(row => row.actual === 0));
});

test('Four voice/chat switches stop OpenAI, retain transcript and freeze elapsed time in chat', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  let elapsed = 0;
  for (let i = 0; i < 4; i++) {
    const call = await f.start(); f.tick(2000);
    await f.invoke(f.adapters.voiceTranscript!, await f.body(undefined, { call_id: call.call_id, events: [{ source: 'voice', source_key: `${call.call_id}:0`, source_revision: 0, local_order: 0, call_id: call.call_id, role: 'user', kind: 'utterance', text: 'Олег', occurred_at: NOW + 2000, data: { is_final: true, medium: 'voice' } }] }));
    await f.core.channel(f.request(), await f.body(undefined, { action: 'switch', channel: 'chat' }), f.adapters.pollVoice);
    const s = await f.core.store.requireSession('s1'); assert.equal(s.state.active_channel, 'chat'); assert.equal(s.activeCallId, null);
    elapsed += 2000; assert.equal(s.state.elapsed_ms, elapsed);
    f.tick(5000); assert.equal((await f.core.view(await f.core.store.requireSession('s1')) as any).remaining_ms, 900000 - elapsed);
    await f.core.channel(f.request(), await f.body(undefined, { action: 'switch', channel: 'voice' }), f.adapters.pollVoice);
  }
  assert.equal(f.requests.filter(r => r.url.endsWith('/hangup')).length, 4);
  assert.equal((await f.core.store.listEvents('s1', 0, 100)).filter(e => e.text === 'Олег').length, 4);
});

test('Transcript from a browser clock an hour ahead or behind is accepted with server time', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const call = await f.start(); f.tick(2000);
  const line = (ordinal: number, role: string, text: string, occurred_at: number) => ({ source: 'voice', source_key: `${call.call_id}:${ordinal}`, source_revision: 0, local_order: ordinal,
    call_id: call.call_id, role, kind: 'utterance', text, occurred_at, data: { is_final: true, medium: 'voice' } });
  const events = [line(0, 'assistant', 'Как Вас зовут?', NOW + 3_600_000), line(1, 'user', 'Меня зовут Александр.', NOW - 3_600_000)];
  const result = await f.invoke(f.adapters.voiceTranscript!, await f.body(undefined, { call_id: call.call_id, events }));
  assert.equal(result.accepted_events.length, 2);
  const stored = (await f.core.store.listEvents('s1', 0, 100)).filter(e => e.source === 'voice');
  assert.deepEqual(stored.map(e => [e.text, e.occurred_at, obj(e.data).client_occurred_at]),
    [['Как Вас зовут?', NOW + 2000, NOW + 3_600_000], ['Меня зовут Александр.', NOW + 2000, NOW - 3_600_000]]);
});

test('Quote matching prefers an exact substring, then whole words ignoring case, ё and punctuation', () => {
  const said = (local_order: number, text: string) => ({ source: 'voice', local_order, text }) as unknown as AuditEvent;
  const events = [said(1, 'Да.'), said(3, 'да, конечно'), said(5, 'Алёна')];
  const orders = (quote: string, ordinals?: number[]) => quoteMatches(events, quote, ordinals).map(e => e.local_order);
  assert.deepEqual(orders('да'), [3], 'a single exact substring still wins');
  assert.deepEqual(orders('ДА'), [1, 3], 'loose words can be ambiguous');
  assert.deepEqual(orders('ДА', [1]), [1], 'ordinals disambiguate');
  assert.deepEqual(orders('«алена»'), [5]);
  assert.deepEqual(orders('алё'), [], 'loose matching needs whole words');
  assert.deepEqual(orders('...'), [], 'punctuation alone is not a quote');
});

async function nameCall(f: Awaited<ReturnType<typeof fixture>>, userText: string) {
  const call = await f.start(); f.tick(2000);
  const line = (ordinal: number, role: string, text: string) => ({ source: 'voice', source_key: `${call.call_id}:${ordinal}`, source_revision: 0, local_order: ordinal,
    call_id: call.call_id, role, kind: 'utterance', text, occurred_at: NOW, data: { is_final: true, medium: 'voice' } });
  const delivered = await f.invoke(f.adapters.voiceTranscript!, await f.body(undefined, { call_id: call.call_id, events: [line(0, 'assistant', 'Как Вас зовут?'), line(1, 'user', userText)] }));
  return (answer: Record<string, unknown>) => f.body(undefined, { call_id: call.call_id, through_event_id: delivered.through_event_id,
    answers: [{ question_id: 'context_name', fact_id: 'context.name', state: 'known', value: 'Александр', source_ordinals: [1], ...answer }] });
}

test('Voice answer is saved when the quote differs from the transcript only in case and punctuation', async t => {
  for (const quote of ['александр.', '«Александр»', 'АЛЕКСАНДР']) {
    const f = await fixture(); t.after(() => f.db.close());
    const save = await nameCall(f, 'Александр,');
    await f.invoke(f.adapters.voiceAnswers!, await save({ source_quotes: [quote] }));
    const answers = await f.core.store.listAnswers('s1');
    assert.deepEqual(answers.map(a => [a.fact_id, a.value]), [['context.name', 'Александр']], quote);
  }
});

test('Rejected voice saves are logged by structure only, with the engine reason', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const warn = t.mock.method(console, 'warn', () => {});
  const save = await nameCall(f, 'Александр,');
  await assert.rejects(f.invoke(f.adapters.voiceAnswers!, await save({ source_quotes: ['Меня зовут Александр'] })), code('pending_evidence'));
  await assert.rejects(f.invoke(f.adapters.voiceAnswers!, await save({ fact_id: 'context.position', source_quotes: ['Александр'] })), code('invalid_answers'));
  const logs = warn.mock.calls.map(c => String(c.arguments[0]));
  assert.equal(logs.length, 2);
  for (const text of logs) assert(!/Александр|зовут/iu.test(text), 'visitor words and values never reach logs');
  const [missing, invalid] = logs.map(text => JSON.parse(text));
  assert.equal(missing.event, 'voice_answers_rejected'); assert.equal(missing.code, 'pending_evidence'); assert.equal(missing.current_question_id, 'context_name');
  assert.deepEqual(missing.user_replicas, [{ ordinal: 1, length: 10 }]);
  assert.deepEqual(missing.answers[0].quotes, [{ length: 20, exact: 0, matched: 0 }]); assert.equal(missing.answers[0].value, 'string');
  assert.equal(invalid.code, 'invalid_answers'); assert.equal(invalid.detail, 'Unknown or inactive question/fact pair'); assert.equal(invalid.answers[0].fact_id, 'context.position');
});

test('Extra model fields such as value_type are dropped and the voice answer is saved', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const save = await nameCall(f, 'Александр,');
  await f.invoke(f.adapters.voiceAnswers!, await save({ source_quotes: ['Александр,'], value_type: 'text', confirmation_candidate: 'explicit', is_correction: false, event_ids: ['forged'] }));
  const answers = await f.core.store.listAnswers('s1');
  assert.deepEqual(answers.map(a => [a.fact_id, a.value]), [['context.name', 'Александр']]);
  assert.notDeepEqual(answers[0].event_ids, ['forged']);
});

test('Malformed model arguments are a 400 invalid_answers, not a retryable 500', async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const warn = t.mock.method(console, 'warn', () => {});
  const save = await nameCall(f, 'Александр,');
  const definite = (e: unknown) => e instanceof HttpError && e.status === 400 && e.code === 'invalid_answers' && !e.retryable;
  await assert.rejects(f.invoke(f.adapters.voiceAnswers!, await save({ state: 'unknown', source_quotes: ['Александр'] })), definite);
  const callId = (await f.core.store.requireSession('s1')).activeCallId;
  await assert.rejects(f.invoke(f.adapters.voiceAnswers!, await f.body(undefined, { call_id: callId, tool: 'offTopicReply', kind: 'invented', certain: true, safe_category_ids: [] })), definite);
  const [answer, offTopic] = warn.mock.calls.map(c => JSON.parse(String(c.arguments[0])));
  assert.equal(answer.status, 400); assert.equal(answer.detail, 'Uncertain answers require null');
  assert.equal(offTopic.tool, 'offTopicReply'); assert.equal(offTopic.detail, 'Invalid off-topic candidate');
  assert.equal((await f.core.store.listAnswers('s1')).length, 0);
});

test('Heartbeat cannot revive another call; cron terminates stale calls; failed hangup blocks overlap', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const call = await f.start();
  await assert.rejects(f.invoke(f.adapters.voiceControl!, { session_id: 's1', call_id: 'not-owned', action: 'heartbeat' }), code('call_mismatch'));
  f.tick(45000); await f.invoke(f.adapters.voiceControl!, { session_id: 's1', call_id: call.call_id, action: 'heartbeat' });
  f.tick(45000); await f.adapters.recoverVoice!(f.core); assert.equal((await f.core.store.getCall(call.call_id))!.status, 'active');
  f.respond(async () => new Response(null, { status: 500 }));
  f.tick(20000); await f.adapters.recoverVoice!(f.core); assert.equal((await f.core.store.getCall(call.call_id))!.status, 'stopping');
  await assert.rejects(f.start(), code('voice_unavailable'));
  f.respond(async () => new Response(null, { status: 200 }));
  await f.adapters.recoverVoice!(f.core); assert.equal((await f.core.store.getCall(call.call_id))!.status, 'stopped');
  assert.equal((await f.core.store.requireSession('s1')).activeCallId, null);
});

test('Voice deadline ends the interview and schedules the report even after stop freezes the timer', async t => {
  const f = await fixture(); t.after(() => f.db.close()); const call = await f.start();
  f.tick(900000);
  await f.invoke(f.adapters.voiceControl!, { session_id: 's1', call_id: call.call_id, action: 'stop', delivery_complete: true });
  const session = await f.core.store.requireSession('s1');
  assert.equal(session.state.status, 'closing'); assert.equal(session.state.finish_reason, 'time_limit'); assert.equal(session.state.elapsed_ms, 900000);
  assert.equal(f.db.sqlite.prepare('SELECT COUNT(*) n FROM audit_jobs').get()!.n, 1);
});
