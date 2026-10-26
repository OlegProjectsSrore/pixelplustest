import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditRequestError } from './audit-http.js';

globalThis.window = { addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  addEventListener() {}, body: { append() {} },
  createElement() { return { click() {}, remove() {} }; },
};
const { createAuditClient } = await import('./audit-client.js');

const state = (patch = {}) => ({ session_id: 's1', status: 'in_progress', revision: 0,
  channel_revision: 0, library_version: 'test', active_channel: 'chat', paused: false,
  remaining_ms: 900000, access_expires_at: Date.now() + 86400000,
  question: { id: 'q1', text: 'Вопрос', options: [{ id: 'a1', text: 'Ответ' }] }, ...patch });
const record = session => ({ version: 1, session, management_token: 'management', report_token: 'report',
  pending: null, draft: '', messages: [], transcript_outbox: [] });

function fixture(t, { initial = record(state()), request, challenge, microphone, storage, publicSessionsEnabled } = {}) {
  let stored = structuredClone(initial);
  let server = structuredClone(initial?.session || state());
  const calls = [];
  let handlers;
  let model;
  let draft = '';
  let voiceCallbacks;
  let voiceActive = false;
  let stopFailure = false;
  let startFailure = false;
  let voiceStarts = 0;
  const persistence = storage || { load: () => structuredClone(stored), save: value => { stored = structuredClone(value); } };
  const client = createAuditClient({ config: { publicSessionsEnabled, apiBaseUrl: 'https://audit.example', turnstileSiteKey: 'test', ultravoxSdkUrl: '/sdk.js' },
    persistence, challenge: challenge || (async () => 'challenge'), microphone: microphone || (async () => {}), sdkLoader: async () => ({}),
    viewFactory(callbacks) {
      handlers = callbacks;
      return { render(value) { model = value; }, open() {}, close() {}, notify() {}, destroy() {}, challengeElement: {},
        getDraft: () => draft, setDraft: value => { draft = value; }, clearDraft: () => { draft = ''; } };
    },
    voiceFactory(callbacks) {
      voiceCallbacks = callbacks;
      return { get active() { return voiceActive; }, async start() { voiceStarts++; if (startFailure) throw new Error('join failed'); voiceActive = true; callbacks.onState('listening'); },
        async stop() { if (stopFailure) throw new Error('leave unknown'); if (voiceActive) callbacks.onState('disconnected'); voiceActive = false; } };
    },
    transport: { async request(path, options = {}) {
      calls.push({ path, ...structuredClone(options) });
      if (request) {
        const result = await request(path, options, { get server() { return server; }, set server(value) { server = value; }, calls });
        if (result !== undefined) return result;
      }
      if (path.startsWith('/api/report/')) return new Blob(['%PDF-test'], { type: 'application/pdf' });
      if (options.method !== 'POST') return structuredClone(server);
      if (path === '/api/session') {
        server = state({ active_channel: options.body.channel });
        return { session: structuredClone(server), management_token: 'management', report_token: 'report' };
      }
      server.revision++;
      if (path === '/api/session/channel') {
        server.channel_revision++;
        server.paused = options.body.action === 'pause' || (options.body.channel || server.active_channel) === 'voice';
        if (options.body.channel) server.active_channel = options.body.channel;
      }
      if (path === '/api/voice/start') server.paused = false;
      if (path === '/api/audit/finish') server.status = 'closing';
      return { session: structuredClone(server), ...(path === '/api/voice/start' ? { call_id: `call${server.revision}`, join_url: 'wss://voice.example/join' } : {}),
        ...(path === '/api/voice/transcript' ? { through_event_id: 'voice:call1:0:1', accepted_events: options.body.events.map(event => ({ event_id: `server:${event.source_key}:${event.source_revision}`, source_key: event.source_key, source_revision: event.source_revision })) } : {}) };
    } },
  });
  t.after(async () => { stopFailure = false; await client.destroy(); });
  return { client, calls, get handlers() { return handlers; }, get model() { return model; }, get stored() { return stored; },
    set draft(value) { draft = value; }, get draft() { return draft; }, get voice() { return voiceCallbacks; },
    set stopFailure(value) { stopFailure = value; }, set startFailure(value) { startFailure = value; }, get voiceStarts() { return voiceStarts; }, get voiceActive() { return voiceActive; } };
}

