import test from 'node:test';
import assert from 'node:assert/strict';
import { D1Store, StoreError } from '../src/storage/d1-store.ts';
import { initialAuditState, INTERVIEW_BUDGET_MS, type AuditAnswer, type AuditEvent, type AuditSnapshot } from '../src/audit/contracts.ts';
import { SqliteD1 } from './helpers/d1.ts';

const NOW = 1700000000000;
function event(id: string, kind: AuditEvent['kind'] = 'answer'): AuditEvent {
  return { id, source: 'chat', source_key: id, source_revision: 0, local_order: 0, role: 'user', kind, occurred_at: NOW, received_at: NOW };
}
function answer(id: string, eventId: string): AuditAnswer {
  return { id, question_id: 'q1', answer_id: 'a1', fact_id: 'f1', state: 'known', value: true, event_ids: [eventId], channel: 'chat', method: 'selection', confirmation: 'explicit', library_version: '1.0', created_at: NOW };
}
async function setup(channel: 'chat' | 'voice' = 'chat') {
  const db = new SqliteD1(); const store = new D1Store(db.binding());
  const session = await store.createSession({ id: 's1', tokenHash: 'sessionhash', reportId: 'r1', reportTokenHash: 'reporthash', state: initialAuditState('1.0', channel, NOW), now: NOW });
  return { db, store, session };
}
function count(db: SqliteD1, table: string): number { return Number(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n); }

test('concurrent CAS loser inserts neither event nor answer; source retries do not duplicate', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  const base = { sessionId: 's1', expectedRevision: 0, channelRevision: 0, state: session.state, now: NOW + 1000 };
  const results = await Promise.all([
    store.commit({ ...base, operationId: 'op1', event: event('e1'), answers: [answer('a1', 'e1')] }),
    store.commit({ ...base, operationId: 'op2', event: event('e2'), answers: [answer('a2', 'e2')] }),
  ]);
  assert.deepEqual(results.map(r => r.kind).sort(), ['accepted', 'conflict']);
  assert.equal(count(db, 'audit_answers'), 1); assert.equal(count(db, 'audit_events'), 1);
  const winner = results.findIndex(r => r.kind === 'accepted') + 1;
  const duplicate = await store.commit({ ...base, operationId: 'different-client-key', event: event(`e${winner}`) });
  assert.equal(duplicate.kind, 'duplicate'); assert.equal(count(db, 'audit_events'), 1);
});

test('same operation racing creates one event and returns stored result', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  const input = { sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'same', event: event('same'), answers: [answer('a1', 'same')], state: session.state, now: NOW + 100 };
  const results = await Promise.all([store.commit(input), store.commit(input)]);
  assert.deepEqual(results.map(r => r.kind).sort(), ['accepted', 'duplicate']);
  assert.deepEqual(results[0].result, results[1].result); assert.equal(count(db, 'audit_answers'), 1);
});

test('SQL error rolls back the revision, event, and all dependent inserts', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  const a = answer('a1', 'e1');
  await assert.rejects(store.commit({ sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'op1', event: event('e1'), answers: [a, a], state: session.state, now: NOW + 100 }));
  assert.equal((await store.requireSession('s1')).state.revision, 0); assert.equal(count(db, 'audit_events'), 0); assert.equal(count(db, 'audit_answers'), 0);
});

test('pause and resume preserve the shared budget and reject answers after the limit', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  const pause = await store.pause({ sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'pause', now: NOW + 10000 });
  assert.equal(pause.session.state.elapsed_ms, 10000); assert.equal(pause.session.state.active_since, null);
  const resume = await store.changeChannel({ sessionId: 's1', expectedRevision: 1, channelRevision: 0, operationId: 'resume', channel: 'chat', now: NOW + 50000 });
  assert.equal(resume.session.state.elapsed_ms, 10000); assert.equal(resume.session.state.channel_revision, 1);
  await assert.rejects(store.commit({ sessionId: 's1', expectedRevision: 2, channelRevision: 1, operationId: 'late', state: resume.session.state, event: event('late'), now: NOW + 50000 + INTERVIEW_BUDGET_MS }), (error: unknown) => error instanceof StoreError && error.code === 'time_limit');
  assert.equal(await store.closeExpiredSessions(NOW + 50000 + INTERVIEW_BUDGET_MS), 1);
  assert.equal(await store.closeExpiredSessions(NOW + 50000 + INTERVIEW_BUDGET_MS + 1), 0);
  assert.equal(count(db, 'audit_jobs'), 1);
});

