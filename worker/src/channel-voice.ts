import { INTERVIEW_BUDGET_MS, type AuditAnswer, type AuditEvent, type AuditState, type Json } from './audit/contracts.ts';
import { advanceAudit, nextQuestion, validateAnswers } from './audit/engine.ts';
import { compileVoiceBlocks, getLibrary } from './audit/library.ts';
import type { HumorIntent } from './audit/humor.ts';
import { validateRuntimeValue, type RuntimeValueSchema } from './audit/value-schemas.ts';
import type { CoreServices } from './core.ts';
import type { AdapterContext, ChannelAdapters } from './integration.ts';
import { fail, hashToken, identifier, mutation, object, readBytes, requestHash, revision, textField } from './security.ts';
import { elapsedMs, type StoredSession, type UsageReservation, type VoiceCall } from './storage/d1-store.ts';
import { buildCallConfig, buildInterviewPrompt, createVoiceProvider, parseVerifiedWebhook, parseVoiceAnswerPayload, parseVoiceOffTopicPayload, VoiceProviderError } from './voice/index.ts';
import type { VoiceAnswerCandidate, VoiceCallConfig, VoiceDependencies } from './voice/types.ts';
import { refreshVoiceAccounts, voiceConfigHash } from './voice-accounts.ts';

type Provider = ReturnType<typeof createVoiceProvider>;
export interface VoiceBridgeOptions {
  refreshAccounts?: (core: CoreServices) => Promise<void>;
  providerFactory?: (dependencies: VoiceDependencies) => Provider;
  /** Optional metered recovery classifier. Its candidates are still validated against delivered user events. */
  recoverAnswers?: (input: { core: CoreServices; session: StoredSession; events: AuditEvent[]; existingAnswers: AuditAnswer[]; call: VoiceCall }) => Promise<AuditAnswer[]>;
  assessIntent?: (input: { core: CoreServices; session: StoredSession; events: AuditEvent[]; existingAnswers: AuditAnswer[]; call: VoiceCall }) => Promise<HumorIntent>;
  slotMaxAgeMs?: number;
}
export interface VoicePollResult { status: 'idle' | 'pending' | 'stopped' | 'conflict'; session: StoredSession; stoppedFromRevision?: number }
const MAX_EVENTS = 40;
const SLOT_MAX_AGE_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 12_000;
const record = (value: Json | undefined): Record<string, Json> => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;

