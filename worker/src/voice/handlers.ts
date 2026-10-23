import type { AuditEvent, Json } from '../audit/contracts.ts';
import type { CoreServices } from '../core.ts';
import type { HumorIntent } from '../audit/humor.ts';
import type { AdapterContext, AdapterHandler } from '../integration.ts';
import type { VoiceCall } from '../storage/types.ts';
import { HttpError, fail, identifier, mutation, requestHash } from '../security.ts';
import { parseVoiceAnswerPayload, parseVoiceFinishPayload, parseVoiceOffTopicPayload, type VoiceOffTopicPayload } from './client-tools.ts';
import { latestVoiceEvents, resolveVoiceAnswers, type EvidenceAssessor } from './evidence.ts';
import { normalizeTranscriptBatch } from './transcripts.ts';
import { parseVerifiedWebhook } from './webhook.ts';
import { CLOSING_MESSAGE } from './call-config.ts';
import { record } from './validation.ts';
import type { ProviderWebhook } from './types.ts';
import type { WebhookVerificationOptions } from './webhook-signature.ts';

export interface TranscriptAcceptance { response: Json; accepted_event_ids: string[] }
export interface VoiceHandlerHooks {
  acceptTranscriptBatch?: (request: Request, context: AdapterContext, batch: { call: VoiceCall; events: AuditEvent[] }) => Promise<TranscriptAcceptance>;
  assessEvidence?: EvidenceAssessor;
  webhookOptions?: (core: CoreServices) => Promise<WebhookVerificationOptions> | WebhookVerificationOptions;
  applyProviderEvent?: (core: CoreServices, event: ProviderWebhook, source: 'webhook' | 'lookup') => Promise<Json>;
  /** Durably request stopping; this is not confirmation that the provider has stopped. */
  requestPause?: (request: Request, context: AdapterContext, call: VoiceCall) => Promise<Json>;
  /** Rare service-tool assessment from stored evidence; browser kind/certain/categories are only candidates. */
  assessServiceIntent?: (request: Request, context: AdapterContext, input: { call: VoiceCall; candidate: VoiceOffTopicPayload; evidence: AuditEvent[] }) => Promise<Omit<HumorIntent, 'now'>>;
}
function unavailable(name: string): never { return fail(503, 'integration_unavailable', `Не подключён обработчик ${name}.`); }
function clientError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  return fail(400, 'invalid_voice_payload', 'Голосовые данные не прошли проверку.');
}
async function owned(context: AdapterContext, active: boolean) {
  const body = context.body, session = context.session;
  if (!body || !session) return fail(401, 'unauthorized', 'Требуется подтверждённая сессия.');
  const input = mutation(body);
  if (input.session_id !== session.id || input.library_version !== session.state.library_version) fail(409, 'library_mismatch', 'Сессия или версия библиотеки не совпадает.');
  const call = await context.core.store.getCall(identifier(body.call_id, 'call_id'));
  if (!call || call.sessionId !== session.id || call.id !== body.call_id) return fail(403, 'call_mismatch', 'Звонок не принадлежит сессии.');
  if (active && (session.activeCallId !== call.id || session.state.active_channel !== 'voice' || session.state.status !== 'in_progress' || session.state.paused || call.channelRevision !== input.channel_revision)) fail(409, 'channel_conflict', 'Голосовой канал уже изменился.');
  return { body, session, input, call };
}
async function duplicate(context: AdapterContext): Promise<Json | undefined> {
  if (!context.body || !context.session) return undefined;
  const input = mutation(context.body);
  if (input.session_id !== context.session.id || input.library_version !== context.session.state.library_version) fail(409, 'library_mismatch', 'Сессия или версия библиотеки не совпадает.');
  const previous = await context.core.store.getOperation(context.session.id, input.operation_id);
  if (!previous) return undefined;
  if (!previous.requestHash || previous.requestHash !== await requestHash(context.body)) fail(409, 'operation_payload_conflict', 'Запрос прежней операции не подтверждён или отличается.');
  return { kind: 'duplicate', operation: previous.result, session: await context.core.view(context.session) };
}
/** Read every page so recent evidence is not silently lost after 1,000 transcript revisions. */
export async function readSessionEvents(core: CoreServices, sessionId: string): Promise<AuditEvent[]> {
  const events: AuditEvent[] = []; let after = 0;
  for (let page = 0; page < 100; page++) {
    const batch = await core.store.listEvents(sessionId, after, 1000);
    if (!batch.length) return events;
    const last = batch.at(-1)?.seq;
    if (!Number.isSafeInteger(last) || last! <= after) throw new Error('Invalid stored event pagination');
    events.push(...batch); after = last!;
    if (batch.length < 1000) return events;
  }
  throw new Error('Stored evidence exceeds page limit');
}
async function rawBody(request: Request, max = 1_048_576): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) return fail(400, 'invalid_webhook', 'Пустой вебхук.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > max) { await reader.cancel(); fail(413, 'body_too_large', 'Вебхук слишком большой.'); }
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const data = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}