test('finish races create one job, while a lost finish CAS cannot update report', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  const base = { sessionId: 's1', expectedRevision: 0, channelRevision: 0, state: session.state, now: NOW + 100, reason: 'visitor_request' };
  const results = await Promise.all([store.finish({ ...base, operationId: 'f1', event: event('f1', 'finish') }), store.finish({ ...base, operationId: 'f2', event: event('f2', 'finish') })]);
  assert.equal(results.filter(r => r.kind === 'accepted').length, 1); assert.equal(count(db, 'audit_jobs'), 1); assert.equal((await store.getReport('r1'))!.status, 'closing');
});

test('stale job owner cannot publish, and stale snapshot cannot drop concurrent events', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  await store.finish({ sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'f', event: event('f', 'finish'), state: session.state, now: NOW + 10, reason: 'visitor_request' });
  const jobId = 'audit:r1:1';
  await store.claimJob(jobId, 'old', NOW + 20, 100);
  await store.claimJob(jobId, 'new', NOW + 121, 1000);
  assert.equal(await store.checkpointJob(jobId, 'old', NOW + 122, { state: 'done', reportPatch: { status: 'ready', kvKey: 'invalid' } }), false);
  assert.equal((await store.getReport('r1'))!.status, 'closing');
  const state = (await store.requireSession('s1')).state;
  const snapshot: AuditSnapshot = { id: 'snap1', session_id: 's1', library_version: '1.0', created_at: NOW + 130, through_seq: state.through_seq, answers: [], state, limitations: [] };
  db.beforeBatch = () => { db.beforeBatch = null; db.sqlite.prepare('UPDATE audit_sessions SET revision=revision+1 WHERE id=?').run('s1'); };
  assert.equal(await store.checkpointJob(jobId, 'new', NOW + 130, { expectedSessionRevision: state.revision, snapshot: { data: snapshot, hash: 'hash' }, stage: 'analyze', reportPatch: { snapshotId: 'snap1', status: 'preparing' } }), false);
  assert.equal(count(db, 'audit_snapshots'), 0); assert.equal((await store.getJob(jobId))!.stage, 'reconcile'); assert.equal((await store.getReport('r1'))!.snapshotId, null);
});

test('snapshot and stage are atomically persisted, immutable, and old lease cannot overwrite content', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  await store.finish({ sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'f', event: event('f', 'finish'), state: session.state, now: NOW + 10, reason: 'visitor_request' });
  const jobId = 'audit:r1:1'; await store.claimJob(jobId, 'owner', NOW + 20, 1000);
  const state = (await store.requireSession('s1')).state;
  const snapshot: AuditSnapshot = { id: 'snap1', session_id: 's1', library_version: '1.0', created_at: NOW + 30, through_seq: 1, answers: [], state, limitations: [] };
  assert.equal(await store.checkpointJob(jobId, 'owner', NOW + 30, { expectedSessionRevision: state.revision, snapshot: { data: snapshot, hash: 'hash' }, stage: 'analyze', reportPatch: { snapshotId: 'snap1', status: 'preparing' } }), true);
  assert.equal((await store.getSnapshot('snap1'))!.id, 'snap1'); assert.equal((await store.getJob(jobId))!.stage, 'analyze');
  assert.throws(() => db.sqlite.prepare('UPDATE audit_snapshots SET hash=? WHERE id=?').run('bad', 'snap1'));
  assert.equal(await store.checkpointJob(jobId, 'owner', NOW + 40, { stage: 'render', reportPatch: { content: { html: 'saved' }, contentHash: 'content' } }), true);
  await assert.rejects(store.checkpointJob(jobId, 'owner', NOW + 50, { reportPatch: { content: { html: 'new' } } }), /cannot be replaced/);
});

test('usage quota reserves atomically and unknown outcomes retain the reservation', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  const base = { period: 'day1', kind: 'pdf_renders', amount: 1, limit: 1, now: NOW, expiresAt: NOW + 86400000 };
  const results = await Promise.all([store.reserveUsage({ ...base, id: 'u1' }), store.reserveUsage({ ...base, id: 'u2' })]);
  assert.equal(results.filter(Boolean).length, 1); const winner = results.find(Boolean)!;
  assert.equal(await store.settleUsage(winner.id, null, NOW + 1), true);
  assert.equal(await store.reserveUsage({ ...base, id: 'u3' }), null);
  assert.equal(await store.settleUsage(winner.id, 0, NOW + 2), true);
  assert.ok(await store.reserveUsage({ ...base, id: 'u4' }));
  assert.equal(await store.settleUsage(winner.id, 0, NOW + 3), false);
});