test('Retry creates a session after a challenge failure without nesting a busy action', async t => {
  let challenges = 0;
  const f = fixture(t, { initial: null, challenge: async () => { if (!challenges++) throw new Error('challenge unavailable'); return 'ok'; } });
  await f.client.open();
  assert.equal(f.model.phase, 'failed');
  await f.handlers.onRetry();
  assert.equal(f.model.phase, 'interview');
  assert.equal(f.calls.filter(call => call.path === '/api/session').length, 1);
});

test('lost chat ACK survives reload and retries the exact operation before clearing draft', async t => {
  let count = 0;
  const f = fixture(t, { request(path, options, context) {
    if (path === '/api/chat' && !count++) {
      context.server.revision++;
      throw new AuditRequestError('lost ACK');
    }
  } });
  await f.client.open(); f.draft = 'Мой ответ'; await f.handlers.onText(f.draft);
  const pending = structuredClone(f.stored.pending);
  assert.equal(f.draft, 'Мой ответ');
  await f.client.destroy();
  const recovered = fixture(t, { initial: f.stored });
  await recovered.client.open(); await recovered.handlers.onRetry();
  const sent = recovered.calls.find(call => call.path === '/api/chat');
  assert.deepEqual(sent.body, pending.body);
  assert.equal(recovered.stored.pending, null);
  assert.equal(recovered.draft, '');
  assert.equal(recovered.stored.messages.filter(message => message.role === 'user').length, 1);
});

test('a definite revision conflict during Retry clears pending but preserves the draft', async t => {
  let count = 0;
  const f = fixture(t, { request(path, options, context) {
    if (path === '/api/chat') {
      if (++count === 1) throw new AuditRequestError('network');
      if (count === 2) { context.server.revision = 7; throw new AuditRequestError('conflict', { status: 409, code: 'revision_conflict', retryable: false }); }
    }
  } });
  await f.client.open(); f.draft = 'Черновик'; await f.handlers.onText(f.draft);
  const oldId = f.stored.pending.body.operation_id;
  await f.handlers.onRetry();
  assert.equal(f.stored.pending, null); assert.equal(f.draft, 'Черновик');
  assert.equal(f.client.session.revision, 7);
  await f.handlers.onText(f.draft);
  const latest = f.calls.filter(call => call.path === '/api/chat').at(-1);
  assert.notEqual(latest.body.operation_id, oldId); assert.equal(latest.body.expected_revision, 7);
});

test('a failed persistence write prevents dispatch, including on Retry', async t => {
  const f = fixture(t, { storage: { load: () => record(state()), save() { throw new AuditRequestError('storage blocked'); } } });
  await f.client.open(); f.draft = 'Ответ'; await f.handlers.onText(f.draft); await f.handlers.onRetry();
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 0);
  assert.equal(f.draft, 'Ответ');
});

test('malformed mutation success keeps the exact operation pending', async t => {
  const f = fixture(t, { request: path => path === '/api/chat' ? {} : undefined });
  await f.client.open(); await f.handlers.onText('Ответ');
  assert.equal(f.stored.pending.path, '/api/chat');
  assert.match(f.model.error, /не подтвердил/);
});