function secret(core: CoreServices, name: string): string {
  const value = core.env[name];
  return typeof value === 'string' && value.trim() ? value : fail(503, 'not_configured', 'Голосовой канал ещё не настроен.');
}
function keyForSlot(core: CoreServices, slot: string): string {
  if (!/^[1-9]\d*$/.test(slot)) fail(503, 'not_configured', 'Слот голосового аккаунта не настроен.');
  return secret(core, `ULTRAVOX_KEY_${slot}`);
}
function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unbase64url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid ciphertext');
  return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)), char => char.charCodeAt(0));
}
async function replayKey(core: CoreServices): Promise<CryptoKey> {
  let bytes: Uint8Array;
  try { bytes = unbase64url(secret(core, 'VOICE_REPLAY_SECRET')); if (bytes.byteLength !== 32) throw new Error('length'); }
  catch { return fail(503, 'not_configured', 'Не настроено защищённое повторение голосового подключения.'); }
  return crypto.subtle.importKey('raw', bytes!, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptJoinUrl(core: CoreServices, sessionId: string, operationId: string, url: string): Promise<Json> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${sessionId}:${operationId}`) }, await replayKey(core), new TextEncoder().encode(url));
  return { iv: base64url(iv), ciphertext: base64url(new Uint8Array(encrypted)) };
}
export async function decryptJoinUrl(core: CoreServices, sessionId: string, operationId: string, envelope: Json, protocol: string | null = 'wss:'): Promise<string> {
  try {
    const value = record(envelope);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64url(String(value.iv)), additionalData: new TextEncoder().encode(`${sessionId}:${operationId}`) }, await replayKey(core), unbase64url(String(value.ciphertext)));
    const url = new TextDecoder().decode(plain);
    if (protocol && new URL(url).protocol !== protocol) throw new Error('URL');
    return url;
  } catch { return fail(503, 'voice_replay_unavailable', 'Не удалось восстановить защищённое подключение.'); }
}

export async function prepared(request: Request, context: AdapterContext) {
  const body = object(context.body), input = mutation(body), core = context.core;
  const session = await core.authenticate(request, input.session_id);
  if (input.library_version !== session.state.library_version) fail(409, 'library_mismatch', 'Версия библиотеки не совпадает.');
  const digest = await requestHash(body), previous = await core.store.getOperation(session.id, input.operation_id);
  if (previous && previous.requestHash !== digest) fail(409, 'operation_payload_conflict', 'Ключ операции уже использован с другим запросом.');
  return { core, body, input, session, digest, previous };
}
function currentRevision(session: StoredSession, input: ReturnType<typeof mutation>): void {
  if (input.expected_revision !== session.state.revision || input.channel_revision !== session.state.channel_revision) fail(409, 'revision_conflict', 'Состояние изменилось. Получите актуальную ревизию.');
}
async function member(core: CoreServices, session: StoredSession, callId: unknown): Promise<VoiceCall> {
  const call = await core.store.getCall(identifier(callId, 'call_id'));
  return call && call.sessionId === session.id ? call : fail(403, 'call_mismatch', 'Звонок не принадлежит сессии.');
}
export async function readEvents(core: CoreServices, sessionId: string): Promise<AuditEvent[]> {
  const result: AuditEvent[] = [];
  for (let page = 0; page < 10; page++) {
    const next = await core.store.listEvents(sessionId, result.at(-1)?.seq ?? 0, 500);
    result.push(...next); if (next.length < 500) return result;
  }
  return fail(413, 'history_too_large', 'История превышает ограничение обработки.');
}
export function latestEvents(events: AuditEvent[]): AuditEvent[] {
  const map = new Map<string, AuditEvent>();
  for (const event of events) {
    const key = `${event.source}:${event.source_key}`;
    if (!map.has(key) || map.get(key)!.source_revision < event.source_revision) map.set(key, event);
  }
  return [...map.values()];
}

/** A transcript request is one CAS transaction, including its replay record and all source revisions. */
async function saveEvidence(core: CoreServices, session: StoredSession, operationId: string, digest: string, events: AuditEvent[], result: Record<string, Json> = {}): Promise<Json> {
  const prior = await core.store.getOperation(session.id, operationId);
  if (prior) {
    if (prior.requestHash !== digest) fail(409, 'operation_payload_conflict', 'Ключ операции уже использован.');
    return { kind: 'duplicate', ...record(prior.result), session: await core.view(await core.store.requireSession(session.id)) };
  }
  if (events.length > MAX_EVENTS) fail(413, 'payload_too_large', 'Слишком большой пакет реплик.');
  const existing = await readEvents(core, session.id);
  const additions: AuditEvent[] = [];
  for (const event of events) {
    const old = existing.find(item => item.source === event.source && item.source_key === event.source_key && item.source_revision === event.source_revision);
    if (old) {
      if (old.text !== event.text || old.role !== event.role || old.call_id !== event.call_id || record(old.data).is_final !== record(event.data).is_final) fail(409, 'source_event_conflict', 'Версия реплики уже сохранена с другим содержанием.');
    } else {
      const inBatch = additions.find(item => item.id === event.id);
      if (inBatch && (inBatch.text !== event.text || inBatch.role !== event.role || record(inBatch.data).is_final !== record(event.data).is_final)) fail(409, 'source_event_conflict', 'В пакете есть противоречащие версии реплики.');
      if (!inBatch) additions.push(event);
    }
  }
  const nonce = crypto.randomUUID(), now = core.now();
  const next: AuditState = { ...session.state, revision: session.state.revision + 1, through_seq: session.state.through_seq + additions.length + 1,
    elapsed_ms: elapsedMs(session.state, now), active_since: session.state.active_since === null ? null : now };
  const boundary = events.at(-1)?.id ?? null;
  const reply: Json = { ...result, through_event_id: boundary, accepted_event_ids: events.map(event => event.id),
    accepted_events: events.map(event => ({ event_id: event.id, source_key: event.source_key, source_revision: event.source_revision })) };
  const operation = core.serviceEvent(operationId, 'service', { type: 'voice_evidence_batch' });
  const guard = `EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND revision=? AND mutation_nonce=?)`;
  const owner = [session.id, next.revision, nonce];
  const statements = [core.store.db.prepare(`UPDATE audit_sessions SET revision=?,state_json=?,last_seq=?,used_ms=?,active_started_at=?,mutation_nonce=?,updated_at=? WHERE id=? AND revision=? AND NOT EXISTS(SELECT 1 FROM audit_events WHERE session_id=? AND operation_id=?)`).bind(next.revision, JSON.stringify(next), next.through_seq, next.elapsed_ms, next.active_since, nonce, now, session.id, session.state.revision, session.id, operationId)];
  let seq = session.state.through_seq;
  for (const event of [...additions, operation]) {
    const isOperation = event === operation, eventSeq = ++seq;
    statements.push(core.store.db.prepare(`INSERT INTO audit_events(id,session_id,seq,source,source_event_key,source_revision,source_order,call_id,role,type,payload_json,source_timestamp,received_at,operation_id,result_json,request_hash) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`).bind(event.id, session.id, eventSeq, event.source, event.source_key, event.source_revision, event.local_order, event.call_id ?? null, event.role, event.kind, JSON.stringify({ ...event, seq: eventSeq }), event.occurred_at, now, isOperation ? operationId : `evidence:${event.id}`, JSON.stringify(isOperation ? reply : null), isOperation ? digest : null, ...owner));
  }
  const outcome = await core.store.db.batch(statements);
  if (outcome[0].meta.changes !== 1) {
    const previous = await core.store.getOperation(session.id, operationId);
    if (previous) {
      if (previous.requestHash !== digest) fail(409, 'operation_payload_conflict', 'Ключ операции уже использован.');
      return { kind: 'duplicate', ...record(previous.result), session: await core.view(await core.store.requireSession(session.id)) };
    }
    return fail(409, 'revision_conflict', 'История изменилась. Получите актуальную ревизию.');
  }
  return { kind: 'accepted', ...record(reply), session: await core.view(await core.store.requireSession(session.id)) };
}

async function normalizeTranscripts(core: CoreServices, session: StoredSession, call: VoiceCall, raw: unknown): Promise<AuditEvent[]> {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_EVENTS) fail(400, 'invalid_transcript', 'Некорректный пакет реплик.');
  const result: AuditEvent[] = [];
  for (const value of raw as unknown[]) {
    const item = object(value), ordinal = revision(item.local_order, 'local_order'), sourceRevision = revision(item.source_revision, 'source_revision');
    if (item.source !== 'voice' || item.call_id !== call.id || !['user', 'assistant'].includes(String(item.role)) || item.kind !== 'utterance' || item.source_key !== `${call.id}:${ordinal}`) fail(400, 'invalid_transcript', 'Неверное происхождение реплики.');
    const text = textField(item.text, 'text', 12000), data = object(item.data);
    if (typeof data.is_final !== 'boolean' || !['voice', 'text'].includes(String(data.medium))) fail(400, 'invalid_transcript', 'Некорректное состояние реплики.');
    const occurredAt = revision(item.occurred_at, 'occurred_at');
    if (occurredAt < session.createdAt || occurredAt > core.now() + 5000) fail(400, 'invalid_transcript', 'Неверное время реплики.');
    result.push({ id: `ve:${await hashToken(`${session.id}:${call.id}:${ordinal}:${sourceRevision}`)}`, source: 'voice', source_key: `${call.id}:${ordinal}`, source_revision: sourceRevision,
      local_order: ordinal, call_id: call.id, role: item.role as 'user' | 'assistant', kind: item.role === 'user' && /^Исправляю:\s+\S/iu.test(text) ? 'correction' : 'utterance', text,
      data: { is_final: data.is_final as boolean, medium: String(data.medium) }, occurred_at: occurredAt, received_at: core.now() });
  }
  return result;
}

/** Exact user quotes establish provenance; model-supplied confirmation never becomes explicit approval. */
export async function normalizeVoiceAnswers(core: CoreServices, session: StoredSession, call: VoiceCall, candidates: VoiceAnswerCandidate[]): Promise<AuditAnswer[]> {
  if (candidates.length > 50) fail(413, 'payload_too_large', 'Слишком большой пакет ответов.');
  const conversation = latestEvents(await readEvents(core, session.id)).filter(event => event.call_id === call.id && ['voice', 'webhook'].includes(event.source) && record(event.data).is_final === true);
  const events = conversation.filter(event => event.role === 'user');
  const existing = candidates.some(candidate => candidate.is_correction) ? await core.store.listAnswers(session.id) : [];
  const replaced = new Set(existing.flatMap(answer => answer.replaces_answer_id ? [answer.replaces_answer_id] : []));
  const answers: AuditAnswer[] = [];
  for (const candidate of candidates) {
    const evidence: AuditEvent[] = [];
    for (const quote of candidate.source_quotes) {
      const matches = events.filter(event => event.text?.includes(quote) && (!candidate.source_ordinals?.length || (event.source === 'voice' && candidate.source_ordinals.includes(event.local_order))));
      if (matches.length !== 1) fail(409, 'pending_evidence', 'Цитата не найдена однозначно в доставленных репликах посетителя.');
      if (!evidence.some(item => item.id === matches[0].id)) evidence.push(matches[0]);
    }
    const confirmation = confirmationEvidence(core, session, candidate, evidence, conversation);
    if (confirmation && !evidence.some(event => event.id === confirmation.id)) evidence.push(confirmation);
    const previous = existing.filter(answer => answer.fact_id === candidate.fact_id && answer.library_version === session.state.library_version && !replaced.has(answer.id));
    const correction = candidate.is_correction && confirmation && previous.length === 1 && candidates.filter(item => item.is_correction && item.fact_id === candidate.fact_id).length === 1 && evidence.some(event => event.kind === 'correction');
    // Ambiguous replacement targets or unverified correction speech preserve the dispute and history.
    answers.push({ id: crypto.randomUUID(), question_id: candidate.question_id, fact_id: candidate.fact_id, ...(candidate.answer_id ? { answer_id: candidate.answer_id } : {}),
      state: candidate.state, value: candidate.value, ...(candidate.parameters ? { parameters: candidate.parameters } : {}), event_ids: evidence.map(event => event.id), channel: 'voice', method: 'voice_batch',
      confirmation: correction ? 'explicit' : candidate.is_correction ? 'disputed' : confirmation ? 'explicit' : 'unconfirmed',
      ...(correction ? { replaces_answer_id: previous[0].id } : {}), library_version: session.state.library_version, created_at: core.now() });
  }
  return answers;
}

const normalizeClaim = (text: string): string => text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');
const escapePattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stateWords: Record<string, readonly string[]> = {
  unknown: ['не знаю'], not_measured: ['не измеряли', 'не измеряем'], not_applicable: ['не применимо', 'неприменимо'],
  declined: ['отказываюсь отвечать'], ambiguous: ['неоднозначно'],
};
// These are field headings, not unit/currency aliases or semantic synonyms for arbitrary values.
const fieldHeadings: Record<string, string> = {
  description: 'описание', object: 'объект', observation: 'наблюдение', period: 'период', context: 'контекст', task: 'задача',
  current_way: 'текущий способ', constraint: 'ограничение', metric: 'показатель', value: 'значение', min: 'минимум', max: 'максимум',
  unit: 'единица', currency: 'валюта', approximate: 'приблизительно', attempts_status: 'попытки', work: 'работа',
  period_and_duration: 'период и длительность', goal: 'цель', executor_and_resources: 'исполнитель и ресурсы', outcome: 'результат',
  measurement: 'измерение', current_status: 'текущий статус', stop_reason: 'причина остановки', level: 'уровень',
};
function numericPattern(value: number): string | null {
  const text = String(value);
  // No spoken-number conversion, exponent expansion, rounding or unit conversion.
  return /^-?\d+(?:\.\d+)?$/.test(text) ? escapePattern(text).replace('\\.', '[.,]') : null;
}
function quantityPattern(value: Record<string, Json>): string | null {
  if (Object.keys(value).some(key => !['value', 'min', 'max', 'unit', 'currency', 'period', 'approximate'].includes(key)) ||
      typeof value.approximate !== 'boolean' || typeof value.unit !== 'string' || typeof value.period !== 'string') return null;
  let amount: string | null = null;
  if (typeof value.value === 'number' && value.min == null && value.max == null) amount = numericPattern(value.value);
  else if (value.value == null && typeof value.min === 'number' && typeof value.max === 'number' && value.min <= value.max) {
    const min = numericPattern(value.min), max = numericPattern(value.max); if (min && max) amount = `от ${min} до ${max}`;
  }
  if (!amount || !value.unit.trim() || !value.period.trim()) return null;
  const currency = typeof value.currency === 'string' && normalizeClaim(value.currency) !== normalizeClaim(value.unit)
    ? `(?: ${escapePattern(normalizeClaim(value.currency))}| \\(${escapePattern(normalizeClaim(value.currency))}\\))` : '';
  if (value.currency !== undefined && value.currency !== null && typeof value.currency !== 'string') return null;
  return `${value.approximate ? '(?:примерно|около|приблизительно)' : '(?:ровно|точно)'} ${amount} ${escapePattern(normalizeClaim(value.unit))}${currency} (?:в|за) ${escapePattern(normalizeClaim(value.period))}`;
}

/** Only explicit field:value assertions are accepted; presence of unrelated leaf words is insufficient. */
function structuredClaimMatches(value: Json, schema: RuntimeValueSchema, assertion: string): boolean {
  try { validateRuntimeValue(value, schema); } catch { return false; }
  const root = record(value);
  const quantity = quantityPattern(root);
  if (quantity && new RegExp(`^(?:${quantity})$`, 'u').test(assertion)) return true;
  const fields = new Map<string, string>();
  function leaf(value: Json): string | null {
    if (typeof value === 'string' && value.trim() && !/[;\r\n]/.test(value)) return escapePattern(normalizeClaim(value));
    if (typeof value === 'number') return numericPattern(value);
    if (typeof value === 'boolean') return value ? 'да' : 'нет';
    const item = record(value);
    if (item.state === 'known' || item.state === 'other') {
      if (typeof item.value === 'string' && Object.values(stateWords).some(words => words.includes(normalizeClaim(item.value as string)))) return null;
      return leaf(item.value);
    }
    if (typeof item.state === 'string' && item.value === null && stateWords[item.state]) return `(?:${stateWords[item.state].map(escapePattern).join('|')})`;
    return quantityPattern(item);
  }
  function collect(item: Record<string, Json>): boolean {
    for (const [key, value] of Object.entries(item)) {
      if (key === 'attempts') {
        // An attempt ID is bookkeeping. Multiple attempts need independent association evidence.
        if (!Array.isArray(value) || value.length > 1) return false;
        if (value.length && !collect(record(value[0]))) return false;
        continue;
      }
      if (key === 'attempt_id') { if (typeof value !== 'string' || !value.trim()) return false; continue; }
      if (key === 'applies_to_block_ids') { if (!Array.isArray(value) || value.length) return false; continue; }
      const heading = fieldHeadings[key]; if (!heading || fields.has(heading)) return false;
      let pattern = leaf(value);
      if (key === 'attempts_status') {
        const statuses: Record<string, string> = { tried: 'пробовали', not_tried: 'не пробовали', unknown: 'не знаю', declined: 'отказываюсь отвечать' };
        pattern = typeof value === 'string' && statuses[value] ? escapePattern(statuses[value]) : null;
      }
      if (!pattern) return false;
      fields.set(heading, pattern);
    }
    return true;
  }
  if (!collect(root) || !fields.size) return false;
  const clauses = assertion.split(/\s*;\s*/); if (clauses.length !== fields.size) return false;
  const seen = new Set<string>();
  for (const clause of clauses) {
    const match = /^([^:]+):\s*(.+)$/.exec(clause); if (!match) return false;
    const heading = match[1].trim(), pattern = fields.get(heading);
    if (!pattern || seen.has(heading) || !new RegExp(`^(?:${pattern})$`, 'u').test(match[2])) return false;
    seen.add(heading);
  }
  return true;
}

function confirmationEvidence(core: CoreServices, session: StoredSession, candidate: VoiceAnswerCandidate, originals: AuditEvent[], conversation: AuditEvent[]): AuditEvent | null {
  if (candidate.confirmation_candidate !== 'explicit' || !originals.length) return null;
  if (candidate.is_correction && (originals.length !== 1 || originals[0].kind !== 'correction' || !/^Исправляю:\s+\S/iu.test(originals[0].text ?? ''))) return null;
  const originalText = (event: AuditEvent): string => candidate.is_correction ? (event.text ?? '').replace(/^Исправляю:\s+/iu, '') : event.text ?? '';
  const lib = getLibrary(session.state.library_version), definition = lib.facts.find(fact => fact.id === candidate.fact_id);
  const question = lib.questions.find(item => item.id === candidate.question_id && item.fact_ids.includes(candidate.fact_id));
  if (!definition || !question) return null;
  if (candidate.state === 'known' && typeof candidate.value === 'string' && Object.values(stateWords).some(words => words.includes(normalizeClaim(candidate.value as string)))) return null;
  const original = originals.length === 1 ? originals[0] : null, assertion = original ? normalizeClaim(originalText(original)) : '';
  const asked = original && conversation.find(event => event.source === original.source && event.local_order === original.local_order - 1 && event.role === 'assistant');
  const matchesQuestion = asked && [question.voice, question.chat].some(text => normalizeClaim(text) === normalizeClaim(asked.text ?? ''));
  let literal = false, booleanReply: string | null = null;
  if (original && matchesQuestion) {
    if (candidate.state !== 'known' && candidate.state !== 'other') literal = candidate.value === null && (stateWords[candidate.state] ?? []).includes(assertion);
    else if (typeof candidate.value === 'boolean' && definition.value_type === 'boolean' && !/(?:^|\s)(?:не|нет|без)(?:\s|[,.?!]|$)/u.test(normalizeClaim(question.voice))) {
      const expected = candidate.value ? 'да' : 'нет'; if (assertion === expected) booleanReply = expected;
    } else if (definition.runtime_schema) {
      const value = typeof candidate.value === 'number' ? { ...candidate.parameters, value: candidate.value } as Json : candidate.value;
      literal = structuredClaimMatches(value, definition.runtime_schema, assertion);
    }
  }
  let parts: string[] = [];
  if (['known', 'other'].includes(candidate.state) && typeof candidate.value === 'string') {
    const option = definition?.values?.find(value => value.id === candidate.value);
    parts = [option?.label ?? candidate.value];
  } else if (Array.isArray(candidate.value) && candidate.value.length && candidate.value.every(value => typeof value === 'string')) {
    parts = candidate.value.map(value => candidate.fact_id === 'context.priority' ? lib.domains.find(domain => domain.id === value)?.title ?? String(value) : String(value));
  }
  // Free text cannot be reduced to a fragment that drops the original negation.
  if (parts.length === 1 && normalizeClaim(parts[0]).length >= 3 && originals.every(event => normalizeClaim(originalText(event)) === normalizeClaim(parts[0]))) literal = true;
  if (!literal && !booleanReply) return null;
  const approvals = /^(?:да(?:,? (?:все |всё )?(?:верно|правильно))?|верно|правильно|подтверждаю)[.!\s]*$/i;
  for (const user of conversation) {
    if (user.role !== 'user' || !approvals.test((user.text ?? '').trim())) continue;
    const recap = conversation.find(event => event.source === user.source && event.local_order === user.local_order - 1 && event.role === 'assistant');
    if (!recap || !/^(?:правильно ли я (?:понял|поняла)|верно ли|подтвердите)[, :]/i.test(recap.text ?? '')) continue;
    const recapAssertion = normalizeClaim((recap.text ?? '').replace(/^(?:правильно ли я (?:понял|поняла)|верно ли|подтвердите)[, :]+/i, ''));
    if (booleanReply) {
      const prompt = escapePattern(normalizeClaim(question.voice));
      if (!new RegExp(`^${prompt}[?.,;:]? ответ: ${booleanReply}$`, 'u').test(recapAssertion)) continue;
    } else if (!originals.every(event => normalizeClaim(originalText(event)) === recapAssertion)) continue;
    if (originals.every(event => event.source === recap.source && event.local_order < recap.local_order)) return user;
  }
  return null;
}

function literalIntent(text: string, now: number): HumorIntent {
  const value = text.toLocaleLowerCase('ru').trim().replace(/[.!?]+$/, '').replace(/\s+/g, ' ');
  const kind: HumorIntent['kind'] = /^(?:пауза|сделайте паузу|давайте сделаем паузу|давайте паузу|приостановите опрос)$/.test(value) ? 'pause'
    : /^(?:завершить|закончить|завершите опрос|закончим опрос|давайте закончим|хочу завершить опрос)$/.test(value) ? 'finish'
    : /^(?:без шуток|без юмора|не шутите|давайте без шуток|не нужно шутить)$/.test(value) ? 'humor_declined' : 'ambiguous';
  return { kind, certain: kind !== 'ambiguous', safe_category_ids: [], now };
}

function providerDependencies(core: CoreServices, call: VoiceCall, creating = false, gate?: () => boolean): VoiceDependencies {
  let createUsed = false;
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  return { api_key: keyForSlot(core, call.slotId), account_slot: call.slotId,
    fetch: (input, init) => core.fetcher(input, { ...init, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) }),
    run_authorized: async (context, execute) => {
      const stored = await core.store.getCall(call.id);
      if (!stored || stored.sessionId !== call.sessionId || stored.slotId !== context.account_slot) fail(403, 'call_mismatch', 'Неверный владелец звонка.');
      if (context.operation === 'create_call') {
        if (!creating || createUsed || stored!.status !== 'reserved' || !gate?.()) fail(409, 'voice_operation_pending', 'Создание звонка уже начато.');
        createUsed = true;
      } else if (!stored!.providerCallId) fail(409, 'voice_operation_pending', 'Идентификатор звонка ещё не подтверждён.');
      return execute();
    } };
}

export async function settleStoppedCall(core: CoreServices, callId: string): Promise<void> {
  const call = await core.store.getCall(callId); if (call?.status !== 'stopped') return;
  await core.store.settleUsage(`voice_seconds:${call.sessionId}:${call.operationId}`, Math.ceil(call.usedMs / 1000), core.now());
  await core.store.settleUsage(`voice_starts:${call.sessionId}:${call.operationId}`, 1, core.now());
}

async function replayStart(core: CoreServices, session: StoredSession, operationId: string, saved: Json): Promise<Json> {
  const result = record(saved), callId = result.call_id;
  if (typeof callId !== 'string') fail(409, 'voice_operation_pending', 'Подключение ещё согласуется.');
  const call = await member(core, session, callId);
  if (result.status === 'active' && result.join_cipher && call.status === 'active') {
    return { kind: 'duplicate', call_id: call.id, provider_call_id: call.providerCallId, join_url: await decryptJoinUrl(core, session.id, operationId, result.join_cipher), session: await core.view(await core.store.requireSession(session.id)) };
  }
  return { kind: 'duplicate', call_id: call.id, provider_call_id: call.providerCallId, status: call.status, session: await core.view(await core.store.requireSession(session.id)) };
}

export function createVoiceAdapters(options: VoiceBridgeOptions = {}): Partial<ChannelAdapters> {
  const makeProvider = options.providerFactory ?? createVoiceProvider;
  const pollVoice = async (original: StoredSession, _now: number, core: CoreServices): Promise<VoicePollResult> => {
    if (!original.activeCallId) return { status: 'idle', session: original };
    const call = await core.store.getCall(original.activeCallId);
    if (!call || call.sessionId !== original.id || !call.providerCallId) return { status: 'pending', session: original };
    let endedAt: number;
    try {
      const dependencies = providerDependencies(core, call);
      dependencies.fetch = (input, init) => core.fetcher(input, { ...init, signal: AbortSignal.timeout(5000) });
      const status = await makeProvider(dependencies).getCall(call.providerCallId);
      if (status.call_id !== call.providerCallId || status.ended_at === null) return { status: 'pending', session: await core.store.requireSession(original.id) };
      endedAt = Math.min(core.now(), Math.max(call.startedAt ?? status.ended_at, status.ended_at));
    } catch { return { status: 'pending', session: await core.store.requireSession(original.id) }; }
    const before = await core.store.requireSession(original.id);
    if (before.state.revision !== original.state.revision) return { status: 'conflict', session: before };
    await core.store.confirmCallStopped(call.id, endedAt);
    const session = await core.store.requireSession(original.id), stopped = await core.store.getCall(call.id);
    if (stopped?.status !== 'stopped' || stopped.stoppedRevision !== session.state.revision || session.state.revision !== original.state.revision + 1 || session.state.channel_revision !== original.state.channel_revision) return { status: 'conflict', session };
    await settleStoppedCall(core, call.id);
    return { status: 'stopped', session, stoppedFromRevision: original.state.revision };
  };
  const reconcile: NonNullable<ChannelAdapters['reconcile']> = async (original, _now, core) => {
    const limitations: string[] = [];
    let complete = true;
    const calls = await core.store.listCalls(original.id);
    for (const call of calls) {
      if (call.slotId === 'openai') continue;
      if (call.status === 'failed') continue;
      if (!call.providerCallId) { complete = false; limitations.push('Создание одного из звонков пока не согласовано с провайдером.'); continue; }
      try {
        const provider = makeProvider(providerDependencies(core, call));
        const current = await provider.getCall(call.providerCallId);
        if (current.call_id !== call.providerCallId || current.ended_at === null) { complete = false; continue; }
        if (!['stopped', 'failed'].includes(call.status)) await core.store.confirmCallStopped(call.id, Math.min(core.now(), Math.max(call.startedAt ?? current.ended_at, current.ended_at)));
        await settleStoppedCall(core, call.id);
        const history = await provider.getCallHistory(call.providerCallId, { max_pages: 10, max_messages: 500, page_size: 100 });
        const events: AuditEvent[] = [];
        for (const message of history) {
          if (!['user', 'assistant'].includes(message.role) || !message.text.trim()) continue;
          const key = message.call_stage_id !== null && message.call_stage_message_index !== null ? `${message.call_stage_id}:${message.call_stage_message_index}` : `order:${message.provider_order}`;
          events.push({ id: `ph:${await hashToken(`${call.id}:${key}`)}`, source: 'webhook', source_key: `history:${call.id}:${key}`, source_revision: 0,
            local_order: message.provider_order, call_id: call.id, role: message.role as 'user' | 'assistant', kind: 'utterance', text: message.text,
            data: { is_final: true, provider: 'ultravox', provenance: json(message) }, occurred_at: current.joined_at ?? current.created_at, received_at: core.now() });
        }
        for (let offset = 0; offset < events.length; offset += MAX_EVENTS) {
          const batch = events.slice(offset, offset + MAX_EVENTS), session = await core.store.requireSession(original.id);
          const digest = await requestHash({ call_id: call.id, events: batch.map(({ received_at: _received, ...event }) => event) });
          await saveEvidence(core, session, `history:${call.id}:${offset}:${digest.slice(0, 24)}`, digest, batch);
        }
        const session = await core.store.requireSession(original.id), all = await readEvents(core, original.id), existingAnswers = await core.store.listAnswers(original.id);
        // A completed extraction marker also covers utterances that contained no answer.
        const processed = all.filter(event => event.call_id === call.id && event.kind === 'answer').flatMap(event => { const ids = record(event.data).processed_event_ids; return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []; });
        const covered = new Set(processed);
        // A single previously extracted fact does not prove that all facts in an utterance were extracted.
        const pending = events.filter(event => event.role === 'user' && !covered.has(event.id));
        const unprocessed = pending.slice(0, MAX_EVENTS);
        if (unprocessed.length && session.state.status === 'closing') {
          if (!options.recoverAnswers) { complete = false; limitations.push('Есть реплики без проверенного сопоставления; восстановление фактов классификатором не настроено.'); }
          else {
            const recovered = await options.recoverAnswers({ core, session, events: unprocessed, existingAnswers, call });
            const afterClassification = await core.store.requireSession(session.id);
            if (afterClassification.state.revision !== session.state.revision || afterClassification.state.status !== 'closing') throw new Error('Recovery state changed');
            if (recovered.some(answer => answer.channel !== 'voice' || answer.method !== 'recovery' || answer.event_ids.some(id => !unprocessed.some(event => event.id === id)))) throw new Error('Recovery used another source');
            validateAnswers(recovered, all, existingAnswers, getLibrary(session.state.library_version), core.engineOptions);
            const state = advanceAudit(session.state, [...existingAnswers, ...recovered], core.now(), getLibrary(session.state.library_version), core.engineOptions);
            state.extracted_through_seq = session.state.through_seq;
            const op = `recovery:${call.id}:${state.extracted_through_seq}`;
            const saved = await core.store.commitRecovery({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: session.state.channel_revision, operationId: op,
              event: { ...core.serviceEvent(op, 'answer', { call_id: call.id, processed_event_ids: unprocessed.map(event => event.id) }), source: 'webhook', call_id: call.id }, answers: recovered, state, now: core.now() });
            if (saved.kind === 'conflict') { complete = false; limitations.push('История изменилась во время восстановления.'); }
            if (pending.length > unprocessed.length) { complete = false; limitations.push('Оставшиеся реплики будут восстановлены следующей ограниченной порцией.'); }
          }
        }
        await core.store.updateCallHistory(call.id, original.id, complete ? 'complete' : 'incomplete');
      } catch { complete = false; limitations.push('История одного из звонков пока не получена полностью.'); }
    }
    return { complete, limitations: [...new Set(limitations)] };
  };

  return {
    reconcile, pollVoice,
    recoverVoice: async core => {
      let stopped = 0;
      const calls = await core.store.listPendingCalls(2);
      for (const call of calls) { if (call.slotId === 'openai') continue; const session = await core.store.requireSession(call.sessionId); if ((await pollVoice(session, core.now(), core)).status === 'stopped') stopped++; }
      return { checked: calls.length, stopped };
    },
    voiceStart: async (request, context) => {
      const { core, body, input, session, digest, previous } = await prepared(request, context);
      if (previous) return replayStart(core, session, input.operation_id, previous.result);
      currentRevision(session, input);
      if (session.state.status !== 'in_progress' || session.state.active_channel !== 'voice') fail(409, 'channel_conflict', 'Голосовой канал не активен.');
      await replayKey(core);
      const remainingSeconds = (INTERVIEW_BUDGET_MS - elapsedMs(session.state, core.now())) / 1000;
      if (remainingSeconds <= 0) fail(409, 'time_limit', 'Время опроса закончилось.');
      const model = secret(core, 'ULTRAVOX_MODEL'), voice = secret(core, 'ULTRAVOX_VOICE'), webhookSecret = secret(core, 'ULTRAVOX_WEBHOOK_SECRET');
      const publicUrl = new URL(secret(core, 'PUBLIC_WORKER_URL'));
      if (publicUrl.protocol !== 'https:') fail(503, 'not_configured', 'Не настроен HTTPS-адрес обратных вызовов.');
      const maxAge = options.slotMaxAgeMs ?? SLOT_MAX_AGE_MS;
      await (options.refreshAccounts ?? refreshVoiceAccounts)(core);
      const candidates = await core.store.db.prepare(`SELECT id,config_hash FROM ultravox_slots WHERE state='available' AND checked_at>=? AND next_attempt_at<=? AND active_calls<max_concurrency AND available_ms-reserved_ms>=? ORDER BY id LIMIT 4`).bind(core.now() - maxAge, core.now(), remainingSeconds * 1000).all<{ id: string; config_hash: string }>();
      const verified = await Promise.all(candidates.results.map(async item => /^[1-4]$/.test(item.id) && typeof core.env[`ULTRAVOX_KEY_${item.id}`] === 'string' && item.config_hash === await voiceConfigHash(core, item.id) ? item : null));
      const slot = verified.find(item => item !== null);
      if (!slot) fail(503, 'voice_unavailable', 'Нет проверенного свободного голосового аккаунта.');
      const lib = getLibrary(session.state.library_version), planned = { ...session.state, paused: false };
      const question = nextQuestion(planned, core.now(), lib, core.engineOptions);
      const blocks = compileVoiceBlocks(lib, core.engineOptions), block = question ? Object.values(blocks).find(item => item.questions.some(item => item.id === question.id)) : undefined;
      const history = await core.store.listCalls(session.id), prior = history.findLast(call => call.status === 'stopped' && call.providerCallId !== null);
      const priorOnSameSlot = prior?.slotId === slot!.id;
      const alreadyAsked = priorOnSameSlot && question && latestEvents(await readEvents(core, session.id)).some(event =>
        event.call_id === prior?.id && event.role === 'assistant' && event.kind === 'utterance' &&
        record(event.data).is_final === true && event.text?.trim() === question.text.trim());
      const config: VoiceCallConfig = {
        system_prompt: buildInterviewPrompt({ library_version: lib.version, questions: block?.questions ?? (question ? [question] : []), current_question_id: question?.id ?? null, accepted_facts: Object.values(session.state.facts), remaining_seconds: remainingSeconds, humor_enabled: session.state.humor.enabled, off_topic_categories: lib.jokes.categories }),
        model, voice, remaining_seconds: remainingSeconds, first_message: question?.text ?? 'Сведения сохранены. Можно завершить опрос и подготовить предварительный аудит.',
        callback_url: new URL('/api/webhooks/ultravox', publicUrl).href, webhook_secrets: [webhookSecret], metadata: { audit_session_id: session.id },
        ...(priorOnSameSlot ? { prior_call_id: prior!.providerCallId!, user_first: Boolean(alreadyAsked) } : {}),
      };
      buildCallConfig(config);
      let starts: UsageReservation | null = null, seconds: UsageReservation | null = null, call: VoiceCall | null = null;
      let providerStarted = false;
      try {
        starts = await core.reserve('voice_starts', 1, `${session.id}:${input.operation_id}`);
        if (!starts.newlyCreated) fail(409, 'voice_operation_pending', 'Создание звонка уже зарезервировано.');
        seconds = await core.reserve('voice_seconds', Math.ceil(remainingSeconds), `${session.id}:${input.operation_id}`);
        if (!seconds.newlyCreated) fail(409, 'voice_operation_pending', 'Время звонка уже зарезервировано.');
        call = await core.store.reserveVoiceCall({ id: crypto.randomUUID(), sessionId: session.id, slotId: slot!.id, operationId: input.operation_id,
          expectedRevision: input.expected_revision, channelRevision: input.channel_revision, now: core.now(), slotMaxAgeMs: maxAge, configHash: slot!.config_hash, ...(prior ? { previousCallId: prior.id } : {}) });
        if (!call) fail(409, 'voice_unavailable', 'Голосовой слот или состояние уже изменились.');
        const reserved = await core.store.requireSession(session.id);
        const accepted = await core.store.commit({ sessionId: session.id, expectedRevision: reserved.state.revision, channelRevision: reserved.state.channel_revision, operationId: input.operation_id, requestHash: digest,
          event: core.serviceEvent(input.operation_id, 'service', { type: 'voice_start', call_id: call!.id, question_ids: (block?.questions ?? (question ? [question] : [])).map(item => item.id) }), state: reserved.state, now: core.now(), result: { status: 'pending', call_id: call!.id } });
        if (accepted.kind !== 'accepted') fail(409, 'voice_operation_pending', 'Создание звонка уже обрабатывается.');
        const dependencies = providerDependencies(core, call!, true, () => starts?.newlyCreated === true && seconds?.newlyCreated === true);
        providerStarted = true;
        const created = await makeProvider(dependencies).createCall(config);
        if (!await core.store.attachCall(call!.id, created.call.call_id, core.now())) throw new VoiceProviderError('ULTRAVOX_ATTACH_FAILED', 201, 'unknown', null, created.call.call_id);
        await core.store.settleUsage(starts.id, 1, core.now());
        const saved: Json = { status: 'active', call_id: call!.id, provider_call_id: created.call.call_id, join_cipher: await encryptJoinUrl(core, session.id, input.operation_id, created.join_url) };
        const update = await core.store.db.prepare(`UPDATE audit_events SET result_json=? WHERE session_id=? AND operation_id=? AND request_hash=? AND EXISTS(SELECT 1 FROM ultravox_calls WHERE id=? AND provider_call_id=? AND status='active')`).bind(JSON.stringify(saved), session.id, input.operation_id, digest, call!.id, created.call.call_id).run();
        if (update.meta.changes !== 1) throw new VoiceProviderError('ULTRAVOX_REPLAY_SAVE_FAILED', 201, 'unknown', null, created.call.call_id);
        return { kind: 'accepted', call_id: call!.id, provider_call_id: created.call.call_id, join_url: created.join_url, session: await core.view(await core.store.requireSession(session.id)) };
      } catch (error) {
        const knownNotCreated = !providerStarted || error instanceof VoiceProviderError && error.creation_outcome === 'not_created';
        if (call) {
          if (knownNotCreated) await core.store.failCallCreation(call.id, core.now(), true);
          else {
            await core.store.markCallUnknown(call.id);
            if (error instanceof VoiceProviderError && error.provider_call_id) await core.store.db.prepare(`UPDATE ultravox_calls SET provider_call_id=? WHERE id=? AND status='unknown' AND provider_call_id IS NULL`).bind(error.provider_call_id, call.id).run();
          }
          if (error instanceof VoiceProviderError && [401, 403].includes(error.status ?? 0)) await core.store.db.prepare(`UPDATE ultravox_slots SET state='disabled',last_error='provider_auth',refresh_token=NULL,refresh_expires_at=0 WHERE id=?`).bind(call.slotId).run();
          if (error instanceof VoiceProviderError && error.status === 429) {
            const after = error.retry_after && /^\d+$/.test(error.retry_after) ? Number(error.retry_after) * 1000 : error.retry_after ? Date.parse(error.retry_after) - core.now() : 60_000;
            const delay = Number.isFinite(after) ? Math.max(1000, Math.min(after, 3600_000)) : 60_000;
            await core.store.db.prepare(`UPDATE ultravox_slots SET state='cooldown',next_attempt_at=?,last_error='provider_rate_limit',refresh_token=NULL,refresh_expires_at=0 WHERE id=?`).bind(core.now() + delay, call.slotId).run();
          }
        }
        for (const reservation of [starts, seconds]) if (reservation?.newlyCreated) await core.store.settleUsage(reservation.id, knownNotCreated ? 0 : null, core.now());
        if (error instanceof VoiceProviderError) fail(503, error.creation_outcome === 'unknown' ? 'voice_creation_unknown' : 'voice_provider_unavailable', 'Подключение не подтверждено. Повторное создание до сверки не выполняется.', false);
        throw error;
      }
    },
    voiceTranscript: async (request, context) => {
      const { core, body, input, session, digest, previous } = await prepared(request, context);
      if (previous) return { kind: 'duplicate', ...record(previous.result), session: await core.view(session) };
      currentRevision(session, input);
      const call = await member(core, session, body.call_id);
      const events = await normalizeTranscripts(core, session, call, body.events);
      return saveEvidence(core, session, input.operation_id, digest, events);
    },
    voiceAnswers: async (request, context) => {
      const { core, body, input, session, digest, previous } = await prepared(request, context);
      if (previous) return { kind: 'duplicate', ...record(previous.result), operation: previous.result, session: await core.view(session) };
      currentRevision(session, input);
      const call = await member(core, session, body.call_id);
      if (session.state.status !== 'in_progress' || session.state.active_channel !== 'voice' || call.id !== session.activeCallId || call.channelRevision !== input.channel_revision || call.status !== 'active') fail(409, 'channel_conflict', 'Звонок больше не владеет каналом ввода.');
      if (body.tool === 'offTopicReply') {
        parseVoiceOffTopicPayload(Object.fromEntries(['kind', 'certain', 'safe_category_ids', 'excluded_joke_ids', 'previous_topic_category_ids'].filter(key => body[key] !== undefined).map(key => [key, body[key]])));
        const evidence = latestEvents(await readEvents(core, session.id)).filter(event => event.call_id === call.id && event.source === 'voice' && event.role === 'user' && record(event.data).is_final === true).sort((a, b) => a.local_order - b.local_order);
        const latest = evidence.at(-1); if (!latest) fail(409, 'pending_evidence', 'Последняя реплика посетителя ещё не доставлена.');
        let intent = literalIntent(latest!.text ?? '', core.now());
        if (intent.kind === 'ambiguous' && options.assessIntent) intent = await options.assessIntent({ core, session, events: [latest!], existingAnswers: await core.store.listAnswers(session.id), call });
        if (intent.kind === 'pause') {
          const result = { status: 'stopping', stop_required: true, text: 'Приостановим опрос. Завершите голосовое соединение.' };
          const accepted = await core.store.commit({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision, operationId: input.operation_id, requestHash: digest,
            event: core.serviceEvent(input.operation_id, 'service', { type: 'pause_requested', event_id: latest!.id }), state: session.state, result, now: core.now() });
          if (accepted.kind === 'conflict') fail(409, 'revision_conflict', 'Состояние изменилось.');
          await core.store.markCallStopping(call.id);
          return { ...result, kind: accepted.kind, operation: accepted.result ?? null, session: await core.view(accepted.session) };
        }
        if (intent.kind === 'finish') return core.response(await core.store.finish({ sessionId: session.id, expectedRevision: input.expected_revision, channelRevision: input.channel_revision, operationId: input.operation_id, requestHash: digest,
          event: core.serviceEvent(input.operation_id, 'finish', { reason: 'visitor_request', event_id: latest!.id }), state: session.state, now: core.now(), reason: 'visitor_request' }));
        return core.humor(request, body, { ...intent, now: core.now() });
      }
      const parsed = parseVoiceAnswerPayload({ answers: body.answers });
      if (body.through_event_id !== undefined && !(await readEvents(core, session.id)).some(event => event.id === body.through_event_id && event.call_id === call.id)) fail(409, 'pending_evidence', 'Граница голосовой истории ещё не сохранена.');
      const answers = await normalizeVoiceAnswers(core, session, call, parsed.answers);
      const event: AuditEvent = { ...core.serviceEvent(input.operation_id, 'answer', { type: 'voice_packet' }), source: 'voice', call_id: call.id };
      return core.accept(request, body, event, answers);
    },
    ultravoxWebhook: async (request, context) => {
      const core = context.core, webhookSecret = secret(core, 'ULTRAVOX_WEBHOOK_SECRET'), raw = await readBytes(request, 128 * 1024);
      let webhook;
      try { webhook = await parseVerifiedWebhook(raw, request.headers, { secrets: [webhookSecret], now: core.now }); }
      catch { return fail(401, 'invalid_webhook', 'Подпись или содержание вебхука не подтверждены.'); }
      const call = await core.store.getCall(webhook.call.call_id);
      if (!call || call.providerCallId !== webhook.call.call_id) fail(403, 'call_mismatch', 'Неизвестный звонок.');
      keyForSlot(core, call!.slotId);
      const operationId = `webhook:${await requestHash(json(webhook) as Record<string, unknown>)}`;
      const existing = await core.store.getOperation(call!.sessionId, operationId);
      if (existing) return { accepted: true, replayed: true };
      if (webhook.call.ended_at !== null) await core.store.confirmCallStopped(call!.id, Math.min(core.now(), Math.max(call!.startedAt ?? webhook.call.ended_at, webhook.call.ended_at)));
      if (webhook.call.ended_at !== null) await settleStoppedCall(core, call!.id);
      const session = await core.store.requireSession(call!.sessionId);
      const event = { ...core.serviceEvent(operationId, 'service', json(webhook)), source: 'webhook' as const, call_id: call!.id };
      const outcome = await core.store.appendLateEvent({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: session.state.channel_revision, operationId, event, now: core.now() });
      if (outcome.kind === 'conflict') fail(409, 'revision_conflict', 'Повторите доставку вебхука.');
      if (webhook.call.ended_at !== null) context.execution.waitUntil(reconcile(outcome.session, core.now(), core).catch(() => undefined));
      return { accepted: true, replayed: outcome.kind === 'duplicate' };
    },
  };
}
