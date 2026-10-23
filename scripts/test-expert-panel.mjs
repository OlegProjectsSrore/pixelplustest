import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.PIXELPLUS_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const output = fileURLToPath(new URL('../.artifacts/chat-panel/', import.meta.url));
await mkdir(output, { recursive: true });
const origin = 'https://olegprojectssrore.github.io';
const base = `${origin}/pixelplustest`;
const api = 'https://pixelplus-ai.rudiskiyoleg.workers.dev';
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
const browser = await chromium.launch({ channel: process.env.PIXELPLUS_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  for (const width of [320, 390, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const requests = [];
    const errors = [];
    let session;
    let report = false;
    page.on('pageerror', error => errors.push(error.stack || error.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === origin) {
        if (!url.pathname.startsWith('/pixelplustest/')) return route.fulfill({ status: 404 });
        let name = url.pathname.replace(/^\/pixelplustest\//, '');
        if (name.endsWith('/')) name += 'index.html';
        const filename = path.resolve(root, name);
        assert(filename.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep), filename);
        try {
          let body = await readFile(filename);
          if (['.html', '.css', '.js', '.json', '.svg', '.txt'].includes(path.extname(filename))) body = Buffer.from(body.toString().replaceAll('/assets/', '/pixelplustest/assets/'));
          // Exercise the future released flow only against the isolated fake backend.
          if (name === 'assets/audit-config.js') body = Buffer.from(body.toString().replace('publicSessionsEnabled: false', 'publicSessionsEnabled: true'));
          return route.fulfill({ contentType: types[path.extname(filename)] || 'application/octet-stream', body });
        } catch { return route.fulfill({ status: 404 }); }
      }
      if (url.hostname === 'challenges.cloudflare.com') return route.fulfill({ contentType: 'text/javascript', body: `window.turnstile={render(node,options){setTimeout(()=>options.callback('test-only-challenge'),0);return 'stub';},remove(){}};` });
      if (url.origin === api) {
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'content-type, authorization' } });
        const body = route.request().postDataJSON();
        requests.push({ path: url.pathname, body });
        if (url.pathname === '/api/session') session = { session_id: 'ui-test', library_version: 'fixture', revision: 0, channel_revision: 0, active_channel: body.channel, status: 'in_progress', remaining_ms: 900000, access_expires_at: Date.now() + 86400000,
          question: { id: 'q1', text: 'Какая задача сейчас важнее для вашего бизнеса?', options: [{ id: 'leads', text: 'Получать больше обращений' }, { id: 'cost', text: 'Снизить стоимость привлечения клиентов' }, { id: 'sales', text: 'Увеличить продажи с сайта' }] } };
        if (url.pathname === '/api/chat') {
          session.revision++;
          session.question = { id: 'q2', text: 'Что вы уже пробовали, чтобы решить эту задачу?', options: [] };
        }
        if (url.pathname === '/api/audit/finish') { session.status = 'closing'; session.revision++; report = true; }
        if (url.pathname === '/api/session/ui-test' && report) session.status = 'ready';
        const payload = { session, ...(url.pathname === '/api/session' ? { management_token: 'fixture-only', report_token: 'fixture-report' } : {}), ...(url.pathname === '/api/chat' ? { reply: { id: 'reply-1', text: 'Спасибо, учту вашу задачу при подготовке аудита.' } } : {}) };
        return route.fulfill({ json: payload, headers: { 'Access-Control-Allow-Origin': origin } });
      }
      // Original-site analytics and embeds are not needed to check this UI.
      return route.fulfill({ contentType: 'text/plain', body: '' });
    });
    await page.goto(`${base}/main/`, { waitUntil: 'networkidle' });
    const consent = page.locator('.fancybox__container [data-fancybox-close]').first();
    if (await consent.isVisible()) await consent.click();
    const expert = page.locator('[data-ai-action="chat"]').filter({ hasText: 'Эксперт' });
    await expert.scrollIntoViewIfNeeded();
    const pageScroll = await page.evaluate(() => scrollY);
    await expert.click();
    await page.locator('.audit-textarea:not(:disabled)').waitFor();
    assert.equal(await page.evaluate(() => scrollY), pageScroll, 'Opening the panel preserves the page scroll');
    assert.equal(await page.locator('.audit-body').evaluate(node => node.scrollTop), 0, 'Greeting starts at the top');
    assert.equal(requests[0].body.channel, 'chat');
    assert.equal(requests.filter(r => r.path.startsWith('/api/voice')).length, 0);
    const panel = await page.locator('.audit-dialog').boundingBox();
    assert(panel.x >= 0 && panel.x + panel.width <= width + 1);
    if (width > 600) { assert.equal(Math.round(panel.width), 440); assert.equal(Math.round(panel.x + panel.width), width - 24); }
    else { assert.equal(Math.round(panel.width), width); assert.equal(Math.round(panel.y), 0); }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `page-chat-${width}.png`) });
    await page.locator('.audit-option-input').first().check();
    await page.getByRole('button', { name: 'Ответить', exact: true }).click();
    await page.getByText('Что вы уже пробовали, чтобы решить эту задачу?', { exact: true }).waitFor();
    assert.deepEqual(requests.find(r => r.path === '/api/chat').body.input, { kind: 'selection', option_ids: ['leads'] });
    const composerBefore = await page.locator('.audit-text-form').boundingBox();
    await page.evaluate(() => { const list = document.querySelector('.audit-messages'); for (let i = 0; i < 35; i++) { const item = document.createElement('p'); item.textContent = 'Длинная история разговора для проверки прокрутки.'; list.append(item); } document.querySelector('.audit-body').scrollTop = 200; });
    const composerAfter = await page.locator('.audit-text-form').boundingBox();
    assert.equal(composerBefore.y, composerAfter.y, 'Composer stays fixed while conversation scrolls');
    await page.locator('.audit-textarea').fill('Черновик ответа');
    if (width > 600) {
      const requestCount = requests.length;
      await expert.click();
      assert.equal(await page.locator('.audit-dialog').evaluate(node => node.open), false, 'Second expert click closes the panel');
      assert.equal(requests.length, requestCount, 'Closing does not send API requests');
    } else {
      await page.keyboard.press('Escape');
    }
    assert.equal(await expert.getAttribute('aria-expanded'), 'false');
    assert(await expert.evaluate(node => node === document.activeElement));
    await expert.click();
    assert.equal(await page.locator('.audit-textarea').inputValue(), 'Черновик ответа');
    assert.equal(requests.filter(r => r.path === '/api/session').length, 1, 'Reopening does not create a new session');
    await page.getByRole('button', { name: 'Завершить опрос', exact: true }).click();
    await page.getByRole('button', { name: 'Скачать PDF', exact: true }).waitFor();
    assert.equal(await page.locator('.audit-text-form').isVisible(), false);
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log('PASS actual main page: expert opens chat, no voice start, 4 viewport sizes, choices, fixed composer, draft/reopen, report state, no JS errors. External APIs mocked.');
} finally { await browser.close(); }