test('finishAudit persists candidates then finish; lost first ACK preserves the second step', async t => {
  let count = 0;
  const f = fixture(t, { initial: null, request(path) { if (path === '/api/voice/answers' && !count++) throw new AuditRequestError('lost final packet ACK'); } });
  await f.client.open('voice');
  const candidates = [{ question_id: 'q1', fact_id: 'f1', state: 'known', value: 'x', source_quotes: ['x'] }];
  await assert.rejects(f.voice.onTool('finishAudit', { answers: candidates, reason: 'visitor_request', operation_id: 'forged' }, 'call1'));
  const first = structuredClone(f.stored.pending);
  assert.equal(first.path, '/api/voice/answers');
  assert.equal(first.followup.path, '/api/audit/finish');
  await f.handlers.onRetry();
  const packets = f.calls.filter(call => ['/api/voice/answers', '/api/audit/finish'].includes(call.path));
  assert.deepEqual(packets[0].body, packets[1].body);
  assert.deepEqual(packets[1].body.answers, candidates);
  assert.equal(packets[2].path, '/api/audit/finish');
  assert.equal('answers' in packets[2].body, false);
  assert.equal(packets[2].body.expected_revision, packets[1].body.expected_revision + 1);
  assert.notEqual(packets[1].body.operation_id, 'forged');
  assert.equal(f.client.session.status, 'closing');
});

test('transcript Retry removes acknowledged outbox revisions and records server event boundary', async t => {
  let count = 0;
  const f = fixture(t, { initial: null, request(path) { if (path === '/api/voice/transcript' && !count++) throw new AuditRequestError('lost transcript ACK'); } });
  await f.client.open('voice');
  const event = { id: 'untrusted-browser-id', call_id: 'call1', source_key: 'call1:0', source_revision: 1, text: 'Ответ' };
  await assert.rejects(f.voice.onEvents([event], 'call1'));
  assert.equal(f.stored.transcript_outbox.length, 1);
  await f.handlers.onRetry();
  assert.equal(f.stored.transcript_outbox.length, 0);
  assert.equal(f.stored.transcript_boundaries.call1, 'voice:call1:0:1');
});

test('live voice captions update both sides in the chat and survive a view refresh', async t => {
  const f = fixture(t, { initial: null });
  await f.client.open('voice');
  const event = (ordinal, role, text, revision) => ({ id: `voice:call1:${ordinal}`, role, text,
    source_revision: revision, data: { medium: 'voice', is_final: revision > 0 } });
  f.voice.onTranscript(event(0, 'user', 'Мне нужен', 0));
  f.voice.onTranscript(event(0, 'user', 'Мне нужен аудит', 1));
  f.voice.onTranscript(event(1, 'assistant', 'Помогу', 0));
  f.voice.onTranscript(event(1, 'assistant', 'Помогу разобраться', 1));
  f.voice.onTranscript(event(0, 'user', 'Мне нужен', 0));
  assert.deepEqual(f.model.messages.map(message => [message.role, message.text]), [
    ['user', 'Мне нужен аудит'], ['assistant', 'Помогу разобраться'],
  ]);
  assert.equal(f.calls.some(call => call.path === '/api/voice/transcript'), false,
    'captions must appear before any server acknowledgement');
  await f.client.refresh();
  assert.deepEqual(f.stored.messages.map(message => message.text), ['Мне нужен аудит', 'Помогу разобраться']);
});

test('microphone denial prevents paid voice start and permits switching to chat', async t => {
  const f = fixture(t, { initial: null, microphone: async () => { throw new Error('microphone denied'); } });
  await f.client.open('voice');
  assert.equal(f.calls.some(call => call.path === '/api/voice/start'), false);
  await f.handlers.onChannel('chat');
  assert.equal(f.client.session.active_channel, 'chat');
});

test('restored unknown voice call blocks a new start until server accepts channel ownership', async t => {
  let stopped = false;
  const f = fixture(t, { initial: record(state({ active_channel: 'voice' })), request(path) {
    if (path === '/api/session/channel' && !stopped) throw new AuditRequestError('call unknown', { status: 409, code: 'channel_stop_pending' });
  } });
  await f.client.open('voice'); await f.handlers.onRetry();
  assert.equal(f.calls.some(call => call.path === '/api/voice/start'), false);
  stopped = true; await f.handlers.onRetry();
  assert.equal(f.voiceStarts, 1);
});

