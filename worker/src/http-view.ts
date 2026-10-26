import type { CoreServices } from './core.ts';
import type { AuditEvent, Json } from './audit/contracts.ts';
import { diagnosticStarted, INTERVIEW_BUDGET_MS } from './audit/contracts.ts';
import { getLibrary } from './audit/library.ts';
import { elapsedMs } from './storage/d1-store.ts';
import type { ReportRecord, StoredSession } from './storage/types.ts';

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function readExpiry(session: StoredSession, report: ReportRecord | null): number {
  if (report?.publishedAt !== null && report?.publishedAt !== undefined) return report.reportExpiresAt ?? session.accessExpiresAt;
  if (report?.status === 'failed' && report.failedAt !== null) return report.failedAt + 86_400_000;
  return report?.prepareDeadline ?? session.accessExpiresAt;
}

function publicQuestion(coreQuestion: unknown, session: StoredSession): Json {
  const question = record(coreQuestion);
  if (!question || typeof question.id !== 'string' || typeof question.text !== 'string' || !Array.isArray(question.options)) return null;
  const library = getLibrary(session.state.library_version);
  const facts = library.facts.filter(fact => Array.isArray(question.fact_ids) && question.fact_ids.includes(fact.id));
  const options = question.options.flatMap(value => {
    const option = record(value);
    return option && typeof option.id === 'string' && typeof option.text === 'string' ? [{ id: option.id, label: option.text, text: option.text }] : [];
  });
  const multiple = question.id === 'context_priority' && facts.some(fact => fact.id === 'context.priority');
  const answerMode = multiple ? 'multiple' : options.length ? 'single' : facts.length === 1 && facts[0]!.value_type === 'number' ? 'number' : 'text';
  return { id: question.id, text: question.text, fact_ids: facts.map(fact => fact.id), answer_mode: answerMode, options,
    can_skip: facts.length > 0 && facts.every(fact => fact.states.includes('declined') || fact.states.includes('unknown')) };
}

function publicMessage(event: AuditEvent, session: StoredSession): Json | null {
  const selectedReply = session.state.humor.operations[event.source_key];
  if (event.kind === 'service' && selectedReply && typeof selectedReply.text === 'string') {
    return { id: event.id, seq: event.seq ?? 0, role: 'assistant', text: selectedReply.text, kind: 'service' };
  }
  if (event.role !== 'user' && event.role !== 'assistant') return null;
  if (typeof event.text !== 'string' || !event.text.trim()) return null;
  // Only conversational event text is exposed, never data payloads, snapshots or report content.
  if (!['utterance', 'answer', 'correction', 'service'].includes(event.kind)) return null;
  const kind = event.kind === 'service' ? 'service' : event.role === 'user' ? 'answer' : 'question';
  return { id: event.id, seq: event.seq ?? 0, role: event.role, text: event.text, kind };
}

/** The report-token view deliberately contains no interview messages, question or control rights. */
export async function sessionView(core: CoreServices, session: StoredSession, readOnly = false): Promise<Json> {
  const now = core.now();
  const state = session.state;
  const report = await core.store.getReport(session.reportId);
  const reportAccessExpiry = readExpiry(session, report);
  const managementValid = now < session.accessExpiresAt;
  const expired = (readOnly ? now >= reportAccessExpiry : !managementValid) && state.status === 'in_progress';
  const status = expired ? 'expired' : state.status;
  const elapsed = elapsedMs(state, now);
  const remainingMs = Math.max(0, INTERVIEW_BUDGET_MS - elapsed);
  const remainingSeconds = Math.floor(remainingMs / 1000);
  const canManage = !readOnly && managementValid;
  const canInterview = canManage && status === 'in_progress' && remainingSeconds > 0;
  const call = !readOnly && session.activeCallId ? await core.store.getCall(session.activeCallId) : null;
  const callMustStop = Boolean(call && !['stopped', 'failed'].includes(call.status));
  const publicBase = !readOnly && !expired ? record(await core.view(session)) : null;
  const events = !readOnly && managementValid ? await core.store.listEvents(session.id, Math.max(0, state.through_seq - 1000), 1000) : [];
  const messages = events.map(event => publicMessage(event, session)).filter((value): value is Exclude<Json, null> => value !== null);
  const smtpConfigured = Boolean(core.env.SMTP_HOST && core.env.SMTP_USERNAME && core.env.SMTP_PASSWORD && core.env.SMTP_FROM && core.env.PUBLIC_WORKER_URL && (!core.env.SMTP_PORT || core.env.SMTP_PORT === '465' || core.env.SMTP_PORT === '587'));
  return {
    api_version: '1', session_id: session.id, revision: state.revision, channel_revision: state.channel_revision,
    library_version: state.library_version, status, active_channel: !readOnly && canInterview ? state.active_channel : null,
    paused: state.paused, remaining_seconds: readOnly ? 0 : remainingSeconds, server_time: now,
    remaining_ms: readOnly ? 0 : remainingMs, elapsed_ms: readOnly ? 0 : elapsed,
    expires_at: readOnly ? reportAccessExpiry : session.accessExpiresAt,
    access_expires_at: readOnly ? 0 : session.accessExpiresAt,
    ...(!readOnly ? { humor_enabled: state.humor.enabled, conversation_mode: state.mode ?? 'diagnostic', diagnostic_started: diagnosticStarted(state) } : {}),
    question: canInterview && !state.paused ? publicQuestion(publicBase?.question, session) : null,
    messages, voice: call ? { call_id: call.id, provider_call_id: call.providerCallId, status: call.status } : null,
    report: { id: session.reportId, status: report?.status ?? state.status, expires_at: report?.reportExpiresAt ?? null },
    report_id: session.reportId, report_status: report?.status ?? state.status, report_expires_at: report?.reportExpiresAt ?? null,
    retry_after_seconds: ['closing', 'preparing'].includes(status) ? 5 : null,
    capabilities: {
      chat: canInterview && !callMustStop, voice: canInterview && !callMustStop,
      resume: canInterview && state.paused && !callMustStop, pause: canInterview && !state.paused,
      finish: canManage && status === 'in_progress',
      email: canManage && smtpConfigured && report?.status === 'ready' && report.reportExpiresAt !== null && now < report.reportExpiresAt,
    },
  };
}

