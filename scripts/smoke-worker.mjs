import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { D1Store } from '../worker/src/storage/d1-store.ts';
import { initialAuditState } from '../worker/src/audit/contracts.ts';
import { library } from '../worker/src/audit/library.ts';
import { hashToken, randomToken } from '../worker/src/security.ts';
const require = createRequire(new URL('../worker/package.json', import.meta.url));
const { Miniflare } = require('miniflare');
const { unstable_splitSqlQuery } = require('wrangler');
const now = Date.now();
const origin = 'https://olegprojectssrore.github.io';
let outboundRequests = 0;
// Miniflare 5 WorkerOptionsSchema uses config.manifest and typed config.env bindings.
// See the installed miniflare/dist/src/index.d.ts; the bundled README still shows v4 options.
const runtime = new Miniflare({
  cf: false,
  telemetry: { enabled: false },
  workers: [{
    config: {
      name: 'pixelplus-smoke', compatibilityDate: '2026-10-22',
      manifest: { mainModule: 'index.js', modules: {
        'index.js': { type: 'esm', contents: await readFile(new URL('../.artifacts/worker-build/index.js', import.meta.url), 'utf8') },
      } },
      env: {
        DB: { type: 'd1', id: 'pixelplus-smoke-db' }, REPORTS_KV: { type: 'kv', id: 'pixelplus-smoke-reports' },
        ALLOW_DRAFT_LIBRARY: { type: 'text', value: 'true' }, ALLOWED_ORIGINS: { type: 'text', value: origin },
        IP_HASH_SALT: { type: 'text', value: 'local-smoke-only-'.repeat(4) }, BUDGETS_JSON: { type: 'text', value: '{}' },
      },
    },
    dev: { outboundService: { type: 'fetcher', handler: async () => { outboundRequests++; throw new Error('External network is disabled in this smoke test'); } } },
  }],
});
try {
  const db = await runtime.getD1Database('DB');
  const directory = new URL('../worker/migrations/', import.meta.url);
  for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
    const sql = await readFile(new URL(name, directory), 'utf8');
    // Use Wrangler's exported SQLite splitter so BEGIN ... END triggers stay intact.
    const statements = unstable_splitSqlQuery(sql);
    await db.batch(statements.map(statement => db.prepare(statement)));
  }
  const store = new D1Store(db);
  const token = randomToken(); const read = randomToken();
  await store.createSession({ id: 'runtime-smoke', reportId: 'runtime-report', tokenHash: await hashToken(token), reportTokenHash: await hashToken(read),
    state: initialAuditState(library.version, 'chat', now), now });
  const session = await store.requireSession('runtime-smoke');
  await store.commit({ sessionId: session.id, expectedRevision: 0, channelRevision: 0, operationId: 'seed-evidence', now,
    state: session.state, event: { id: 'private-evidence', source: 'chat', source_key: 'private-evidence', source_revision: 0,
      local_order: 0, role: 'user', kind: 'utterance', text: 'Private interview evidence', occurred_at: now, received_at: now } });
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const response = await runtime.dispatchFetch('https://worker.example/api/session/runtime-smoke', { headers });
  const state = await response.json(); assert.equal(response.status, 200); assert.equal(state.ok, true); assert.equal(state.data.session.session_id, 'runtime-smoke');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(state.data.session.messages[0].text, 'Private interview evidence');
  assert.equal((await runtime.dispatchFetch('https://worker.example/api/session/runtime-smoke', { headers: { Origin: origin } })).status, 401);
  const readHeaders = { ...headers, Authorization: `Bearer ${read}` };
  const reportView = await runtime.dispatchFetch('https://worker.example/api/session/runtime-smoke', { headers: readHeaders });
  assert.equal(reportView.status, 200);
  const restricted = (await reportView.json()).data.session;
  assert.deepEqual(restricted.messages, []); assert.equal(restricted.question, null); assert.equal(restricted.active_channel, null);
  assert.ok(Object.values(restricted.capabilities).every(value => value === false));
  assert.equal((await runtime.dispatchFetch('https://worker.example/api/session/another-session', { headers: readHeaders })).status, 401);

  const pauseBody = operationId => ({ api_version: '1', session_id: 'runtime-smoke', operation_id: operationId,
    expected_revision: 1, channel_revision: 0, library_version: library.version });
  const operationIds = [crypto.randomUUID(), crypto.randomUUID()];
  const pause = body => runtime.dispatchFetch('https://worker.example/api/session/pause', { method: 'POST', headers, body: JSON.stringify(body) });
  const concurrent = await Promise.all(operationIds.map(id => pause(pauseBody(id))));
  assert.deepEqual(concurrent.map(value => value.status).sort(), [200, 409]);
  const winningIndex = concurrent.findIndex(value => value.status === 200);
  const accepted = await concurrent[winningIndex].json();
  assert.equal(accepted.data.session.paused, true); assert.equal(accepted.data.session.revision, 2);
  assert.equal((await store.getSession('runtime-smoke')).state.revision, 2);
  const conflict = await concurrent[1 - winningIndex].json();
  assert.equal(conflict.error.code, 'revision_conflict');
  const replay = await pause(pauseBody(operationIds[winningIndex]));
  assert.equal(replay.status, 200); assert.equal((await replay.json()).data.replayed, true);
  assert.equal((await store.getSession('runtime-smoke')).state.revision, 2);
  const readMutation = await runtime.dispatchFetch('https://worker.example/api/session/pause', { method: 'POST', headers: readHeaders, body: JSON.stringify(pauseBody(crypto.randomUUID())) });
  assert.equal(readMutation.status, 401);

  // Accepted report access outlives the management token without exposing interview history.
  await db.batch([
    db.prepare('UPDATE audit_sessions SET access_expires_at=? WHERE id=?').bind(now - 1, 'runtime-smoke'),
    db.prepare("UPDATE reports SET status='preparing',prepare_deadline=? WHERE id=?").bind(now + 86_400_000, 'runtime-report'),
  ]);
  assert.equal((await runtime.dispatchFetch('https://worker.example/api/session/runtime-smoke', { headers })).status, 401);
  const afterExpiry = await runtime.dispatchFetch('https://worker.example/api/session/runtime-smoke', { headers: readHeaders });
  assert.equal(afterExpiry.status, 200); assert.deepEqual((await afterExpiry.json()).data.session.messages, []);
  assert.equal(outboundRequests, 0);
  console.log('PASS workerd/Miniflare: migrations, actual D1 batch/CAS race, authorization, read-token isolation, pause replay, management expiry, HTTP envelope; external requests: 0');
} finally { await runtime.dispose(); }
