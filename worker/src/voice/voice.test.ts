import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  buildCallConfig, buildInterviewPrompt, CLOSING_MESSAGE, createInterviewTools, createVoiceProvider, createVoiceStartHandler, fetchCallHistory,
  normalizeProviderMessage, parseVerifiedWebhook, parseVoiceAnswerPayload, parseVoiceFinishPayload,
  parseVoiceOffTopicPayload, verifyWebhookSignature, VoiceProviderError,
} from './index.ts';
import type { VoiceCallConfig, VoiceDependencies } from './types.ts';
import { renderPrompt } from '../prompt-template.ts';
import { INTERVIEW_PROMPT } from './interview-prompt.ts';
import type { AdapterContext } from '../integration.ts';

const id = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const created = '2026-10-22T10:00:00Z';
const rawCall = { callId: id, created, joined: null, ended: null, endReason: null, billedDuration: null, billingStatus: 'BILLING_STATUS_PENDING', joinUrl: 'wss://voice.ultravox.ai/call?token=private' };
const config: VoiceCallConfig = { system_prompt: 'Опрос', model: 'account-approved-model', voice: 'account-approved-voice', first_message: 'Здравствуйте.', remaining_seconds: 321.9876, callback_url: 'https://pixel.example/api/webhooks/ultravox', webhook_secrets: ['test-signing-secret'] };
const candidate = { question_id: 'q1', fact_id: 'f1', state: 'known', value: true, source_quotes: ['Да, пробовали'], source_ordinals: [3], confirmation_candidate: 'unconfirmed' };
const message = { role: 'MESSAGE_ROLE_USER', text: 'Да, пробовали', medium: 'MESSAGE_MEDIUM_VOICE', callStageId: 'stage-1', callStageMessageIndex: 0, timespan: { start: '1.2s', end: '2s' }, wallClockTimespan: { start: '1.4s', end: '2.2s' } };
const pass: VoiceDependencies['run_authorized'] = async (_context, execute) => execute();
const mockFetch = (handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)) as typeof fetch;

test('call configuration pins WebRTC evidence, signing and remaining budget on continuation', () => {
  const output = buildCallConfig({ ...config, prior_call_id: id });
  assert.equal(output.prior_call_id, id);
  assert.equal(output.body.maxDuration, '321.987s');
  assert.equal(output.body.recordingEnabled, false);
  assert.equal(output.body.transcriptOptional, false);
  assert.equal(output.body.callbacks.ended.secrets[0], 'test-signing-secret');
  assert.equal(output.body.timeExceededMessage, CLOSING_MESSAGE);
  assert.equal('initialMessages' in output.body, false);
  assert.equal('voiceOverrides' in output.body, false);
  assert.deepEqual(buildCallConfig({ ...config, prior_call_id: id, user_first: true }).body.firstSpeakerSettings, { user: {} });
  assert.deepEqual(output.body.firstSpeakerSettings, { agent: { text: 'Здравствуйте.', uninterruptible: false } });
  const nikolai = buildCallConfig({ ...config, voice: '83b2a94f-8078-4321-935c-a0798b2ac621' });
  assert.deepEqual(nikolai.body.voiceOverrides, { inworld: { speakingRate: 1 } });
  assert.throws(() => buildCallConfig({ ...config, prior_call_id: id, initial_messages: [] }), /mutually exclusive/);
  assert.throws(() => buildCallConfig({ ...config, remaining_seconds: 901 }), /Remaining/);
  assert.throws(() => buildCallConfig({ ...config, remaining_seconds: 0 }), /Remaining/);
  assert.throws(() => buildCallConfig({ ...config, webhook_secrets: [] }), /signing/);
  assert.throws(() => buildCallConfig({ ...config, callback_url: 'http://pixel.example/webhook' }), /HTTPS/);
});

