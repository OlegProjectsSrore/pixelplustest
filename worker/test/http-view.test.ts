import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/d1.ts';
import { CoreServices } from '../src/core.ts';
import { initialAuditState } from '../src/audit/contracts.ts';
import type { AuditEvent, Json } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { presentPayload, sessionView } from '../src/http-view.ts';

const createdAt = Date.parse('2026-10-22T12:00:00Z');
function object(value: Json): Record<string, Json> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, Json>;
}

async function fixture() {
  const db = new SqliteD1(); let now = createdAt;
  const core = new CoreServices({ DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true' }, () => now);
  const session = await core.store.createSession({ id: 'session', reportId: 'report', tokenHash: 'private-token-hash', reportTokenHash: 'report-token-hash',
    state: initialAuditState(library.version, 'chat', now), now });
  return { db, core, session, setNow(value: number) { now = value; } };
}

async function append(core: CoreServices, id: string, role: AuditEvent['role'], kind: AuditEvent['kind'], text?: string, data?: Json) {
  const session = await core.store.requireSession('session');
  await core.store.commit({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: session.state.channel_revision,
    operationId: id, now: core.now(), state: session.state,
    event: { id, source: role === 'system' ? 'system' : 'chat', source_key: id, source_revision: 0, local_order: 0,
      role, kind, text, data, occurred_at: core.now(), received_at: core.now() } });
}

test('SessionView uses HTTP v1 fields and question options without exposing audit internals', async () => {
  const f = await fixture();
  try {
    const view = object(await sessionView(f.core, f.session));
    assert.equal(view.api_version, '1'); assert.equal(view.server_time, createdAt); assert.equal(view.remaining_seconds, 900);
    assert.equal(view.expires_at, createdAt + 86_400_000);
    assert.equal(view.remaining_ms, 900_000); assert.equal(view.elapsed_ms, 0); assert.equal(view.access_expires_at, view.expires_at);
    assert.deepEqual(object(view.report!).id, 'report');
    assert.equal(view.report_id, object(view.report!).id); assert.equal(view.report_status, object(view.report!).status);
    assert.equal(view.active_channel, 'chat'); assert.equal(view.voice, null);
    const question = object(view.question!);
    assert.equal(typeof question.text, 'string'); assert.ok(['text', 'number', 'single', 'multiple'].includes(String(question.answer_mode)));
    assert.ok(Array.isArray(question.options));
    for (const item of question.options) assert.deepEqual(Object.keys(object(item)).sort(), ['id', 'label', 'text']);
    assert.deepEqual(question.fact_ids, ['context.name']);
    const serialized = JSON.stringify(view);
    for (const secret of ['tokenHash', 'private-token-hash', 'candidate_blocks', 'contradictions', 'result_json', 'content_json']) assert.equal(serialized.includes(secret), false);
    assert.equal(object(view.capabilities!).finish, true);
  } finally { f.db.close(); }
});

test('history is stable and ordered; system data and report payloads are never messages', async () => {
  const f = await fixture();
  try {
    await append(f.core, 'user-one', 'user', 'utterance', 'Сведения посетителя');
    await append(f.core, 'assistant-one', 'assistant', 'utterance', 'Какую задачу нужно решить?');
    await append(f.core, 'internal-one', 'system', 'service', 'Служебный секрет', { report_content: 'Заключение только в PDF' });
    const session = await f.core.store.requireSession('session');
    const first = object(await sessionView(f.core, session)); const second = object(await sessionView(f.core, session));
    assert.deepEqual(first.messages, second.messages);
    const messages = first.messages as Json[];
    assert.deepEqual(messages.map(message => object(message).id), ['user-one', 'assistant-one']);
    assert.deepEqual(messages.map(message => object(message).seq), [1, 2]);
    assert.equal(JSON.stringify(first).includes('Служебный секрет'), false);
    assert.equal(JSON.stringify(first).includes('Заключение только в PDF'), false);
  } finally { f.db.close(); }
});

test('report-token view does not read history or question and exposes no control capabilities', async () => {
  const f = await fixture();
  try {
    await append(f.core, 'private', 'user', 'utterance', 'Приватная история');
    const session = await f.core.store.requireSession('session');
    f.core.store.listEvents = async () => { throw new Error('read-only view must not query history'); };
    f.core.view = async () => { throw new Error('read-only view must not compute interview question'); };
    const view = object(await sessionView(f.core, session, true));
    assert.deepEqual(view.messages, []); assert.equal(view.question, null); assert.equal(view.voice, null); assert.equal(view.active_channel, null);
    assert.equal(view.remaining_seconds, 0); assert.equal(view.remaining_ms, 0); assert.equal(view.access_expires_at, 0);
    assert.ok(Object.values(object(view.capabilities!)).every(value => value === false));
    const output = object(await presentPayload(f.core, { session: { session_id: 'session' }, management_token: 'do-not-return', report_token: 'also-hidden', join_url: 'sensitive',
      provider_call_id: 'private-call', through_event_id: 'private-event', accepted_events: [{ event_id: 'private-event', source_key: 'private-call:0', source_revision: 0 }],
      corpus: 'private-corpus', snippets: [{ id: 'chunk', title: 'title', heading: 'heading', url: 'https://pixelplus.ru/', text: 'private-snippet' }] }, true));
    assert.deepEqual(Object.keys(output), ['session']);
    assert.equal(JSON.stringify(output).includes('Приватная история'), false); assert.equal(JSON.stringify(output).includes('do-not-return'), false);
  } finally { f.db.close(); }
});

test('creation token aliases stay private to creation and replay returns the current revision', async () => {
  const f = await fixture();
  try {
    await append(f.core, 'one', 'user', 'utterance', 'Ответ');
    const payload = object(await presentPayload(f.core, { session: { session_id: 'session', revision: 0 }, management_token: 'new-token', report_token: 'read-token' }));
    assert.equal(payload.session_token, 'new-token'); assert.equal(payload.management_token, payload.session_token);
    assert.equal(payload.session_token_expires_at, createdAt + 86_400_000); assert.equal(payload.report_token_expires_at, createdAt + 86_400_000);
    assert.equal(object(payload.session!).revision, 1);
    const replay = object(await presentPayload(f.core, { kind: 'duplicate', session: { session_id: 'session', revision: 0 }, operation: { revision: 0, result: 'private report' } }));
    assert.equal(replay.replayed, true); assert.equal(object(replay.session!).revision, 1);
    assert.equal(replay.kind, 'duplicate'); assert.equal('management_token' in replay, false); assert.equal('session_token' in replay, false);
    assert.equal('result' in object(replay.operation!), false);
    assert.deepEqual(await presentPayload(f.core, { status: 'unknown', id: 'email', duplicate: true }), { status: 'unknown', delivery_status: 'delivery_unknown', id: 'email', replayed: true });
  } finally { f.db.close(); }
});

test('chat timer stays fixed; voice timer keeps millisecond precision and option labels support both client formats', async () => {
  const f = await fixture();
  try {
    f.setNow(createdAt + 1234);
    f.core.view = async () => ({ question: { id: 'question', text: 'Вопрос', fact_ids: [library.facts[0]!.id], options: [{ id: 'option', text: 'Вариант', rule: 'hidden-rule' }] } });
    const view = object(await sessionView(f.core, f.session));
    assert.equal(view.remaining_seconds, 900); assert.equal(view.remaining_ms, 900_000); assert.equal(view.elapsed_ms, 0);
    f.session.state.active_channel = 'voice'; f.session.state.paused = false; f.session.state.active_since = createdAt;
    const voiceView = object(await sessionView(f.core, f.session));
    assert.equal(voiceView.remaining_seconds, 898); assert.equal(voiceView.remaining_ms, 898_766); assert.equal(voiceView.elapsed_ms, 1234);
    const question = object(view.question!);
    assert.deepEqual(question.options, [{ id: 'option', label: 'Вариант', text: 'Вариант' }]);
    assert.deepEqual(question.fact_ids, [library.facts[0]!.id]); assert.equal(JSON.stringify(view).includes('hidden-rule'), false);
  } finally { f.db.close(); }
});

test('transcript acknowledgement preserves the committed boundary and source revisions without evidence content', async () => {
  const f = await fixture();
  try {
    const payload = object(await presentPayload(f.core, { kind: 'accepted', session: { session_id: 'session' }, through_event_id: 'event-final',
      accepted_event_ids: ['event-partial', 'event-final'], accepted_events: [
        { event_id: 'event-partial', source_key: 'call:0', source_revision: 0, text: 'private text', data: { secret: true } },
        { event_id: 'event-final', source_key: 'call:0', source_revision: 1, received_at: createdAt },
        { event_id: 'invalid', source_key: 'call:1', source_revision: -1 },
      ], answers: [{ value: 'private interpretation' }] }));
    assert.equal(payload.through_event_id, 'event-final'); assert.deepEqual(payload.accepted_event_ids, ['event-partial', 'event-final']);
    assert.deepEqual(payload.accepted_events, [{ event_id: 'event-partial', source_key: 'call:0', source_revision: 0 }, { event_id: 'event-final', source_key: 'call:0', source_revision: 1 }]);
    assert.equal(JSON.stringify(payload).includes('private'), false); assert.equal('answers' in payload, false);
    const legacy = object(await presentPayload(f.core, { through_event_id: 'event-final', accepted_event_ids: ['event-final'] }));
    assert.deepEqual(legacy, { through_event_id: 'event-final', accepted_event_ids: ['event-final'] });
  } finally { f.db.close(); }
});

test('reference search returns public snippet fields without document paths or index internals', async () => {
  const f = await fixture();
  try {
    const snippet = { id: 'chunk-id', title: 'Pixel Plus', heading: 'Услуги', url: 'https://pixelplus.ru/services/', text: 'Одобренный справочный текст' };
    const payload = await presentPayload(f.core, { corpus: 'corpus-hash', snippets: [{ ...snippet, path: 'secret-document.md', score: 12, metadata: { token: 'hidden' } }, { id: 'incomplete' }], index: 'private index' });
    assert.deepEqual(payload, { corpus: 'corpus-hash', snippets: [snippet] });
  } finally { f.db.close(); }
});

test('voice responses preserve control fields and distinguish server call ID from provider ID', async () => {
  const f = await fixture();
  try {
    f.core.store.getCall = async () => ({ id: 'server-call', providerCallId: 'provider-call', sessionId: 'session', slotId: 'private-slot', previousCallId: null,
      channelRevision: 0, status: 'active', reservedMs: 1000, startedAt: createdAt, endedAt: null, stoppedRevision: null, usedMs: 0, historyStatus: 'pending', operationId: 'private-operation', createdAt });
    const view = object(await sessionView(f.core, { ...f.session, activeCallId: 'server-call' }));
    assert.deepEqual(view.voice, { call_id: 'server-call', provider_call_id: 'provider-call', status: 'active' });
    assert.equal(JSON.stringify(view).includes('private-slot'), false);
    const started = await presentPayload(f.core, { call_id: 'server-call', provider_call_id: 'provider-call', join_url: 'wss://join.example/call', join_cipher: 'private-cipher', api_key: 'private-key' });
    assert.deepEqual(started, { call_id: 'server-call', provider_call_id: 'provider-call', join_url: 'wss://join.example/call' });
    const stopping = await presentPayload(f.core, { status: 'stopping', stop_required: true, message: 'Завершите голосовое соединение.' });
    assert.deepEqual(stopping, { status: 'stopping', stop_required: true, message: 'Завершите голосовое соединение.' });
    assert.deepEqual(await presentPayload(f.core, { accepted: true, replayed: true, signature: 'private-signature' }), { accepted: true, replayed: true });
  } finally { f.db.close(); }
});

test('management expiry disables interview; accepted report remains readable with its separate expiry', async () => {
  const f = await fixture();
  try {
    f.setNow(createdAt + 86_400_000);
    const expired = object(await sessionView(f.core, f.session));
    assert.equal(expired.status, 'expired'); assert.equal(expired.question, null);
    assert.ok(Object.values(object(expired.capabilities!)).every(value => value === false));
    const accepted = { ...f.session, state: { ...f.session.state, status: 'preparing' as const } };
    f.db.sqlite.prepare("UPDATE reports SET status='preparing',prepare_deadline=? WHERE id='report'").run(createdAt + 2 * 86_400_000);
    const readOnly = object(await sessionView(f.core, accepted, true));
    assert.equal(readOnly.status, 'preparing'); assert.equal(readOnly.expires_at, createdAt + 2 * 86_400_000);
    assert.equal(object(readOnly.report!).status, 'preparing');
  } finally { f.db.close(); }
});
