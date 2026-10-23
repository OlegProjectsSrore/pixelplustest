import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');

test('real workerd can read Ultravox account/call and refuses redirects without forwarding the key', async () => {
  const voice = '83b2a94f-8078-4321-935c-a0798b2ac621';
  const bundled = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), contents: `
    import {inspectAccount} from './voice/accounts.ts';
    import {createVoiceProvider} from './voice/provider.ts';
    export default {async fetch(){try {
      const account=await inspectAccount('test-secret','test-model','${voice}',fetch);
      const provider=createVoiceProvider({api_key:'test-secret',account_slot:'1',fetch,run_authorized:(_,run)=>run()});
      const call=await provider.getCall('${voice}');return Response.json({account,call});
    }catch(e){return Response.json({error:e.code??'unexpected',message:e.message},{status:503})}}};
  ` }, bundle: true, format: 'esm', platform: 'browser', write: false });
  let redirect = false, requests = 0;
  const runtime = new Miniflare({ cf: false, telemetry: { enabled: false }, workers: [{
    config: { name: 'voice-runtime-test', compatibilityDate: '2026-10-22', manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: bundled.outputFiles[0].text },
    } } },
    dev: { outboundService: { type: 'fetcher', handler: async request => {
      requests++; assert.equal(new URL(request.url).origin, 'https://api.ultravox.ai');
      assert.equal(request.headers.get('X-API-Key'), 'test-secret');
      if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } });
      if (request.url.includes('/voices/')) return Response.json({ voiceId: voice, billingStyle: 'VOICE_BILLING_STYLE_INCLUDED' });
      if (request.url.includes('/models')) return Response.json({ results: [{ name: 'test-model' }], next: null });
      if (request.url.includes('/calls/')) return Response.json({ callId: voice, created: new Date().toISOString(), joined: null, ended: null, endReason: null, billedDuration: null, billingStatus: null });
      return Response.json({ accountId: voice, freeTimeRemaining: '1800s', activeCalls: 0, allowedConcurrentCalls: 2 });
    } } },
  }] });
  try {
    const response = await runtime.dispatchFetch('https://test.example/');
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result)); assert.equal(result.account.remainingMs, 1800000);
    assert.equal(requests, 4);
    redirect = true;
    const rejected = await runtime.dispatchFetch('https://test.example/');
    assert.equal(rejected.status, 503); assert.equal((await rejected.json()).error, 'provider_http');
    assert.equal(requests, 5, 'redirect target was never contacted');
  } finally { await runtime.dispose(); }
});