test('cross-account continuation emits verified provider message enum values', () => {
  const result = buildCallConfig({ ...config, initial_messages: [{ role: 'user', text: 'Да' }, { role: 'assistant', text: 'Уточню' }] });
  assert.deepEqual(result.body.initialMessages, [{ role: 'MESSAGE_ROLE_USER', text: 'Да' }, { role: 'MESSAGE_ROLE_AGENT', text: 'Уточню' }]);
  const tools = result.body.selectedTools;
  assert.equal(tools.filter(tool => 'temporaryTool' in tool).every(tool => 'temporaryTool' in tool && tool.temporaryTool.precomputable === false), true);
  assert.equal(JSON.stringify(tools).includes('test-signing-secret'), false);
  assert.equal(JSON.stringify(tools).includes('session_id'), false);
  assert.deepEqual(tools.at(-1), { toolName: 'hangUp', parameterOverrides: { strict: true } });
});

test('authorization gate runs before every fetch, including history pages, and can deny without network activity', async () => {
  let count = 0;
  const provider = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', fetch: mockFetch(() => { count++; return Response.json(rawCall); }), run_authorized: async () => { throw new Error('not authorized'); } });
  await assert.rejects(provider.createCall(config), /not authorized/);
  await assert.rejects(provider.getCall(id), /not authorized/);
  await assert.rejects(provider.getCallHistory(id), /not authorized/);
  assert.equal(count, 0);
});

test('create uses priorCallId query and validates response without persisting join token', async () => {
  let calls = 0;
  const provider = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: async (context, execute) => { assert.equal(context.operation, 'create_call'); assert.equal(context.mutating, true); return execute(); }, fetch: mockFetch((url, init) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('priorCallId'), id);
    assert.equal(init?.redirect, 'manual');
    assert.equal((init?.headers as Record<string, string>)['X-API-Key'], 'private');
    assert.equal(JSON.parse(String(init?.body)).maxDuration, '321.987s');
    return Response.json(rawCall, { status: 201 });
  }) });
  const result = await provider.createCall({ ...config, prior_call_id: id });
  assert.equal(result.call.created_at, Date.parse(created));
  assert.equal('join_url' in result.call, false);
  assert.equal(result.join_url, rawCall.joinUrl);
  assert.equal(calls, 1);
});

test('uncertain create outcomes are never retried or exposed as safe failures', async () => {
  let calls = 0;
  const provider = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => { calls++; throw new Error('network with private credential'); }) });
  await assert.rejects(provider.createCall(config), error => error instanceof VoiceProviderError && error.creation_outcome === 'unknown' && !error.message.includes('private'));
  assert.equal(calls, 1);
  const invalid = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => Response.json({ ...rawCall, joinUrl: null }, { status: 201 })) });
  await assert.rejects(invalid.createCall(config), error => error instanceof VoiceProviderError && error.creation_outcome === 'unknown' && error.provider_call_id === id);
  const timedOut = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => new Response('', { status: 408 })) });
  await assert.rejects(timedOut.createCall(config), error => error instanceof VoiceProviderError && error.creation_outcome === 'unknown');
});

test('429 retains retry advice; lookup rejects a different provider call', async () => {
  const provider = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => new Response('', { status: 429, headers: { 'Retry-After': '12' } })) });
  await assert.rejects(provider.createCall(config), error => error instanceof VoiceProviderError && error.creation_outcome === 'not_created' && error.retry_after === '12');
  const wrongCall = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => Response.json({ ...rawCall, callId: otherId })) });
  await assert.rejects(wrongCall.getCall(id), /another call/);
});

test('history reads all stages/pages, retains tool roles and relative time, and removes identical overlaps', async () => {
  let reads = 0, gates = 0;
  const provider = createVoiceProvider({ api_key: 'private', account_slot: 'slot-1', run_authorized: async (context, execute) => { assert.equal(context.operation, 'get_history'); gates++; return execute(); }, fetch: mockFetch(url => {
    assert.equal(new URL(url).searchParams.get('mode'), 'in_call'); reads++;
    return Response.json(reads === 1 ? { results: [message], next: `/api/calls/${id}/messages?cursor=next` } : { results: [message, { ...message, role: 'MESSAGE_ROLE_TOOL_RESULT', callStageId: 'stage-2', text: '{}' }], next: null });
  }) });
  const result = await provider.getCallHistory(id);
  assert.equal(reads, 2); assert.equal(gates, 2);
  assert.equal(result.length, 2);
  assert.equal(result[1].role, 'tool_result');
  assert.equal(result[1].provider_order, 1);
  assert.deepEqual(result[0].wall_clock_timespan, { start: '1.4s', end: '2.2s' });
  assert.equal('ordinal' in result[0], false);
});