test('pause waits for local stop and server ACK; resume creates voice only afterward', async t => {
  const f = fixture(t, { initial: null }); await f.client.open('voice');
  f.stopFailure = true; await f.handlers.onPause();
  assert.equal(f.calls.some(call => call.path === '/api/session/channel'), false);
  f.stopFailure = false; await f.handlers.onPause();
  assert.equal(f.client.session.paused, true);
  await f.handlers.onResume();
  assert.equal(f.client.session.paused, false); assert.equal(f.voiceStarts, 2);
});

test('voice and chat can be switched repeatedly without a false disconnect error', async t => {
  const f = fixture(t, { initial: null });
  await f.client.open('voice');
  for (let index = 0; index < 3; index++) {
    await f.handlers.onChannel('chat');
    assert.equal(f.client.session.active_channel, 'chat');
    assert.equal(f.model.mode, 'chat');
    assert.equal(f.model.error, '');
    await f.handlers.onChannel('voice');
    assert.equal(f.client.session.active_channel, 'voice');
    assert.equal(f.client.session.paused, false);
    assert.equal(f.model.mode, 'voice');
    assert.equal(f.model.error, '');
  }
  assert.equal(f.voiceStarts, 4);
});

test('a late server revision during call stop is refreshed and the switch completes', async t => {
  let conflicts = 0;
  const f = fixture(t, { initial: null, request(path, options, context) {
    if (path === '/api/session/channel' && options.body.channel === 'chat' && conflicts++ === 0) {
      context.server.revision += 2;
      context.server.paused = true;
      throw new AuditRequestError('Состояние изменилось. Получите актуальную ревизию.', { status: 409, code: 'revision_conflict' });
    }
  } });
  await f.client.open('voice');
  await f.handlers.onChannel('chat');
  assert.equal(f.client.session.active_channel, 'chat');
  assert.equal(f.stored.control_intent, null);
  assert.equal(f.model.error, '');
  const switches = f.calls.filter(call => call.path === '/api/session/channel');
  assert.equal(switches.length, 2);
  assert.equal(switches[1].body.expected_revision, switches[0].body.expected_revision + 2);
});

test('retry reconnects after voice join fails on a paused voice channel', async t => {
  const f = fixture(t, { initial: record(state()) });
  await f.client.open('chat');
  f.startFailure = true;
  await f.handlers.onChannel('voice');
  assert.equal(f.client.session.active_channel, 'voice');
  assert.equal(f.client.session.paused, false);
  assert.ok(f.model.error);
  assert.ok(f.stored.voice_call);
  f.startFailure = false;
  await f.handlers.onRetry();
  assert.equal(f.client.session.active_channel, 'voice');
  assert.equal(f.client.session.paused, false);
  assert.equal(f.model.error, '');
  assert.equal(f.stored.voice_call.call_id, 'call4');
  assert.equal(f.voiceStarts, 2);
});

test('ready PDF downloads using report token after management expiry', async t => {
  const f = fixture(t, { initial: record(state({ status: 'ready', access_expires_at: 1 })) });
  await f.client.open(); await f.handlers.onDownload();
  assert.equal(f.model.phase, 'ready'); assert.equal(f.model.capabilities.email, false);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/report/report']);
  assert.equal(f.calls[0].token, undefined);
  assert.equal(f.stored.management_token, undefined);
  assert.equal(f.stored.report_token, 'report');
});

