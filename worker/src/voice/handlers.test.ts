import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AuditAnswer, AuditEvent, Json } from '../audit/contracts.ts';
import { initialAuditState } from '../audit/contracts.ts';
import type { CoreServices } from '../core.ts';
import type { AdapterContext } from '../integration.ts';
import type { StoredSession, VoiceCall } from '../storage/types.ts';
import { HttpError } from '../security.ts';
import { createVoiceHandlers, readSessionEvents } from './handlers.ts';
import { createVoiceReconcileHandler } from './reconcile.ts';
import { normalizeTranscriptBatch } from './transcripts.ts';
import { resolveVoiceAnswers } from './evidence.ts';
import type { ProviderCall, VoiceAnswerCandidate } from './types.ts';
import type { createVoiceProvider } from './provider.ts';

const now = Date.parse('2026-10-22T10:00:00Z');
const call: VoiceCall = { id: 'local-call', sessionId: 'session-1', slotId: 'slot-1', providerCallId: '11111111-1111-4111-8111-111111111111', previousCallId: null, channelRevision: 0, status: 'active', reservedMs: 900000, startedAt: now - 10000, endedAt: null, usedMs: 0, historyStatus: 'pending', operationId: 'create', createdAt: now - 12000, stoppedRevision: null };
const session: StoredSession = { id: 'session-1', tokenHash: 'private', createdAt: now - 12000, accessExpiresAt: now + 100000, state: { ...initialAuditState('test', 'voice', now), paused: false, active_since: now - 10000 }, activeCallId: call.id, reportId: 'report', closedAt: null };
const envelope = { session_id: session.id, operation_id: 'operation-1', expected_revision: 0, channel_revision: 0, library_version: 'test', call_id: call.id };
const event: AuditEvent = { id: 'stored-evidence', source: 'voice', source_key: `${call.id}:1`, source_revision: 0, local_order: 1, role: 'user', kind: 'utterance', text: 'Да, пробовали рекламу', call_id: call.id, occurred_at: now - 1000, received_at: now - 900, seq: 1, data: { is_final: true, medium: 'voice' } };
const candidate: VoiceAnswerCandidate = { question_id: 'q1', fact_id: 'f1', state: 'known', value: true, source_quotes: ['Да, пробовали рекламу'], confirmation_candidate: 'explicit' };
const rawTranscript = { id: 'forged', source: 'voice', source_key: `${call.id}:1`, source_revision: 2, local_order: 1, role: 'user', kind: 'utterance', text: 'Да', call_id: call.id, occurred_at: 42, data: { is_final: true, medium: 'voice', confirmation: 'explicit', replaces_answer_id: 'fake' } };
const request = () => new Request('https://pixel.example/api/voice/answers', { method: 'POST' });
function context(body: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}): AdapterContext {
  const core = { now: () => now, store: { getCall: async () => call, getOperation: async () => null, listEvents: async () => [event], listAnswers: async () => [], listCalls: async () => [call], getSession: async () => session },
    view: async () => ({ status: 'in_progress', revision: 0 }), accept: async () => ({ kind: 'accepted' }),
    channel: async () => ({ kind: 'paused' }), humor: async () => ({ kind: 'humor' }), finish: async () => ({ session: { status: 'closing' } }), ...overrides };
  return { core: core as unknown as CoreServices, session, body: { ...envelope, ...body }, env: {}, execution: {} } as unknown as AdapterContext;
}
const isCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test('transcript normalization assigns version-specific server identity and strips browser authority', () => {
  const [result] = normalizeTranscriptBatch([rawTranscript], call, now);
  assert.equal(result.id, `voice:${call.id}:1:2`); assert.equal(result.occurred_at, now);
  assert.deepEqual(result.data, { is_final: true, medium: 'voice', client_occurred_at: 42 });
  assert.throws(() => normalizeTranscriptBatch([{ ...rawTranscript, kind: 'correction' }], call, now), /kind/);
  assert.throws(() => normalizeTranscriptBatch([{ ...rawTranscript, call_id: 'other-call' }], call, now), /another/);
  assert.throws(() => normalizeTranscriptBatch([rawTranscript, rawTranscript], call, now), /Repeated/);
});

