import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, readdir } from 'node:fs/promises';
const require = createRequire(import.meta.url);
const { build } = require('esbuild'), { Miniflare } = require('miniflare'), { unstable_splitSqlQuery } = require('wrangler');

test('real workerd creates multipart Realtime calls and hangs up; credentials never follow redirects', async () => {
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), contents: `
    import {CoreServices} from './core.ts';
    import {createRealtimeAdapters} from './channel-realtime.ts';
    import {initialAuditState} from './audit/contracts.ts';
    import {library} from './audit/library.ts';
    import {hashToken} from './security.ts';
    const adapters=createRealtimeAdapters();
    export default {async fetch(req,env,execution){try {
      const core=new CoreServices(env),id=new URL(req.url).pathname.slice(1),token=id.padEnd(43,'a');
      await core.store.createSession({id,tokenHash:await hashToken(token),reportId:'report-'+id,reportTokenHash:'report-token-'+id,state:initialAuditState(library.version,'voice',Date.now()),now:Date.now()});
      const request=new Request('https://test.example',{headers:{Authorization:'Bearer '+token}});
      const body={session_id:id,operation_id:crypto.randomUUID(),library_version:library.version,expected_revision:0,channel_revision:0,sdp:'v=0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n'};
      const started=await adapters.voiceStart(request,{core,env,execution,body});
      await adapters.voiceControl(request,{core,env,execution,body:{session_id:id,call_id:started.call_id,action:'stop',delivery_complete:true}});
      return Response.json({sdp:started.sdp_answer,status:(await core.store.getCall(started.call_id)).status});
    }catch(e){return Response.json({error:e.code??'unexpected',message:e.message},{status:503})}}};
  ` }, bundle: true, format: 'esm', platform: 'browser', write: false });
  let redirect = false, requests = 0;
  const runtime = new Miniflare({ cf: false, telemetry: { enabled: false }, workers: [{ config: { name: 'realtime-runtime-test', compatibilityDate: '2026-10-22', manifest: { mainModule: 'index.js', modules: {
    'index.js': { type: 'esm', contents: bundle.outputFiles[0].text },
  } }, env: { DB: { type: 'd1', id: 'realtime-test-db' },
    OPENAI_API_KEY: { type: 'text', value: 'test-secret' }, VOICE_REPLAY_SECRET: { type: 'text', value: Buffer.alloc(32, 3).toString('base64url') },
    ALLOW_DRAFT_LIBRARY: { type: 'text', value: 'true' }, BUDGETS_JSON: { type: 'text', value: '{"voice_starts":14,"voice_seconds":7200}' },
  } }, dev: { outboundService: { type: 'fetcher', handler: async request => {
    requests++; assert.equal(new URL(request.url).origin, 'https://api.openai.com'); assert.equal(request.headers.get('Authorization'), 'Bearer test-secret');
    if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } });
    if (request.url.endsWith('/hangup')) return new Response(null, { status: 200 });
    const form = await request.formData(), config = JSON.parse(String(form.get('session')));
    assert.equal(config.model, 'gpt-realtime-2.1'); assert.equal(config.audio.output.speed, 1);
    assert.match(String(form.get('sdp')), /^v=0/);
    return new Response('v=0\r\nm=audio', { status: 201, headers: { Location: '/v1/realtime/calls/rtc_runtime' } });
  } } } }] });
  try {
    const db = await runtime.getD1Database('DB'), dir = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) await db.batch(unstable_splitSqlQuery(await readFile(new URL(name, dir), 'utf8')).map(sql => db.prepare(sql)));
    const first = await runtime.dispatchFetch('https://test.example/runtime-first');
    const result = await first.json(); assert.equal(first.status, 200, JSON.stringify(result)); assert.equal(result.status, 'stopped'); assert.equal(requests, 2);
    redirect = true;
    const second = await runtime.dispatchFetch('https://test.example/runtime-redirect'); assert.equal(second.status, 503); assert.equal(requests, 3, 'No credentials sent to redirect destination');
  } finally { await runtime.dispose(); }
});