test('report polling falls back to report token, respects retry delay, stops on ready', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let reads = 0;
  const f = fixture(t, { initial: record(state({ status: 'preparing', access_expires_at: 1 })), request(path) {
    if (path.startsWith('/api/report/')) return ++reads === 1 ? { status: 'preparing', retry_after_seconds: 10 } : new Blob(['%PDF']);
  } });
  await f.client.open();
  t.mock.timers.tick(9999); await new Promise(setImmediate); assert.equal(reads, 1);
  t.mock.timers.tick(1); await new Promise(setImmediate); assert.equal(reads, 2);
  assert.equal(f.model.phase, 'ready');
  t.mock.timers.tick(60000); await new Promise(setImmediate); assert.equal(reads, 2);
  assert.equal(f.calls.some(call => call.path.startsWith('/api/session/')), false);
});

test('creation already accepted preserves nonce instead of silently creating a second session', async t => {
  const initial = { ...record(null), pending: { path: '/api/session', body: { operation_id: 'nonce', channel: 'chat', turnstile_token: 'used' } } };
  const f = fixture(t, { initial, request: () => { throw new AuditRequestError('lost credentials', { status: 409, code: 'creation_already_accepted' }); } });
  await f.client.open(); await f.handlers.onRetry();
  assert.equal(f.stored.pending.body.operation_id, 'nonce');
  assert.equal(f.calls.length, 1);
});

test('a newer draft is not erased by acknowledgement of an older text', async t => {
  let fail = true;
  const f = fixture(t, { request(path) { if (path === '/api/chat' && fail) { fail = false; throw new AuditRequestError('offline'); } } });
  await f.client.open(); f.draft = 'Первый ответ'; await f.handlers.onText(f.draft);
  f.draft = 'Новое уточнение'; await f.handlers.onRetry();
  assert.equal(f.draft, 'Новое уточнение');
  assert.equal(f.stored.draft, 'Новое уточнение');
});

test('large transcript backlog is split by byte size and every server ACK removes only its chunk', async t => {
  const f = fixture(t, { initial: null }); await f.client.open('voice');
  const events = Array.from({ length: 230 }, (_, index) => ({ call_id: 'call1', source_key: `call1:${index}`, source_revision: 0,
    text: 'Ответ посетителя '.repeat(100), local_order: index }));
  await f.voice.onEvents(events, 'call1');
  const packets = f.calls.filter(call => call.path === '/api/voice/transcript');
  assert.ok(packets.length > 1);
  assert.equal(packets.flatMap(packet => packet.body.events).length, events.length);
  for (const packet of packets) {
    assert.ok(packet.body.events.length <= 40);
    assert.ok(new TextEncoder().encode(JSON.stringify(packet.body)).byteLength < 64 * 1024);
  }
  assert.equal(f.stored.transcript_outbox.length, 0);
});

test('pause intent survives server stop-pending conflict and Retry does not reconnect instead', async t => {
  let stopPending = true;
  const f = fixture(t, { initial: null, request(path, options) {
    if (path === '/api/session/channel' && options.body.action === 'pause' && stopPending) throw new AuditRequestError('wait stop', { status: 409, code: 'channel_stop_pending' });
  } });
  await f.client.open('voice'); await f.handlers.onPause();
  assert.equal(f.stored.control_intent.action, 'pause');
  stopPending = false; await f.handlers.onRetry();
  assert.equal(f.client.session.paused, true); assert.equal(f.voiceStarts, 1);
  assert.equal(f.stored.control_intent, null);
});

test('primary bridge accepted_event_ids uses server IDs in request order', async t => {
  const f = fixture(t, { initial: null, request(path, options, context) {
    if (path === '/api/voice/transcript') return { session: { ...context.server, revision: context.server.revision + 1 }, accepted_event_ids: ['ve:server-hash'], through_event_id: 've:server-hash' };
  } });
  await f.client.open('voice');
  await f.voice.onEvents([{ call_id: 'call1', source_key: 'call1:0', source_revision: 0, text: 'Да' }], 'call1');
  assert.equal(f.stored.transcript_outbox.length, 0);
  assert.equal(f.stored.transcript_boundaries.call1, 've:server-hash');
});