test('transcript endpoint fails closed without atomic batch hook and never acknowledges missing events', async () => {
  const absent = createVoiceHandlers().voiceTranscript;
  await assert.rejects(absent(request(), context({ events: [rawTranscript] })), isCode('integration_unavailable'));
  const partial = createVoiceHandlers({ acceptTranscriptBatch: async () => ({ response: { kind: 'accepted' }, accepted_event_ids: [] }) }).voiceTranscript;
  await assert.rejects(partial(request(), context({ events: [rawTranscript] })), isCode('pending_events'));
  const accepted = createVoiceHandlers({ acceptTranscriptBatch: async (_request, _context, batch) => ({ response: { kind: 'accepted' }, accepted_event_ids: batch.events.map(item => item.id) }) }).voiceTranscript;
  const response = await accepted(request(), context({ events: [rawTranscript] })) as Record<string, Json>;
  assert.equal(response.through_event_id, `voice:${call.id}:1:2`);
  assert.deepEqual(response.accepted_events, [{ event_id: `voice:${call.id}:1:2`, source_key: `${call.id}:1`, source_revision: 2 }]);
});

test('answer resolver never trusts model confirmation and binds only latest final user evidence', async () => {
  const input = { session, call, candidates: [candidate], events: [event], existing_answers: [], operation_id: 'operation', now };
  const result = await resolveVoiceAnswers(input);
  assert.equal(result.answers[0].confirmation, 'unconfirmed');
  assert.deepEqual(result.answers[0].event_ids, [event.id]);
  assert.equal(result.answers[0].library_version, session.state.library_version);
  assert.equal(result.answers[0].created_at, now);
  assert.equal('replaces_answer_id' in result.answers[0], false);
  await assert.rejects(resolveVoiceAnswers({ ...input, events: [{ ...event, role: 'assistant' }] }), /delivered/);
  await assert.rejects(resolveVoiceAnswers({ ...input, events: [event, { ...event, id: 'new', source_revision: 1, text: 'Нет', data: { is_final: false } }] }), /delivered/);
  await assert.rejects(resolveVoiceAnswers({ ...input, events: [{ ...event, call_id: 'another-call' }] }), /delivered/);
});

test('ambiguous quotes require matching ordinals; correction target comes only from trusted assessor', async () => {
  const twice = [event, { ...event, id: 'second', source_key: `${call.id}:2`, local_order: 2 }];
  const base = { session, call, candidates: [candidate], events: twice, existing_answers: [], operation_id: 'operation', now };
  await assert.rejects(resolveVoiceAnswers(base), /Ambiguous/);
  const scoped = await resolveVoiceAnswers({ ...base, candidates: [{ ...candidate, source_ordinals: [2] }] });
  assert.deepEqual(scoped.answers[0].event_ids, ['second']);
  await assert.rejects(resolveVoiceAnswers({ ...base, events: [{ ...event, source: 'webhook' }], candidates: [{ ...candidate, source_ordinals: [1] }] }), /delivered/);
  const old = { ...scoped.answers[0], id: 'old-answer' };
  const corrected = await resolveVoiceAnswers({ ...base, events: [event], existing_answers: [old] }, async () => ({ confirmation: 'explicit', replaces_answer_id: old.id }));
  assert.equal(corrected.answers[0].replaces_answer_id, old.id);
  assert.equal(corrected.event.kind, 'correction');
  assert.ok(corrected.answers[0].event_ids.includes(corrected.event.id));
  await assert.rejects(resolveVoiceAnswers({ ...base, events: [event] }, async () => ({ confirmation: 'explicit', replaces_answer_id: 'not-owned' })), /target/);
});

test('voice answers route accepts server-owned metadata through core and rejects evidence bypass', async () => {
  let accepted: AuditAnswer[] = [];
  const ctx = context({ answers: [candidate] }, { accept: async (_request: Request, _body: unknown, acceptedEvent: AuditEvent, answers: AuditAnswer[]) => {
    // Mirrors the actual storage invariant: service/delivery events may not carry answers.
    if (answers.length && ['service', 'delivery'].includes(acceptedEvent.kind)) throw new Error('Service events cannot carry answers');
    assert.equal(acceptedEvent.kind, 'answer'); accepted = answers; return { kind: 'accepted' };
  } });
  await createVoiceHandlers().voiceAnswers(request(), ctx);
  assert.equal(accepted[0].confirmation, 'unconfirmed');
  assert.deepEqual(accepted[0].event_ids, [event.id]);
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), context({ answers: [{ ...candidate, event_ids: ['forged'] }] })), isCode('invalid_voice_payload'));
  const unavailableEvidence = context({ answers: [candidate] }); unavailableEvidence.core.store.listEvents = async () => [];
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), unavailableEvidence), isCode('unresolved_evidence'));
});

test('stored event pagination includes recent evidence beyond the first 1000 rows', async () => {
  const seen: number[] = [];
  const ctx = context();
  ctx.core.store.listEvents = async (_session, after = 0) => { seen.push(after); return after === 0 ? Array.from({ length: 1000 }, (_, i) => ({ ...event, seq: i + 1 })) : [{ ...event, id: 'latest', seq: 1001 }]; };
  const events = await readSessionEvents(ctx.core, session.id);
  assert.equal(events.at(-1)?.id, 'latest'); assert.deepEqual(seen, [0, 1000]);
});

