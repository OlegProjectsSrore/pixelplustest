import test from 'node:test';
import assert from 'node:assert/strict';
import { getTurnstileToken } from './audit-turnstile.js';

test('challenge uses compact layout and removes a synchronously completed widget', async () => {
  let options; const removed = [];
  globalThis.window = { turnstile: { render(container, value) { options = value; value.callback('challenge-token'); return 'widget'; }, remove: id => removed.push(id) } };
  assert.equal(await getTurnstileToken({}, 'sitekey', 'session'), 'challenge-token');
  assert.equal(options.size, 'compact'); assert.equal(options.action, 'session');
  assert.deepEqual(removed, ['widget']);
});

test('challenge failure rejects without returning a reusable token', async () => {
  globalThis.window = { turnstile: { render(container, options) { queueMicrotask(() => options['error-callback']()); return 'widget'; }, remove() {} } };
  await assert.rejects(getTurnstileToken({}, 'sitekey', 'voice_start'), /не пройдена/);
  await assert.rejects(getTurnstileToken({}, '', 'session'), /недоступен/);
});
