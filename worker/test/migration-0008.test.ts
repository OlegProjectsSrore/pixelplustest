import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreServices } from '../src/core.ts';
import { createRealtimeAdapters } from '../src/channel-realtime.ts';
import { initialAuditState } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import { hashToken } from '../src/security.ts';
import type { AdapterContext } from '../src/integration.ts';
import type { Env } from '../src/env.ts';
import { SqliteD1 } from './helpers/d1.ts';

const NOW = Date.parse('2026-10-26T12:00:00Z'), TOKEN = 'a'.repeat(43), SDP = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const CHILD_TABLES = ['audit_events', 'audit_answers', 'audit_snapshots', 'ultravox_calls', 'voice_recovery_results', 'realtime_calls', 'reports', 'report_access_tokens', 'audit_jobs', 'email_jobs'];

test('migration 0008 lets a voice interview last 25 minutes and keeps every session row and its children', async () => {
  const db = new SqliteD1({ before: '0008' });
  try {
    // Real data through the application: session, report and token, an OpenAI call, transcript events and an answer.
    const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ALLOW_DRAFT_LIBRARY: 'true', OPENAI_API_KEY: 'test-key',
      VOICE_REPLAY_SECRET: Buffer.alloc(32, 3).toString('base64url'), BUDGETS_JSON: JSON.stringify({ voice_starts: 14, voice_seconds: 7200 }) };
    const core = new CoreServices(env, () => NOW, (async () => new Response(SDP, { status: 201, headers: { Location: '/v1/realtime/calls/rtc_migration' } })) as typeof fetch);
    await core.store.createSession({ id: 's1', tokenHash: await hashToken(TOKEN), reportId: 'r1', reportTokenHash: 'read-only', state: initialAuditState(library.version, 'voice', NOW), now: NOW });
    const adapters = createRealtimeAdapters();
    const request = new Request('https://worker.example/test', { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } });
    const context = (body: Record<string, unknown>): AdapterContext => ({ core, env, body, execution: { waitUntil() {} } as unknown as ExecutionContext });
    const body = async (extra: Record<string, unknown>) => { const s = await core.store.requireSession('s1'); return { session_id: 's1', operation_id: crypto.randomUUID(), library_version: library.version, expected_revision: s.state.revision, channel_revision: s.state.channel_revision, ...extra }; };
    const call = await adapters.voiceStart!(request, context(await body({ sdp: SDP }))) as Record<string, string>;
    const line = (ordinal: number, role: string, text: string) => ({ source: 'voice', source_key: `${call.call_id}:${ordinal}`, source_revision: 0, local_order: ordinal,
      call_id: call.call_id, role, kind: 'utterance', text, occurred_at: NOW, data: { is_final: true, medium: 'voice' } });
    const delivered = await adapters.voiceTranscript!(request, context(await body({ call_id: call.call_id, events: [line(0, 'assistant', 'Как Вас зовут?'), line(1, 'user', 'Александр')] }))) as Record<string, string>;
    await adapters.voiceAnswers!(request, context(await body({ call_id: call.call_id, through_event_id: delivered.through_event_id,
      answers: [{ question_id: 'context_name', fact_id: 'context.name', state: 'known', value: 'Александр', source_quotes: ['Александр'], source_ordinals: [1] }] })));
    const dump = (table: string) => JSON.stringify(db.sqlite.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    const before = Object.fromEntries(['audit_sessions', ...CHILD_TABLES].map(table => [table, dump(table)]));
    for (const table of ['audit_sessions', 'audit_events', 'audit_answers', 'ultravox_calls', 'realtime_calls', 'reports', 'report_access_tokens'])
      assert(JSON.parse(before[table]).length > 0, `${table} has rows before the migration`);
    assert.throws(() => db.sqlite.prepare(`UPDATE audit_sessions SET used_ms=1200000`).run(), /CHECK constraint/, 'the old schema stops at 15 minutes');

    db.migrate('0008_interview_25_minutes.sql');
    for (const [table, rows] of Object.entries(before)) assert.equal(dump(table), rows, `${table} is unchanged`);
    assert.deepEqual(db.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'keep_%' OR name='audit_sessions_rebuilt'`).get()!.n, 0, 'no temporary tables remain');
    db.sqlite.prepare(`UPDATE audit_sessions SET used_ms=1500000`).run();
    assert.throws(() => db.sqlite.prepare(`UPDATE audit_sessions SET used_ms=1500001`).run(), /CHECK constraint/);
    assert.match(String(db.sqlite.prepare(`SELECT sql FROM sqlite_master WHERE name='audit_sessions_deadline'`).get()!.sql), /active_started_at \+ 1500000 - used_ms/);
    // Foreign keys still point at the rebuilt table: deleting the session cascades as before.
    db.sqlite.prepare(`DELETE FROM audit_sessions WHERE id='s1'`).run();
    for (const table of ['audit_events', 'audit_answers', 'ultravox_calls', 'realtime_calls', 'reports', 'report_access_tokens'])
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0, `${table} cascades`);
  } finally { db.close(); }
});