export function createVoiceHandlers(hooks: VoiceHandlerHooks = {}): { voiceTranscript: AdapterHandler; voiceAnswers: AdapterHandler; voiceFinish: AdapterHandler; ultravoxWebhook: AdapterHandler } {
  const voiceTranscript: AdapterHandler = async (request, context) => {
    if (!hooks.acceptTranscriptBatch) return unavailable('acceptTranscriptBatch');
    const { call, body } = await owned(context, false);
    let events: AuditEvent[];
    try { events = normalizeTranscriptBatch(body.events, call, context.core.now()); } catch (error) { return clientError(error); }
    const accepted = await hooks.acceptTranscriptBatch(request, context, { call, events });
    if (events.some(event => !accepted.accepted_event_ids.includes(event.id))) fail(409, 'pending_events', 'Не все реплики подтверждены сервером.');
    return { ...(record(accepted.response) ? accepted.response as Record<string, Json> : { operation: accepted.response }),
      accepted_events: events.map(event => ({ event_id: event.id, source_key: event.source_key, source_revision: event.source_revision })),
      through_event_id: events.at(-1)!.id,
    };
  };
  const voiceAnswers: AdapterHandler = async (request, context) => {
    // Ownership is checked even for duplicates; legacy operations without a digest cannot authorize replay.
    await owned(context, false);
    const existingOperation = await duplicate(context); if (existingOperation !== undefined) return existingOperation;
    if (context.body?.tool === 'offTopicReply') {
      const { body, call, session } = await owned(context, false);
      if (call.channelRevision !== session.state.channel_revision || session.state.active_channel !== 'voice') fail(409, 'channel_conflict', 'Голосовой канал уже изменился.');
      if (session.state.status !== 'in_progress' || session.state.paused || (session.activeCallId !== null && session.activeCallId !== call.id)) fail(409, 'channel_conflict', 'Этот звонок больше не управляет текущим интервью.');
      let intent;
      try {
        intent = parseVoiceOffTopicPayload({ kind: body.kind, certain: body.certain, safe_category_ids: body.safe_category_ids,
          ...(body.excluded_joke_ids === undefined ? {} : { excluded_joke_ids: body.excluded_joke_ids }),
          ...(body.previous_topic_category_ids === undefined ? {} : { previous_topic_category_ids: body.previous_topic_category_ids }) });
      } catch (error) { return clientError(error); }
      if (intent.kind === 'pause') {
        if (!['stopped', 'failed'].includes(call.status)) {
          if (!hooks.requestPause) return unavailable('requestPause');
          const result = await hooks.requestPause(request, context, call);
          const currentSession = await context.core.store.getSession(session.id);
          if (!currentSession) return fail(409, 'session_changed', 'Сессия изменилась во время остановки.');
          return { accepted: true, pause_pending: true, stop_required: true, operation: result, session: await context.core.view(currentSession) };
        }
        return context.core.channel(request, { ...body, action: 'pause' });
      }
      if (intent.kind === 'finish') return fail(409, 'finish_required', 'Сначала подтвердите последние ответы, затем вызовите finishAudit.');
      if (session.activeCallId !== call.id || call.status !== 'active') fail(409, 'channel_conflict', 'Голосовой звонок уже остановлен.');
      if (!hooks.assessServiceIntent) return unavailable('assessServiceIntent');
      const evidence = latestVoiceEvents(await readSessionEvents(context.core, session.id), call).filter(event => record(event.data) && event.data.is_final === true);
      if (!evidence.some(event => event.role === 'user')) fail(409, 'pending_events', 'Сначала доставьте исходную реплику для служебного ответа.');
      const assessed = await hooks.assessServiceIntent(request, context, { call, candidate: intent, evidence });
      // Check the trusted hook's shape as well; never fall back to the browser candidate on failure.
      const verified = parseVoiceOffTopicPayload(assessed);
      if (verified.kind === 'finish' || verified.kind === 'pause') return fail(409, 'control_action_required', 'Подтвердите завершение или паузу отдельным действием.');
      return context.core.humor(request, body, { ...verified, now: context.core.now() });
    }
    const { body, session, call, input } = await owned(context, true);
    let candidates;
    try { candidates = parseVoiceAnswerPayload({ answers: body.answers }).answers; } catch (error) { return clientError(error); }
    const events = await readSessionEvents(context.core, session.id), existingAnswers = await context.core.store.listAnswers(session.id);
    let resolved;
    try { resolved = await resolveVoiceAnswers({ session, call, candidates, events, existing_answers: existingAnswers, operation_id: input.operation_id, now: context.core.now() }, hooks.assessEvidence); }
    catch { return fail(409, 'unresolved_evidence', 'Нужно доставить или уточнить исходные реплики.'); }
    return context.core.accept(request, body, resolved.event, resolved.answers);
  };
  const voiceFinish: AdapterHandler = async (request, context) => {
    // Preferred browser protocol: voiceAnswers acknowledgement, then this request without candidates.
    const { body, call, session } = await owned(context, false);
    if (session.state.active_channel !== 'voice' || call.channelRevision !== session.state.channel_revision || (session.activeCallId !== null && session.activeCallId !== call.id)) fail(409, 'channel_conflict', 'Этот звонок больше не управляет текущим интервью.');
    try {
      if (body.reason === 'recovery_expired') fail(403, 'server_only_reason', 'Эту причину завершения назначает сервер.');
      const parsed = parseVoiceFinishPayload({ reason: body.reason, answers: body.answers ?? [] });
      if (parsed.answers.length) fail(409, 'answers_pending', 'Сначала подтвердите последний пакет через /api/voice/answers.');
    } catch (error) { return clientError(error); }
    if (body.through_event_id !== undefined) {
      const boundary = (await readSessionEvents(context.core, session.id)).find(event => event.id === body.through_event_id);
      if (!boundary || boundary.call_id !== call.id) fail(409, 'pending_events', 'Граница доставки этого звонка не подтверждена.');
    }
    const result = await context.core.finish(request, { ...body, answers: undefined });
    if (record(result) && record(result.session) && result.session.status !== 'in_progress') return { ...result as Record<string, Json>, accepted: true, closing_message: CLOSING_MESSAGE };
    return result;
  };
  const ultravoxWebhook: AdapterHandler = async (request, context) => {
    if (!hooks.webhookOptions || !hooks.applyProviderEvent) return unavailable('Ultravox webhook');
    const options = await hooks.webhookOptions(context.core), bytes = await rawBody(request);
    let event: ProviderWebhook;
    try { event = await parseVerifiedWebhook(bytes, request.headers, { ...options, now: options.now ?? context.core.now }); }
    catch { return fail(401, 'invalid_webhook', 'Подпись или данные вебхука не подтверждены.'); }
    return hooks.applyProviderEvent(context.core, event, 'webhook');
  };
  return { voiceTranscript, voiceAnswers, voiceFinish, ultravoxWebhook };
}
