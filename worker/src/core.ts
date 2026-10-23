import { initialAuditState, INTERVIEW_BUDGET_MS, type AuditAnswer, type AuditEvent, type Json, type MutationRequest } from './audit/contracts.ts';
import { advanceAudit, nextQuestion, validateAnswers } from './audit/engine.ts';
import { assertLibraryReady, getLibrary, library } from './audit/library.ts';
import { selectHumorReply, type HumorIntent } from './audit/humor.ts';
import { D1Store, elapsedMs, type StoredSession, type MutationResult } from './storage/d1-store.ts';
import type { Env } from './env.ts';
import { bearer, budgets, fail, hashIp, hashToken, identifier, mutation, object, randomToken, requestHash, revision, textField, verifyTurnstile } from './security.ts';

export class CoreServices {
  readonly store: D1Store;
  readonly env: Env;
  readonly now: () => number;
  readonly fetcher: typeof fetch;
  constructor(env: Env, now = Date.now, fetcher: typeof fetch = fetch) {
    this.env = env; this.store = new D1Store(env.DB); this.now = now; this.fetcher = (input, init) => fetcher(input, init);
  }
  get engineOptions() { return { allowDraft: this.env.ALLOW_DRAFT_LIBRARY === 'true' }; }
  async authenticate(request: Request, sessionId: string): Promise<StoredSession> {
    const session = await this.store.authenticateSession(sessionId, await hashToken(bearer(request)), this.now());
    return session ?? fail(401, 'unauthorized', 'Право управления сессией отсутствует или истекло.');
  }
  /** Read every evidence page; never silently validate against a truncated prefix. */
  async events(sessionId: string): Promise<AuditEvent[]> {
    const events: AuditEvent[] = [];
    for (let page = 0; page < 10; page++) {
      const next = await this.store.listEvents(sessionId, events.at(-1)?.seq ?? 0, 500);
      events.push(...next);
      if (next.length < 500) return events;
    }
    return fail(413, 'history_too_large', 'История превышает ограничение обработки.');
  }
  async view(session: StoredSession): Promise<Json> {
    const state = session.state;
    const used = elapsedMs(state, this.now());
    const question = state.status === 'in_progress' && !state.paused && used < INTERVIEW_BUDGET_MS
      ? nextQuestion(state, this.now(), getLibrary(state.library_version), this.engineOptions) : null;
    const report = await this.store.getReport(session.reportId);
    return JSON.parse(JSON.stringify({ session_id: session.id, report_id: session.reportId, library_version: state.library_version,
      revision: state.revision, channel_revision: state.channel_revision, status: state.status, active_channel: state.active_channel,
      paused: state.paused, elapsed_ms: used, remaining_ms: INTERVIEW_BUDGET_MS - used, question,
      humor_enabled: state.humor.enabled, access_expires_at: session.accessExpiresAt, report_status: report?.status,
      report_expires_at: report?.reportExpiresAt, retry_after_seconds: state.status === 'closing' || state.status === 'preparing' ? 5 : null,
    })) as Json;
  }
  async response(result: MutationResult): Promise<Json> {
    if (result.kind === 'conflict') fail(409, 'revision_conflict', 'Состояние изменилось. Получите актуальную ревизию.');
    return { kind: result.kind, operation: result.result ?? null, session: await this.view(result.session) };
  }
  private checkVersion(session: StoredSession, request: MutationRequest): void {
    if (request.library_version !== session.state.library_version) fail(409, 'library_mismatch', 'Версия библиотеки не совпадает с закреплённой.');
  }
  /** Reserve before a provider operation. Unknown outcomes remain charged until reconciled. */
  async reserve(kind: string, amount: number, operationId: string, minIntervalMs = 0) {
    const limits = budgets(this.env);
    const limit = limits[kind] ?? 0;
    if (!limit) fail(503, 'budget_not_configured', 'Для операции не задан бюджет.');
    const now = this.now();
    const period = new Date(now).toISOString().slice(0, 10);
    const reservation = await this.store.reserveUsage({ id: `${kind}:${operationId}`, period, kind, amount, limit, now,
      expiresAt: Date.parse(`${period}T00:00:00Z`) + 2 * 86400000, minIntervalMs });
    if (!reservation) fail(429, 'budget_exhausted', 'Лимит операции исчерпан. Повторите позже.', true);
    if (reservation!.state !== 'reserved' || !reservation!.newlyCreated) fail(409, 'operation_already_reserved', 'Операция уже учтена; повторный внешний вызов запрещён.');
    return reservation!;
  }
  async create(request: Request, body: Record<string, unknown>): Promise<Json> {
    const operationId = textField(body.operation_id, 'operation_id', 128);
    // A browser-generated 256-bit nonce identifies creation; it is not a bearer credential.
    if (!/^[A-Za-z0-9_-]{43}$/.test(operationId) && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId)) fail(400, 'invalid_operation', 'Для создания требуется случайный UUID v4.');
    if (body.api_version !== undefined && body.api_version !== '1') fail(400, 'invalid_request', 'Неизвестная версия API.');
    const channel = body.channel;
    if (channel !== 'chat' && channel !== 'voice') fail(400, 'invalid_channel', 'Выберите чат или голос.');
    if (this.env.PUBLIC_SESSIONS_ENABLED === 'false') fail(503, 'sessions_not_released', 'Публичные сессии ещё не открыты.');
    if (!this.engineOptions.allowDraft) {
      try { assertLibraryReady(library); } catch { fail(503, 'library_not_approved', 'Рабочая библиотека ещё не утверждена.'); }
      if (this.env.PUBLIC_SESSIONS_ENABLED !== 'true') fail(503, 'sessions_not_released', 'Публичные сессии ещё не открыты.');
    }
    const id = await hashToken(`session:${operationId}`);
    if (await this.store.getSession(id)) fail(409, 'creation_already_accepted', 'Сессия уже создана. Используйте сохранённые токены; сервер не восстанавливает их из хешей.');
    await verifyTurnstile(request, body.turnstile_token, this.env, 'session', this.fetcher);
    const ip = await hashIp(request.headers.get('CF-Connecting-IP') ?? 'local', this.env.IP_HASH_SALT);
    const ipLimit = budgets(this.env).sessions_per_ip ?? 0;
    if (!ipLimit) fail(503, 'budget_not_configured', 'Не задан предел создания сессий.');
    const globalReservation = await this.reserve('new_sessions', 1, id);
    const now = this.now(); const period = new Date(now).toISOString().slice(0, 10);
    const ipReservation = await this.store.reserveUsage({ id: `ip-session:${id}`, period, kind: `ip-session:${ip}`, amount: 1, limit: ipLimit,
      now, expiresAt: Date.parse(`${period}T00:00:00Z`) + 2 * 86400000 });
    if (!ipReservation) { await this.store.settleUsage(globalReservation.id, 0, now); fail(429, 'session_limit', 'Предел создания сессий исчерпан.', true); }
    const token = randomToken(); const reportToken = randomToken();
    const state = initialAuditState(library.version, channel as 'chat' | 'voice', now);
    state.current_question_id = nextQuestion(state, now, library, this.engineOptions)?.id ?? null;
    const session = await this.store.createSession({ id, reportId: crypto.randomUUID(), tokenHash: await hashToken(token), reportTokenHash: await hashToken(reportToken), state, now });
    await this.store.settleUsage(globalReservation.id, 1, now);
    await this.store.settleUsage(ipReservation!.id, 1, now);
    return { session: await this.view(session), management_token: token, report_token: reportToken };
  }
  private async prepared(request: Request, body: Record<string, unknown>) {
    const input = mutation(body); const session = await this.authenticate(request, input.session_id);
    this.checkVersion(session, input);
    const digest = await requestHash(body);
    const previous = await this.store.getOperation(session.id, input.operation_id);
    if (previous?.requestHash && previous.requestHash !== digest) fail(409, 'operation_payload_conflict', 'Ключ операции уже использован с другим запросом.');
    return { input, session, digest };
  }
  /** Adapters classify only. The core validates and commits their candidate answers. */
  async accept(request: Request, body: Record<string, unknown>, event: AuditEvent, answers: AuditAnswer[]): Promise<Json> {
    const { input, session, digest } = await this.prepared(request, body);
    const previous = await this.store.getOperation(session.id, input.operation_id);
    if (previous) return { kind: 'duplicate', operation: previous.result, session: await this.view(session) };
    if (event.source !== session.state.active_channel || answers.some(answer => answer.channel !== session.state.active_channel)) fail(409, 'channel_conflict', 'Канал ввода уже изменился.');
    if (session.state.paused) fail(409, 'session_paused', 'Сначала возобновите опрос.');
    if (event.call_id) { const call = await this.store.getCall(event.call_id); if (!call || call.sessionId !== session.id || call.channelRevision !== input.channel_revision) fail(403, 'call_mismatch', 'Звонок не принадлежит активному каналу.'); }
    const existing = await this.store.listAnswers(session.id);
    const evidence = await this.events(session.id);
    const lib = getLibrary(session.state.library_version);
    try { validateAnswers(answers, [...evidence, event], existing, lib, this.engineOptions); }
    catch { fail(400, 'invalid_answers', 'Ответы не прошли проверку словаря или свидетельств.'); }
    const state = advanceAudit(session.state, [...existing, ...answers], this.now(), lib, this.engineOptions);
    return this.response(await this.store.commit({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision,
      operationId: input.operation_id, requestHash: digest, event, answers, state, now: this.now() }));
  }
  /** Only an internal normalizer may supply answers; HTTP candidates never carry trusted provenance. */
  async finish(request: Request, body: Record<string, unknown>, trustedLastPacket?: { readonly answers: readonly AuditAnswer[] }): Promise<Json> {
    const { input, session, digest } = await this.prepared(request, body);
    const originalReason = textField(body.reason, 'reason', 64);
    const reason = ({ sufficient_data: 'sufficient', user_requested: 'visitor_request', unrecoverable_disconnect: 'recovery_expired' } as Record<string,string>)[originalReason] ?? originalReason;
    if (!['sufficient', 'visitor_request', 'declined', 'time_limit'].includes(reason)) fail(400, 'invalid_reason', 'Неизвестная причина завершения.');
    if (body.answers !== undefined && !trustedLastPacket) fail(400, 'untrusted_answers', 'Сначала передайте ответы обработчику канала; подтверждённость и происхождение назначает сервер.');
    const previous = await this.store.getOperation(session.id, input.operation_id);
    if (previous) {
      const saved = previous.result && typeof previous.result === 'object' && !Array.isArray(previous.result) ? previous.result : {};
      return { kind: saved.clarification_required === true ? 'clarification_required' : 'duplicate', replayed: true,
        operation: previous.result, session: await this.view(session) };
    }
    if (session.state.status !== 'in_progress') return { kind: 'duplicate', session: await this.view(session) };
    if (session.state.revision !== input.expected_revision || session.state.channel_revision !== input.channel_revision) fail(409, 'revision_conflict', 'Состояние изменилось. Получите актуальную ревизию.');
    let state = session.state;
    let answers: AuditAnswer[] = [];
    const evidence = await this.events(session.id);
    let callId: string | undefined;
    if (body.call_id !== undefined || trustedLastPacket?.answers.some(answer => answer.channel === 'voice')) {
      const call = await this.store.getCall(identifier(body.call_id, 'call_id'));
      if (!call || call.sessionId !== session.id || call.channelRevision !== input.channel_revision || call.id !== session.activeCallId || session.state.active_channel !== 'voice') fail(403, 'call_mismatch', 'Звонок не принадлежит активному голосовому каналу.');
      callId = call!.id;
    }
    if (trustedLastPacket) {
      if (!Array.isArray(trustedLastPacket.answers) || trustedLastPacket.answers.length > 50) fail(400, 'invalid_answers', 'Некорректный последний пакет ответов.');
      answers = [...trustedLastPacket.answers];
      const existing = await this.store.listAnswers(session.id);
      const lib = getLibrary(session.state.library_version);
      try { validateAnswers(answers, evidence, existing, lib, this.engineOptions); }
      catch { fail(400, 'invalid_answers', 'Последний пакет не прошёл проверку свидетельств.'); }
      if (answers.some(answer => answer.channel !== session.state.active_channel)) fail(409, 'channel_conflict', 'Канал ввода уже изменился.');
      if (callId && answers.some(answer => answer.event_ids.some(id => evidence.find(event => event.id === id)?.call_id !== callId))) fail(403, 'call_mismatch', 'Последний пакет ссылается на другой звонок.');
      state = advanceAudit(state, [...existing, ...answers], this.now(), lib, this.engineOptions);
    }
    const data: Record<string, Json> = { reason };
    if (body.last_event_seq !== undefined) data.last_event_seq = revision(body.last_event_seq, 'last_event_seq');
    if (body.last_source_key !== undefined) data.last_source_key = identifier(body.last_source_key, 'last_source_key');
    if (body.through_event_id !== undefined) {
      const boundaryId = identifier(body.through_event_id, 'through_event_id');
      const boundary = evidence.find(event => event.id === boundaryId && (!callId || event.call_id === callId));
      if (!boundary) fail(409, 'pending_events', 'Подтвердите доставку последнего события перед завершением.');
      data.last_event_seq = boundary!.seq ?? 0;
    }
    if (reason === 'sufficient' && elapsedMs(state, this.now()) < INTERVIEW_BUDGET_MS) {
      const question = nextQuestion(state, this.now(), getLibrary(session.state.library_version), this.engineOptions);
      if (question) {
        const saved = await this.store.commit({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision,
          operationId: input.operation_id, requestHash: digest, event: this.serviceEvent(input.operation_id, 'answer', { ...data, clarification_required: true }),
          answers, state, result: { clarification_required: true, question_id: question.id }, now: this.now() });
        if (saved.kind === 'conflict') fail(409, 'revision_conflict', 'Состояние изменилось. Получите актуальную ревизию.');
        return { kind: 'clarification_required', replayed: saved.kind === 'duplicate', operation: saved.result ?? null,
          question: JSON.parse(JSON.stringify(question)), session: await this.view(saved.session) };
      }
    }
    const event = this.serviceEvent(input.operation_id, 'finish', data);
    const result = await this.store.finish({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision,
      operationId: input.operation_id, requestHash: digest, event, answers, state, now: this.now(), reason });
    return this.response(result);
  }
  async channel(request: Request, body: Record<string, unknown>, resolveVoice?: (session: StoredSession, now: number, core: CoreServices) => Promise<{ status: 'idle' | 'pending' | 'stopped' | 'conflict'; session: StoredSession; stoppedFromRevision?: number }>): Promise<Json> {
    const { input, session, digest } = await this.prepared(request, body);
    const previous = await this.store.getOperation(session.id, input.operation_id);
    if (previous) return { kind: 'duplicate', operation: previous.result, session: await this.view(session) };
    if (!['pause', 'switch', 'resume'].includes(String(body.action))) fail(400, 'invalid_action', 'Неизвестное действие канала.');
    const channel = body.action === 'resume' ? session.state.active_channel : body.channel;
    if (body.action !== 'pause' && channel !== 'chat' && channel !== 'voice') fail(400, 'invalid_channel', 'Неизвестный канал.');
    if (input.channel_revision !== session.state.channel_revision) fail(409, 'revision_conflict', 'Канал уже изменился.');
    let current = session;
    if (input.expected_revision !== session.state.revision) {
      // Only a recorded stop of this channel can explain one new revision. Other writes require a fresh client request.
      const stopped = (await this.store.listCalls(session.id)).some(call => call.channelRevision === input.channel_revision && call.status === 'stopped' && call.stoppedRevision === session.state.revision);
      if (session.activeCallId || input.expected_revision + 1 !== session.state.revision || !stopped) fail(409, 'revision_conflict', 'Состояние изменилось. Получите актуальную ревизию.');
    }
    if (current.activeCallId && resolveVoice) {
      const resolved = await resolveVoice(current, this.now(), this);
      if (resolved.status === 'conflict' || resolved.session.state.channel_revision !== current.state.channel_revision ||
        (resolved.session.state.revision !== current.state.revision && !(resolved.status === 'stopped' && resolved.stoppedFromRevision === current.state.revision && resolved.session.state.revision === current.state.revision + 1))) fail(409, 'revision_conflict', 'Состояние изменилось при завершении звонка.');
      current = resolved.session;
      if (resolved.status === 'pending') fail(409, 'voice_stop_pending', 'Дождитесь подтверждения остановки голосового соединения.');
    }
    const common = { sessionId: current.id, expectedRevision: current.state.revision, channelRevision: input.channel_revision, operationId: input.operation_id, requestHash: digest, now: this.now() };
    if (body.action === 'pause') return this.response(await this.store.pause(common));
    return this.response(await this.store.changeChannel({ ...common, channel: channel as 'chat' | 'voice' }));
  }
  serviceEvent(key: string, kind: AuditEvent['kind'], data: Json): AuditEvent {
    return { id: crypto.randomUUID(), source: 'system', source_key: key, source_revision: 0, local_order: 0,
      role: 'system', kind, data, occurred_at: this.now(), received_at: this.now() };
  }
  /** Classifier-provided intent is server-side input; never expose this directly as a client route. */
  async humor(request: Request, body: Record<string, unknown>, intent: HumorIntent): Promise<Json> {
    const { input, session, digest } = await this.prepared(request, body);
    const previous = await this.store.getOperation(session.id, input.operation_id);
    if (previous) return { kind: 'duplicate', operation: previous.result, session: await this.view(session) };
    const lib = getLibrary(session.state.library_version);
    const question = nextQuestion(session.state, this.now(), lib, this.engineOptions);
    const reply = selectHumorReply(session.state, intent, question, lib);
    const state = structuredClone(session.state);
    if (intent.kind === 'humor_declined') state.humor.enabled = false;
    if ((intent.kind as string) === 'humor_enabled') state.humor.enabled = true;
    if (reply.joke_id) state.humor.reserved_ids.push(reply.joke_id);
    state.humor.operations[input.operation_id] = { ...reply, status: 'reserved' };
    const result = await this.store.commit({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision,
      operationId: input.operation_id, requestHash: digest, event: this.serviceEvent(input.operation_id, 'service', { intent: intent.kind }), state,
      result: { ...reply, operation_id: input.operation_id }, now: this.now() });
    return this.response(result);
  }
  async acknowledgeHumor(request: Request, body: Record<string, unknown>, selectionOperation: string): Promise<Json> {
    const { input, session, digest } = await this.prepared(request, body);
    const state = structuredClone(session.state); const delivery = state.humor.operations[selectionOperation];
    if (!delivery) fail(404, 'delivery_not_found', 'Реплика не найдена.');
    delivery.status = 'delivered';
    if (delivery.joke_id && !state.humor.used_ids.includes(delivery.joke_id)) state.humor.used_ids.push(delivery.joke_id);
    return this.response(await this.store.commit({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision,
      operationId: input.operation_id, requestHash: digest, event: this.serviceEvent(input.operation_id, 'delivery', { selection_operation: selectionOperation }), state, now: this.now() }));
  }
}
