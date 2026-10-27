import { createAuditView } from './audit-ui.js?v=07c4e8d01c';
import { createAuditTransport, createAuditStorage, AuditRequestError } from './audit-http.js';
import { getTurnstileToken } from './audit-turnstile.js';
import { checkMicrophone, createVoiceAdapter, loadVoiceSdk } from './audit-voice.js?v=7f69e524a9';

import { createRealtimeVoiceAdapter } from './audit-realtime.js?v=54504d9f6e';

const THANKS = 'Спасибо за предоставленную информацию, сейчас подготовим результат предварительного аудита.';
const VOICE_FALLBACK = 'Пожалуйста, лучше напишите здесь';
const TYPE_WEBSITE = 'Пожалуйста, напечатайте адрес сайта здесь.';
const VOICE_AGAIN = 'Дальше можно отвечать здесь или вернуться к голосу — кнопка «Голос» вверху окна.';
const VOICE_STATUS = { connecting: 'Соединяемся…', listening: 'Слушаю Вас', thinking: 'Обрабатываю ответ…', speaking: 'Помощник говорит', idle: 'Соединение установлено', disconnected: 'Голосовой разговор отключён', disconnecting: 'Завершаем соединение…' };
const EMAIL_STATUS = { pending: 'Письмо ожидает отправки.', sending: 'Отправляем письмо…', sent: 'Письмо отправлено.', unknown: 'Результат отправки пока не подтверждён. Повторное письмо автоматически не отправляем.', failed: 'Не удалось отправить письмо. PDF можно скачать.' };