test('history refuses hostile pagination URLs, downgraded mode and endless cursors', async () => {
  for (const next of ['https://attacker.example/steal', `/api/calls/${otherId}/messages?cursor=next`, `/api/calls/${id}/messages?mode=last_stage`]) {
    let reads = 0;
    await assert.rejects(fetchCallHistory(id, async () => { reads++; return { results: [], next }; }), /pagination/);
    assert.equal(reads, 1);
  }
  await assert.rejects(fetchCallHistory(id, async () => ({ results: [], next: `/api/calls/${id}/messages?cursor=same` })), /loop/);
  await assert.rejects(fetchCallHistory(id, async () => ({ results: [message], next: `/api/calls/${id}/messages?cursor=next` }), { max_pages: 1 }), /page limit/);
});

test('history does not silently combine conflicting message versions or unknown roles', async () => {
  let reads = 0;
  await assert.rejects(fetchCallHistory(id, async () => ++reads === 1 ? { results: [message], next: '?cursor=2' } : { results: [{ ...message, text: 'Нет' }], next: null }), /Conflicting/);
  assert.throws(() => normalizeProviderMessage({ ...message, role: '__proto__' }, id, 0), /role/);
  assert.throws(() => normalizeProviderMessage({ ...message, wallClockTimespan: { start: created } }, id, 0), /duration/);
});

const now = Date.parse('2026-10-22T10:00:30Z');
function signed(body: Uint8Array, timestamp = '2026-10-22T10:00:29Z', secret = 'new-secret'): Headers {
  const signature = createHmac('sha256', secret).update(body).update(timestamp).digest('hex');
  return new Headers({ 'X-Ultravox-Webhook-Timestamp': timestamp, 'X-Ultravox-Webhook-Signature': `${'0'.repeat(64)}, ${signature}` });
}
test('webhook HMAC verifies raw UTF-8 bytes and rotating keys, not reserialized JSON', async () => {
  const body = new TextEncoder().encode('{ "text": "Привет" }');
  const options = { secrets: ['old-secret', 'new-secret'], now: () => now };
  assert.equal(await verifyWebhookSignature(body, signed(body), options), true);
  const changed = new TextEncoder().encode('{"text":"Привет"}');
  assert.equal(await verifyWebhookSignature(changed, signed(body), options), false);
  assert.equal(await verifyWebhookSignature(body, signed(body), { ...options, secrets: ['wrong-secret'] }), false);
});

test('webhook rejects stale/future/invalid timestamps and malformed signatures', async () => {
  const body = new TextEncoder().encode('{}'), options = { secrets: ['new-secret'], now: () => now };
  for (const stamp of ['2026-10-22T09:59:00Z', '2026-10-22T10:05:00Z', 'not-a-date']) assert.equal(await verifyWebhookSignature(body, signed(body, stamp), options), false);
  const headers = signed(body); headers.set('X-Ultravox-Webhook-Signature', 'xyz');
  assert.equal(await verifyWebhookSignature(body, headers, options), false);
});

test('verified webhook normalizes lifecycle but does not trust provider metadata as session authority', async () => {
  const body = new TextEncoder().encode(JSON.stringify({ event: 'call.ended', call: { ...rawCall, ended: '2026-10-22T10:00:28Z', endReason: 'unjoined', metadata: { session_id: 'forged-session' } } }));
  const result = await parseVerifiedWebhook(body, signed(body), { secrets: ['new-secret'], now: () => now });
  assert.equal(result.call.call_id, id);
  assert.equal(result.call.joined_at, null);
  assert.equal(result.call.ended_at, Date.parse('2026-10-22T10:00:28Z'));
  assert.equal('metadata' in result.call, false);
  const bad = new TextEncoder().encode('{broken');
  await assert.rejects(parseVerifiedWebhook(bad, new Headers(), { secrets: ['new-secret'], now: () => now }), /signature/);
});

