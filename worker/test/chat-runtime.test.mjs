import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const { build } = require('esbuild');
const { Miniflare } = require('miniflare');

test('DeepSeek classifier works in real workerd and refuses redirects without forwarding credentials', async () => {
  const context = { library_version: 'test', mode: 'chat', current_question_id: null, questions: [], facts: [], allowed_answers: [], accepted_facts: [], correctable_answers: [],
    source_events: [{ id: 'u', role: 'user', text: 'Не знаю' }], history: [], clarification_questions: [], faqs: [], joke_categories: [], mapping_rules: [], humor_enabled: false };
  const bundle = await build({ stdin: { resolveDir: fileURLToPath(new URL('../src/', import.meta.url)), contents: `
    import {classifyTurn} from './chat/classifier.ts';
    export default {async fetch(){const result=await classifyTurn(${JSON.stringify(context)}, {
      api_key:'test-secret',max_tokens:4096,timeout_ms:12000,fetch,runAuthorized:(_input,execute)=>execute()
    });return Response.json(result)}};
  ` }, bundle: true, format: 'esm', platform: 'browser', write: false });
  let redirect = false, requests = 0;
  const runtime = new Miniflare({ cf: false, telemetry: { enabled: false }, workers: [{
    config: { name: 'chat-runtime-test', compatibilityDate: '2026-10-22', manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: bundle.outputFiles[0].text },
    } } },
    dev: { outboundService: { type: 'fetcher', handler: async request => {
      requests++; assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
      assert.equal(request.headers.get('Authorization'), 'Bearer test-secret');
      if (redirect) return new Response(null, { status: 302, headers: { Location: 'https://attacker.example/' } });
      const body = await request.json(); assert.equal(body.model, 'deepseek-v4-pro'); assert.deepEqual(body.thinking, { type: 'disabled' });
      return Response.json({ usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
        intent: 'unknown', answers: [], clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null,
      }) } }] });
    } } },
  }] });
  try {
    const result = await (await runtime.dispatchFetch('https://test.example/')).json();
    assert.equal(result.ok, true); assert.equal(result.usage.total_tokens, 100);
    redirect = true;
    const rejected = await (await runtime.dispatchFetch('https://test.example/')).json();
    assert.equal(rejected.ok, false); assert.equal(requests, 2);
  } finally { await runtime.dispose(); }
});
