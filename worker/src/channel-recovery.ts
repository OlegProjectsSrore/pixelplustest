import type { AuditAnswer, AuditEvent, Json } from './audit/contracts.ts';
import { validateAnswers } from './audit/engine.ts';
import type { HumorIntent } from './audit/humor.ts';
import { getLibrary } from './audit/library.ts';
import { buildChatContext } from './chat/build-context.ts';
import { classifyTurn, parseClassification, type ClassificationResult } from './chat/classifier.ts';
import { createChatRuntime } from './channel-runtime.ts';
import type { CoreServices } from './core.ts';
import type { StoredSession, VoiceCall } from './storage/types.ts';
import { fail, requestHash } from './security.ts';

export interface RecoveryInput {
  core: CoreServices;
  session: StoredSession;
  events: AuditEvent[];
  existingAnswers: AuditAnswer[];
  call: VoiceCall;
}
export type RecoveryClassifier = (input: RecoveryInput) => Promise<AuditAnswer[]>;
const MAX_SOURCES = 40;
const MAX_SOURCE_BYTES = 48_000;
const record = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

async function requireRevision(core: CoreServices, expected: StoredSession): Promise<void> {
  const current = await core.store.requireSession(expected.id);
  if (current.state.revision !== expected.state.revision || current.state.channel_revision !== expected.state.channel_revision ||
    current.state.library_version !== expected.state.library_version || current.state.status !== expected.state.status ||
    !['in_progress', 'closing'].includes(current.state.status)) {
    fail(409, 'recovery_revision_conflict', 'Состояние изменилось во время восстановления голосовых сведений.');
  }
}

async function readEvents(core: CoreServices, sessionId: string): Promise<AuditEvent[]> {
  const result: AuditEvent[] = [];
  for (let page = 0; page < 10; page++) {
    const events = await core.store.listEvents(sessionId, result.at(-1)?.seq ?? 0, 500);
    result.push(...events);
    if (events.length < 500) return result;
  }
  return fail(409, 'recovery_history_limit', 'История превышает ограничение одного восстановления.');
}

/** Identity ignores delivery time and the current revision: neither authorizes a second paid extraction. */
function sourceIdentity(event: AuditEvent): Json {
  return { id: event.id, source: event.source, source_key: event.source_key, source_revision: event.source_revision,
    local_order: event.local_order, call_id: event.call_id ?? null, role: event.role, kind: event.kind,
    text: event.text ?? null, occurred_at: event.occurred_at };
}