test('pause cannot manufacture provider stop; stopped call uses core.channel', async () => {
  const body = { tool: 'offTopicReply', kind: 'pause', certain: true, safe_category_ids: [] };
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), context(body)), isCode('integration_unavailable'));
  let requests = 0;
  const pending = createVoiceHandlers({ requestPause: async () => { requests++; return { requested: true }; } });
  const result = await pending.voiceAnswers(request(), context(body)) as Record<string, Json>;
  assert.equal(requests, 1); assert.equal(result.stop_required, true); assert.equal(result.pause_pending, true);
  const stopped = context(body); stopped.core.store.getCall = async () => ({ ...call, status: 'stopped' });
  assert.deepEqual(await pending.voiceAnswers(request(), stopped), { kind: 'paused' });
  const fresh = context(body);
  fresh.core.store.getSession = async () => ({ ...session, state: { ...session.state, revision: 3 } });
  fresh.core.view = async current => ({ revision: current.state.revision });
  assert.deepEqual((await pending.voiceAnswers(request(), fresh) as Record<string, Json>).session, { revision: 3 });
});

test('off-topic routes only to humor, and final raw answers must be acknowledged separately', async () => {
  const serviceBody = { tool: 'offTopicReply', kind: 'off_topic', certain: true, safe_category_ids: [] };
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), context(serviceBody)), isCode('integration_unavailable'));
  let receivedKind: string | undefined;
  const service = createVoiceHandlers({ assessServiceIntent: async (_request, _context, input) => {
    assert.equal(input.candidate.kind, 'off_topic'); assert.equal(input.evidence[0].id, event.id);
    return { kind: 'sensitive', certain: true, safe_category_ids: [] };
  } });
  const result = await service.voiceAnswers(request(), context(serviceBody, { humor: async (_request: Request, _body: unknown, intent: { kind: string }) => { receivedKind = intent.kind; return { kind: 'humor' }; } }));
  assert.deepEqual(result, { kind: 'humor' }); assert.equal(receivedKind, 'sensitive');
  const oldCall = context(serviceBody); oldCall.session = { ...session, activeCallId: 'another-local-call' };
  await assert.rejects(service.voiceAnswers(request(), oldCall), isCode('channel_conflict'));
  const finish = createVoiceHandlers().voiceFinish;
  await assert.rejects(finish(request(), context({ reason: 'visitor_request', answers: [candidate] })), isCode('answers_pending'));
  const response = await finish(request(), context({ reason: 'visitor_request' })) as Record<string, Json>;
  assert.equal(response.accepted, true); assert.equal(typeof response.closing_message, 'string');
  await assert.rejects(finish(request(), context({ reason: 'recovery_expired' })), isCode('server_only_reason'));
  await assert.rejects(finish(request(), context({ reason: 'guessed_reason' })), isCode('invalid_voice_payload'));
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), context({ tool: 'offTopicReply', kind: 'finish', certain: true, safe_category_ids: [] })), isCode('finish_required'));
});

test('duplicate answer operation cannot bypass call ownership or an absent request digest', async () => {
  const ctx = context({ answers: [candidate] });
  ctx.core.store.getOperation = async () => ({ event, result: null, requestHash: null });
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), ctx), isCode('operation_payload_conflict'));
  ctx.core.store.getCall = async () => ({ ...call, sessionId: 'another-session' });
  await assert.rejects(createVoiceHandlers().voiceAnswers(request(), ctx), isCode('call_mismatch'));
});

test('HTTP webhook verifies raw body before calling the idempotent core hook', async () => {
  const raw = JSON.stringify({ event: 'call.ended', call: { callId: call.providerCallId, created: '2026-10-22T09:59:00Z', joined: null, ended: '2026-10-22T10:00:00Z', endReason: 'unjoined', billedDuration: null } });
  const stamp = '2026-10-22T10:00:00Z', secret = 'signing-key', signature = createHmac('sha256', secret).update(raw).update(stamp).digest('hex');
  let calls = 0;
  const handler = createVoiceHandlers({ webhookOptions: () => ({ secrets: [secret], now: () => now }), applyProviderEvent: async (_core, payload, source) => { calls++; assert.equal(payload.call.call_id, call.providerCallId); assert.equal(source, 'webhook'); return { accepted: true }; } }).ultravoxWebhook;
  const makeRequest = (signed: boolean) => new Request('https://pixel.example/webhook', { method: 'POST', body: raw, headers: signed ? { 'X-Ultravox-Webhook-Timestamp': stamp, 'X-Ultravox-Webhook-Signature': signature } : {} });
  await assert.rejects(handler(makeRequest(false), context()), isCode('invalid_webhook')); assert.equal(calls, 0);
  assert.deepEqual(await handler(makeRequest(true), context()), { accepted: true }); assert.equal(calls, 1);
});