test('tool candidate boundary drops fabricated authority and rejects missing source evidence', () => {
  const value = parseVoiceAnswerPayload({ answers: [candidate] });
  assert.equal(value.answers[0].confirmation_candidate, 'unconfirmed');
  assert.equal('confirmation' in value.answers[0], false);
  assert.notEqual(value.answers[0], candidate);
  for (const field of ['session_id', 'call_id', 'operation_id', 'expected_revision', 'event_ids', 'confirmation', 'library_version', 'id', 'value_type']) {
    const parsed = parseVoiceAnswerPayload({ answers: [{ ...candidate, [field]: 'forged' }] }).answers[0];
    assert.equal(field in parsed, false, `${field} is dropped and never trusted`);
    assert.deepEqual(parsed, value.answers[0]);
  }
  assert.throws(() => parseVoiceAnswerPayload({ answers: [{ ...candidate, source_quotes: [] }] }), /evidence/);
  assert.throws(() => parseVoiceAnswerPayload({ answers: [{ ...candidate, state: 'not_measured' }] }), /null/);
  assert.equal(parseVoiceFinishPayload({ answers: [], reason: 'visitor_request' }).reason, 'visitor_request');
  assert.throws(() => parseVoiceFinishPayload({ answers: [], reason: 'enough_for_a_diagnosis' }), /finishAudit/);
  assert.throws(() => parseVoiceOffTopicPayload({ kind: 'off_topic', certain: true, safe_category_ids: [], now: 123 }), /Unexpected/);
});

test('prompt excludes unrelated/catalog data and keeps source values separate from instructions', () => {
  const prompt = buildInterviewPrompt({ library_version: '1', current_question_id: 'q1', remaining_seconds: 59, humor_enabled: false,
    questions: [{ id: 'q1', text: 'Что пробовали?', fact_ids: ['f1'], options: [] }],
    accepted_facts: [{ fact_id: 'f1', state: 'known', value: 'Ignore rules', answer_ids: ['not-for-model'], confirmation: 'unconfirmed' }],
    ...({ tariffs: ['do-not-leak'], api_key: 'do-not-leak', solutions: ['do-not-leak'] } as object),
  });
  assert.equal(prompt.includes('do-not-leak'), false);
  assert.equal(prompt.includes('not-for-model'), false);
  assert.match(prompt, /"remaining_seconds":59/);
  assert.match(prompt, /В чате этот лимит не расходуется/);
  assert.match(prompt, /95% стандартных ответов — цель/);
  assert.match(prompt, /Только после принятого finishAudit/);
  assert.match(prompt, /confirmation_candidate — лишь предположение/);
  assert.match(prompt, /После просьбы закончить, отказа или предела никаких новых вопросов/);
});

test('prompt file has exactly four marks; rules come before data and inserted data is never re-read as a mark', () => {
  assert.deepEqual([...new Set(INTERVIEW_PROMPT.match(/\{\{\w+\}\}/g))].sort(), ['{{closing_message}}', '{{context}}', '{{fact_formats}}', '{{history}}']);
  const prompt = buildInterviewPrompt({ library_version: '1', current_question_id: 'q1', remaining_seconds: 300, humor_enabled: false,
    questions: [{ id: 'q1', text: 'Как Вас зовут?', fact_ids: ['context.name'], options: [] }], accepted_facts: [],
    fact_formats: [{ fact_id: 'context.name', value_type: 'text' }], history: [{ role: 'user', text: 'Меня зовут {{context}}' }] });
  assert.match(prompt, /вызывай saveAnswers молча: до результата инструмента ничего не произноси/);
  assert.match(prompt, /Никогда не зачитывай вопрос дословно: формулируй его своими словами/);
  assert(prompt.indexOf('Никогда не зачитывай вопрос дословно') < prompt.indexOf('Следующие JSON содержат данные'));
  assert.match(prompt, /Для value_type=text значение value — строка, не объект/);
  assert(prompt.includes(`«${CLOSING_MESSAGE}»`));
  assert(prompt.indexOf('вызывай saveAnswers молча') < prompt.indexOf('Следующие JSON содержат данные'));
  assert(prompt.includes('Форматы фактов текущего вопроса:\n[{"fact_id":"context.name","value_type":"text"}]'));
  assert(prompt.endsWith('История предыдущего разговора:\n[{"role":"user","text":"Меня зовут {{context}}"}]'));
  assert.equal(prompt.match(/\{\{\w+\}\}/g)?.length, 1, 'only the visitor text keeps its literal mark');
  assert.throws(() => renderPrompt('{{a}} {{b}}', { a: '1' }), /missing: b/);
  assert.throws(() => renderPrompt('{{a}}', { a: '1', b: '2' }), /unused: b/);
});