test('rejected final candidates never become a finish request on Retry', async t => {
  const f = fixture(t, { initial: null, request(path) {
    if (path === '/api/voice/answers') throw new AuditRequestError('invalid candidates', { status: 400, code: 'invalid_answers' });
  } });
  await f.client.open('voice');
  await assert.rejects(f.voice.onTool('finishAudit', { answers: [{}], reason: 'visitor_request' }, 'call1'));
  await f.handlers.onRetry();
  assert.equal(f.calls.some(call => call.path === '/api/audit/finish'), false);
});

test('401 removes management credential and uses the independent report token', async t => {
  const f = fixture(t, { initial: record(state({ status: 'preparing' })), request(path) {
    if (path.startsWith('/api/session/')) throw new AuditRequestError('expired remotely', { status: 401, code: 'unauthorized' });
  } });
  await f.client.open();
  assert.equal(f.stored.management_token, undefined);
  assert.equal(f.stored.report_token, 'report');
  assert.equal(f.model.phase, 'ready');
});

test('context_priority renders multiple choice and submits every selected domain ID', async t => {
  const question = { id: 'context_priority', fact_ids: ['context.priority'], text: 'Какие направления важнее?',
    options: [{ id: 'seo', text: 'Поиск' }, { id: 'analytics', text: 'Аналитика' }] };
  const f = fixture(t, { initial: record(state({ question })) });
  await f.client.open();
  assert.equal(f.model.question.answer_mode, 'multiple');
  assert.equal(f.client.session.question.answer_mode, undefined, 'UI mapping must not mutate server state');
  await f.handlers.onSelection(['seo', 'analytics']);
  const sent = f.calls.find(call => call.path === '/api/chat');
  assert.equal(sent.body.question_id, 'context_priority');
  assert.deepEqual(sent.body.input, { kind: 'selection', option_ids: ['seo', 'analytics'] });
});

test('multiple-choice mapping requires both the exact question ID and priority fact', async t => {
  for (const question of [
    { id: 'context_priority', fact_ids: ['context.industry'], answer_mode: 'single' },
    { id: 'another_question', fact_ids: ['context.priority'] },
  ]) {
    const f = fixture(t, { initial: record(state({ question: { text: 'Вопрос', options: [], ...question } })) });
    await f.client.open();
    assert.equal(f.model.question.answer_mode, question.answer_mode);
  }
});


test('closed release refuses creation without retaining an expired challenge for Retry', async t => {
  let challenges = 0;
  let closed = true;
  const f = fixture(t, { initial: null, challenge: async () => `challenge-${++challenges}`,
    request(path) {
      if (path === '/api/session' && closed) throw new AuditRequestError('Closed', { status: 503, code: 'sessions_not_released' });
    },
  });
  await f.client.open('chat');
  assert.equal(f.stored.pending, null);
  assert.equal(f.stored.session, null);
  assert.match(f.model.error, /Аудит готовится к запуску/);
  closed = false;
  await f.client.retry();
  assert.equal(challenges, 2);
  assert.equal(f.calls.at(-1).body.turnstile_token, 'challenge-2');
  assert.equal(f.client.session.active_channel, 'chat');
});


test('published closed mode opens the panel without a pointless challenge or session request', async t => {
  let challenges = 0;
  const f = fixture(t, { initial: null, publicSessionsEnabled: false, challenge: async () => { challenges++; return 'unused'; } });
  await f.client.open('chat');
  assert.equal(f.model.phase, 'unavailable');
  assert.equal(f.model.launchPending, true);
  await f.client.retry();
  assert.equal(challenges, 0);
  assert.equal(f.calls.length, 0);
});

