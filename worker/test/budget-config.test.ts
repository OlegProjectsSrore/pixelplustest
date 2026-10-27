import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CoreServices } from '../src/core.ts';
import { HttpError } from '../src/security.ts';
import { SqliteD1 } from './helpers/d1.ts';
import type { Env } from '../src/env.ts';
const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const agreed = JSON.parse(config.vars.BUDGETS_JSON);

test('deployed configuration matches agreed daily limits and accommodates every PDF time reservation', () => {
  for (const [name, value] of Object.entries({ new_sessions: 50, sessions_per_ip: 33, voice_seconds: 7200, deepseek_usd_micros: 20_000_000, pdf_renders: 20, browser_seconds: 600 })) assert.equal(agreed[name], value);
  assert.equal(agreed.pdf_renders * 30, agreed.browser_seconds);
  assert.equal(agreed.voice_starts, agreed.new_sessions * 2);
});
test('the configured number of sessions is accepted, the next is denied; per-IP limit remains independent', async t => {
  const db = new SqliteD1(); t.after(() => db.close());
  const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ...config.vars, ALLOW_DRAFT_LIBRARY: 'true', PUBLIC_SESSIONS_ENABLED: 'true', TURNSTILE_SECRET: 'test', IP_HASH_SALT: 'x'.repeat(32) };
  const core = new CoreServices(env, () => Date.parse('2026-10-23T12:00:00Z'), (async () => Response.json({ success: true, hostname: 'olegprojectssrore.github.io', action: 'session' })) as typeof fetch);
  const create = (ip = '192.0.2.1') => core.create(new Request('https://worker.example/api/session', { headers: { 'CF-Connecting-IP': ip } }), { channel: 'chat', operation_id: crypto.randomUUID(), turnstile_token: 'test-token' });
  // One address can open at most sessions_per_ip of them; the rest come from another address.
  for (let i = 0; i < agreed.new_sessions; i++) await create(i < agreed.sessions_per_ip ? '192.0.2.1' : '192.0.2.3');
  await assert.rejects(create('192.0.2.2'), (e: unknown) => e instanceof HttpError && e.code === 'budget_exhausted');
  env.BUDGETS_JSON = JSON.stringify({ ...agreed, new_sessions: agreed.new_sessions * 2 });
  await assert.rejects(create(), (e: unknown) => e instanceof HttpError && e.code === 'session_limit');
  await create('192.0.2.2');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM audit_sessions').get()!.n, agreed.new_sessions + 1);
});