test('email operation deduplication, session cap, and expired SMTP sending becomes unknown', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  db.sqlite.prepare("UPDATE reports SET status='ready',report_expires_at=?,published_at=? WHERE id='r1'").run(NOW + 86400000, NOW);
  const base = { sessionId: 's1', reportId: 'r1', recipient: 'a@example.test', consent: { accepted: true }, now: NOW };
  const results = await Promise.all([store.enqueueEmail({ ...base, id: 'm1', operationId: 'o1' }), store.enqueueEmail({ ...base, id: 'm2', operationId: 'o2' }), store.enqueueEmail({ ...base, id: 'm3', operationId: 'o3' })]);
  assert.equal(results.filter(r => r.kind === 'accepted').length, 2);
  assert.equal((await store.enqueueEmail({ ...base, id: 'm4', operationId: 'o1' })).kind, 'duplicate');
  assert.ok(await store.claimEmail('m1', 'sender', NOW + 1, 100));
  assert.equal(await store.claimEmail('m1', 'other', NOW + 2, 100), null);
  assert.equal(await store.markEmailSending('m1', 'sender', NOW + 3), true);
  assert.equal(await store.checkpointEmail('m1', 'sender', NOW + 4, { status: 'pending' }), false);
  assert.equal(await store.recoverExpiredSending(NOW + 102), 1);
  assert.equal((await store.getEmail('m1'))!.status, 'unknown'); assert.equal(await store.claimEmail('m1', 'new', NOW + 103, 100), null);
});

test('voice slots and channel ownership prevent overlapping calls and preserve elapsed time', async t => {
  const { db, store } = await setup('voice'); t.after(() => db.close());
  await store.updateVoiceSlot({ id: 'slot1', availableMs: 1000000, maxConcurrency: 1, now: NOW });
  const base = { sessionId: 's1', slotId: 'slot1', expectedRevision: 0, channelRevision: 0, now: NOW, slotMaxAgeMs: 60000 };
  const calls = await Promise.all([store.reserveVoiceCall({ ...base, id: 'c1', operationId: 'v1' }), store.reserveVoiceCall({ ...base, id: 'c2', operationId: 'v2' })]);
  assert.equal(calls.filter(Boolean).length, 1); const call = calls.find(Boolean)!;
  assert.equal(await store.attachCall(call.id, 'provider1', NOW + 10), true);
  const session = await store.requireSession('s1');
  await assert.rejects(store.changeChannel({ sessionId: 's1', expectedRevision: session.state.revision, channelRevision: 0, operationId: 'switch', now: NOW + 20, channel: 'chat' }), /confirmed voice/);
  assert.equal(await store.confirmCallStopped(call.id, NOW + 1010), true);
  assert.equal(await store.confirmCallStopped(call.id, NOW + 2010), false);
  const stopped = await store.requireSession('s1'); assert.equal(stopped.state.elapsed_ms, 1000);
  const changed = await store.changeChannel({ sessionId: 's1', expectedRevision: stopped.state.revision, channelRevision: 0, operationId: 'switch', now: NOW + 5000, channel: 'chat' });
  assert.equal(changed.session.state.elapsed_ms, 1000); assert.equal(changed.session.state.channel_revision, 1);
});

test('report read permission outlives session management but not the original retention', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  db.sqlite.prepare("UPDATE reports SET status='ready',report_expires_at=?,published_at=? WHERE id='r1'").run(NOW + 3 * 86400000, NOW);
  assert.equal(await store.authenticateSession('s1', 'sessionhash', NOW + 86400001), null);
  assert.ok(await store.findReportByTokenHash('reporthash', NOW + 86400001));
  assert.equal(await store.addReportAccessToken('r1', 'mailhash', 'email', NOW), true);
  assert.ok(await store.findReportByTokenHash('reporthash', NOW + 1)); assert.ok(await store.findReportByTokenHash('mailhash', NOW + 1));
  assert.equal(await store.findReportByTokenHash('reporthash', NOW + 3 * 86400000), null);
  assert.equal(await store.cleanup(NOW + 3 * 86400000), 1); assert.equal(count(db, 'report_access_tokens'), 0);
});

