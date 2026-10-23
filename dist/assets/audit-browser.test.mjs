/** Local mocked HTTP + actual view/controller modules; no provider credentials or calls.
 * Uses an already installed Playwright: set PIXELPLUS_PLAYWRIGHT_MODULE to its file URL.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const { chromium } = await import(process.env.PIXELPLUS_PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ channel: process.env.PIXELPLUS_BROWSER_CHANNEL || 'msedge', headless: true });
const origin = 'http://127.0.0.1:4198';
const page = await browser.newPage({ viewport: { width: 320, height: 800 } });
const errors = [];
const requests = [];
let chatAttempts = 0;
const session = { session_id: 'browser-test', library_version: 'test', revision: 0, channel_revision: 0,
  active_channel: 'chat', paused: false, status: 'in_progress', remaining_ms: 900000,
  access_expires_at: Date.now() + 86400000, question: { id: 'q1', text: 'Какая задача сейчас важнее?', options: [{ id: 'a1', text: 'Получать больше обращений' }] } };
page.on('pageerror', error => errors.push(error.message));
await page.route('**/*', async route => {
  const url = new URL(route.request().url());
  assert.equal(url.origin, origin, 'Only the local stub may be requested');
  if (url.pathname === '/test') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/audit-ui.css"><style>@font-face{font-family:Ubuntu;src:url(/assets/d3194c31591b-ubuntu.woff);font-weight:400}@font-face{font-family:Ubuntu;src:url(/assets/73e5fbbdb8ed-ubuntubold.woff2);font-weight:700}</style></head><body><button id="opener">Открыть опрос</button></body></html>' });
  if (['/assets/d3194c31591b-ubuntu.woff', '/assets/73e5fbbdb8ed-ubuntubold.woff2'].includes(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.woff2') ? 'font/woff2' : 'font/woff', body: await readFile(new URL(url.pathname.split('/').at(-1), import.meta.url)) });
  if (/^\/assets\/audit-[a-z]+\.(js|css)$/.test(url.pathname)) return route.fulfill({ contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript', body: await readFile(new URL(url.pathname.split('/').at(-1), import.meta.url), 'utf8') });
  const body = route.request().postDataJSON();
  requests.push({ path: url.pathname, body, headers: route.request().headers() });
  if (url.pathname === '/api/session') return route.fulfill({ json: { session, management_token: 'management', report_token: 'report' } });
  if (url.pathname === '/api/chat') {
    if (!chatAttempts++) { session.revision++; return route.abort('connectionreset'); }
    return route.fulfill({ json: { kind: 'duplicate', session } });
  }
  if (url.pathname === '/api/audit/finish') { session.status = 'closing'; session.revision++; return route.fulfill({ json: { session } }); }
  if (url.pathname === '/api/session/browser-test') return route.fulfill({ json: session });
  if (url.pathname === '/api/email/send') return route.fulfill({ json: { status: 'pending' } });
  if (url.pathname === '/api/report/report') return route.fulfill({ contentType: 'application/pdf', body: '%PDF-1.7\nmock PDF' });
  throw new Error(`Unexpected local route ${url.pathname}`);
});

async function mount(failChallenge = false) {
  await page.evaluate(async ({ origin, failChallenge }) => {
    const { createAuditClient } = await import(`${origin}/assets/audit-client.js`);
    let challenges = 0;
    window.auditClient = createAuditClient({ config: { apiBaseUrl: origin, turnstileSiteKey: 'local-stub' },
      challenge: async () => { if (failChallenge && !challenges++) throw new Error('Проверка временно недоступна'); return 'stub-token'; } });
    document.querySelector('#opener').focus();
    await window.auditClient.open('chat');
  }, { origin, failChallenge });
}

try {
  await page.goto(`${origin}/test`);
  await mount(true);
  await page.getByRole('button', { name: 'Попробовать ещё раз' }).click();
  await page.locator('.audit-textarea').waitFor({ state: 'visible' });
  if (process.env.PIXELPLUS_AUDIT_SCREENSHOTS) {
    await page.evaluate(() => document.fonts.ready);
    for (const width of [320, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 800 : 1000 });
      await page.screenshot({ path: path.join(process.env.PIXELPLUS_AUDIT_SCREENSHOTS, `audit-ui-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 320, height: 800 });
  }
  await page.locator('.audit-textarea').fill('Нам нужны заявки');
  await page.getByRole('button', { name: 'Отправить', exact: true }).click();
  await page.getByRole('button', { name: 'Попробовать ещё раз' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('.audit-textarea').inputValue(), 'Нам нужны заявки');
  const operation = requests.find(request => request.path === '/api/chat').body;
  await page.evaluate(() => auditClient.destroy());
  await page.reload(); await mount();
  await page.getByRole('button', { name: 'Попробовать ещё раз' }).click();
  await page.waitForFunction(() => document.querySelector('.audit-textarea').value === '');
  assert.deepEqual(requests.filter(request => request.path === '/api/chat').at(-1).body, operation);
  await page.getByRole('button', { name: 'Завершить опрос' }).click();
  await page.waitForFunction(() => document.querySelector('dialog').dataset.phase === 'closing');
  session.status = 'ready';
  await page.evaluate(() => auditClient.refresh());
  await page.getByRole('button', { name: 'Скачать PDF' }).waitFor({ state: 'visible' });
  await page.locator('.audit-input').fill('visitor@example.com');
  await page.getByRole('button', { name: 'Отправить PDF' }).click();
  assert.equal(requests.some(request => request.path === '/api/email/send'), false);
  await page.locator('.audit-checkbox').check();
  await page.getByRole('button', { name: 'Отправить PDF' }).click();
  await page.waitForFunction(() => document.querySelector('.audit-email-status').textContent.includes('ожидает'));
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать PDF' }).click();
  assert.equal((await downloadPromise).suggestedFilename(), 'ПРЕДВАРИТЕЛЬНЫЙ АУДИТ.pdf');
  assert.equal(requests.find(request => request.path === '/api/report/report').headers.authorization, undefined);
  const beforeEscape = requests.filter(request => request.path === '/api/audit/finish').length;
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(node => node.open), false);
  assert.equal(await page.locator('#opener').evaluate(node => node === document.activeElement), true);
  assert.equal(requests.filter(request => request.path === '/api/audit/finish').length, beforeEscape);
  await page.evaluate(() => auditClient.destroy());

  // Pure view rendering checks keep all nine states and user-supplied text in scope.
  await page.evaluate(async origin => {
    const { createAuditView } = await import(`${origin}/assets/audit-ui.js`);
    window.channelCalls = [];
    window.auditView = createAuditView({ onChannel: channel => window.channelCalls.push(channel) }); auditView.open();
  }, origin);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const phase of ['idle', 'loading', 'interview', 'paused', 'closing', 'preparing', 'ready', 'failed', 'unavailable']) {
      await page.evaluate(phase => auditView.render({ mode: 'chat', phase, question: { id: 'unsafe', text: '<script>danger()</script>', options: [{ id: 'a', text: '<img src=x>' }] },
        messages: [{ id: 'u', role: 'user', text: '<img src=x onerror=alert(1)>' }], remaining_seconds: 500, busy: false,
        capabilities: { chat: true, voice: true, pause: true, resume: true, finish: true, email: true } }), phase);
      assert.equal(await page.locator('dialog').evaluate(node => node.scrollWidth > node.clientWidth || node.querySelector('.audit-body').scrollWidth > node.querySelector('.audit-body').clientWidth), false, `${width}px ${phase}`);
    }
  }
  await page.evaluate(() => auditView.render({ phase: 'interview', mode: 'chat', launchPending: false, capabilities: { voice: true } }));
  await page.getByRole('button', { name: 'Переключиться на голос' }).click();
  assert.deepEqual(await page.evaluate(() => channelCalls), ['voice']);
  await page.evaluate(() => auditView.render({ phase: 'unavailable', launchPending: true }));
  assert.equal(await page.locator('.audit-button--call').isVisible(), true);
  assert.equal(await page.locator('.audit-button--call').isDisabled(), true);
  assert.equal(await page.locator('dialog img, dialog script').count(), 0);
  await page.setViewportSize({ width: 390, height: 800 });
  await page.locator('.audit-button--close').focus(); await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.querySelector('dialog').contains(document.activeElement)), true);
  assert.deepEqual(errors, []);
  console.log('Passed: actual controller+transport+view, challenge retry, lost ACK/reload, PDF/email consent, Escape/focus, nine phases at 320/390/768/1440px, safe text. No provider requests.');
} finally { await browser.close(); }
