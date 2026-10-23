import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditTransport, createAuditStorage, AuditRequestError } from './audit-http.js';

test('transport restricts API origin and never sends browser credentials or follows redirects', async () => {
  const requests = [];
  const api = createAuditTransport('https://audit.example', { fetcher: async (url, options) => {
    requests.push({ url, options }); return Response.json({ ok: true });
  } });
  await api.request('/api/chat', { method: 'POST', token: 'secret', body: { operation_id: 'same' } });
  assert.equal(requests[0].options.credentials, 'omit');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer secret');
  assert.equal(requests[0].options.body, '{"operation_id":"same"}');
  await assert.rejects(api.request('https://elsewhere.example/api/chat'), { code: 'invalid_request' });
  await assert.rejects(api.request('/outside'), { code: 'invalid_request' });
  assert.equal(requests.length, 1);
  assert.throws(() => createAuditTransport('http://audit.example'), { code: 'configuration_required' });
});

test('timeout and network failures remain retryable unknown outcomes', async () => {
  const timeout = createAuditTransport('https://audit.example', { timeoutMs: 5, fetcher: (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }) });
  await assert.rejects(timeout.request('/api/chat'), error => error instanceof AuditRequestError && error.status === 0 && error.retryable);
  const network = createAuditTransport('https://audit.example', { fetcher: async () => { throw new TypeError('offline'); } });
  await assert.rejects(network.request('/api/chat'), { code: 'network_error', retryable: true });
});

test('transport preserves definite conflicts, retry-after and report failure status', async () => {
  const responses = [Response.json({ error: { code: 'revision_conflict', message: 'Conflict' } }, { status: 409 }),
    Response.json({ error: { code: 'busy' } }, { status: 429, headers: { 'Retry-After': '17' } }),
    Response.json({ status: 'expired' }, { status: 410 })];
  const api = createAuditTransport('https://audit.example', { fetcher: async () => responses.shift() });
  await assert.rejects(api.request('/api/chat'), { code: 'revision_conflict', status: 409, retryable: false });
  await assert.rejects(api.request('/api/chat'), { status: 429, retryAfter: 17, retryable: true });
  await assert.rejects(api.request('/api/report/token', { pdf: true }), { code: 'expired', status: 410 });
});

test('PDF retrieval is separate from report-pending JSON and malformed responses', async () => {
  const responses = [new Response('%PDF-1.7', { headers: { 'Content-Type': 'application/pdf' } }),
    Response.json({ status: 'preparing', retry_after_seconds: 10 }, { status: 202 }), new Response('<html>gateway error</html>', { status: 502 })];
  const api = createAuditTransport('https://audit.example', { fetcher: async () => responses.shift() });
  assert.ok(await api.request('/api/report/token', { pdf: true }) instanceof Blob);
  assert.deepEqual(await api.request('/api/report/token', { pdf: true }), { status: 'preparing', retry_after_seconds: 10 });
  await assert.rejects(api.request('/api/report/token', { pdf: true }), { code: 'invalid_response', retryable: true });
});

test('storage preserves the exact pending payload and fails closed when writes are denied', () => {
  const map = new Map();
  const storage = createAuditStorage({ getItem: key => map.get(key), setItem: (key, value) => map.set(key, value), removeItem: key => map.delete(key) });
  const pending = { path: '/api/chat', body: { operation_id: 'persistent-id', expected_revision: 4, text: 'Ответ' } };
  storage.save({ pending }); assert.deepEqual(storage.load().pending, pending);
  const denied = createAuditStorage({ getItem: () => '{broken', setItem() { throw new Error('quota'); } });
  assert.equal(denied.load(), null);
  assert.throws(() => denied.save({ pending }), { code: 'storage_unavailable', retryable: false });
});