test('lease stolen after reads makes every checkpoint dependent write a no-op', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  await store.finish({ sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'f', event: event('f', 'finish'), state: session.state, now: NOW + 10, reason: 'visitor_request' });
  const id = 'audit:r1:1'; await store.claimJob(id, 'old-owner', NOW + 20, 1000);
  db.beforeBatch = () => { db.beforeBatch = null; db.sqlite.prepare('UPDATE audit_jobs SET lease_token=? WHERE id=?').run('new-owner', id); };
  assert.equal(await store.checkpointJob(id, 'old-owner', NOW + 30, { state: 'done', reportPatch: { status: 'ready', kvKey: 'wrong-key' } }), false);
  assert.equal((await store.getReport('r1'))!.kvKey, null); assert.equal((await store.getReport('r1'))!.status, 'closing');
  assert.equal((await store.requireSession('s1')).state.status, 'closing'); assert.equal((await store.getJob(id))!.leaseToken, 'new-owner');
});

test('humor reservation, delivery, and disabled preference survive retries and channel changes', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  const next = structuredClone(session.state);
  next.humor.reserved_ids.push('joke1');
  next.humor.operations.j1 = { joke_id: 'joke1', text: 'Prepared text', status: 'reserved', question_id: null };
  const input = { sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'j1', event: event('j1', 'service'), state: next, now: NOW + 1, result: { text: 'Prepared text' } };
  const results = await Promise.all([store.commit(input), store.commit(input)]);
  assert.deepEqual(results.map(r => r.kind).sort(), ['accepted', 'duplicate']); assert.equal(count(db, 'audit_answers'), 0);
  const delivery = structuredClone((await store.requireSession('s1')).state);
  delivery.humor.operations.j1.status = 'delivered'; delivery.humor.used_ids.push('joke1'); delivery.humor.enabled = false;
  await store.commit({ sessionId: 's1', expectedRevision: 1, channelRevision: 0, operationId: 'ack', event: event('ack', 'delivery'), state: delivery, now: NOW + 2 });
  const switched = await store.changeChannel({ sessionId: 's1', expectedRevision: 2, channelRevision: 0, operationId: 'switch', channel: 'voice', now: NOW + 3 });
  assert.equal(switched.session.state.humor.enabled, false); assert.deepEqual(switched.session.state.humor.reserved_ids, ['joke1']); assert.deepEqual(switched.session.state.humor.used_ids, ['joke1']);
  assert.equal((await store.commit(input)).kind, 'duplicate'); assert.equal(count(db, 'audit_answers'), 0);
});

test('late evidence after a snapshot changes only the event log and keeps the snapshot immutable', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  await store.finish({ sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'f', event: event('f', 'finish'), state: session.state, now: NOW + 10, reason: 'visitor_request' });
  await store.claimJob('audit:r1:1', 'owner', NOW + 20, 1000);
  const state = (await store.requireSession('s1')).state;
  const snapshot: AuditSnapshot = { id: 'snap1', session_id: 's1', library_version: '1.0', created_at: NOW + 30, through_seq: state.through_seq, answers: [], state, limitations: [] };
  await store.checkpointJob('audit:r1:1', 'owner', NOW + 30, { expectedSessionRevision: state.revision, snapshot: { data: snapshot, hash: 'hash' }, stage: 'analyze', reportPatch: { snapshotId: 'snap1', status: 'preparing' } });
  const current = await store.requireSession('s1');
  const late = await store.appendLateEvent({ sessionId: 's1', expectedRevision: current.state.revision, channelRevision: 0, operationId: 'late', event: event('late', 'utterance'), now: NOW + 40 });
  assert.equal(late.kind, 'accepted'); assert.equal((await store.getSnapshot('snap1'))!.through_seq, 1); assert.equal(late.session.state.through_seq, 2);
  assert.equal(count(db, 'audit_answers'), 0); assert.deepEqual(late.session.state.facts, {}); assert.equal(late.session.state.status, 'preparing');
});