test('reconcile waits for provider stop and only recovers evidence not already explicitly confirmed', async () => {
  const ctx = context();
  const providerCall: ProviderCall = { provider: 'ultravox', call_id: call.providerCallId!, created_at: now - 12000, joined_at: now - 10000, ended_at: null, end_reason: null, billed_duration: null, billing_status: null };
  let historyReads = 0, recovered: AuditEvent[] = [], applied = 0;
  const otherEvent = { ...event, id: 'uncovered', local_order: 2 };
  const provider = { getCall: async () => providerCall, getCallHistory: async () => { historyReads++; return []; } } as unknown as ReturnType<typeof createVoiceProvider>;
  const answer = { id: 'confirmed', event_ids: [event.id], confirmation: 'explicit' } as AuditAnswer;
  ctx.core.store.listAnswers = async () => [answer];
  const reconcile = createVoiceReconcileHandler({ providerForCall: async () => provider, applyProviderEvent: async (_core, _payload, source) => { applied++; assert.equal(source, 'lookup'); return null; },
    ingestProviderHistory: async () => ({ complete: true, limitations: [], events: [event, otherEvent] }),
    recoverAnswers: async (_core, _session, _call, events) => { recovered = events; return { complete: true, limitations: [] }; },
  });
  assert.equal((await reconcile(session, now, ctx.core)).complete, false); assert.equal(historyReads, 0); assert.equal(applied, 0);
  providerCall.ended_at = now;
  assert.equal((await reconcile(session, now, ctx.core)).complete, true); assert.equal(historyReads, 1); assert.equal(applied, 1);
  assert.deepEqual(recovered.map(item => item.id), ['uncovered']);
});

test('reconcile remains incomplete for unknown creation or missing recovery hooks, without exposing sensitive errors', async () => {
  const ctx = context(); ctx.core.store.listCalls = async () => [{ ...call, status: 'unknown', providerCallId: null }];
  const noHooks = await createVoiceReconcileHandler({})(session, now, ctx.core);
  assert.equal(noHooks.complete, false);
  const failure = await createVoiceReconcileHandler({ providerForCall: async () => { throw new Error('private key and visitor text'); }, applyProviderEvent: async () => null, ingestProviderHistory: async () => ({ complete: true, limitations: [], events: [] }) })(session, now, ctx.core);
  assert.equal(failure.complete, false); assert.equal(JSON.stringify(failure).includes('private'), false);
});

test('reconcile does not treat unconfirmed, disputed or superseded answers as confirmed coverage', async () => {
  const ctx = context();
  const providerCall: ProviderCall = { provider: 'ultravox', call_id: call.providerCallId!, created_at: now - 12000, joined_at: now - 10000, ended_at: now, end_reason: null, billed_duration: null, billing_status: null };
  const provider = { getCall: async () => providerCall, getCallHistory: async () => [] } as unknown as ReturnType<typeof createVoiceProvider>;
  const all = ['old-evidence', 'uncertain-evidence', 'disputed-evidence', 'replacement-evidence'].map((id, index) => ({ ...event, id, local_order: index }));
  ctx.core.store.listAnswers = async () => [
    { id: 'old', event_ids: ['old-evidence'], confirmation: 'explicit' },
    { id: 'uncertain', event_ids: ['uncertain-evidence'], confirmation: 'unconfirmed' },
    { id: 'disputed', event_ids: ['disputed-evidence'], confirmation: 'disputed' },
    { id: 'replacement', event_ids: ['replacement-evidence'], confirmation: 'explicit', replaces_answer_id: 'old' },
  ] as AuditAnswer[];
  let recovered: AuditEvent[] = [];
  const reconcile = createVoiceReconcileHandler({ providerForCall: async () => provider, applyProviderEvent: async () => null,
    ingestProviderHistory: async () => ({ complete: true, limitations: [], events: all }),
    recoverAnswers: async (_core, _session, _call, events) => { recovered = events; return { complete: true, limitations: [] }; },
  });
  assert.equal((await reconcile(session, now, ctx.core)).complete, true);
  assert.deepEqual(recovered.map(item => item.id), ['old-evidence', 'uncertain-evidence', 'disputed-evidence']);
});