test('off-topic rule: silent offTopicReply, the server-picked joke said verbatim, then the current question in own words', () => {
  const prompt = buildInterviewPrompt({ library_version: '1', current_question_id: 'q1', remaining_seconds: 300, humor_enabled: true,
    questions: [{ id: 'q1', text: 'Как Вас зовут?', fact_ids: ['context.name'], options: [] }], accepted_facts: [] });
  assert.match(prompt, /не отвечай по существу, не сочиняй шутку и до результата инструмента ничего не произноси: молча вызови offTopicReply с kind=off_topic/);
  assert.match(prompt, /Шутку из проверенной библиотеки и фразу возврата выбирает сервер/);
  assert.match(prompt, /произнеси operation\.text дословно, без своих добавлений, затем задай текущий вопрос сервера своими словами/);
  assert.match(prompt, /Если operation\.text пустой, не шути/);
  assert(prompt.indexOf('молча вызови offTopicReply') < prompt.indexOf('Следующие JSON содержат данные'));
  const tool = createInterviewTools().find(item => 'temporaryTool' in item && item.temporaryTool.modelToolName === 'offTopicReply');
  assert(tool && 'temporaryTool' in tool); assert.match(tool.temporaryTool.description, /^Вызывать молча при любом уходе посетителя от темы/);
});

test('start bridge returns no join URL until caller has attached the provider call', async () => {
  const steps: string[] = [];
  const context = { core: {}, session: { id: 'session' }, body: { operation_id: 'operation' } } as unknown as AdapterContext;
  const handler = createVoiceStartHandler(async (_core, session, body) => {
    assert.equal(session.id, 'session'); assert.equal(body.operation_id, 'operation');
    steps.push('plan');
    return { kind: 'create', call_record_id: 'local-call', config,
      provider_dependencies: { api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => { steps.push('provider'); return Response.json(rawCall, { status: 201 }); }) },
      on_created: async result => { assert.equal(result.call.call_id, id); steps.push('attach'); return { revision: 2 }; },
      on_failure: async () => { throw new Error('not expected'); },
    };
  });
  const result = await handler(new Request('https://pixel.example/api/voice/start'), context);
  assert.deepEqual(steps, ['plan', 'provider', 'attach']);
  assert.deepEqual(result, { call_id: 'local-call', provider_call_id: id, join_url: rawCall.joinUrl, session: { revision: 2 } });
  const duplicate = createVoiceStartHandler(async () => ({ kind: 'existing', response: { kind: 'duplicate' } }));
  assert.deepEqual(await duplicate(new Request('https://pixel.example'), context), { kind: 'duplicate' });
});

test('start bridge marks attach failure unknown with the provider ID for caller reconciliation', async () => {
  let failure: unknown;
  const context = { core: {}, session: { id: 'session' }, body: {} } as unknown as AdapterContext;
  const handler = createVoiceStartHandler(async () => ({ kind: 'create', call_record_id: 'local-call', config,
    provider_dependencies: { api_key: 'private', account_slot: 'slot-1', run_authorized: pass, fetch: mockFetch(() => Response.json(rawCall, { status: 201 })) },
    on_created: async () => { throw new Error('D1 unavailable'); }, on_failure: async error => { failure = error; },
  }));
  await assert.rejects(handler(new Request('https://pixel.example'), context), error => error instanceof VoiceProviderError && error.code === 'ULTRAVOX_ATTACH_FAILED');
  assert.ok(failure instanceof VoiceProviderError);
  assert.equal(failure.creation_outcome, 'unknown'); assert.equal(failure.provider_call_id, id);
});