test('voice keeps counting through accepted finish until provider confirms its stop', async t => {
  const { db, store } = await setup('voice'); t.after(() => db.close());
  await store.updateVoiceSlot({ id: 'slot1', availableMs: 1000000, maxConcurrency: 1, now: NOW });
  await store.reserveVoiceCall({ id: 'c1', sessionId: 's1', slotId: 'slot1', operationId: 'v1', expectedRevision: 0, channelRevision: 0, now: NOW, slotMaxAgeMs: 60000 });
  await store.attachCall('c1', 'provider1', NOW + 10);
  const current = await store.requireSession('s1');
  await store.finish({ sessionId: 's1', expectedRevision: current.state.revision, channelRevision: 0, operationId: 'f', event: event('f', 'finish'), state: current.state, now: NOW + 1000, reason: 'visitor_request' });
  assert.equal((await store.requireSession('s1')).state.active_since, NOW + 1000);
  await store.confirmCallStopped('c1', NOW + 2010);
  assert.equal((await store.requireSession('s1')).state.elapsed_ms, 2000);
});

test('render start interval applies across daily counter rollover', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  const base = { kind: 'pdf_renders', amount: 1, limit: 10, expiresAt: NOW + 86400000, minIntervalMs: 10000 };
  assert.ok(await store.reserveUsage({ ...base, id: 'last-yesterday', period: 'yesterday', now: NOW }));
  assert.equal(await store.reserveUsage({ ...base, id: 'first-today', period: 'today', now: NOW + 1000 }), null);
  assert.ok(await store.reserveUsage({ ...base, id: 'first-today', period: 'today', now: NOW + 10000 }));
});

