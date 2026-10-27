import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/d1.ts';
import { NAME_CHECK_PROMPT } from '../src/chat/name-check.ts';
import { createWorker } from '../src/index.ts';
import { CoreServices } from '../src/core.ts';
import type { Env } from '../src/env.ts';

// Use the real client and transport; only DOM presentation and external providers are replaced.
(globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
(globalThis as any).document = { addEventListener() {} };
// @ts-expect-error The independently implemented static frontend intentionally uses JavaScript.
const { createAuditClient } = await import('../../dist/assets/audit-client.js');
// @ts-expect-error Static frontend transport has no TypeScript declaration file.
const { createAuditTransport } = await import('../../dist/assets/audit-http.js');

test('real client/transport/Worker: creation, key phrase, text, multi-selection, lost ACK retry, pause and finish', async () => {
  const db = new SqliteD1(); let now = Date.parse('2026-10-22T20:00:00Z');
  const jobs: Promise<unknown>[] = [];
  let providerCalls = 0, stored: any = null, handlers: any, model: any, dropSelectionAck = true;
  const selectionBodies: string[] = [];
  const origin = 'https://olegprojectssrore.github.io';
  const env: Env = { DB: db.binding(), REPORTS_KV: { get: async () => null, put: async () => undefined } as unknown as KVNamespace,
    ALLOW_DRAFT_LIBRARY: 'true', ALLOWED_ORIGINS: origin, TURNSTILE_HOSTNAMES: 'olegprojectssrore.github.io',
    TURNSTILE_SECRET: 'local-test', IP_HASH_SALT: 'local-test-only-'.repeat(4), DEEPSEEK_API_KEY: 'local-test',
    BUDGETS_JSON: JSON.stringify({ new_sessions: 10, sessions_per_ip: 10, deepseek_usd_micros: 20_000_000, deepseek_calls: 10, deepseek_tokens: 1_000_000 }) };
  const provider: typeof fetch = async (url, init) => {
    if (String(url).includes('turnstile')) return Response.json({ success: true, hostname: 'olegprojectssrore.github.io', action: 'session' });
    if (String(url).startsWith('https://cloudflare-dns.com/')) return Response.json({ Status: 0, Answer: [{ type: 1 }] });
    // The name check answers apart from the classifier.
    if (JSON.parse(String(init?.body)).messages[0].content === NAME_CHECK_PROMPT) return Response.json({ usage: { prompt_tokens: 60, completion_tokens: 5, total_tokens: 65 }, choices: [{ finish_reason: 'stop', message: { content: '{"is_name":true}' } }] });
    providerCalls++;
    const context = JSON.parse(JSON.parse(String(init?.body)).messages[1].content), event = context.source_events[0];
    const answers = [ ['context_name', 'context.name', 'Олег'], ['context_position', 'context.position', 'Директор'], ['context_company_name', 'context.company_name', 'Магазин «Дом»'], ['context_website', 'context.website', 'dom-shop.ru'], ['context_responsibilities', 'context.responsibilities', 'Продажи'], ['context_company_size', 'context.company_size', '50 сотрудников'], ['context_business', 'context.business', 'Магазин'], ['context_goal', 'context.goal', 'Рост продаж'], ['context_assets', 'context.assets', ['Сайт']], ['context_products', 'context.products', 'Товары для дома'], ['context_audience', 'context.audience', 'Частные покупатели'], ['context_channels', 'context.channels', ['Сайт']], ['context_geography', 'context.geography', ['Москва']], ['context_revenue_year', 'context.revenue_year', '10 млн рублей'], ['context_revenue_3y', 'context.revenue_3y', '25 млн рублей'], ['context_average_check', 'context.average_check', '5 тысяч рублей'], ['context_deal_cycle', 'context.deal_cycle', 'Один день'], ['context_goal_period', 'context.goal_period', 'К весне'], ['context_main_problem', 'context.main_problem', 'Мало продаж'] ]
      .map(([question_id, fact_id, value]) => ({ question_id, fact_id, value, state: 'known', event_ids: [event.id], evidence: [{ event_id: event.id, text: event.text }] }));
    const start = event.text.includes('диагностик');
    return Response.json({ usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      intent: start ? 'start_diagnostic' : 'answer', answers: start ? [] : answers, clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null,
    }) } }] });
  };
  const worker = createWorker(undefined, { now: () => now, fetcher: provider });
  const transport = createAuditTransport('https://audit.example', { fetcher: async (url: string, init: RequestInit) => {
    const headers = new Headers(init.headers); headers.set('Origin', origin); headers.set('CF-Connecting-IP', '192.0.2.1');
    const response = await worker.fetch(new Request(url, { ...init, headers }), env, { waitUntil(promise: Promise<unknown>) { jobs.push(promise); } } as ExecutionContext);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    if (url.endsWith('/api/chat') && body.input.kind === 'selection') {
      selectionBodies.push(String(init.body));
      if (dropSelectionAck && response.ok) { dropSelectionAck = false; throw new Error('lost ACK after durable commit'); }
    }
    return response;
  } });
  const client = createAuditClient({ config: { apiBaseUrl: 'https://audit.example', turnstileSiteKey: 'local-test' }, transport, now: () => now,
    persistence: { load: () => structuredClone(stored), save: (value: unknown) => { stored = structuredClone(value); } }, challenge: async () => 'test-turnstile',
    viewFactory(callbacks: any) { handlers = callbacks; return { open() {}, destroy() {}, render(value: unknown) { model = value; },
      getDraft: () => '', setDraft() {}, clearDraft() {}, challengeElement: {} }; },
  });
  try {
    await client.open('chat');
    // The greeting asks what the visitor needs; the survey starts on the key phrase.
    assert.equal(model.error, ''); assert.equal(client.session.question, null); assert.equal(model.diagnostic, false);
    await handlers.onText('Давайте экспресс-диагностику');
    assert.equal(model.error, ''); assert.equal(client.session.question.id, 'context_name'); assert.equal(model.diagnostic, true);
    assert.equal(stored.management_token.length, 43); assert.notEqual(stored.management_token, stored.report_token);
    now += 600000;
    await handlers.onText('Олег. Директор. Отвечаю за продажи. 50 сотрудников. Магазин. Рост продаж. Сайт.');
    assert.equal(model.remaining_seconds, 1500, 'Ten minutes in chat do not consume the voice timer');
    assert.equal(model.error, ''); assert.equal(client.session.question.id, 'context_priority');
    assert.equal(model.question.answer_mode, 'multiple');
    await handlers.onSelection(['strategy', 'analytics']);
    assert.ok(stored.pending); assert.equal(providerCalls, 2);
    const core = new CoreServices(env, () => now);
    const revision = (await core.store.requireSession(client.session.session_id)).state.revision;
    await handlers.onRetry();
    assert.equal(model.error, ''); assert.equal(stored.pending, null);
    assert.equal(selectionBodies.length, 2); assert.equal(selectionBodies[0], selectionBodies[1]);
    assert.equal(client.session.revision, revision); assert.equal(providerCalls, 2);
    const answers = await core.store.listAnswers(client.session.session_id);
    assert.equal(answers.length, 20);
    assert.deepEqual(answers.find(answer => answer.fact_id === 'context.priority')?.value, ['strategy', 'analytics']);
    await handlers.onPause(); assert.equal(client.session.paused, true);
    await handlers.onResume(); assert.equal(client.session.paused, false);
    await handlers.onFinish();
    assert.ok(['closing', 'preparing'].includes(client.session.status));
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM audit_jobs').get()!.n, 1);
    assert.ok(stored.messages.some((message: any) => message.id === 'closing-message'));
  } finally { await client.destroy(); await Promise.allSettled(jobs); db.close(); }
});