function creationNonce() {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createAuditClient({ config, viewFactory = createAuditView, transport, persistence,
  challenge = getTurnstileToken, microphone = checkMicrophone, sdkLoader = loadVoiceSdk,
  voiceFactory = createVoiceAdapter, now = Date.now } = {}) {
  const store = persistence || createAuditStorage(localStorage);
  let saved = { version: 1, session: null, messages: [], pending: null, transcript_outbox: [],
    transcript_boundaries: {}, draft: '', ...store.load() };
  // A restored browser cannot prove that a previous provider call has ended.
  if (saved.session?.active_channel === 'voice' && !saved.session.paused && !saved.voice_call) saved.voice_call = { state: 'unknown' };
  let api = transport;
  let view;
  let voice;
  let busy = false;
  let visible = false;
  let error = '';
  let voiceStatus = '';
  let emailStatus = '';
  let mode = saved.session?.active_channel || 'chat';
  let observedAt = now();
  let serial = Promise.resolve();
  let pollTimer;
  let tickTimer;
  let destroyed = false;
  let timeFinishRequested = false;
  let readyFile = null;
  let pollDelay = 5000;
  const downloads = new Map();

  function persist() { saved.draft = view?.getDraft?.() ?? saved.draft; store.save(saved); }
  function discardExpiredManagement(force = false) {
    if (saved.management_token && (force || saved.session?.access_expires_at <= now())) {
      delete saved.management_token;
      persist();
    }
  }
  function hasConfig() { return !!(config?.apiBaseUrl && (config?.turnstileEnabled === false || config?.turnstileSiteKey)); }
  function ensureApi() {
    if (!api) {
      if (!hasConfig()) throw new Error('Предварительный аудит пока недоступен. Пожалуйста, зайдите позже.');
      api = createAuditTransport(config.apiBaseUrl);
    }
    return api;
  }
  function remaining() {
    const session = saved.session;
    if (!session) return 900;
    const active = session.status === 'in_progress' && session.active_channel === 'voice' && !session.paused;
    return Math.max(0, Math.ceil((session.remaining_ms - (active ? Math.max(0, now() - observedAt) : 0)) / 1000));
  }
  function phase() {
    if ((!saved.session && config?.publicSessionsEnabled === false) || (!hasConfig() && !transport)) return 'unavailable';
    const session = saved.session;
    if (!session) return busy ? 'loading' : error ? 'failed' : 'idle';
    if (session.status !== 'in_progress') return session.status;
    return session.paused ? 'paused' : 'interview';
  }
  function render() {
    const session = saved.session;
    const phrasing = saved.question_phrasing;
    // DeepSeek's wording replaces the library text only for the question it was written for.
    const serverQuestion = session?.question && phrasing?.question_id === session.question.id ? { ...session.question, text: phrasing.text } : session?.question;
    const question = serverQuestion?.id === 'context_priority' && Array.isArray(serverQuestion.fact_ids) && serverQuestion.fact_ids.includes('context.priority')
      ? { ...serverQuestion, answer_mode: 'multiple' } : serverQuestion ?? null;
    const active = session?.status === 'in_progress';
    const canManage = !!saved.management_token && session?.access_expires_at > now();
    const allowed = active && canManage && !busy && !saved.pending;
    // Too little information: the server sends a notice instead of the PDF.
    const notice = session?.status === 'ready' && session.report?.outcome === 'insufficient' ? session.report.message || '' : null;
    view?.render({ mode, phase: phase(), question, diagnostic: session?.diagnostic_started !== false, notice,
      launchPending: !session && config?.publicSessionsEnabled === false,
      messages: shownMessages(), remaining_seconds: remaining(), busy,
      voice_status: voiceStatus, email_status: emailStatus, error,
      capabilities: { chat: !!allowed, voice: !!allowed && !!(config?.voiceProvider === 'openai' || config?.ultravoxSdkUrl),
        resume: !!allowed && session.paused, pause: !!allowed && !session.paused,
        finish: !!allowed, email: session?.status === 'ready' && canManage && !busy && !saved.pending,
        restart: !!(session || saved.pending) },
    });
  }
  // The visitor's message is shown as soon as it is sent, while the reply is awaited; a refused request takes it away again.
  function shownMessages() {
    const messages = saved.messages || [], pending = saved.pending;
    const id = pending?.user_text && pending.body?.operation_id ? `user:${pending.body.operation_id}` : null;
    return id && !messages.some(message => message.id === id) ? [...messages, { id, role: 'user', text: pending.user_text }] : messages;
  }
  function addMessage(id, role, text) {
    if (!text || saved.messages.some(message => message.id === id)) return;
    saved.messages.push({ id, role, text });
  }
  function showVoiceTranscript(event) {
    if (event.data?.medium !== 'voice' || !event.text?.trim()) return;
    const index = saved.messages.findIndex(message => message.id === event.id);
    if (index >= 0 && saved.messages[index].source_revision >= event.source_revision) return;
    const message = { id: event.id, role: event.role, text: event.text, source_revision: event.source_revision };
    if (index < 0) saved.messages.push(message);
    else saved.messages[index] = message;
    persist(); render();
  }
  function accept(data) {
    const session = data?.session || (typeof data?.session_id === 'string' ? data : null);
    if (session) {
      if (saved.session && saved.session.session_id !== session.session_id) throw new Error('Получен ответ другой сессии.');
      if (!Number.isSafeInteger(session.revision) || !Number.isFinite(session.remaining_ms)) throw new Error('Получено некорректное состояние опроса.');
      if (!saved.session || session.revision >= saved.session.revision) {
        saved.session = session; mode = session.active_channel; observedAt = now();
      }
    }
    if (data?.management_token) saved.management_token = data.management_token;
    if (data?.report_token) saved.report_token = data.report_token;
    const operation = data?.operation;
    const phrasing = data?.question_phrasing || (typeof operation?.question_text === 'string' ? { question_id: operation.question_id, text: operation.question_text } : null);
    if (typeof phrasing?.question_id === 'string' && typeof phrasing.text === 'string' && phrasing.text.trim()) saved.question_phrasing = { question_id: phrasing.question_id, text: phrasing.text };
    const reply = data?.reply?.text || data?.operation?.text;
    const replyId = data?.reply?.id || data?.operation?.operation_id || saved.pending?.body?.operation_id;
    if (reply && replyId) addMessage(`reply:${replyId}`, 'assistant', reply);
    // The address asked for after a voice call is in: the interview can go back to voice.
    if (saved.voice_hint && saved.session?.active_channel === 'chat' && saved.session.question?.id !== 'context_website') { saved.voice_hint = false; addMessage(`voice-again:${now()}`, 'assistant', VOICE_AGAIN); }
    if (saved.session && ['closing', 'preparing', 'ready'].includes(saved.session.status)) addMessage('closing-message', 'assistant', THANKS);
  }
  function enqueue(task) {
    const next = serial.then(task, task);
    serial = next.catch(() => {});
    return next;
  }
  async function refresh() {
    discardExpiredManagement();
    if (!saved.session || saved.session.status === 'ready') return;
    const reportPhase = ['closing', 'preparing', 'failed'].includes(saved.session.status);
    if (saved.management_token && saved.session.access_expires_at > now()) {
      try {
        const data = await ensureApi().request(`/api/session/${encodeURIComponent(saved.session.session_id)}`, { token: saved.management_token });
        accept(data); persist(); render(); return;
      } catch (problem) {
        if (problem.status === 401) discardExpiredManagement(true);
        if (problem.status !== 401 || !reportPhase || !saved.report_token) throw problem;
      }
    }
    if (!reportPhase || !saved.report_token) throw new Error('Время управления опросом истекло.');
    const report = await ensureApi().request(`/api/report/${encodeURIComponent(saved.report_token)}`, { pdf: true });
    if (report instanceof Blob) {
      readyFile = report;
      saved.session.status = 'ready';
    } else if (report?.status === 'insufficient') {
      saved.session.status = 'ready';
      saved.session.report = { ...(saved.session.report || {}), status: 'ready', outcome: 'insufficient', message: report.message };
    } else {
      saved.session.status = 'preparing';
      pollDelay = Math.max(5000, Number(report.retry_after_seconds || 10) * 1000);
    }
    persist(); render();
  }
  function mutationBody(extra) {
    const session = saved.session;
    if (!session) throw new Error('Сначала начните опрос.');
    return { ...extra, session_id: session.session_id, operation_id: crypto.randomUUID(), expected_revision: session.revision,
      channel_revision: session.channel_revision, library_version: session.library_version };
  }
  async function sendPending() {
    const pending = saved.pending;
    if (!pending) return null;
    // Also required on Retry: a failed local write must never become an unlogged request.
    persist();
    if (pending.path !== '/api/session') {
      discardExpiredManagement();
      if (!saved.management_token) throw new Error('Время управления опросом истекло. Готовый PDF можно скачать отдельно.');
    }
    let data;
    try {
      data = await ensureApi().request(pending.path, { method: 'POST', token: pending.path === '/api/session' ? undefined : saved.management_token, body: pending.body });
    } catch (problem) {
      if (problem.status === 401) discardExpiredManagement(true);
      // These explicit release refusals happen before a session or challenge is accepted.
      const releaseClosed = pending.path === '/api/session' && problem instanceof AuditRequestError
        && ['sessions_not_released', 'library_not_approved'].includes(problem.code);
      const definite = releaseClosed || problem instanceof AuditRequestError && problem.status >= 400 && problem.status < 500 && problem.status !== 429;
      if (definite && problem.code !== 'creation_already_accepted') {
        saved.pending = null; persist();
        if (problem.status === 409) await refresh().catch(() => {});
      }
      throw problem;
    }
    if (pending.path !== '/api/email/send' && (!data?.session || !Number.isSafeInteger(data.session.revision))) {
      throw new AuditRequestError('Сервис не подтвердил состояние опроса. Повторите сохранённый запрос.', { code: 'invalid_response' });
    }
    if (pending.path === '/api/session' && (!data.management_token || !data.report_token)) {
      throw new AuditRequestError('Сервис не подтвердил создание сессии. Повторите сохранённый запрос.', { code: 'invalid_response' });
    }
    const previous = structuredClone(saved);
    const clearDraft = pending.clear_draft && (view?.getDraft?.() ?? saved.draft).trim() === pending.user_text;
    try {
      // The visitor's message precedes the reply to it.
      if (pending.user_text) addMessage(`user:${pending.body.operation_id}`, 'user', pending.user_text);
      accept(data);
      if (pending.path === '/api/voice/transcript') {
        const acceptedIds = data.accepted_event_ids;
        const acknowledged = Array.isArray(data.accepted_events) ? data.accepted_events
          : Array.isArray(acceptedIds) && acceptedIds.length === pending.body.events.length && acceptedIds.every(id => typeof id === 'string' && id.length)
            ? pending.body.events.map((event, index) => ({ source_key: event.source_key, source_revision: event.source_revision, event_id: acceptedIds[index] })) : [];
        const revisions = new Map(acknowledged.map(event => [event.source_key, event.source_revision]));
        if (pending.body.events.some(event => revisions.get(event.source_key) !== event.source_revision) || typeof data.through_event_id !== 'string') {
          throw new AuditRequestError('Доставка реплик не подтверждена полностью. Повторите сохранённый запрос.', { code: 'invalid_response' });
        }
        saved.transcript_outbox = saved.transcript_outbox.filter(event => event.source_revision > (revisions.get(event.source_key) ?? -1));
        saved.transcript_boundaries[pending.body.call_id] = data.through_event_id;
      }
      if (pending.path === '/api/session/channel') {
        saved.voice_call = null;
        if (saved.control_intent?.action === pending.body.action) saved.control_intent = null;
      }
      if (pending.path === '/api/audit/finish' && ['closing', 'preparing', 'ready'].includes(saved.session.status)) saved.control_intent = null;
      if (pending.followup?.path === '/api/audit/finish') saved.control_intent = { action: 'finish', reason: pending.followup.extra.reason };
      if (pending.path === '/api/voice/start') saved.voice_call = { call_id: data.call_id, state: 'unconfirmed' };
      if (clearDraft) saved.draft = '';
      // Persist the second step before sending it, including its new revision/operation ID.
      saved.pending = pending.followup ? { path: pending.followup.path, body: mutationBody(pending.followup.extra) } : null;
      store.save(saved);
    } catch (problem) {
      saved = previous;
      throw problem;
    }
    if (clearDraft) view.clearDraft();
    render();
    return saved.pending ? sendPending() : data;
  }
  async function mutate(path, extra, { userText, clearDraft = false, followup } = {}) {
    if (saved.pending) throw new Error('Сначала повторите неподтверждённую отправку.');
    saved.pending = { path, body: mutationBody(extra), user_text: userText, clear_draft: clearDraft, followup };
    persist();
    if (userText) render();
    return sendPending();
  }
  async function action(task) {
    if (busy || destroyed) return;
    busy = true; error = ''; render();
    try { await task(); }
    catch (problem) {
      error = !saved.session && ['budget_exhausted', 'session_limit'].includes(problem?.code)
        ? 'Суточный лимит новых опросов исчерпан. Доступ возобновится после 00:00 UTC.'
        : ['sessions_not_released', 'library_not_approved'].includes(problem?.code)
          ? 'Аудит готовится к запуску. Начать опрос пока нельзя. Пожалуйста, зайдите позже.'
          : problem?.message || 'Операция временно недоступна.';
    }
    finally { busy = false; render(); schedulePoll(); }
  }
  async function create(channel) {
    const turnstile_token = config?.turnstileEnabled === false ? undefined : await challenge(view.challengeElement, config?.turnstileSiteKey, 'session');
    saved.pending = { path: '/api/session', body: { operation_id: creationNonce(), channel, turnstile_token } };
    persist();
    await sendPending();
  }
  async function postTranscript(events, callId) {
    const known = new Map(saved.transcript_outbox.map(event => [event.source_key, event]));
    for (const event of events) if (!known.has(event.source_key) || known.get(event.source_key).source_revision <= event.source_revision) known.set(event.source_key, event);
    saved.transcript_outbox = Array.from(known.values()); persist();
    return enqueue(async () => {
      for (;;) {
        const outstanding = saved.transcript_outbox.filter(event => event.call_id === callId);
        if (!outstanding.length) return;
        const batch = [];
        for (const event of outstanding) {
          const candidate = [...batch, event];
          // Leave room for the mutation envelope inside the router's 64 KiB limit.
          if (candidate.length > 40 || new TextEncoder().encode(JSON.stringify(candidate)).byteLength > 48 * 1024) break;
          batch.push(event);
        }
        if (!batch.length) throw new Error('Одна реплика слишком велика для отправки. Она сохранена в браузере.');
        await mutate('/api/voice/transcript', { call_id: callId, events: batch });
      }
    });
  }
  async function getVoice() {
    if (voice) return voice;
    const realtime = config?.voiceProvider === 'openai';
    const sdk = realtime ? undefined : await sdkLoader(config?.ultravoxSdkUrl);
    const factory = realtime && voiceFactory === createVoiceAdapter ? createRealtimeVoiceAdapter : voiceFactory;
    voice = factory({ sdk, onControl(action, callId, complete, details) {
      const task = async () => {
        const data = await ensureApi().request('/api/voice/control', { method: 'POST', token: saved.management_token,
          body: { session_id: saved.session.session_id, call_id: callId, action, delivery_complete: complete === true, ...(details ? { details } : {}) } });
        if (action === 'stop') { accept(data); saved.voice_call = null; persist(); render(); }
        return data;
      };
      return action === 'stop' ? enqueue(task) : task();
    }, onState(status) {
      voiceStatus = VOICE_STATUS[status] || 'Голосовой опрос';
      if (status === 'disconnected' && !saved.control_intent && saved.session?.status === 'in_progress' && mode === 'voice') error = 'Голосовое соединение прервано. Для продолжения нажмите «Попробовать ещё раз».';
      if (status === 'disconnected' && saved.control_intent?.action === 'pause') void action(performControlIntent);
      render();
    },
      onEvents: postTranscript,
      onTranscript: showVoiceTranscript,
      onError(problem) { error = problem.message; render(); },
      // Voice could not answer twice in a row: stop the call, continue in the chat and say so there.
      onFallback() { continueInChat(VOICE_FALLBACK); },
      onTool(name, args, callId) {
        // A knowledge search reads only; it bypasses the mutation queue so it never waits behind a save.
        if (name === 'searchKnowledge') return searchKnowledge(args?.query);
        return enqueue(async () => {
          if (!['saveAnswers', 'finishAudit', 'offTopicReply', 'startDiagnostic'].includes(name)) throw new Error('Неизвестный инструмент разговора.');
          const boundary = saved.transcript_boundaries[callId];
          const payload = name === 'offTopicReply'
            ? Object.fromEntries(['kind', 'certain', 'safe_category_ids', 'excluded_joke_ids', 'previous_topic_category_ids'].filter(key => args[key] !== undefined).map(key => [key, args[key]]))
            : name === 'startDiagnostic' ? {} : { answers: args.answers };
          const extra = { ...payload, call_id: callId, ...(boundary ? { through_event_id: boundary } : {}) };
          let result;
          if (name === 'finishAudit') {
            // Raw voice candidates must pass the voice normalizer before core.finish.
            result = await mutate('/api/voice/answers', { answers: args.answers, call_id: callId, ...(boundary ? { through_event_id: boundary } : {}) }, {
              followup: { path: '/api/audit/finish', extra: { reason: args.reason, call_id: callId, ...(boundary ? { through_event_id: boundary } : {}) } },
            });
          } else result = await mutate('/api/voice/answers', { ...extra, ...(['offTopicReply', 'startDiagnostic'].includes(name) ? { tool: name } : {}) });
          // The company has a site: its address is typed in the chat, not dictated.
          if (result?.type_in_chat === 'website') { saved.voice_hint = true; persist(); continueInChat(TYPE_WEBSITE); }
          if (name === 'offTopicReply' && args.kind === 'pause' && (result?.stop_required === true || result?.status === 'stopping')) {
            saved.control_intent = { action: 'pause' }; persist();
          }
          if (name === 'finishAudit' && ['closing', 'preparing', 'ready'].includes(result?.session?.status)) {
            schedulePoll();
            return { accepted: true, closing_message: THANKS };
          }
          return result;
        });
      },
    });
    return voice;
  }
  // Stops the call and continues the interview in the chat with a message there; waits for a running action to finish first.
  function continueInChat(message) {
    const run = () => busy ? setTimeout(run, 300) : void action(async () => {
      await switchChannel('chat');
      addMessage(`voice-to-chat:${Date.now()}`, 'assistant', message); persist();
    });
    run();
  }
  async function startVoice() {
    if (saved.voice_call || voice?.active) throw new Error('Остановка предыдущего звонка ещё не подтверждена. Повторите проверку состояния.');
    if (config?.voiceProvider !== 'openai') await microphone();
    const adapter = await getVoice();
    const turnstile_token = config?.turnstileEnabled === false ? undefined : await challenge(view.challengeElement, config?.turnstileSiteKey, 'voice_start');
    const offer = adapter.prepare ? await adapter.prepare() : {};
    try {
      const data = await enqueue(() => mutate('/api/voice/start', { turnstile_token, ...offer }));
      await adapter.start(data);
    } catch (problem) {
      await adapter.stop().catch(() => {});
      throw problem;
    }
  }
  async function searchKnowledge(query) {
    if (typeof query !== 'string' || !query.trim() || !saved.session || !saved.management_token) throw new Error('Поиск недоступен.');
    const path = '/api/tools/search?session_id=' + encodeURIComponent(saved.session.session_id) + '&q=' + encodeURIComponent(query.trim().slice(0, 300));
    const data = await ensureApi().request(path, { token: saved.management_token });
    // A checked answer from DeepSeek V4 Pro is spoken as it is; otherwise the voice model answers from the fragments.
    if (typeof data?.answer === 'string' && data.answer.trim()) return { found: true, answer: data.answer };
    const fragments = Array.isArray(data?.snippets) ? data.snippets.map(({ title, url, text }) => ({ title, url, text })) : [];
    return { found: fragments.length > 0, fragments };
  }
  async function stopVoice() {
    if (voice) await voice.stop();
  }
  // Forgets this browser's interview, including an unconfirmed send, and starts a new session.
  // The abandoned server session is not reused and simply expires.
  async function restart() {
    await stopVoice().catch(() => {});
    clearTimeout(pollTimer);
    timeFinishRequested = false; readyFile = null; error = ''; voiceStatus = ''; emailStatus = ''; mode = 'chat';
    saved = { version: 1, session: null, messages: [], pending: null, transcript_outbox: [], transcript_boundaries: {}, draft: '' };
    view?.clearDraft?.();
    persist(); render();
    await create('chat');
  }
  async function switchChannel(channel) {
    if (!saved.session) { await create(channel); if (channel === 'voice') await startVoice(); return; }
    saved.control_intent = { action: 'switch', channel }; persist();
    await performControlIntent();
  }
  async function performControlIntent() {
    const intent = saved.control_intent;
    if (!intent) return;
    await stopVoice();
    if (intent.action === 'finish') {
      await enqueue(() => mutate('/api/audit/finish', { reason: intent.reason }));
    } else {
      for (let attempt = 0; ; attempt++) {
        try {
          await enqueue(() => mutate('/api/session/channel', intent));
          break;
        } catch (problem) {
          if (!(problem instanceof AuditRequestError) || problem.status !== 409 ||
              !['revision_conflict', 'voice_stop_pending', 'channel_stop_pending'].includes(problem.code) || saved.pending) throw problem;
          await refresh();
          const completed = intent.action === 'pause' ? saved.session?.paused
            : intent.action === 'resume' ? false
              : saved.session?.active_channel === intent.channel &&
                saved.session?.paused === (intent.channel === 'voice') &&
                (intent.channel !== 'voice' || !saved.voice_call);
          if (completed) { saved.control_intent = null; saved.voice_call = null; persist(); break; }
          if (attempt >= 5) throw problem;
          if (problem.code !== 'revision_conflict') await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      if (intent.action !== 'pause' && mode === 'voice') await startVoice();
    }
  }
  async function control(intent) {
    saved.control_intent = intent; persist();
    await performControlIntent();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    if (destroyed || !visible || !saved.session) return;
    if (!['closing', 'preparing'].includes(saved.session.status)) return;
    pollTimer = setTimeout(() => {
      if (busy) { schedulePoll(); return; }
      void refresh().catch(problem => {
        error = problem.message;
        if (problem.retryAfter) pollDelay = Math.max(5000, problem.retryAfter * 1000);
        if ([404, 410].includes(problem.status) || problem.code === 'failed') saved.session.status = 'failed';
        render();
      }).finally(schedulePoll);
    }, Math.max(pollDelay, (saved.session.retry_after_seconds || 5) * 1000));
  }
  async function download() {
    if (!saved.report_token) throw new Error('Не найдено право на получение отчёта.');
    if (saved.session?.report?.outcome === 'insufficient') return;
    const file = readyFile || await ensureApi().request(`/api/report/${encodeURIComponent(saved.report_token)}`, { pdf: true });
    if (!(file instanceof Blob)) { error = 'Отчёт ещё готовится. Повторите скачивание немного позже.'; return; }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a'); link.href = url; link.download = 'ПРЕДВАРИТЕЛЬНЫЙ АУДИТ.pdf';
    link.rel = 'noreferrer'; document.body.append(link); link.click(); link.remove();
    downloads.set(url, setTimeout(() => { URL.revokeObjectURL(url); downloads.delete(url); }, 60000));
  }
  async function retry() {
    if (!saved.session && config?.publicSessionsEnabled === false) return;
    let pendingPath;
    let result;
    if (saved.pending) { pendingPath = saved.pending.path; result = await enqueue(sendPending); }
    else if (!saved.session) { await create(mode); }
    else await refresh();
    for (const callId of new Set(saved.transcript_outbox.map(event => event.call_id))) await postTranscript([], callId);
    if (saved.control_intent && !saved.pending) { await performControlIntent(); return; }
    if (pendingPath === '/api/voice/start' && (result?.join_url || result?.sdp_answer)) {
      if (config?.voiceProvider !== 'openai') await microphone();
      const adapter = await getVoice();
      if (result.sdp_answer && !adapter.active) {
        const stopped = await ensureApi().request('/api/voice/control', { method: 'POST', token: saved.management_token, body: { session_id: saved.session.session_id, call_id: result.call_id, action: 'stop', delivery_complete: true } });
        accept(stopped); saved.voice_call = null; persist();
        await startVoice();
      } else await adapter.start(result);
    } else if (saved.session?.status === 'in_progress' && mode === 'voice' && !voice?.active) {
      await stopVoice();
      if (saved.voice_call) {
        saved.control_intent = { action: 'resume' }; persist();
        await performControlIntent();
      } else await startVoice();
    }
  }
  function ensureView() {
    if (view) return;
    view = viewFactory({
      onText: text => action(() => enqueue(() => mutate('/api/chat', { question_id: saved.session?.question?.id ?? null, input: { kind: 'text', text } }, { userText: text, clearDraft: true }))),
      onSelection: ids => action(() => enqueue(() => mutate('/api/chat', { question_id: saved.session?.question?.id ?? null, input: { kind: 'selection', option_ids: ids } }, { userText: ids.map(id => saved.session.question.options.find(option => option.id === id)?.text || id).join(', ') }))),
      onSkip: () => action(() => enqueue(() => mutate('/api/chat', { question_id: saved.session?.question?.id ?? null, input: { kind: 'text', text: 'Предпочитаю не отвечать на этот вопрос.' } }))),
      onChannel: channel => action(() => switchChannel(channel)),
      onPause: () => action(() => control({ action: 'pause' })),
      onResume: () => action(() => control({ action: 'resume' })),
      onFinish: () => action(() => control({ action: 'finish', reason: 'visitor_request' })),
      onEmail: email => action(async () => { const result = await enqueue(() => mutate('/api/email/send', { email, consent: { accepted: true, version: 'audit-email-v1' } })); emailStatus = result.status === 'failed' && saved.session?.report?.outcome === 'insufficient' ? 'Не удалось отправить письмо.' : EMAIL_STATUS[result.status] || 'Запрос на отправку принят.'; }),
      onDownload: () => action(download), onRetry: () => action(retry), onRestart: () => action(restart),
      onClose() { visible = false; clearTimeout(pollTimer); persist(); },
    });
    view.setDraft?.(saved.draft || '');
    tickTimer = setInterval(() => {
      if (!saved.session) return;
      try { discardExpiredManagement(); } catch (problem) { error = problem.message; }
      render();
      if (!busy && !saved.pending && saved.session.status === 'in_progress' && !saved.session.paused && remaining() === 0 && !timeFinishRequested) {
        timeFinishRequested = true;
        void action(() => control({ action: 'finish', reason: 'time_limit' }));
      }
    }, 1000);
  }
  async function open(channel = 'chat') {
    ensureView(); visible = true; mode = saved.session?.active_channel || channel; view.open(); render();
    if ((!saved.session && config?.publicSessionsEnabled === false) || (!hasConfig() && !transport)) return;
    const work = async () => {
      discardExpiredManagement();
      if (saved.pending) { error = 'Есть неподтверждённая отправка. Нажмите «Повторить».'; return; }
      if (saved.session) { await refresh(); return; }
      await create(channel);
      if (channel === 'voice') await startVoice();
    };
    await action(work);
  }
  const onStorage = event => {
    if (event.key !== 'pixelplus.audit.v1') return;
    error = 'Сессия изменена в другой вкладке. Обновите её состояние перед продолжением.';
    void voice?.stop().catch(() => {}); render();
  };
  window.addEventListener('storage', onStorage);
  return { open, refresh, retry,
    toggle(channel = 'chat') {
      if (visible) { visible = false; view.close(); return; }
      return open(channel);
    },
    get session() { return saved.session; },
    async destroy() {
      destroyed = true; clearTimeout(pollTimer); clearInterval(tickTimer); window.removeEventListener('storage', onStorage);
      for (const [url, timer] of downloads) { clearTimeout(timer); URL.revokeObjectURL(url); }
      downloads.clear();
      try { await stopVoice(); } finally { view?.destroy(); }
    },
  };
}

let client;
document.addEventListener('click', event => {
  const button = event.target.closest?.('[data-ai-action]');
  if (!button || !['chat', 'voice'].includes(button.dataset.aiAction)) return;
  event.preventDefault();
  if (!document.querySelector('link[data-audit-styles]')) {
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./audit-ui.css?v=60c462f074', import.meta.url).href; link.dataset.auditStyles = ''; document.head.append(link);
  }
  client ||= createAuditClient({ config: window.PIXELPLUS_AUDIT_CONFIG });
  void client.toggle(button.dataset.aiAction);
});
