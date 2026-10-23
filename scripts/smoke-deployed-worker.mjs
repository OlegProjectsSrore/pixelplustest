// Check deployed access controls without creating sessions or calling AI providers.
// No credentials are accepted; requests only exercise CORS, D1 and access gates.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const [workerArgument, originArgument, mode] = process.argv.slice(2);
assert.ok(mode === undefined || mode === '--open', 'Only --open is supported as the third argument');
if (!workerArgument || !originArgument) {
  throw new Error('Usage: npm run smoke:deployed -- <Worker HTTPS origin> <allowed frontend HTTPS origin> [--open]');
}
const base = new URL(workerArgument);
const frontend = new URL(originArgument);
for (const url of [base, frontend]) {
  assert.equal(url.protocol, 'https:', 'Only HTTPS origins are supported');
  assert.equal(url.username + url.password + url.search + url.hash, '', 'Pass an origin without credentials, query or fragment');
  assert.equal(url.pathname, '/', 'Pass an origin without a path');
}

async function request(path, options = {}) {
  const response = await fetch(new URL(path, base), {
    ...options, headers: { Origin: frontend.origin, ...options.headers },
    redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('x-request-id'), 'The Worker must supply a request ID');
  return response;
}
async function errorResponse(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.ok, false);
  if (code) assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, 'string');
  assert.equal(body.request_id, response.headers.get('x-request-id'));
}

const preflight = await request('/api/session', { method: 'OPTIONS', headers: {
  'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type',
} });
assert.equal(preflight.status, 204);
assert.equal(preflight.headers.get('access-control-allow-origin'), frontend.origin);

const denied = await request('/api/session/deployment-probe', { headers: { Origin: 'https://deployment-probe.invalid' } });
await errorResponse(denied, 403);
assert.equal(denied.headers.get('access-control-allow-origin'), null);

const unauthenticated = await request('/api/session/deployment-probe');
await errorResponse(unauthenticated, 401, 'unauthorized');
assert.equal(unauthenticated.headers.get('access-control-allow-origin'), frontend.origin);

const absentReport = await request(`/api/report/${randomBytes(32).toString('base64url')}`);
assert.equal(absentReport.status, 404);

const closed = await request('/api/session', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ operation_id: randomBytes(32).toString('base64url'), channel: mode === '--open' ? 'invalid-probe-channel' : 'chat' }),
});
if (mode === '--open') {
  await errorResponse(closed, 400, 'invalid_channel');
  console.log('PASS open Worker: CORS, authorization, D1 lookup, missing report, invalid creation is rejected before allocating resources. No audit session or provider request created.');
} else {
  await errorResponse(closed, 503, 'sessions_not_released');
  assert.ok(Number(closed.headers.get('retry-after')) > 0);
  console.log('PASS closed Worker: CORS, authorization, D1 lookup, missing report, release gate. No audit session or provider request created.');
}
