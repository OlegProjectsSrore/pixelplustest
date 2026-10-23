import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreServices } from '../src/core.ts';
import { initialAuditState, type AuditAnswer, type AuditEvent } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { hashToken, HttpError } from '../src/security.ts';
import { SqliteD1 } from './helpers/d1.ts';

const now = Date.parse('2026-10-22T12:00:00Z');
const token = 'a'.repeat(43);
async function fixture(channel: 'chat' | 'voice' = 'chat') {
  const db = new SqliteD1();
  const core = new CoreServices({ DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true' }, () => now);
  const session = await core.store.createSession({ id: 'session', reportId: 'report', tokenHash: await hashToken(token), reportTokenHash: 'report-hash',
    state: initialAuditState(library.version, channel, now), now });
  const event: AuditEvent = { id: 'evidence', source: channel, source_key: 'evidence', source_revision: 0, local_order: 0,
    role: 'user', kind: 'utterance', text: 'Продаём оборудование', occurred_at: now, received_at: now };
  await core.store.commit({ sessionId: session.id, expectedRevision: 0, channelRevision: 0, operationId: 'evidence', event, state: session.state, now });
  const request = new Request('https://audit.example/api/audit/finish', { headers: { Authorization: `Bearer ${token}` } });
  const body = { session_id: session.id, operation_id: 'finish', expected_revision: 1, channel_revision: 0, library_version: library.version,
    reason: 'visitor_request', through_event_id: event.id };
  const answer: AuditAnswer = { id: 'answer', question_id: 'context_business', fact_id: 'context.business', state: 'known', value: 'Продаём оборудование',
    event_ids: [event.id], channel, method: channel === 'chat' ? 'classification' : 'voice_batch', confirmation: 'explicit', library_version: library.version, created_at: now };
  return { db, core, request, body, answer, event };
}
const hasCode = (code: string) => (error: unknown) => error instanceof HttpError && error.code === code;

test('public finish cannot promote unrelated user text or client confirmation into a trusted fact', async () => {
  const f = await fixture();
  try {
    const forged = { ...f.answer, value: 'Выдуманная компания', method: 'recovery' as const, created_at: now + 86_400_000 };
    await assert.rejects(f.core.finish(f.request, { ...f.body, answers: [forged] }), hasCode('untrusted_answers'));
    await assert.rejects(f.core.finish(f.request, { ...f.body, answers: [] }), hasCode('untrusted_answers'));
    assert.equal((await f.core.store.listAnswers('session')).length, 0);
    assert.equal((await f.core.store.requireSession('session')).state.status, 'in_progress');
    assert.equal(await f.core.store.getOperation('session', 'finish'), null);
  } finally { f.db.close(); }
});

test('trusted final packet is validated and accepted once, with original client body hash', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.core.finish(f.request, f.body, { answers: [{ ...f.answer, event_ids: ['missing'] }] }), hasCode('invalid_answers'));
    const accepted = await f.core.finish(f.request, f.body, { answers: [f.answer] }) as any;
    assert.equal(accepted.kind, 'accepted'); assert.equal(accepted.session.status, 'closing');
    const replay = await f.core.finish(f.request, f.body) as any;
    assert.equal(replay.kind, 'duplicate'); assert.equal(replay.replayed, true);
    assert.equal((await f.core.store.listAnswers('session')).length, 1);
    assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM audit_jobs').get()!.n, 1);
    await assert.rejects(f.core.finish(f.request, { ...f.body, reason: 'declined' }), hasCode('operation_payload_conflict'));
  } finally { f.db.close(); }
});

test('insufficient trusted packet commits once and its retry retains clarification rather than closing', async () => {
  const f = await fixture();
  try {
    const body = { ...f.body, reason: 'sufficient' };
    const first = await f.core.finish(f.request, body, { answers: [f.answer] }) as any;
    assert.equal(first.kind, 'clarification_required'); assert.equal(first.replayed, false); assert.equal(first.session.status, 'in_progress');
    const replay = await f.core.finish(f.request, body) as any;
    assert.equal(replay.kind, 'clarification_required'); assert.equal(replay.replayed, true);
    assert.equal(replay.operation.clarification_required, true); assert.equal(replay.session.revision, first.session.revision);
    assert.equal((await f.core.store.listAnswers('session')).length, 1);
    assert.equal(f.db.sqlite.prepare('SELECT count(*) n FROM audit_jobs').get()!.n, 0);
    await assert.rejects(f.core.finish(f.request, { ...body, reason: 'visitor_request' }), hasCode('operation_payload_conflict'));
  } finally { f.db.close(); }
});

test('clarification without a final packet is also recorded and stale revisions cannot request it', async () => {
  const f = await fixture();
  try {
    const body = { ...f.body, reason: 'sufficient' };
    await assert.rejects(f.core.finish(f.request, { ...body, expected_revision: 0 }), hasCode('revision_conflict'));
    await f.core.finish(f.request, body);
    const replay = await f.core.finish(f.request, body) as any;
    assert.equal(replay.kind, 'clarification_required'); assert.equal(replay.replayed, true);
    assert.equal((await f.core.store.listEvents('session')).length, 2);
  } finally { f.db.close(); }
});

test('undelivered final boundary rejects before any trusted answers are written', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.core.finish(f.request, { ...f.body, reason: 'sufficient', through_event_id: 'missing' }, { answers: [f.answer] }), hasCode('pending_events'));
    assert.equal((await f.core.store.listAnswers('session')).length, 0);
    assert.equal((await f.core.store.requireSession('session')).state.revision, 1);
    await assert.rejects(f.core.finish(f.request, { ...f.body, reason: 'recovery_expired' }), hasCode('invalid_reason'));
  } finally { f.db.close(); }
});

test('voice final packet requires current call membership even for an internal caller', async () => {
  const f = await fixture('voice');
  try {
    await assert.rejects(f.core.finish(f.request, f.body, { answers: [f.answer] }), hasCode('invalid_request'));
    await assert.rejects(f.core.finish(f.request, { ...f.body, call_id: 'foreign-call' }, { answers: [f.answer] }), hasCode('call_mismatch'));
    assert.equal((await f.core.store.listAnswers('session')).length, 0);
  } finally { f.db.close(); }
});

test('final boundary after the first 1000 events is resolved from paginated server history', async () => {
  const f = await fixture();
  try {
    const insert = f.db.sqlite.prepare('INSERT INTO audit_events(id,session_id,seq,source,source_event_key,source_revision,source_order,role,type,payload_json,source_timestamp,received_at,operation_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
    for (let seq = 2; seq <= 1001; seq++) {
      const event = { ...f.event, id: `event-${seq}`, source_key: `event-${seq}`, local_order: seq, seq };
      insert.run(event.id, 'session', seq, 'chat', event.source_key, 0, seq, 'user', 'utterance', JSON.stringify(event), now, now, event.id);
    }
    const session = await f.core.store.requireSession('session');
    const state = { ...session.state, through_seq: 1001 };
    f.db.sqlite.prepare('UPDATE audit_sessions SET last_seq=?,state_json=? WHERE id=?').run(1001, JSON.stringify(state), 'session');
    const result = await f.core.finish(f.request, { ...f.body, through_event_id: 'event-1001' }, { answers: [{ ...f.answer, event_ids: ['event-1001'] }] }) as any;
    assert.equal(result.kind, 'accepted'); assert.equal(result.session.status, 'closing');
    assert.deepEqual((await f.core.store.listAnswers('session'))[0]!.event_ids, ['event-1001']);
  } finally { f.db.close(); }
});