test('exhausted new-session budget explains the daily reset without enabling a blocked channel', async t => {
  const f = fixture(t, { initial: null, request(path) {
    if (path === '/api/session') throw new AuditRequestError('Лимит операции исчерпан. Повторите позже.', { status: 429, code: 'budget_exhausted' });
  } });
  await f.client.open('chat');
  assert.equal(f.model.phase, 'failed');
  assert.match(f.model.error, /Суточный лимит новых опросов/);
  assert.match(f.model.error, /00:00 UTC/);
  assert.equal(f.model.capabilities.chat, false);
  assert.equal(f.model.capabilities.voice, false);
  assert.equal(f.stored.pending.path, '/api/session', 'the original creation nonce remains available after the reset');
});

test('Restart forgets a blocked interview without sending its unconfirmed operation and starts a new chat session', async t => {
  const blocked = { ...record(state({ session_id: 'old' })), messages: [{ id: 'm1', role: 'user', text: 'Старый ответ' }],
    pending: { path: '/api/voice/answers', body: { operation_id: 'stuck' } }, transcript_outbox: [{ source_key: 'call1:1', call_id: 'call1' }] };
  const f = fixture(t, { initial: blocked });
  await f.client.open();
  assert.match(f.model.error, /неподтверждённая отправка/);
  assert.equal(f.model.capabilities.restart, true);
  f.draft = 'Черновик';
  await f.handlers.onRestart();
  assert.deepEqual(f.calls.map(call => call.path), ['/api/session']);
  assert.equal(f.stored.session.session_id, 's1'); assert.equal(f.stored.pending, null);
  assert.deepEqual(f.stored.messages, []); assert.deepEqual(f.stored.transcript_outbox, []);
  assert.equal(f.model.phase, 'interview'); assert.equal(f.model.mode, 'chat'); assert.equal(f.model.error, ''); assert.equal(f.draft, '');
});

test('Restart during a voice call releases the call first; nothing to restart before a session exists', async t => {
  const f = fixture(t);
  await f.client.open(); await f.handlers.onChannel('voice');
  assert.equal(f.model.mode, 'voice'); assert.equal(f.voiceActive, true);
  await f.handlers.onRestart();
  assert.equal(f.voiceActive, false, 'the provider call is released before the session is forgotten');
  assert.equal(f.model.voice_status, ''); assert.equal(f.model.mode, 'chat'); assert.equal(f.client.session.active_channel, 'chat');
  assert.equal(f.calls.filter(call => call.path === '/api/session').length, 1);
  const empty = fixture(t, { initial: null, challenge: async () => { throw new Error('challenge unavailable'); } });
  await empty.client.open();
  assert.equal(empty.model.capabilities.restart, false);
});

test('DeepSeek wording replaces the library question only for the question it was written for', async t => {
  const f = fixture(t, { initial: null, request(path, options, context) {
    if (path === '/api/session') {
      context.server = state({ question: { id: 'q1', text: 'Как Вас зовут?', options: [] } });
      return { session: structuredClone(context.server), management_token: 'management', report_token: 'report', question_phrasing: { question_id: 'q1', text: 'Как к Вам можно обращаться?' } };
    }
    if (path === '/api/chat') {
      context.server.revision++;
      const mismatch = options.body.input.text === 'другой';
      context.server.question = { id: mismatch ? 'q3' : 'q2', text: mismatch ? 'Третий вопрос?' : 'Какая Ваша должность?', options: [] };
      return { session: structuredClone(context.server), operation: { text: 'Приятно познакомиться.', question_id: 'q2', question_text: 'Кем Вы работаете в компании?' } };
    }
  } });
  await f.client.open();
  assert.equal(f.model.question.text, 'Как к Вам можно обращаться?');
  await f.handlers.onText('Олег');
  assert.equal(f.model.question.text, 'Кем Вы работаете в компании?');
  assert(f.model.messages.some(message => message.role === 'assistant' && message.text === 'Приятно познакомиться.'));
  assert.equal(f.stored.question_phrasing.text, 'Кем Вы работаете в компании?', 'the wording survives a reload');
  await f.handlers.onText('другой');
  assert.equal(f.model.question.text, 'Третий вопрос?', 'wording for another question is never shown');
});

