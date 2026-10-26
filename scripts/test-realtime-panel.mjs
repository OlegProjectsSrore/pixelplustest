import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const { chromium } = await import(process.env.PIXELPLUS_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../dist/assets/', import.meta.url));
const browser = await chromium.launch({ channel: process.env.PIXELPLUS_BROWSER_CHANNEL || 'msedge', headless: true });
try {
  for (const width of [390, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      assert.equal(url.origin, 'https://panel.example', 'No external requests in this test');
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/audit-ui.css"></head><body></body></html>' });
      assert(/^\/[a-z-]+\.(?:js|css)$/.test(url.pathname));
      await route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : 'text/css', body: await readFile(path.join(root, url.pathname.slice(1))) });
    });
    await page.goto('https://panel.example/');
    await page.evaluate(async () => {
      const { createAuditClient } = await import('/audit-client.js');
      window.fixture = { peers: [], stops: 0, tracks: 0, starts: 0, tools: 0, requests: [], snapshots: [] };
      const f = window.fixture;
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { async getUserMedia() {
        const track = { stop() { f.tracks++; } }; return { getTracks: () => [track], getAudioTracks: () => [track] };
      } } });
      window.RTCPeerConnection = class {
        constructor() { f.peers.push(this); this.connectionState = 'new'; }
        createDataChannel() { return this.dc = { readyState: 'connecting', sent: [], send(data) { this.sent.push(JSON.parse(data)); }, close() { this.readyState = 'closed'; } }; }
        addTrack() {} async createOffer() { return { sdp: 'v=0\r\nm=audio' }; } async setLocalDescription() {}
        async setRemoteDescription() { this.connectionState = 'connected'; this.dc.readyState = 'open'; this.dc.onopen(); }
        close() { this.connectionState = 'closed'; }
      };
      let state = { session_id: 'test-session', library_version: 'test', revision: 0, channel_revision: 0, active_channel: 'chat', status: 'in_progress', paused: false,
        access_expires_at: Date.now() + 86400000, remaining_ms: 900000, question: { id: 'context_name', text: 'Как Вас зовут?', options: [] } };
      let activeSince = null;
      const persistence = { load: () => ({ version: 1, session: state, management_token: 'test-only', messages: [] }), save(value) { f.snapshots.push(structuredClone(value)); } };
      const transport = { async request(url, { body, method } = {}) {
        f.requests.push(url);
        if (method !== 'POST') return { session: structuredClone(state) };
        if (url === '/api/voice/control') {
          if (body.action === 'heartbeat') return { accepted: true };
          f.stops++; state.paused = true; state.revision++; state.remaining_ms -= Date.now() - activeSince; activeSince = null;
          return { accepted: true, session: structuredClone(state) };
        }
        if (body.expected_revision !== state.revision) throw new Error('Unexpected revision conflict');
        state.revision++;
        if (url === '/api/session/channel') { state.active_channel = body.channel || state.active_channel; state.paused = state.active_channel === 'voice'; state.channel_revision++; }
        if (url === '/api/voice/start') { f.starts++; state.paused = false; activeSince = Date.now(); return { call_id: `call${f.starts}`, sdp_answer: 'v=0', first_message: 'Как Вас зовут?', session: structuredClone(state) }; }
        if (url === '/api/voice/transcript') return { session: structuredClone(state), through_event_id: 'event', accepted_events: body.events.map(e => ({ event_id: e.id, source_key: e.source_key, source_revision: e.source_revision })) };
        if (url === '/api/voice/answers') { f.tools++; return { session: structuredClone(state), accepted: true, realtime_instructions: 'Следующий вопрос' }; }
        return { session: structuredClone(state) };
      } };
      window.client = createAuditClient({ config: { apiBaseUrl: 'https://panel.example', turnstileEnabled: false, voiceProvider: 'openai' }, persistence, transport });
      await window.client.open();
    });
    for (let i = 0; i < 4; i++) {
      await page.getByRole('button', { name: 'Голос', exact: true }).click();
      await page.waitForFunction(n => fixture.starts === n && fixture.peers.at(-1).connectionState === 'connected', i + 1);
      await page.evaluate(i => {
        const dc = fixture.peers.at(-1).dc;
        const event = e => dc.onmessage({ data: JSON.stringify(e) });
        event({ type: 'conversation.item.input_audio_transcription.completed', item_id: `user${i}`, transcript: `Ответ ${i}` });
        event({ type: 'response.output_audio_transcript.done', item_id: `ai${i}`, transcript: `Уточнение ${i}` });
        const call = { type: 'function_call', call_id: `tool${i}`, name: 'saveAnswers', arguments: '{"answers":[]}' };
        event({ type: 'response.done', response: { status: 'completed', output: [call] } });
      }, i);
      await page.waitForFunction(n => fixture.tools === n, i + 1);
      await page.getByRole('button', { name: 'Чат', exact: true }).click();
      await page.waitForFunction(n => fixture.stops === n && fixture.snapshots.at(-1).session.active_channel === 'chat', i + 1);
      assert.equal(await page.locator('.audit-error:visible').count(), 0);
    }
    const counts = await page.evaluate(() => ({ starts: fixture.starts, stops: fixture.stops, tracks: fixture.tracks, messages: fixture.snapshots.at(-1).messages.length, used: fixture.snapshots.at(-1).session.remaining_ms }));
    assert.equal(counts.starts, 4); assert.equal(counts.stops, 4); assert.equal(counts.tracks, 4); assert.equal(counts.messages, 8);
    await page.waitForTimeout(1200);
    assert.equal(await page.evaluate(() => fixture.snapshots.at(-1).session.remaining_ms), counts.used);
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.client.destroy()); await page.close();
  }
  console.log('PASS native Realtime adapter + real controller/UI: 4 voice/chat switches at 390/1440px, transcripts/tools, track cleanup, stopped timer, no false errors. Provider/RTC mocked.');
} finally { await browser.close(); }
