import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteD1 } from './helpers/d1.ts';
import { createWorker } from '../src/index.ts';
import { CoreServices } from '../src/core.ts';
import { hashToken, randomToken, readJson, verifyTurnstile, HttpError } from '../src/security.ts';
import { initialAuditState, type AuditAnswer } from '../src/audit/contracts.ts';
import { library } from '../src/audit/library.ts';
import type { Env } from '../src/env.ts';
import type { ChannelAdapters } from '../src/integration.ts';
import { createChatAdapter } from '../src/channel-runtime.ts';
import { createKnowledgeSearchHandler } from '../src/search/service.ts';
import knowledgeIndex from '../src/search/kb-index.mjs';

const now = Date.UTC(2026, 9, 22, 20);
const origin = 'https://olegprojectssrore.github.io';
function setup(adapters: ChannelAdapters = {}) {
  const db = new SqliteD1(); const pending: Promise<unknown>[] = [];
  const env: Env = { DB: db.binding(), REPORTS_KV: { get: async () => null, put: async () => undefined } as unknown as KVNamespace,
    ALLOWED_ORIGINS: origin, TURNSTILE_HOSTNAMES: 'olegprojectssrore.github.io', TURNSTILE_SECRET: 'test-secret', IP_HASH_SALT: 'test-salt-'.repeat(5),
    ALLOW_DRAFT_LIBRARY: 'true', BUDGETS_JSON: JSON.stringify({ new_sessions: 10, sessions_per_ip: 10, requests_per_ip_per_minute: 120 }) };
  const worker = createWorker(adapters, { now: () => now, fetcher: (async () => Response.json({ success: true, hostname: 'olegprojectssrore.github.io', action: 'session' })) as typeof fetch });
  const ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); }, passThroughOnException() {} } as ExecutionContext;
  const call = (path: string, body?: unknown, token?: string, requestOrigin = origin) => worker.fetch(new Request(`https://audit.example${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.2', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), env, ctx);
  async function create() {
    const operation = randomToken(); const response = await call('/api/session', { operation_id: operation, channel: 'chat', turnstile_token: 'test-token' });
    assert.equal(response.status, 201); const responseBody = await response.json() as any;
    const data = responseBody.data;
    return { data: { ...data, management_token: data.session_token }, operation };
  }
  return { db, env, worker, ctx, call, create, pending };
}

test('HTTP creation uses separate rights; hashes only; same office allows two sessions; replay never duplicates', async () => {
  const app = setup(); const first = await app.create(); const second = await app.create();
  assert.notEqual(first.data.session.session_id, second.data.session.session_id);
  assert.notEqual(first.data.management_token, first.data.report_token);
  assert.equal(first.data.management_token.length, 43);
  const stored = app.db.sqlite.prepare('SELECT access_token_hash,state_json FROM audit_sessions WHERE id=?').get(first.data.session.session_id)!;
  assert.equal(stored.access_token_hash, await hashToken(first.data.management_token));
  assert.ok(!JSON.stringify(stored).includes(first.data.management_token));
  const repeated = await app.call('/api/session', { operation_id: first.operation, channel: 'chat', turnstile_token: 'test-token' });
  assert.equal(repeated.status, 409);
  assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM audit_sessions').get()!.n, 2);
  const other = await app.call(`/api/session/${second.data.session.session_id}`, undefined, first.data.management_token);
  assert.equal(other.status, 401);
  const readCannotWrite = await app.call(`/api/session/${first.data.session.session_id}`, undefined, first.data.report_token);
  assert.equal(readCannotWrite.status, 200);
  const readView = (await readCannotWrite.json() as any).data.session;
  assert.deepEqual(readView.messages, []); assert.equal(readView.capabilities.finish, false);
  const read = await app.call(`/api/report/${first.data.report_token}`); assert.equal(read.status, 202);
  assert.equal(read.headers.get('Retry-After'), '10');
  app.db.close();
});

test('HTTP denies wrong origin and missing token while public release gate controls approved production library', async () => {
  const app = setup();
  assert.equal((await app.call('/api/session/id', undefined, undefined, 'https://evil.example')).status, 403);
  assert.equal((await app.call('/api/session/id')).status, 401);
  app.env.ALLOW_DRAFT_LIBRARY = 'false';
  app.env.PUBLIC_SESSIONS_ENABLED = 'false';
  const closed = await app.call('/api/session', { operation_id: randomToken(), channel: 'chat', turnstile_token: 'token' });
  assert.equal(closed.status, 503);
  assert.equal((await closed.json() as any).error.code, 'sessions_not_released');
  assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM audit_sessions').get()!.n, 0);
  app.env.PUBLIC_SESSIONS_ENABLED = 'true';
  const response = await app.call('/api/session', { operation_id: randomToken(), channel: 'chat', turnstile_token: 'token' });
  assert.equal(response.status, 201);
  assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM audit_sessions').get()!.n, 1);
  app.db.close();
});

test('HTTP finish survives browser disappearance and retry returns same report without conclusions in JSON', async () => {
  const app = setup(); const { data } = await app.create(); const session = data.session;
  const body = { session_id: session.session_id, library_version: session.library_version, operation_id: 'finish-1', expected_revision: 0, channel_revision: 0, reason: 'visitor_request' };
  const finish = await app.call('/api/audit/finish', body, data.management_token); assert.equal(finish.status, 202);
  await Promise.all(app.pending); app.pending.length = 0;
  const repeat = await app.call('/api/audit/finish', body, data.management_token); assert.equal(repeat.status, 202);
  await Promise.all(app.pending);
  assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM audit_jobs').get()!.n, 1);
  const state = await app.call(`/api/session/${session.session_id}`, undefined, data.management_token);
  const text = await state.text(); assert.ok(!text.includes('solutions')); assert.ok(!text.includes('result_json')); assert.ok(!text.includes('ПРЕДВАРИТЕЛЬНЫЙ АУДИТ'));
  app.db.close();
});

test('HTTP channel operations reject stale revisions and pause/resume without duplicate events', async () => {
  const app = setup(); const { data } = await app.create(); const session = data.session;
  const body = { session_id: session.session_id, library_version: session.library_version, operation_id: 'pause-1', expected_revision: 0, channel_revision: 0, action: 'pause' };
  assert.equal((await app.call('/api/session/channel', body, data.management_token)).status, 200);
  assert.equal((await app.call('/api/session/channel', body, data.management_token)).status, 200);
  assert.equal((await app.call('/api/session/channel', { ...body, operation_id: 'other-pause' }, data.management_token)).status, 409);
  assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM audit_events').get()!.n, 1);
  app.db.close();
});

test('HTTP limits requests without optional rate-limit binding and external operations without budgets', async () => {
  const app = setup(); app.env.BUDGETS_JSON = JSON.stringify({ requests_per_ip_per_minute: 1 });
  assert.equal((await app.call('/api/session/nonexistent')).status, 401);
  assert.equal((await app.call('/api/session/nonexistent')).status, 429);
  const core = new CoreServices(app.env, () => now);
  await assert.rejects(core.reserve('pdf_renders', 1, 'render'), (error: unknown) => error instanceof HttpError && error.code === 'budget_not_configured');
  app.db.close();
});

test('Turnstile verifies both hostname and action and never accepts API failure', async () => {
  const app = setup(); const request = new Request('https://audit.example');
  for (const result of [{ success: false }, { success: true, hostname: 'evil.example', action: 'session' }, { success: true, hostname: 'olegprojectssrore.github.io', action: 'voice_start' }]) {
    await assert.rejects(verifyTurnstile(request, 'token', app.env, 'session', (async () => Response.json(result)) as typeof fetch), (error: unknown) => error instanceof HttpError && error.status === 403);
  }
  app.db.close();
});

test('body reader enforces byte size even without Content-Length and rejects non-object JSON', async () => {
  await assert.rejects(readJson(new Request('https://audit.example', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(100) }) }), 50), (error: unknown) => error instanceof HttpError && error.status === 413);
  await assert.rejects(readJson(new Request('https://audit.example', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[]' })), (error: unknown) => error instanceof HttpError && error.status === 400);
});

test('humor choice and delivery use session CAS; replay keeps reserved joke across channels', async () => {
  const app = setup(); const { data } = await app.create(); const session = data.session;
  const core = new CoreServices(app.env, () => now);
  const request = new Request('https://audit.example', { headers: { Authorization: `Bearer ${data.management_token}` } });
  const body = { session_id: session.session_id, library_version: session.library_version, operation_id: 'humor-1', expected_revision: 0, channel_revision: 0 };
  const category = library.jokes.categories.find(item => item.selection_source === 'fallback')!;
  const intent = { kind: 'off_topic' as const, certain: true, safe_category_ids: [category.id], now };
  const first = await core.humor(request, body, intent) as any;
  const repeat = await core.humor(request, body, intent) as any;
  assert.equal(repeat.kind, 'duplicate'); assert.equal(first.operation.joke_id, repeat.operation.joke_id);
  assert.equal(app.db.sqlite.prepare('SELECT count(*) n FROM audit_answers').get()!.n, 0);
  const current = await core.store.requireSession(session.session_id);
  assert.equal(current.state.humor.reserved_ids.length, 1);
  await core.acknowledgeHumor(request, { ...body, operation_id: 'delivery-1', expected_revision: 1 }, 'humor-1');
  assert.equal((await core.store.requireSession(session.session_id)).state.humor.used_ids.length, 1);
  app.db.close();
});

test('finish rejects browser provenance and atomically snapshots a trusted final packet; invalid email is a client error', async () => {
  const app = setup(); const { data } = await app.create();
  const core = new CoreServices(app.env, () => now); const session = await core.store.requireSession(data.session.session_id);
  const event = { id: 'user-final', source: 'chat' as const, source_key: 'user-final', source_revision: 0, local_order: 1, role: 'user' as const,
    kind: 'utterance' as const, text: 'Мы продаём оборудование.', occurred_at: now, received_at: now };
  await core.store.commit({ sessionId: session.id, expectedRevision: 0, channelRevision: 0, operationId: 'transcript-final', event, state: session.state, now });
  const envelope = { session_id: session.id, library_version: session.state.library_version, expected_revision: 1, channel_revision: 0 };
  const finishBody = { ...envelope, operation_id: 'final-packet', reason: 'user_requested', through_event_id: event.id };
  const answers: AuditAnswer[] = [{ id: 'answer-final', question_id: 'context_business', fact_id: 'context.business', state: 'known', value: 'Мы продаём оборудование.',
    event_ids: [event.id], channel: 'chat', method: 'classification', confirmation: 'explicit', library_version: session.state.library_version, created_at: now }];
  const forged = await app.call('/api/audit/finish', { ...finishBody, answers }, data.management_token);
  assert.equal(forged.status, 400); assert.equal((await forged.json() as any).error.code, 'untrusted_answers');
  assert.equal((await core.store.listAnswers(session.id)).length, 0);
  await core.finish(new Request('https://audit.example/api/audit/finish', { headers: { Authorization: `Bearer ${data.management_token}` } }), finishBody, { answers });
  const response = await app.call('/api/audit/finish', finishBody, data.management_token);
  assert.equal(response.status, 202);
  await Promise.all(app.pending);
  assert.equal((await core.store.listAnswers(session.id)).length, 1);
  const report = await core.store.getReport(session.reportId);
  assert.equal((await core.store.getSnapshot(report!.snapshotId!))!.answers.length, 1);
  const invalid = await app.call('/api/email/send', { ...envelope, operation_id: 'email-invalid', email: 'not-an-email', consent: true }, data.management_token);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as any).error.retryable, false);
  app.db.close();
});

test('different request body with same mutation key is rejected; old reserved budget cannot authorize another call', async () => {
  const app = setup(); const { data } = await app.create();
  const body = { api_version: '1', session_id: data.session.session_id, library_version: data.session.library_version, operation_id: 'pause-once', expected_revision: 0, channel_revision: 0 };
  assert.equal((await app.call('/api/session/pause', body, data.management_token)).status, 200);
  const changed = await app.call('/api/session/pause', { ...body, expected_revision: 1 }, data.management_token);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as any).error.code, 'operation_payload_conflict');
  const core = new CoreServices(app.env, () => now);
  await core.reserve('new_sessions', 1, 'provider-test');
  await assert.rejects(core.reserve('new_sessions', 1, 'provider-test'), (error: unknown) => error instanceof HttpError && error.code === 'operation_already_reserved');
  app.db.close();
});


test('explicitly disabled Turnstile permits session and voice checks without contacting Cloudflare, retaining budgets and auth', async () => {
  const app = setup();
  try {
    app.env.TURNSTILE_ENABLED = 'false';
    for (const action of ['session', 'voice_start'] as const) {
      await verifyTurnstile(new Request('https://audit.example'), undefined, app.env, action, async () => { throw new Error('Must not contact Turnstile'); });
    }
    const response = await app.call('/api/session', { operation_id: randomToken(), channel: 'chat' });
    assert.equal(response.status, 201);
    const data = await response.json() as any;
    assert.equal((await app.call(`/api/session/${data.session.session_id}`)).status, 401);
    app.env.BUDGETS_JSON = '{}';
    assert.equal((await app.call('/api/session', { operation_id: randomToken(), channel: 'chat' })).status, 503);
    delete app.env.TURNSTILE_ENABLED;
    await assert.rejects(verifyTurnstile(new Request('https://audit.example'), undefined, app.env, 'session'), /turnstile_token/);
  } finally { app.db.close(); }
});

test('HTTP chat: DeepSeek words the first question at creation and later questions arrive as operation.question_text', async () => {
  const db = new SqliteD1();
  const env: Env = { DB: db.binding(), REPORTS_KV: { get: async () => null, put: async () => undefined } as unknown as KVNamespace,
    ALLOWED_ORIGINS: origin, TURNSTILE_HOSTNAMES: 'olegprojectssrore.github.io', TURNSTILE_SECRET: 'test-secret', IP_HASH_SALT: 'test-salt-'.repeat(5),
    ALLOW_DRAFT_LIBRARY: 'true', DEEPSEEK_API_KEY: 'test-key', CHAT_COMPOSER_ENABLED: 'true',
    BUDGETS_JSON: JSON.stringify({ new_sessions: 10, sessions_per_ip: 10, requests_per_ip_per_minute: 120, deepseek_usd_micros: 20_000_000, deepseek_calls: 20, deepseek_tokens: 2_000_000 }) };
  let failFirst = false;
  const fetcher = (async (url: string, init?: RequestInit) => {
    if (!String(url).startsWith('https://api.deepseek.com/')) return Response.json({ success: true, hostname: 'olegprojectssrore.github.io', action: 'session' });
    const data = JSON.parse(JSON.parse(String(init!.body)).messages[1].content);
    if ('next_question' in data && !data.visitor_message && failFirst) return new Response(null, { status: 500 });
    const content = 'next_question' in data
      ? { reply: data.visitor_message ? 'Приятно познакомиться.' : '', question: data.visitor_message ? 'Какую должность Вы занимаете?' : 'Как к Вам можно обращаться?' }
      : { intent: 'answer', clarification_question_id: null, faq_id: null, joke_category_id: null, humor_preference: null,
        answers: [{ question_id: 'context_name', fact_id: 'context.name', state: 'known', value: 'Олег', event_ids: [data.source_events[0].id], evidence: [{ event_id: data.source_events[0].id, text: 'Олег' }] }] };
    return Response.json({ id: 'provider', usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(content) } }] });
  }) as typeof fetch;
  const worker = createWorker({ chat: createChatAdapter() }, { now: () => now, fetcher });
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  const call = (path: string, body: unknown, token?: string) => worker.fetch(new Request(`https://audit.example${path}`, { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.3', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env, ctx);
  try {
    const created = await (await call('/api/session', { operation_id: randomToken(), channel: 'chat', turnstile_token: 'test-token' })).json() as any;
    assert.deepEqual(created.data.question_phrasing, { question_id: 'context_name', text: 'Как к Вам можно обращаться?' });
    const session = created.data.session;
    const chat = await (await call('/api/chat', { api_version: '1', session_id: session.session_id, operation_id: randomToken(), expected_revision: session.revision,
      channel_revision: session.channel_revision, library_version: session.library_version, question_id: 'context_name', input: { kind: 'text', text: 'Олег' } }, created.data.session_token)).json() as any;
    assert.equal(chat.data.operation.text, 'Приятно познакомиться.'); assert.equal(chat.data.operation.question_text, 'Какую должность Вы занимаете?');
    assert.equal(chat.data.operation.question_id, 'context_position');
    failFirst = true;
    const plain = await call('/api/session', { operation_id: randomToken(), channel: 'chat', turnstile_token: 'test-token' });
    assert.equal(plain.status, 201); assert.equal(((await plain.json()) as any).data.question_phrasing, undefined, 'a provider failure keeps the library question');
  } finally { db.close(); }
});