test('operation retries require the original request hash, including concurrent contenders', async t => {
  const { db, store, session } = await setup(); t.after(() => db.close());
  const base = { sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'same-operation', state: session.state, event: event('hash-event'), now: NOW + 1 };
  const outcomes = await Promise.allSettled([
    store.commit({ ...base, requestHash: 'body-a' }),
    store.commit({ ...base, requestHash: 'body-b' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof StoreError); assert.equal(rejected.reason.code, 'operation_payload_conflict');
  const persisted = (await store.getOperation('s1', base.operationId))!;
  assert.ok(persisted.requestHash);
  assert.equal((await store.commit({ ...base, requestHash: persisted.requestHash! })).kind, 'duplicate');
  await assert.rejects(store.commit(base), (error: unknown) => error instanceof StoreError && error.code === 'operation_payload_conflict');
  assert.equal(count(db, 'audit_events'), 1); assert.equal((await store.requireSession('s1')).state.revision, 1);
});

test('pause and channel changes retain and compare the request hash before replay', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  const pause = { sessionId: 's1', expectedRevision: 0, channelRevision: 0, operationId: 'pause-hash', now: NOW + 1, requestHash: 'pause-body' };
  await store.pause(pause);
  assert.equal((await store.pause(pause)).kind, 'duplicate');
  await assert.rejects(store.pause({ ...pause, requestHash: 'changed-pause' }), (error: unknown) => error instanceof StoreError && error.code === 'operation_payload_conflict');
  const change = { sessionId: 's1', expectedRevision: 1, channelRevision: 0, operationId: 'channel-hash', now: NOW + 2, channel: 'chat' as const, requestHash: 'chat-body' };
  await store.changeChannel(change);
  assert.equal((await store.changeChannel(change)).kind, 'duplicate');
  await assert.rejects(store.changeChannel({ ...change, channel: 'voice', requestHash: 'voice-body' }), (error: unknown) => error instanceof StoreError && error.code === 'operation_payload_conflict');
  assert.equal((await store.requireSession('s1')).state.active_channel, 'chat');
});

test('email request hash prevents changing a recipient under the accepted operation key', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  db.sqlite.prepare("UPDATE reports SET status='ready',report_expires_at=?,published_at=? WHERE id='r1'").run(NOW + 86400000, NOW);
  const base = { sessionId: 's1', reportId: 'r1', operationId: 'same-mail', consent: { accepted: true }, now: NOW };
  const outcomes = await Promise.allSettled([
    store.enqueueEmail({ ...base, id: 'm1', recipient: 'first@example.test', requestHash: 'mail-a' }),
    store.enqueueEmail({ ...base, id: 'm2', recipient: 'second@example.test', requestHash: 'mail-b' }),
  ]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.code, 'operation_payload_conflict'); assert.equal(count(db, 'email_jobs'), 1);
  const accepted = outcomes.find(result => result.status === 'fulfilled') as PromiseFulfilledResult<Awaited<ReturnType<typeof store.enqueueEmail>>>;
  const job = accepted.value.job!;
  assert.equal((await store.getExistingEmail('s1', base.operationId, job.requestHash!))!.id, job.id);
  assert.equal((await store.enqueueEmail({ ...base, id: 'm3', recipient: job.recipient, requestHash: job.requestHash! })).kind, 'duplicate');
  await assert.rejects(store.getExistingEmail('s1', base.operationId, 'other-body'), (error: unknown) => error instanceof StoreError && error.code === 'operation_payload_conflict');
});

test('exactly one concurrent usage reservation caller owns permission to start a provider call', async t => {
  const { db, store } = await setup(); t.after(() => db.close());
  const input = { id: 'one-provider-call', kind: 'deepseek_calls', period: 'day', amount: 1, limit: 10, now: NOW, expiresAt: NOW + 86400000 };
  const attempts = await Promise.all([store.reserveUsage(input), store.reserveUsage(input)]);
  assert.deepEqual(attempts.map(reservation => reservation!.newlyCreated).sort(), [false, true]);
  assert.equal((await store.reserveUsage(input))!.newlyCreated, false);
  assert.equal(Number(db.sqlite.prepare('SELECT reserved FROM usage_counters WHERE kind=?').get('deepseek_calls')!.reserved), 1);
  await store.settleUsage(input.id, null, NOW + 1);
  assert.equal((await store.reserveUsage(input))!.state, 'unknown'); assert.equal((await store.reserveUsage(input))!.newlyCreated, false);
  await store.settleUsage(input.id, 1, NOW + 2);
  assert.equal((await store.reserveUsage(input))!.newlyCreated, false); assert.equal(count(db, 'usage_reservations'), 1);
});

test('stop revision and slot release share one CAS; an intervening revision cannot release another owner', async t => {
  const { db, store } = await setup('voice'); t.after(() => db.close());
  await store.updateVoiceSlot({ id: '1', availableMs: 900000, maxConcurrency: 1, now: NOW });
  await store.reserveVoiceCall({ id: 'c1', sessionId: 's1', slotId: '1', operationId: 'voice', expectedRevision: 0, channelRevision: 0, now: NOW, slotMaxAgeMs: 10000 });
  await store.attachCall('c1', 'provider1', NOW);
  const before = await store.requireSession('s1');
  db.beforeBatch = () => { db.beforeBatch = null; db.sqlite.prepare("UPDATE audit_sessions SET revision=revision+1,state_json=json_set(state_json,'$.revision',revision+1) WHERE id=?").run('s1'); };
  assert.equal(await store.confirmCallStopped('c1', NOW + 1000), false);
  assert.equal((await store.getCall('c1'))!.status, 'active'); assert.equal((await store.getCall('c1'))!.stoppedRevision, null);
  assert.equal(db.sqlite.prepare('SELECT active_calls FROM ultravox_slots').get()!.active_calls, 1);
  assert.equal(await store.confirmCallStopped('c1', NOW + 2000), true);
  assert.equal((await store.getCall('c1'))!.stoppedRevision, before.state.revision + 2);
  assert.equal((await store.requireSession('s1')).state.revision, before.state.revision + 2);
  assert.equal(db.sqlite.prepare('SELECT active_calls FROM ultravox_slots').get()!.active_calls, 0);
  assert.equal(await store.confirmCallStopped('c1', NOW + 3000), false);
});

test('recovery cache requires a paid owner reservation, rejects another call and never overwrites', async t => {
  const { db, store } = await setup('voice'); t.after(() => db.close());
  await store.updateVoiceSlot({ id: '1', availableMs: 900000, maxConcurrency: 1, now: NOW });
  await store.reserveVoiceCall({ id: 'c1', sessionId: 's1', slotId: '1', operationId: 'voice', expectedRevision: 0, channelRevision: 0, now: NOW, slotMaxAgeMs: 10000 });
  const input = { sessionId: 's1', callId: 'c1', boundaryHash: 'boundary1', reservationId: 'owner', result: { ok: true }, now: NOW };
  assert.equal(await store.putRecoveryResult(input), false);
  await store.reserveUsage({ id: 'owner', period: 'day', kind: 'deepseek_calls', amount: 1, limit: 10, now: NOW, expiresAt: NOW + 10000 });
  assert.equal(await store.putRecoveryResult({ ...input, callId: 'another-call' }), false);
  assert.equal(await store.putRecoveryResult(input), true);
  assert.equal(await store.putRecoveryResult({ ...input, result: { ok: false } }), false);
  assert.deepEqual(await store.getRecoveryResult('s1', 'c1', 'boundary1'), { ok: true });
});