/** Converts existing core return values into the inner `data` object of the HTTP v1 envelope. */
export async function presentPayload(core: CoreServices, payload: unknown, readOnly = false): Promise<Json> {
  const original = record(payload);
  if (!original) return payload === null || typeof payload === 'string' || typeof payload === 'number' || typeof payload === 'boolean' ? payload : null;
  const nested = record(original.session);
  const oldView = nested ?? (typeof original.session_id === 'string' ? original : null);
  const id = oldView && typeof oldView.session_id === 'string' ? oldView.session_id : null;
  const output: Record<string, Json> = {};
  let session: StoredSession | null = null;
  if (id) {
    session = await core.store.requireSession(id);
    // Read current storage rather than returning an old operation's revision.
    output.session = await sessionView(core, session, readOnly);
  }
  if (readOnly) return output;
  for (const key of ['operation_id', 'status', 'id', 'call_id', 'provider_call_id', 'join_url', 'provider', 'sdp_answer', 'first_message', 'realtime_instructions', 'transition_pending', 'stop_required', 'accepted', 'message', 'through_event_id', 'retry_after_seconds', 'report_token']) {
    const value = original[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) output[key] = value;
  }
  if (typeof original.kind === 'string') {
    output.replayed = original.kind === 'duplicate' || original.replayed === true;
    if (['accepted', 'duplicate', 'clarification_required'].includes(original.kind)) output.kind = original.kind;
    if (original.kind === 'clarification_required') output.clarification_required = true;
  } else if (typeof original.replayed === 'boolean') output.replayed = original.replayed;
  else if (typeof original.duplicate === 'boolean') output.replayed = original.duplicate;
  if (original.status === 'unknown') output.delivery_status = 'delivery_unknown';
  if (Array.isArray(original.accepted_event_ids)) output.accepted_event_ids = original.accepted_event_ids.filter((id): id is string => typeof id === 'string');
  if (Array.isArray(original.accepted_events)) {
    // Acknowledgements come from the committed batch, never from browser-supplied candidates.
    output.accepted_events = original.accepted_events.flatMap(value => {
      const event = record(value);
      if (!event || typeof event.source_key !== 'string' || !Number.isSafeInteger(event.source_revision) || Number(event.source_revision) < 0) return [];
      const id = typeof event.event_id === 'string' ? event.event_id : typeof event.id === 'string' ? event.id : null;
      return id ? [{ event_id: id, source_key: event.source_key, source_revision: Number(event.source_revision) }] : [];
    });
  }
  if (typeof original.corpus === 'string' && Array.isArray(original.snippets)) {
    output.corpus = original.corpus;
    if (typeof original.answer === 'string') output.answer = original.answer;
    output.snippets = original.snippets.flatMap(value => {
      const snippet = record(value);
      if (!snippet || !['id', 'title', 'heading', 'url', 'text'].every(key => typeof snippet[key] === 'string')) return [];
      return [{ id: snippet.id as string, title: snippet.title as string, heading: snippet.heading as string, url: snippet.url as string, text: snippet.text as string }];
    });
  }
  // DeepSeek wording of the first chat question; later questions arrive as operation.question_text.
  const phrasing = record(original.question_phrasing);
  if (phrasing && typeof phrasing.question_id === 'string' && typeof phrasing.text === 'string') output.question_phrasing = { question_id: phrasing.question_id, text: phrasing.text };
  const reply = record(original.reply);
  if (reply && typeof reply.id === 'string' && typeof reply.text === 'string') output.reply = { id: reply.id, text: reply.text };
  const operation = record(original.operation);
  if (operation) {
    const publicOperation: Record<string, Json> = {};
    for (const key of ['text', 'joke_id', 'question_id', 'question_text', 'operation_id', 'revision', 'channel_revision', 'status', 'selection_operation', 'clarification_required']) {
      const value = operation[key];
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) publicOperation[key] = value;
    }
    if (Object.keys(publicOperation).length) output.operation = publicOperation;
    if (operation.suppress_question === true && output.session && typeof output.session === 'object' && !Array.isArray(output.session)) output.session.question = null;
  }
  if (session && typeof original.management_token === 'string') {
    output.session_token = original.management_token;
    output.management_token = original.management_token;
    output.session_token_expires_at = session.accessExpiresAt;
    output.report_token_expires_at = readExpiry(session, await core.store.getReport(session.reportId));
  }
  return output;
}