test('HTTP knowledge search for the voice tool needs the session token and returns pixelplus.ru fragments', async () => {
  const app = setup({ search: createKnowledgeSearchHandler() });
  app.env.KNOWLEDGE_ANSWERS_ENABLED = 'true';
  app.env.BUDGETS_JSON = JSON.stringify({ ...JSON.parse(app.env.BUDGETS_JSON!), knowledge_searches: 10 });
  const insert = app.db.sqlite.prepare('INSERT INTO kb_chunks VALUES (?,?,?,?,?,?)');
  app.db.sqlite.exec('BEGIN');
  for (const [id, d, heading] of knowledgeIndex.chunks) insert.run(id, knowledgeIndex.docs[d][2], knowledgeIndex.docs[d][3], heading, knowledgeIndex.docs[d][4], `Текст: ${knowledgeIndex.docs[d][3]}`);
  app.db.sqlite.exec('COMMIT');
  app.db.sqlite.prepare(`INSERT INTO kb_meta VALUES ('corpus', ?)`).run(knowledgeIndex.corpus);
  try {
    const { data } = await app.create();
    const path = `/api/tools/search?session_id=${data.session.session_id}&q=${encodeURIComponent('сайты на Битрикс')}`;
    assert.equal((await app.call(path)).status, 401);
    const body = await (await app.call(path, undefined, data.management_token)).json() as any;
    assert.equal(body.data.corpus, knowledgeIndex.corpus);
    assert(body.data.snippets.length > 0 && body.data.snippets.length <= 4);
    assert(body.data.snippets.every((snippet: { url: string }) => snippet.url.startsWith('https://pixelplus.ru/')));
    assert(body.data.snippets.some((snippet: { url: string }) => snippet.url.includes('bitrix')));
  } finally { app.db.close(); }
});
