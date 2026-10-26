import test from 'node:test';
import assert from 'node:assert/strict';
import { CoreServices } from '../src/core.ts';
import { refreshVoiceAccounts, voiceConfigHash } from '../src/voice-accounts.ts';
import { freeTimeMs, inspectAccount } from '../src/voice/accounts.ts';
import { initialAuditState } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import type { Env } from '../src/env.ts';
import { SqliteD1 } from './helpers/d1.ts';

const NOW = 1800000000000, VOICE = '83b2a94f-8078-4321-935c-a0798b2ac621';
const ACCOUNT = '0cabdaf5-f7eb-421d-a9c5-4fc7a8192310';
function fixture() {
  const db = new SqliteD1(); let now = NOW;
  const env: Env = { DB: db.binding(), REPORTS_KV: {} as KVNamespace, ULTRAVOX_KEY_1: 'private-test-key', ULTRAVOX_MODEL: 'ultravox-v0.7', ULTRAVOX_VOICE: VOICE };
  const requests: string[] = [];
  let account: Record<string, unknown> = { accountId: ACCOUNT, freeTimeRemaining: '1800s', activeCalls: 0, allowedConcurrentCalls: 2 };
  let status = 200, external = false;
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push(String(url)); assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'manual');
    if (status !== 200) return new Response(null, { status, headers: { 'Retry-After': '120' } });
    if (String(url).includes('/voices/')) return Response.json({ voiceId: VOICE, billingStyle: external ? 'VOICE_BILLING_STYLE_EXTERNAL' : 'VOICE_BILLING_STYLE_INCLUDED' });
    if (String(url).includes('/models')) return Response.json({ results: [{ name: 'ultravox-v0.7' }], next: null });
    return Response.json(account);
  }) as typeof fetch;
  const core = new CoreServices(env, () => now, fetcher);
  const slot = (id = '1') => db.sqlite.prepare('SELECT * FROM ultravox_slots WHERE id=?').get(id)!;
  return { db, core, env, requests, slot, tick: (ms: number) => { now += ms; }, setAccount: (value: Record<string, unknown>) => { account = { ...account, ...value }; }, status: (value: number) => { status = value; }, external: () => { external = true; } };
}
test('account durations use explicit seconds, floor fractions, and reject unknown formats', () => {
  assert.equal(freeTimeMs('1800s'), 1800000); assert.equal(freeTimeMs('0.001999999s'), 1); assert.equal(freeTimeMs('-1s'), 0);
  for (const value of [null, 1800, '30', '00:30:00', 'NaNs', '1e9s', '9007199254740991s']) assert.throws(() => freeTimeMs(value));
});
test('only populated keys are queried; one minute cache and per-slot lease prevent duplicate polling', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await Promise.all([refreshVoiceAccounts(f.core), refreshVoiceAccounts(f.core)]);
  assert.equal(f.requests.length, 3); assert.equal(f.slot().provider_account_id, ACCOUNT);
  assert.equal(f.slot().provider_remaining_ms, 1800000); assert.equal(f.slot().provider_max_concurrency, 2);
  assert.equal(f.slot().state, 'available');
  await refreshVoiceAccounts(f.core); assert.equal(f.requests.length, 3);
  f.tick(60001); f.setAccount({ freeTimeRemaining: '900s', activeCalls: 1 });
  await refreshVoiceAccounts(f.core);
  assert.equal(f.requests.length, 6); assert.equal(f.slot().available_ms, 900000); assert.equal(f.slot().max_concurrency, 1);
  assert.equal(JSON.stringify(f.slot()).includes('private-test-key'), false);
});
test('auth errors fail closed immediately and preserve existing reservations', async t => {
  const f = fixture(); t.after(() => f.db.close()); await refreshVoiceAccounts(f.core);
  f.db.sqlite.prepare('UPDATE ultravox_slots SET active_calls=1,reserved_ms=900000').run();
  f.status(401); f.tick(60001); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().state, 'disabled'); assert.equal(f.slot().reserved_ms, 900000); assert.equal(f.slot().active_calls, 1);
  assert.equal(f.slot().last_error, 'provider_http_401');
  const count = f.requests.length; await refreshVoiceAccounts(f.core); assert.equal(f.requests.length, count);
  f.env.ULTRAVOX_KEY_1 = 'rotated-private-key'; f.status(200); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().state, 'available'); assert.equal(f.slot().reserved_ms, 900000);
});
test('429 Retry-After is respected; removed key disables cached slot', async t => {
  const f = fixture(); t.after(() => f.db.close()); f.status(429); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().state, 'cooldown'); assert.equal(f.slot().next_attempt_at, NOW + 120000);
  f.tick(60001); await refreshVoiceAccounts(f.core); assert.equal(f.requests.length, 1);
  f.env.ULTRAVOX_KEY_1 = ''; await refreshVoiceAccounts(f.core); assert.equal(f.slot().state, 'disabled'); assert.equal(f.slot().config_hash, null);
});
test('unknown quota, external voice charges, changed model and exhausted time do not grant availability', async t => {
  const f = fixture(); t.after(() => f.db.close()); f.setAccount({ allowedConcurrentCalls: null }); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().last_error, 'unknown_account_limits');
  f.tick(60001); f.setAccount({ allowedConcurrentCalls: 2, freeTimeRemaining: '0s', hasActiveSubscription: true }); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().state, 'unknown'); assert.equal(f.slot().last_error, 'free_time_exhausted');
  f.env.ULTRAVOX_MODEL = 'unavailable-model'; await refreshVoiceAccounts(f.core); assert.equal(f.slot().state, 'disabled');
  f.env.ULTRAVOX_MODEL = 'ultravox-v0.7'; f.external(); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().last_error, 'voice_unavailable_or_external_billing');
});
test('duplicate accounts cannot multiply balance or concurrency, and slot account identity cannot silently change', async t => {
  const f = fixture(); t.after(() => f.db.close()); await refreshVoiceAccounts(f.core);
  f.env.ULTRAVOX_KEY_2 = 'second-key-same-account'; await refreshVoiceAccounts(f.core);
  assert.equal(f.slot('2').state, 'disabled'); assert.equal(f.slot('2').last_error, 'duplicate_account');
  f.tick(60001); f.setAccount({ accountId: '11111111-1111-4111-8111-111111111111' }); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().last_error, 'account_changed'); assert.equal(f.slot().provider_account_id, ACCOUNT);
});
test('refresh retains unknown-call holds and reservation atomically rejects obsolete config hash', async t => {
  const f = fixture(); t.after(() => f.db.close()); await refreshVoiceAccounts(f.core);
  await f.core.store.createSession({ id: 's', reportId: 'r', tokenHash: 't', reportTokenHash: 'rt', state: initialAuditState(library.version, 'voice', NOW), now: NOW });
  const request = { id: 'call', sessionId: 's', slotId: '1', operationId: 'start', expectedRevision: 0, channelRevision: 0, now: NOW, slotMaxAgeMs: 300000 };
  assert.equal(await f.core.store.reserveVoiceCall({ ...request, configHash: 'stale' }), null);
  assert.ok(await f.core.store.reserveVoiceCall({ ...request, configHash: await voiceConfigHash(f.core, '1') }));
  await f.core.store.markCallUnknown('call'); f.tick(60001); await refreshVoiceAccounts(f.core);
  assert.equal(f.slot().reserved_ms, 1500000); assert.equal(f.slot().active_calls, 1); assert.equal((await f.core.store.getCall('call'))!.status, 'unknown');
});
test('model pagination cannot send the API key to a different origin', async () => {
  const requests: string[] = [];
  await assert.rejects(inspectAccount('secret', 'wanted', VOICE, (async url => {
    requests.push(String(url));
    return Response.json(String(url).includes('/voices/') ? { voiceId: VOICE, billingStyle: 'VOICE_BILLING_STYLE_INCLUDED' } : { results: [], next: 'https://attacker.example/api/models' });
  }) as typeof fetch));
  assert.equal(requests.length, 2); assert.ok(requests.every(url => url.startsWith('https://api.ultravox.ai/')));
});