/** Reuses the chat schema/evidence validator. Only the bridge may commit returned candidates. */
async function classifySaved(input: RecoveryInput, purpose: 'recovery' | 'intent') {
    const { core, session, call } = input;
    await requireRevision(core, session);
    const storedCall = await core.store.getCall(call.id);
    if (!storedCall || storedCall.sessionId !== session.id || storedCall.providerCallId !== call.providerCallId ||
      (purpose === 'recovery' ? storedCall.status !== 'stopped' : storedCall.status !== 'active' || session.activeCallId !== call.id ||
        session.state.active_channel !== 'voice' || session.state.status !== 'in_progress' || session.state.paused ||
        storedCall.channelRevision !== session.state.channel_revision)) {
      return fail(409, 'recovery_call_mismatch', 'Восстановление требует подтверждённо завершённого звонка этой сессии.');
    }
    if (!input.events.length) return null;
    if (input.events.length > (purpose === 'intent' ? 1 : MAX_SOURCES) || new Set(input.events.map(event => event.id)).size !== input.events.length) {
      return fail(409, 'recovery_source_limit', 'Слишком много или повторяющиеся исходные реплики восстановления.');
    }
    const [all, existing] = await Promise.all([readEvents(core, session.id), core.store.listAnswers(session.id)]);
    const covered = new Set(existing.flatMap(answer => answer.event_ids));
    for (const event of all) {
      if (event.call_id !== call.id || event.role !== 'system' || event.kind !== 'answer' || !['system', 'webhook'].includes(event.source)) continue;
      const ids = record(event.data).processed_event_ids;
      if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string') covered.add(id);
    }
    const saved = new Map(all.map(event => [event.id, event]));
    const sources: AuditEvent[] = [];
    for (const incoming of input.events) {
      const event = saved.get(incoming.id);
      if (!event || JSON.stringify(sourceIdentity(event)) !== JSON.stringify(sourceIdentity(incoming)) || event.call_id !== call.id ||
        !['voice', 'webhook'].includes(event.source) || event.role !== 'user' || !['utterance', 'answer', 'correction'].includes(event.kind) ||
        typeof event.text !== 'string' || !event.text.trim() || record(event.data).is_final !== true ||
        all.some(other => other.source === event.source && other.source_key === event.source_key && other.source_revision > event.source_revision)) {
        return fail(400, 'recovery_invalid_source', 'Восстановление допускается только из сохранённых окончательных реплик посетителя.');
      }
      if (purpose === 'intent' || !covered.has(event.id)) sources.push(event);
    }
    if (!sources.length) return null;
    if (purpose === 'intent' && all.some(event => event.call_id === call.id && event.role === 'user' &&
      record(event.data).is_final === true && (event.seq ?? 0) > sources[0].seq!)) {
      return fail(409, 'recovery_stale_source', 'Намерение относится к более ранней реплике.');
    }
    sources.sort((left, right) => left.seq! - right.seq! || left.id.localeCompare(right.id));
    if (new TextEncoder().encode(JSON.stringify(sources.map(sourceIdentity))).byteLength > MAX_SOURCE_BYTES) {
      return fail(409, 'recovery_source_limit', 'Исходные реплики превышают ограничение одного восстановления.');
    }
    const lib = getLibrary(session.state.library_version);
    const boundaryHash = await requestHash({ purpose, library_version: lib.version, call_id: call.id,
      sources: sources.map(event => ({ source: sourceIdentity(event), seq: event.seq! })) });
    const operationId = `voice-recovery:${boundaryHash}`;
    const allowedAttemptIds: Record<string, string[]> = {};
    for (const fact of lib.facts.filter(item => item.id.endsWith('.history'))) {
      const attempts = record(session.state.facts[fact.id]?.value).attempts;
      allowedAttemptIds[fact.id] = [
        ...(Array.isArray(attempts) ? attempts.flatMap(attempt => typeof record(attempt).attempt_id === 'string' ? [String(record(attempt).attempt_id)] : []) : []),
        ...sources.map((_event, index) => `${operationId}:${fact.id}:${index + 1}`),
      ];
    }
    const callQuestionIds = all.filter(event => event.source === 'system' && event.role === 'system' && event.kind === 'service' &&
      record(event.data).type === 'voice_start' && record(event.data).call_id === call.id).flatMap(event => {
      const ids = record(event.data).question_ids;
      return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
    });
    const allowedQuestionIds = [...new Set([
      ...lib.questions.filter(question => question.phase === 'orientation').map(question => question.id),
      ...callQuestionIds,
      ...existing.filter(answer => answer.library_version === lib.version).map(answer => answer.question_id),
      ...(session.state.current_question_id ? [session.state.current_question_id] : []),
    ])];
    // An immediately preceding assistant prompt can disambiguate a short answer; unrelated turns are excluded.
    const history = all.filter(event => event.role === 'assistant' && event.call_id === call.id && sources.some(source =>
      event.source === source.source && event.local_order === source.local_order - 1)).slice(-8);
    const context = buildChatContext({ lib, state: session.state, events: history, existingAnswers: existing,
      currentQuestion: session.state.current_question_id ? { id: session.state.current_question_id } : null,
      sourceEvents: sources, allowedQuestionIds, allowedAttemptIds, mode: 'voice_recovery', allowDraft: core.engineOptions.allowDraft });
    // Recovery does not perform visitor-facing actions, choose jokes, or reinterpret old answers as new evidence.
    if (purpose === 'recovery') { context.joke_categories = []; context.humor_enabled = false; }
    let result = await core.store.getRecoveryResult(session.id, call.id, boundaryHash) as unknown as ClassificationResult | null;
    if (result === null) {
      await requireRevision(core, session);
      // No background tasks are scheduled by createChatRuntime; the bridge owns reconciliation lifetime.
      const runtime = await createChatRuntime({ core, env: core.env, execution: {} as ExecutionContext }, session, operationId, 0);
      result = await classifyTurn(context, runtime);
      // Save both successful and failed outcomes. In particular, an unknown exchange is never retried for free.
      if (result.ok || result.error.code !== 'not_configured') {
        await core.store.putRecoveryResult({ sessionId: session.id, callId: call.id, boundaryHash,
          reservationId: `deepseek_calls:${session.id}:${operationId}:0`, result: result as unknown as Json, now: core.now() });
      }
    }
    if (!result.ok) return fail(503, `recovery_${result.error.code}`, 'Не удалось проверить пропущенные голосовые сведения.');
    // Re-validate cached candidates against the current allowed questions and still-uncovered evidence.
    const classification = parseClassification(result.classification, context);
    await requireRevision(core, session);
    return { classification, boundaryHash, sources, all, existing, lib };
}

export function createRecoveryClassifier(): RecoveryClassifier {
  return async input => {
    const result = await classifySaved(input, 'recovery');
    if (!result) return [];
    const { classification, boundaryHash, sources, all, existing, lib } = result;
    const answers: AuditAnswer[] = classification.answers.map((candidate, index) => {
      const { evidence: _evidence, replaces_answer_id: _replacement, ...answer } = candidate;
      // A model-proposed correction alone cannot erase a previously accepted answer or confirm ASR accuracy.
      return { ...answer, id: `recovery:${boundaryHash}:${index}`, channel: 'voice', method: 'recovery',
        confirmation: 'unconfirmed', library_version: lib.version, created_at: Math.max(...sources.map(event => event.received_at)) };
    });
    validateAnswers(answers, all, existing, lib, input.core.engineOptions);
    await requireRevision(input.core, input.session);
    return answers;
  };
}

/** Rare off-topic tool requests are assessed from a saved utterance, never from the caller's proposed category. */
export async function assessVoiceIntent(input: RecoveryInput): Promise<HumorIntent> {
  const neutral: HumorIntent = { kind: 'ambiguous', certain: false, safe_category_ids: [], now: input.core.now() };
  try {
    const result = await classifySaved(input, 'intent');
    if (!result) return neutral;
    const value = result.classification;
    const kinds: Partial<Record<typeof value.intent, HumorIntent['kind']>> = {
      answer: 'answer', mixed: 'mixed', sensitive: 'sensitive', clarify: 'clarification', role_change: 'role_change', pause: 'pause', finish: 'finish',
    };
    if (value.humor_preference === 'decline') return { ...neutral, kind: 'humor_declined', certain: true };
    if (value.humor_preference === 'allow') return { ...neutral, kind: 'humor_enabled', certain: true };
    if (value.intent === 'off_topic' && !value.answers.length && value.joke_category_id !== null && value.faq_id === null) {
      return { ...neutral, kind: 'off_topic', certain: true, safe_category_ids: [value.joke_category_id] };
    }
    return { ...neutral, kind: kinds[value.intent] ?? 'ambiguous' };
  } catch { return neutral; }
}

export const defaultVoiceIntentClassifier = assessVoiceIntent;