test('the voice searchKnowledge tool reads /api/tools/search with the session token, outside the mutation queue', async t => {
  const f = fixture(t, { request(path) {
    if (path.startsWith('/api/tools/search')) return { ok: true, corpus: 'c', snippets: [{ id: 'd#0', title: 'Битрикс', heading: 'Сайты', url: 'https://pixelplus.ru/razrabotka-sajtov/cms/bitrix/', text: 'Создаём сайты на Битрикс.' }] };
  } });
  await f.client.open(); await f.handlers.onChannel('voice');
  const result = await f.voice.onTool('searchKnowledge', { query: '  сайты на Битрикс ' }, 'call1');
  assert.deepEqual(result, { found: true, fragments: [{ title: 'Битрикс', url: 'https://pixelplus.ru/razrabotka-sajtov/cms/bitrix/', text: 'Создаём сайты на Битрикс.' }] });
  const call = f.calls.find(item => item.path.startsWith('/api/tools/search'));
  assert.equal(call.path, `/api/tools/search?session_id=s1&q=${encodeURIComponent('сайты на Битрикс')}`);
  assert.equal(call.token, 'management'); assert.equal(call.method, undefined);
  await assert.rejects(f.voice.onTool('searchKnowledge', { query: ' ' }, 'call1'), /Поиск недоступен/);
});

test('a ready DeepSeek answer is spoken as it is; startDiagnostic reaches the server as a tool without arguments', async t => {
  const f = fixture(t, { request(path) {
    if (path.startsWith('/api/tools/search')) return { ok: true, corpus: 'c', answer: 'Да, мы создаём сайты на Битрикс.', snippets: [{ id: 'd#0', title: 'Битрикс', heading: 'Сайты', url: 'https://pixelplus.ru/razrabotka-sajtov/cms/bitrix/', text: 'Создаём сайты на Битрикс.' }] };
  } });
  await f.client.open(); await f.handlers.onChannel('voice');
  assert.deepEqual(await f.voice.onTool('searchKnowledge', { query: 'сайты на Битрикс' }, 'call1'), { found: true, answer: 'Да, мы создаём сайты на Битрикс.' });
  await f.voice.onTool('startDiagnostic', { stray: 1 }, 'call1');
  const call = f.calls.find(item => item.path === '/api/voice/answers');
  assert.equal(call.body.tool, 'startDiagnostic'); assert.equal(call.body.call_id, 'call1');
  assert.equal(call.body.answers, undefined); assert.equal(call.body.stray, undefined);
});

test('too little information: the notice replaces the PDF in the session view', async t => {
  const message = 'К сожалению, для полноценного анализа было предоставлено недостаточно информации.';
  const ready = fixture(t, { initial: record(state({ status: 'ready', report: { id: 'r', status: 'ready', outcome: 'insufficient', message } })) });
  await ready.client.open(); await ready.handlers.onDownload();
  assert.equal(ready.model.phase, 'ready'); assert.equal(ready.model.notice, message);
  assert.equal(ready.calls.some(call => call.path.startsWith('/api/report/')), false, 'there is no PDF to download');
});

test('too little information after management expiry: the report token returns the notice instead of a PDF', async t => {
  const message = 'К сожалению, для полноценного анализа было предоставлено недостаточно информации.';
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const polled = fixture(t, { initial: record(state({ status: 'preparing', access_expires_at: 1 })), request(path) {
    if (path.startsWith('/api/report/')) return { status: 'insufficient', message };
  } });
  await polled.client.open();
  t.mock.timers.tick(10000); await new Promise(setImmediate);
  assert.equal(polled.model.phase, 'ready'); assert.equal(polled.model.notice, message);
});
