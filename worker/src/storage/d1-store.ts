import { INTERVIEW_BUDGET_MS, REPORT_PREPARATION_MS, SESSION_LIFETIME_MS, type AuditAnswer, type AuditEvent, type AuditSnapshot, type AuditState, type Json } from '../audit/contracts.ts';
import type { AuditJob, ChangeChannelInput, CheckpointInput, CommitInput, CreateSessionInput, EmailJob, EnqueueEmailInput, MutationResult, ReportRecord, StoredSession, UsageReservation, UsageReservationInput, VoiceCall } from './types.ts';
export type * from './types.ts';

export class StoreError extends Error {
  code: string; status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code = code; this.status = status; this.name = 'StoreError'; }
}

type Row = Record<string, unknown>;
const parse = <T>(value: unknown): T => JSON.parse(String(value)) as T;
const nullableNumber = (value: unknown): number | null => value == null ? null : Number(value);
const nullableString = (value: unknown): string | null => value == null ? null : String(value);
const stringify = (value: unknown): string => JSON.stringify(value);
const changed = (result: D1Result): boolean => result.success && result.meta.changes === 1;
function assertRequestHash(stored: string | null, incoming?: string): void {
  if (stored !== (incoming ?? null)) throw new StoreError('operation_payload_conflict', 'Operation ID was reused with a different request');
}

function sessionRow(row: Row): StoredSession {
  return { id: String(row.id), tokenHash: String(row.access_token_hash), createdAt: Number(row.created_at), accessExpiresAt: Number(row.access_expires_at), state: parse<AuditState>(row.state_json), activeCallId: nullableString(row.active_call_id), reportId: String(row.report_id), closedAt: nullableNumber(row.closed_at) };
}
function reportRow(row: Row): ReportRecord {
  return { id: String(row.id), sessionId: String(row.session_id), version: Number(row.version), snapshotId: nullableString(row.snapshot_id), result: row.result_json == null ? null : parse(row.result_json), content: row.content_json == null ? null : parse(row.content_json), libraryVersion: String(row.library_version), rulesVersion: nullableString(row.rules_version), tariffsVersion: nullableString(row.tariffs_version), templateVersion: nullableString(row.template_version), contentHash: nullableString(row.content_hash), pdfHash: nullableString(row.pdf_hash), status: row.status as ReportRecord['status'], kvKey: nullableString(row.kv_key), prepareDeadline: nullableNumber(row.prepare_deadline), reportExpiresAt: nullableNumber(row.report_expires_at), publishedAt: nullableNumber(row.published_at), failedAt: nullableNumber(row.failed_at), errorCode: nullableString(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), outcome: (nullableString(row.outcome) as ReportRecord['outcome']) ?? null, review: row.review_json == null ? null : parse(row.review_json) };
}
function jobRow(row: Row): AuditJob {
  return { id: String(row.id), sessionId: String(row.session_id), reportId: String(row.report_id), reportVersion: Number(row.report_version), stage: row.stage as AuditJob['stage'], state: row.state as AuditJob['state'], attempts: parse(row.attempts_json), nextAttemptAt: Number(row.next_attempt_at), leaseToken: nullableString(row.lease_token), leaseExpiresAt: nullableNumber(row.lease_expires_at), errorCode: nullableString(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function emailRow(row: Row): EmailJob {
  return { id: String(row.id), sessionId: String(row.session_id), reportId: String(row.report_id), operationId: String(row.operation_id), requestHash: nullableString(row.request_hash), recipient: String(row.recipient), consent: parse(row.consent_json), status: row.status as EmailJob['status'], nextAttemptAt: Number(row.next_attempt_at), leaseToken: nullableString(row.lease_token), leaseExpiresAt: nullableNumber(row.lease_expires_at), attempts: Number(row.attempts), smtpStartedAt: nullableNumber(row.smtp_started_at), outcome: nullableString(row.outcome), errorCode: nullableString(row.error_code), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function callRow(row: Row): VoiceCall {
  return { id: String(row.id), sessionId: String(row.session_id), slotId: String(row.slot_id), providerCallId: nullableString(row.provider_call_id), previousCallId: nullableString(row.previous_call_id), channelRevision: Number(row.channel_revision), status: row.status as VoiceCall['status'], reservedMs: Number(row.reserved_ms), startedAt: nullableNumber(row.started_at), endedAt: nullableNumber(row.ended_at), usedMs: Number(row.used_ms), historyStatus: String(row.history_status), operationId: String(row.operation_id), createdAt: Number(row.created_at), stoppedRevision: nullableNumber(row.stopped_revision) };
}

export function elapsedMs(state: AuditState, now: number): number {
  return Math.min(INTERVIEW_BUDGET_MS, state.elapsed_ms + (state.active_channel !== 'voice' || state.active_since === null ? 0 : Math.max(0, now - state.active_since)));
}

/** Each dependent statement checks the winning revision AND a fresh batch nonce.
 * A zero-row UPDATE is successful SQL, so batch() alone is not a CAS guard.
 */
export class D1Store {
  readonly db: D1Database;
  constructor(db: D1Database) { this.db = db; }
  private stmt(sql: string, ...values: unknown[]): D1PreparedStatement { return this.db.prepare(sql).bind(...values); }

  async createSession(input: CreateSessionInput): Promise<StoredSession> {
    const { id, tokenHash, reportId, reportTokenHash, state, now } = input;
    if (state.revision !== 0 || state.status !== 'in_progress') throw new StoreError('invalid_initial_state', 'Invalid initial session', 400);
    await this.db.batch([
      this.stmt(`INSERT INTO audit_sessions(id,access_token_hash,created_at,access_expires_at,library_version,revision,channel_revision,status,active_channel,active_started_at,used_ms,current_question_id,state_json,mutation_nonce,updated_at) VALUES(?,?,?,?,?,0,0,'in_progress',?,?,?,?,?,?,?)`, id, tokenHash, now, now + SESSION_LIFETIME_MS, state.library_version, state.active_channel, state.active_since, state.elapsed_ms, state.current_question_id, stringify(state), crypto.randomUUID(), now),
      this.stmt(`INSERT INTO reports(id,session_id,version,library_version,status,created_at,updated_at) VALUES(?,?,1,?,'in_progress',?,?)`, reportId, id, state.library_version, now, now),
      this.stmt(`INSERT INTO report_access_tokens(token_hash,report_id,purpose,created_at) VALUES(?,?,'browser',?)`, reportTokenHash, reportId, now),
    ]);
    return (await this.getSession(id))!;
  }

  async getSession(id: string): Promise<StoredSession | null> {
    const row = await this.stmt(`SELECT s.*,r.id report_id FROM audit_sessions s JOIN reports r ON r.session_id=s.id AND r.version=1 WHERE s.id=?`, id).first<Row>();
    return row ? sessionRow(row) : null;
  }
  async requireSession(id: string): Promise<StoredSession> {
    const session = await this.getSession(id);
    if (!session) throw new StoreError('session_not_found', 'Session not found', 404);
    return session;
  }
  async authenticateSession(id: string, tokenHash: string, now: number): Promise<StoredSession | null> {
    const row = await this.stmt(`SELECT s.*,r.id report_id FROM audit_sessions s JOIN reports r ON r.session_id=s.id AND r.version=1 WHERE s.id=? AND s.access_token_hash=? AND s.access_expires_at>?`, id, tokenHash, now).first<Row>();
    return row ? sessionRow(row) : null;
  }
  async listAnswers(sessionId: string): Promise<AuditAnswer[]> {
    const result = await this.stmt(`SELECT answer_json FROM audit_answers WHERE session_id=? ORDER BY event_seq,created_at,id`, sessionId).all<Row>();
    return result.results.map(row => parse<AuditAnswer>(row.answer_json));
  }
  async listEvents(sessionId: string, afterSeq = 0, limit = 500): Promise<AuditEvent[]> {
    const result = await this.stmt(`SELECT payload_json,seq FROM audit_events WHERE session_id=? AND seq>? ORDER BY seq LIMIT ?`, sessionId, afterSeq, Math.max(1, Math.min(limit, 1000))).all<Row>();
    return result.results.map(row => ({ ...parse<AuditEvent>(row.payload_json), seq: Number(row.seq) }));
  }
  /** Assistant texts of the latest committed chat turns, oldest first; only used so wording does not repeat itself. */
  async recentReplies(sessionId: string, limit = 4): Promise<string[]> {
    const result = await this.stmt(`SELECT result_json FROM audit_events WHERE session_id=? AND source='chat' AND result_json IS NOT NULL ORDER BY seq DESC LIMIT ?`, sessionId, Math.max(1, Math.min(limit, 20))).all<Row>();
    return result.results.flatMap(row => {
      const value = parse<Json>(row.result_json);
      return value && typeof value === 'object' && !Array.isArray(value) && typeof value.text === 'string' && value.text.trim() ? [value.text] : [];
    }).reverse();
  }
  async getOperation(sessionId: string, operationId: string): Promise<{ result: Json; event: AuditEvent; requestHash: string | null } | null> {
    const row = await this.stmt(`SELECT payload_json,result_json,seq,request_hash FROM audit_events WHERE session_id=? AND operation_id=?`, sessionId, operationId).first<Row>();
    return row ? { result: row.result_json == null ? null : parse<Json>(row.result_json), event: { ...parse<AuditEvent>(row.payload_json), seq: Number(row.seq) }, requestHash: nullableString(row.request_hash) } : null;
  }

  async commit(input: CommitInput): Promise<MutationResult> { return this.mutate(input, 'commit'); }
  async finish(input: CommitInput & { reason: string }): Promise<MutationResult> { return this.mutate(input, 'finish', input.reason); }

  private async mutate(input: CommitInput, action: 'commit' | 'finish' | 'pause' | 'channel' | 'recovery' | 'evidence', reason?: string): Promise<MutationResult> {
    const current = await this.requireSession(input.sessionId);
    const previous = await this.getOperation(input.sessionId, input.operationId);
    if (previous) { assertRequestHash(previous.requestHash, input.requestHash); return { kind: 'duplicate', session: current, result: previous.result }; }
    const sourceDuplicate = await this.stmt(`SELECT result_json,operation_id,request_hash FROM audit_events WHERE session_id=? AND source=? AND source_event_key=? AND source_revision=?`, input.sessionId, input.event.source, input.event.source_key, input.event.source_revision).first<Row>();
    if (sourceDuplicate) {
      if (sourceDuplicate.operation_id === input.operationId) assertRequestHash(nullableString(sourceDuplicate.request_hash), input.requestHash);
      return { kind: 'duplicate', session: current, result: parse(sourceDuplicate.result_json) };
    }
    const state = current.state;
    if (action === 'finish' && state.status !== 'in_progress') return { kind: 'duplicate', session: current };
    if (state.revision !== input.expectedRevision || state.channel_revision !== input.channelRevision) return { kind: 'conflict', session: current };
    if (state.status !== 'in_progress' && !(action === 'recovery' && state.status === 'closing') && action !== 'evidence') throw new StoreError('session_closed', 'Interview is closed');
    if (action !== 'recovery' && action !== 'evidence' && current.accessExpiresAt <= input.now && action !== 'finish') throw new StoreError('session_expired', 'Session access has expired', 401);
    if (input.state.library_version !== state.library_version) throw new StoreError('library_mismatch', 'Pinned library cannot change');
    if (action === 'commit') {
      if ((input.event.source === 'chat' || input.event.source === 'voice') && input.event.source !== state.active_channel) throw new StoreError('channel_mismatch', 'Event belongs to an inactive channel');
      if ((input.answers?.length ?? 0) > 0 && state.paused) throw new StoreError('session_paused', 'Resume the interview before accepting answers');
      if ((input.answers ?? []).some(answer => answer.channel !== state.active_channel)) throw new StoreError('channel_mismatch', 'Answer belongs to an inactive channel');
      if (input.event.call_id) {
        const call = await this.getCall(input.event.call_id);
        if (!call || call.sessionId !== current.id || call.channelRevision !== state.channel_revision || call.id !== current.activeCallId) throw new StoreError('call_mismatch', 'Call does not own the active channel', 403);
      }
    }
    const used = elapsedMs(state, input.now);
    if (used >= INTERVIEW_BUDGET_MS && action !== 'finish' && action !== 'recovery' && action !== 'evidence') throw new StoreError('time_limit', 'Interview time is exhausted');
    if ((input.answers?.length ?? 0) > 50) throw new StoreError('batch_too_large', 'Too many answers in a batch', 413);
    const nonce = crypto.randomUUID();
    const next = structuredClone(action === 'evidence' ? state : input.state);
    next.revision = state.revision + 1;
    next.channel_revision = state.channel_revision + (action === 'channel' ? 1 : 0);
    next.through_seq = state.through_seq + 1;
    next.elapsed_ms = used;
    next.active_channel = action === 'channel' ? input.state.active_channel : state.active_channel;
    next.active_since = action === 'pause' ? null : action === 'finish' ? (state.active_channel === 'voice' && current.activeCallId && state.active_since !== null ? input.now : null) : action === 'channel' ? null : (state.active_channel === 'voice' && state.active_since !== null ? input.now : null);
    next.paused = action === 'pause' ? true : action === 'channel' ? next.active_channel === 'voice' : action === 'finish' ? next.active_since === null : state.paused;
    next.status = action === 'finish' ? 'closing' : state.status;
    next.finish_reason = action === 'finish' ? reason ?? 'visitor_request' : state.finish_reason;
    if (action === 'recovery') next.extracted_through_seq = Math.max(state.extracted_through_seq, Math.min(input.state.extracted_through_seq, state.through_seq));
    const event = { ...input.event, seq: next.through_seq, received_at: input.now };
    const result = input.result ?? { revision: next.revision, channel_revision: next.channel_revision, status: next.status };
    const guard = `EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND revision=? AND mutation_nonce=?)`;
    const ownership = [current.id, next.revision, nonce];
    const batch = [this.stmt(`UPDATE audit_sessions SET revision=?,channel_revision=?,status=?,active_channel=?,active_started_at=?,used_ms=?,current_question_id=?,state_json=?,last_seq=?,extracted_through_seq=?,finish_operation_id=CASE WHEN ?='finish' THEN ? ELSE finish_operation_id END,finish_reason=?,closed_at=CASE WHEN ?='finish' THEN ? ELSE closed_at END,mutation_nonce=?,updated_at=? WHERE id=? AND revision=? AND channel_revision=? AND status=? AND NOT EXISTS(SELECT 1 FROM audit_events WHERE session_id=? AND (operation_id=? OR (source=? AND source_event_key=? AND source_revision=?)))`, next.revision, next.channel_revision, next.status, next.active_channel, next.active_since, next.elapsed_ms, next.current_question_id, stringify(next), next.through_seq, next.extracted_through_seq, action, input.operationId, next.finish_reason, action, input.now, nonce, input.now, current.id, input.expectedRevision, input.channelRevision, state.status, current.id, input.operationId, event.source, event.source_key, event.source_revision),
      this.stmt(`INSERT INTO audit_events(id,session_id,seq,source,source_event_key,source_revision,source_order,call_id,role,type,payload_json,source_timestamp,received_at,operation_id,result_json,request_hash) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`, event.id, current.id, next.through_seq, event.source, event.source_key, event.source_revision, event.local_order, event.call_id ?? null, event.role, event.kind, stringify(event), event.occurred_at, input.now, input.operationId, stringify(result), input.requestHash ?? null, ...ownership),
    ];
    for (const answer of input.answers ?? []) {
      if (action === 'evidence') throw new StoreError('late_answers', 'Late evidence cannot directly change answers', 400);
      if (answer.library_version !== state.library_version) throw new StoreError('library_mismatch', 'Answer library differs from the session', 400);
      if (event.kind === 'service' || event.kind === 'delivery') throw new StoreError('service_answer', 'Service events cannot create diagnostic answers', 400);
      if (!answer.event_ids.length) throw new StoreError('missing_evidence', 'Answer must reference an event', 400);
      for (const id of answer.event_ids) {
        if (id !== event.id && !(await this.stmt(`SELECT 1 found FROM audit_events WHERE id=? AND session_id=?`, id, current.id).first())) throw new StoreError('missing_evidence', 'Evidence does not belong to this session', 400);
      }
      if (answer.replaces_answer_id && !(await this.stmt(`SELECT 1 found FROM audit_answers WHERE id=? AND session_id=?`, answer.replaces_answer_id, current.id).first())) throw new StoreError('invalid_correction', 'Replaced answer does not belong to this session', 400);
      batch.push(this.stmt(`INSERT INTO audit_answers(id,session_id,question_id,answer_id,status,answer_json,replaces_answer_id,library_version,event_seq,created_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${guard}`, answer.id, current.id, answer.question_id, answer.answer_id ?? null, answer.state, stringify(answer), answer.replaces_answer_id ?? null, answer.library_version, next.through_seq, answer.created_at, ...ownership));
    }
    if (action === 'finish') {
      batch.push(this.stmt(`UPDATE reports SET status='closing',prepare_deadline=?,updated_at=? WHERE id=? AND ${guard}`, input.now + REPORT_PREPARATION_MS, input.now, current.reportId, ...ownership));
      batch.push(this.stmt(`INSERT INTO audit_jobs(id,session_id,report_id,report_version,stage,state,next_attempt_at,created_at,updated_at) SELECT ?,?,?,1,'reconcile','pending',?,?,? WHERE ${guard}`, `audit:${current.reportId}:1`, current.id, current.reportId, input.now, input.now, input.now, ...ownership));
    }
    const outcomes = await this.db.batch(batch);
    const latest = await this.requireSession(current.id);
    if (!changed(outcomes[0]!)) {
      const duplicate = await this.getOperation(current.id, input.operationId);
      if (duplicate) { assertRequestHash(duplicate.requestHash, input.requestHash); return { kind: 'duplicate', session: latest, result: duplicate.result }; }
      const source = await this.stmt(`SELECT result_json,operation_id,request_hash FROM audit_events WHERE session_id=? AND source=? AND source_event_key=? AND source_revision=?`, input.sessionId, input.event.source, input.event.source_key, input.event.source_revision).first<Row>();
      if (source?.operation_id === input.operationId) assertRequestHash(nullableString(source.request_hash), input.requestHash);
      return source ? { kind: 'duplicate', session: latest, result: parse(source.result_json) } : { kind: 'conflict', session: latest };
    }
    return { kind: 'accepted', session: latest, result };
  }

  async changeChannel(input: ChangeChannelInput): Promise<MutationResult> {
    const session = await this.requireSession(input.sessionId);
    const old = await this.getOperation(input.sessionId, input.operationId);
    if (old) { assertRequestHash(old.requestHash, input.requestHash); return { kind: 'duplicate', session, result: old.result }; }
    if (session.activeCallId) {
      const call = await this.getCall(session.activeCallId);
      if (call && !['stopped', 'failed'].includes(call.status)) throw new StoreError('channel_stop_pending', 'Wait for confirmed voice disconnection');
    }
    const event = this.systemEvent(input.operationId, 'channel', input.now);
    return this.mutate({ ...input, state: { ...session.state, active_channel: input.channel }, event }, 'channel');
  }
  async pause(input: Omit<ChangeChannelInput, 'channel'>): Promise<MutationResult> {
    const session = await this.requireSession(input.sessionId);
    const old = await this.getOperation(input.sessionId, input.operationId);
    if (old) { assertRequestHash(old.requestHash, input.requestHash); return { kind: 'duplicate', session, result: old.result }; }
    if (session.activeCallId) {
      const call = await this.getCall(session.activeCallId);
      if (call && !['stopped', 'failed'].includes(call.status)) throw new StoreError('channel_stop_pending', 'Confirm voice disconnection before pausing');
    }
    return this.mutate({ ...input, state: session.state, event: this.systemEvent(input.operationId, 'channel', input.now) }, 'pause');
  }
  async commitRecovery(input: CommitInput): Promise<MutationResult> { return this.mutate(input, 'recovery'); }
  async appendLateEvent(input: Omit<CommitInput, 'answers' | 'state'>): Promise<MutationResult> {
    const session = await this.requireSession(input.sessionId);
    if (input.event.call_id) {
      const call = await this.getCall(input.event.call_id);
      if (!call || call.sessionId !== input.sessionId) throw new StoreError('call_mismatch', 'Call does not belong to session', 403);
    }
    return this.mutate({ ...input, state: session.state }, 'evidence');
  }
  private systemEvent(key: string, kind: AuditEvent['kind'], now: number): AuditEvent {
    return { id: crypto.randomUUID(), source: 'system', source_key: key, source_revision: 0, local_order: 0, role: 'system', kind, occurred_at: now, received_at: now };
  }

  async getReport(id: string): Promise<ReportRecord | null> {
    const row = await this.stmt(`SELECT * FROM reports WHERE id=?`, id).first<Row>(); return row ? reportRow(row) : null;
  }
  async findReportByTokenHash(hash: string, now: number): Promise<ReportRecord | null> {
    const row = await this.stmt(`SELECT r.* FROM reports r JOIN report_access_tokens t ON t.report_id=r.id JOIN audit_sessions s ON s.id=r.session_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND CASE WHEN r.published_at IS NOT NULL THEN r.report_expires_at>? WHEN r.status='failed' THEN r.failed_at+86400000>? WHEN r.prepare_deadline IS NOT NULL THEN r.prepare_deadline>? ELSE s.access_expires_at>? END`, hash, now, now, now, now).first<Row>();
    return row ? reportRow(row) : null;
  }
  async lookupReportToken(hash: string): Promise<ReportRecord | null> {
    const row = await this.stmt(`SELECT r.* FROM reports r JOIN report_access_tokens t ON t.report_id=r.id WHERE t.token_hash=? AND t.revoked_at IS NULL`, hash).first<Row>();
    return row ? reportRow(row) : null;
  }
  async addReportAccessToken(reportId: string, hash: string, purpose: 'browser' | 'email', now: number): Promise<boolean> {
    const result = await this.stmt(`INSERT INTO report_access_tokens(token_hash,report_id,purpose,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM reports WHERE id=? AND status='ready' AND report_expires_at>?)`, hash, reportId, purpose, now, reportId, now).run(); return changed(result);
  }
  async getSnapshot(id: string): Promise<AuditSnapshot | null> {
    const row = await this.stmt(`SELECT snapshot_json FROM audit_snapshots WHERE id=?`, id).first<Row>(); return row ? parse(row.snapshot_json) : null;
  }
  async getJob(id: string): Promise<AuditJob | null> {
    const row = await this.stmt(`SELECT * FROM audit_jobs WHERE id=?`, id).first<Row>(); return row ? jobRow(row) : null;
  }
  /** Only an explicitly controlled repair may reopen an existing published report. GET never calls this. */
  async reopenRenderJob(reportId: string, now: number): Promise<boolean> {
    const report = await this.getReport(reportId);
    if (!report || report.content === null || report.publishedAt === null || (report.reportExpiresAt ?? 0) <= now) return false;
    const session = await this.requireSession(report.sessionId);
    const nonce = crypto.randomUUID();
    const state = { ...session.state, revision: session.state.revision + 1, status: 'preparing' as const };
    const guard = `EXISTS(SELECT 1 FROM audit_jobs WHERE report_id=? AND mutation_nonce=?)`;
    const result = await this.db.batch([
      this.stmt(`UPDATE audit_jobs SET stage='render',state='retry_wait',next_attempt_at=?,lease_token=NULL,lease_expires_at=NULL,error_code=NULL,mutation_nonce=?,updated_at=? WHERE report_id=? AND state IN ('done','failed') AND json_extract(attempts_json,'$.render')<3 AND EXISTS(SELECT 1 FROM reports WHERE id=? AND content_json IS NOT NULL AND published_at IS NOT NULL AND report_expires_at>?) AND EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND revision=?)`, now, nonce, now, reportId, reportId, now, session.id, session.state.revision),
      this.stmt(`UPDATE reports SET status='preparing',error_code=NULL,updated_at=? WHERE id=? AND ${guard}`, now, reportId, reportId, nonce),
      this.stmt(`UPDATE audit_sessions SET status='preparing',state_json=?,revision=?,updated_at=? WHERE id=? AND ${guard}`, stringify(state), state.revision, now, session.id, reportId, nonce),
    ]); return changed(result[0]!);
  }
  async listDueJobs(now: number, limit = 10): Promise<AuditJob[]> {
    const rows = await this.stmt(`SELECT * FROM audit_jobs WHERE (state IN ('pending','retry_wait') AND next_attempt_at<=?) OR (state='running' AND lease_expires_at<=?) ORDER BY created_at LIMIT ?`, now, now, Math.min(limit, 100)).all<Row>(); return rows.results.map(jobRow);
  }
  async claimJob(id: string, leaseToken: string, now: number, leaseMs: number): Promise<AuditJob | null> {
    if (leaseMs <= 0) throw new StoreError('invalid_lease', 'Lease must be positive', 400);
    const result = await this.stmt(`UPDATE audit_jobs SET state='running',lease_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND ((state IN ('pending','retry_wait') AND next_attempt_at<=?) OR (state='running' AND lease_expires_at<=?))`, leaseToken, now + leaseMs, now, id, now, now).run();
    return changed(result) ? this.getJob(id) : null;
  }

  async checkpointJob(id: string, leaseToken: string, now: number, patch: CheckpointInput): Promise<boolean> {
    if (patch.snapshot && patch.expectedSessionRevision === undefined) throw new StoreError('missing_revision', 'Snapshot requires the reconciled session revision', 400);
    const job = await this.getJob(id);
    if (!job || job.state !== 'running' || job.leaseToken !== leaseToken || (job.leaseExpiresAt ?? 0) <= now) return false;
    const report = await this.getReport(job.reportId);
    if (!report) return false;
    const state = patch.state ?? 'running';
    const p = patch.reportPatch;
    const sessionToUpdate = p?.status || patch.sessionState ? await this.requireSession(job.sessionId) : null;
    const sessionRevision = patch.expectedSessionRevision ?? sessionToUpdate?.state.revision;
    const sessionGuard = sessionRevision === undefined ? '' : ` AND EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND revision=?)`;
    const sessionArgs = sessionRevision === undefined ? [] : [job.sessionId, sessionRevision];
    const nonce = crypto.randomUUID();
    const contentGuard = p?.content !== undefined || p?.result !== undefined ? ` AND EXISTS(SELECT 1 FROM reports WHERE id=? AND content_json IS NULL)` : '';
    const contentArgs = contentGuard ? [job.reportId] : [];
    const guard = `EXISTS(SELECT 1 FROM audit_jobs WHERE id=? AND lease_token=? AND state='running' AND lease_expires_at>? AND mutation_nonce=?)`;
    const args = [id, leaseToken, now, nonce];
    // The first write acquires this exact checkpoint. All subsequent writes share its nonce.
    const batch: D1PreparedStatement[] = [this.stmt(`UPDATE audit_jobs SET mutation_nonce=? WHERE id=? AND lease_token=? AND state='running' AND lease_expires_at>? AND stage=? AND attempts_json=? AND updated_at=?${sessionGuard}${contentGuard}`, nonce, id, leaseToken, now, job.stage, stringify(job.attempts), job.updatedAt, ...sessionArgs, ...contentArgs)];
    if (patch.snapshot) {
      const snapshot = patch.snapshot.data;
      if (snapshot.session_id !== job.sessionId || snapshot.library_version !== report.libraryVersion) throw new StoreError('snapshot_mismatch', 'Snapshot identity mismatch', 400);
      batch.push(this.stmt(`INSERT INTO audit_snapshots(id,session_id,report_version,library_version,through_seq,hash,snapshot_json,created_at) SELECT ?,?,?,?,?,?,?,? WHERE ${guard} AND NOT EXISTS(SELECT 1 FROM audit_snapshots WHERE session_id=? AND report_version=?)`, snapshot.id, job.sessionId, job.reportVersion, snapshot.library_version, snapshot.through_seq, patch.snapshot.hash, stringify(snapshot), now, ...args, job.sessionId, job.reportVersion));
    }
    if (p) {
      if ((p.content !== undefined || p.result !== undefined) && report.content !== null) throw new StoreError('content_immutable', 'Saved report content cannot be replaced');
      if (p.content !== undefined && new TextEncoder().encode(stringify(p.content)).byteLength > 512000) throw new StoreError('content_too_large', 'Report content exceeds the storage bound', 413);
      const columns: Record<string, string> = { snapshotId: 'snapshot_id', result: 'result_json', content: 'content_json', rulesVersion: 'rules_version', tariffsVersion: 'tariffs_version', templateVersion: 'template_version', contentHash: 'content_hash', pdfHash: 'pdf_hash', status: 'status', kvKey: 'kv_key', reportExpiresAt: 'report_expires_at', publishedAt: 'published_at', failedAt: 'failed_at', errorCode: 'error_code', outcome: 'outcome', review: 'review_json' };
      const assignments: string[] = []; const values: unknown[] = [];
      for (const [key, value] of Object.entries(p)) {
        const col = columns[key]; if (!col) throw new StoreError('invalid_patch', 'Invalid report field', 400);
        assignments.push(`${col}=${key === 'reportExpiresAt' || key === 'publishedAt' ? `COALESCE(${col},?)` : '?'}`);
        values.push(key === 'result' || key === 'content' || key === 'review' ? stringify(value) : value);
      }
      if (assignments.length) batch.push(this.stmt(`UPDATE reports SET ${assignments.join(',')},updated_at=? WHERE id=? AND ${guard}`, ...values, now, job.reportId, ...args));
    }
    const attempts = { ...job.attempts };
    if (patch.incrementAttempt) { attempts[patch.incrementAttempt] = (attempts[patch.incrementAttempt] ?? 0) + 1; if (patch.incrementAttempt === 'render' && attempts.render > 3) throw new StoreError('render_attempts_exhausted', 'Render attempt limit reached'); }
    if (p?.status || patch.sessionState) {
      const current = sessionToUpdate!;
      const sessionState = patch.sessionState ?? current.state;
      const next = { ...sessionState, status: p?.status ?? sessionState.status, revision: current.state.revision + 1 };
      batch.push(this.stmt(`UPDATE audit_sessions SET status=?,state_json=?,revision=?,extracted_through_seq=?,updated_at=? WHERE id=? AND ${guard}`, next.status, stringify(next), next.revision, next.extracted_through_seq, now, job.sessionId, ...args));
    }
    // Keep the lease guard live until the final statement, including all dependent writes.
    batch.push(this.stmt(`UPDATE audit_jobs SET stage=?,state=?,attempts_json=?,next_attempt_at=?,error_code=?,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND lease_token=? AND state='running' AND lease_expires_at>? AND mutation_nonce=?`, patch.stage ?? job.stage, state, stringify(attempts), patch.nextAttemptAt ?? job.nextAttemptAt, patch.errorCode ?? null, state === 'running' ? leaseToken : null, state === 'running' ? (patch.leaseMs ? now + patch.leaseMs : job.leaseExpiresAt) : null, now, id, leaseToken, now, nonce));
    const results = await this.db.batch(batch);
    return changed(results[results.length - 1]!);
  }

  async getExistingEmail(sessionId: string, operationId: string, requestHash?: string): Promise<EmailJob | null> {
    const row = await this.stmt(`SELECT * FROM email_jobs WHERE session_id=? AND operation_id=?`, sessionId, operationId).first<Row>();
    if (!row) return null;
    const job = emailRow(row);
    assertRequestHash(job.requestHash, requestHash);
    return job;
  }
  async enqueueEmail(input: EnqueueEmailInput): Promise<{ kind: 'accepted' | 'duplicate' | 'rejected'; job: EmailJob | null }> {
    const old = await this.getExistingEmail(input.sessionId, input.operationId, input.requestHash);
    if (old) return { kind: 'duplicate', job: old };
    const result = await this.stmt(`INSERT INTO email_jobs(id,session_id,report_id,operation_id,recipient,consent_json,status,next_attempt_at,created_at,updated_at,request_hash) SELECT ?,?,?,?,?,?,'pending',?,?,?,? WHERE EXISTS(SELECT 1 FROM reports r JOIN audit_sessions s ON s.id=r.session_id WHERE r.id=? AND s.id=? AND r.status='ready' AND r.report_expires_at>? AND s.access_expires_at>?) AND (SELECT COUNT(*) FROM email_jobs WHERE session_id=?)<2 AND NOT EXISTS(SELECT 1 FROM email_jobs WHERE session_id=? AND operation_id=?)`, input.id, input.sessionId, input.reportId, input.operationId, input.recipient, stringify(input.consent), input.now, input.now, input.now, input.requestHash ?? null, input.reportId, input.sessionId, input.now, input.now, input.sessionId, input.sessionId, input.operationId).run();
    const job = await this.getExistingEmail(input.sessionId, input.operationId, input.requestHash);
    return { kind: changed(result) ? 'accepted' : job ? 'duplicate' : 'rejected', job };
  }
  async getEmail(id: string): Promise<EmailJob | null> { const row = await this.stmt(`SELECT * FROM email_jobs WHERE id=?`, id).first<Row>(); return row ? emailRow(row) : null; }
  async listDueEmails(now: number, limit = 10): Promise<EmailJob[]> {
    const rows = await this.stmt(`SELECT * FROM email_jobs WHERE status='pending' AND next_attempt_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?) ORDER BY created_at LIMIT ?`, now, now, Math.min(limit, 100)).all<Row>(); return rows.results.map(emailRow);
  }
  async claimEmail(id: string, leaseToken: string, now: number, leaseMs: number): Promise<EmailJob | null> {
    const result = await this.stmt(`UPDATE email_jobs SET lease_token=?,lease_expires_at=?,updated_at=? WHERE id=? AND status='pending' AND next_attempt_at<=? AND (lease_expires_at IS NULL OR lease_expires_at<=?)`, leaseToken, now + leaseMs, now, id, now, now).run(); return changed(result) ? this.getEmail(id) : null;
  }
  async markEmailSending(id: string, leaseToken: string, now: number): Promise<boolean> {
    const result = await this.stmt(`UPDATE email_jobs SET status='sending',smtp_started_at=?,attempts=attempts+1,updated_at=? WHERE id=? AND status='pending' AND lease_token=? AND lease_expires_at>?`, now, now, id, leaseToken, now).run(); return changed(result);
  }
  async checkpointEmail(id: string, leaseToken: string, now: number, patch: { status: EmailJob['status']; nextAttemptAt?: number; errorCode?: string | null; outcome?: string | null }): Promise<boolean> {
    const allowed = patch.status === 'pending' ? "status='pending'" : "status IN ('pending','sending')";
    const result = await this.stmt(`UPDATE email_jobs SET status=?,next_attempt_at=COALESCE(?,next_attempt_at),error_code=?,outcome=?,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND lease_token=? AND lease_expires_at>? AND ${allowed}`, patch.status, patch.nextAttemptAt ?? null, patch.errorCode ?? null, patch.outcome ?? null, now, id, leaseToken, now).run(); return changed(result);
  }
  async recoverExpiredSending(now: number, limit = 20): Promise<number> {
    const result = await this.stmt(`UPDATE email_jobs SET status='unknown',error_code='smtp_outcome_unknown',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id IN(SELECT id FROM email_jobs WHERE status='sending' AND lease_expires_at<=? ORDER BY lease_expires_at LIMIT ?)`, now, now, Math.min(limit, 100)).run(); return result.meta.changes;
  }

  async reserveUsage(input: UsageReservationInput): Promise<UsageReservation | null> {
    if (!Number.isFinite(input.limit) || input.limit <= 0 || !Number.isFinite(input.amount) || input.amount <= 0) return null;
    const old = await this.getUsageReservation(input.id);
    if (old) { if (old.period !== input.period || old.kind !== input.kind || old.amount !== input.amount) throw new StoreError('reservation_mismatch', 'Reservation key was reused'); return { ...old, newlyCreated: false }; }
    const nonce = crypto.randomUUID();
    const outcomes = await this.db.batch([
      this.stmt(`INSERT INTO usage_counters(period,kind,used,reserved,next_allowed_at,expires_at) VALUES(?,?,0,0,0,?) ON CONFLICT(period,kind) DO NOTHING`, input.period, input.kind, input.expiresAt),
      this.stmt(`UPDATE usage_counters SET reserved=reserved+?,next_allowed_at=?,mutation_nonce=? WHERE period=? AND kind=? AND used+reserved+?<=? AND next_allowed_at<=? AND NOT EXISTS(SELECT 1 FROM usage_reservations WHERE id=?) AND NOT EXISTS(SELECT 1 FROM usage_counters WHERE kind=? AND next_allowed_at>?)`, input.amount, input.now + (input.minIntervalMs ?? 0), nonce, input.period, input.kind, input.amount, input.limit, input.now, input.id, input.kind, input.now),
      this.stmt(`INSERT INTO usage_reservations(id,period,kind,amount,state,created_at) SELECT ?,?,?,?,'reserved',? WHERE EXISTS(SELECT 1 FROM usage_counters WHERE period=? AND kind=? AND mutation_nonce=?)`, input.id, input.period, input.kind, input.amount, input.now, input.period, input.kind, nonce),
    ]);
    const reserved = await this.getUsageReservation(input.id);
    if (reserved && (reserved.period !== input.period || reserved.kind !== input.kind || reserved.amount !== input.amount)) throw new StoreError('reservation_mismatch', 'Reservation key was reused');
    return reserved ? { ...reserved, newlyCreated: changed(outcomes[1]!) } : null;
  }
  async getUsageReservation(id: string): Promise<UsageReservation | null> {
    const row = await this.stmt(`SELECT * FROM usage_reservations WHERE id=?`, id).first<Row>();
    return row ? { id: String(row.id), period: String(row.period), kind: String(row.kind), amount: Number(row.amount), state: row.state as UsageReservation['state'], actual: nullableNumber(row.actual), createdAt: Number(row.created_at), settledAt: nullableNumber(row.settled_at) } : null;
  }
  async settleUsage(id: string, actual: number | null, now: number): Promise<boolean> {
    if (actual !== null && (!Number.isFinite(actual) || actual < 0)) throw new StoreError('invalid_usage', 'Invalid measured usage', 400);
    const reservation = await this.getUsageReservation(id); if (!reservation || !['reserved', 'unknown'].includes(reservation.state)) return false;
    if (actual === null) { const result = await this.stmt(`UPDATE usage_reservations SET state='unknown' WHERE id=? AND state='reserved'`, id).run(); return changed(result); }
    const nonce = crypto.randomUUID();
    const results = await this.db.batch([
      this.stmt(`UPDATE usage_reservations SET state=?,actual=?,settled_at=?,mutation_nonce=? WHERE id=? AND state IN ('reserved','unknown')`, actual === 0 ? 'released' : 'settled', actual, now, nonce, id),
      this.stmt(`UPDATE usage_counters SET reserved=MAX(0,reserved-?),used=used+? WHERE period=? AND kind=? AND EXISTS(SELECT 1 FROM usage_reservations WHERE id=? AND mutation_nonce=?)`, reservation.amount, actual, reservation.period, reservation.kind, id, nonce),
    ]); return changed(results[0]!);
  }

  async getCall(id: string): Promise<VoiceCall | null> { const row = await this.stmt(`SELECT * FROM ultravox_calls WHERE id=? OR provider_call_id=?`, id, id).first<Row>(); return row ? callRow(row) : null; }
  async listCalls(sessionId: string): Promise<VoiceCall[]> { const rows = await this.stmt(`SELECT * FROM ultravox_calls WHERE session_id=? ORDER BY created_at`, sessionId).all<Row>(); return rows.results.map(callRow); }
  async listPendingCalls(limit = 2): Promise<VoiceCall[]> {
    const rows = await this.stmt(`SELECT * FROM ultravox_calls WHERE status IN ('reserved','active','stopping','unknown') AND provider_call_id IS NOT NULL ORDER BY created_at LIMIT ?`, Math.max(1, Math.min(limit, 10))).all<Row>();
    return rows.results.map(callRow);
  }
  async getRecoveryResult(sessionId: string, callId: string, boundaryHash: string): Promise<Json | null> {
    const row = await this.stmt(`SELECT result_json FROM voice_recovery_results WHERE session_id=? AND call_id=? AND boundary_hash=?`, sessionId, callId, boundaryHash).first<Row>();
    return row ? parse<Json>(row.result_json) : null;
  }
  async putRecoveryResult(input: { sessionId: string; callId: string; boundaryHash: string; reservationId: string; result: Json; now: number }): Promise<boolean> {
    const value = stringify(input.result);
    if (value.length > 512000) throw new StoreError('recovery_result_too_large', 'Recovery result exceeds its limit', 413);
    const result = await this.stmt(`INSERT INTO voice_recovery_results(session_id,call_id,boundary_hash,reservation_id,result_json,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ultravox_calls WHERE id=? AND session_id=?) AND EXISTS(SELECT 1 FROM usage_reservations WHERE id=? AND kind='deepseek_calls' AND state IN ('reserved','settled','unknown')) ON CONFLICT(session_id,call_id,boundary_hash) DO NOTHING`, input.sessionId, input.callId, input.boundaryHash, input.reservationId, value, input.now, input.callId, input.sessionId, input.reservationId).run();
    return changed(result);
  }

  async updateVoiceSlot(input: { id: string; availableMs: number; maxConcurrency: number; now: number; state?: 'available' | 'disabled' | 'cooldown' | 'unknown'; nextAttemptAt?: number; error?: string | null }): Promise<void> {
    if (input.availableMs < 0 || input.maxConcurrency < 1) throw new StoreError('invalid_slot', 'Invalid voice slot limits', 400);
    await this.stmt(`INSERT INTO ultravox_slots(id,state,available_ms,max_concurrency,next_attempt_at,checked_at,last_error) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,available_ms=excluded.available_ms,max_concurrency=excluded.max_concurrency,next_attempt_at=excluded.next_attempt_at,checked_at=excluded.checked_at,last_error=excluded.last_error`, input.id, input.state ?? 'available', input.availableMs, input.maxConcurrency, input.nextAttemptAt ?? 0, input.now, input.error ?? null).run();
  }
  async reserveVoiceCall(input: { id: string; sessionId: string; slotId: string; operationId: string; expectedRevision: number; channelRevision: number; now: number; slotMaxAgeMs: number; configHash?: string; previousCallId?: string }): Promise<VoiceCall | null> {
    const existing = await this.stmt(`SELECT * FROM ultravox_calls WHERE session_id=? AND operation_id=?`, input.sessionId, input.operationId).first<Row>();
    if (existing) return callRow(existing);
    const session = await this.requireSession(input.sessionId);
    const state = session.state;
    if (state.revision !== input.expectedRevision || state.channel_revision !== input.channelRevision || state.active_channel !== 'voice' || state.status !== 'in_progress' || session.accessExpiresAt <= input.now) return null;
    const remaining = INTERVIEW_BUDGET_MS - elapsedMs(state, input.now); if (remaining <= 0) return null;
    if (input.previousCallId) { const prior = await this.getCall(input.previousCallId); if (!prior || prior.sessionId !== input.sessionId || prior.status !== 'stopped') throw new StoreError('invalid_prior_call', 'Prior call does not belong to this session', 400); }
    const nonce = crypto.randomUUID();
    const next = { ...state, revision: state.revision + 1 };
    const guard = `EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND revision=? AND mutation_nonce=?)`;
    const ownership = [session.id, next.revision, nonce];
    const results = await this.db.batch([
      this.stmt(`UPDATE audit_sessions SET revision=?,state_json=?,active_call_id=?,mutation_nonce=?,updated_at=? WHERE id=? AND revision=? AND channel_revision=? AND status='in_progress' AND active_channel='voice' AND access_expires_at>? AND (active_call_id IS NULL OR NOT EXISTS(SELECT 1 FROM ultravox_calls WHERE id=active_call_id AND status IN ('reserved','active','stopping','unknown'))) AND (?='openai' OR (SELECT COUNT(*) FROM ultravox_calls WHERE session_id=?)<2) AND EXISTS(SELECT 1 FROM ultravox_slots WHERE id=? AND state='available' AND checked_at>=? AND next_attempt_at<=? AND active_calls<max_concurrency AND available_ms-reserved_ms>=? AND (? IS NULL OR config_hash=?)) AND NOT EXISTS(SELECT 1 FROM ultravox_calls WHERE session_id=? AND operation_id=?)`, next.revision, stringify(next), input.id, nonce, input.now, session.id, input.expectedRevision, input.channelRevision, input.now, input.slotId, session.id, input.slotId, input.now - input.slotMaxAgeMs, input.now, remaining, input.configHash ?? null, input.configHash ?? null, session.id, input.operationId),
      this.stmt(`UPDATE ultravox_slots SET reserved_ms=reserved_ms+?,active_calls=active_calls+1 WHERE id=? AND ${guard}`, remaining, input.slotId, ...ownership),
      this.stmt(`INSERT INTO ultravox_calls(id,session_id,slot_id,previous_call_id,channel_revision,status,reserved_ms,operation_id,created_at) SELECT ?,?,?,?,?,'reserved',?,?,? WHERE ${guard}`, input.id, session.id, input.slotId, input.previousCallId ?? null, state.channel_revision, remaining, input.operationId, input.now, ...ownership),
    ]);
    if (!changed(results[0]!)) { const row = await this.stmt(`SELECT * FROM ultravox_calls WHERE session_id=? AND operation_id=?`, session.id, input.operationId).first<Row>(); return row ? callRow(row) : null; }
    return this.getCall(input.id);
  }
  async attachCall(id: string, providerCallId: string, now: number): Promise<boolean> {
    const call = await this.getCall(id); if (!call || !['reserved', 'unknown'].includes(call.status)) return false;
    const session = await this.requireSession(call.sessionId);
    if (session.state.status !== 'in_progress') return false;
    const next = { ...session.state, revision: session.state.revision + 1, active_since: now, paused: false };
    const nonce = crypto.randomUUID();
    const results = await this.db.batch([
      this.stmt(`UPDATE audit_sessions SET revision=?,state_json=?,active_started_at=?,mutation_nonce=?,updated_at=? WHERE id=? AND revision=? AND channel_revision=? AND active_call_id=? AND status='in_progress' AND EXISTS(SELECT 1 FROM ultravox_calls WHERE id=? AND status IN ('reserved','unknown'))`, next.revision, stringify(next), now, nonce, now, session.id, session.state.revision, call.channelRevision, call.id, call.id),
      this.stmt(`UPDATE ultravox_calls SET provider_call_id=?,status='active',started_at=? WHERE id=? AND EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND mutation_nonce=?)`, providerCallId, now, call.id, session.id, nonce),
    ]); return changed(results[0]!);
  }
  async markCallUnknown(id: string): Promise<boolean> {
    const result = await this.stmt(`UPDATE ultravox_calls SET status='unknown' WHERE id=? AND status='reserved'`, id).run(); return changed(result);
  }
  async markCallStopping(id: string): Promise<boolean> {
    const result = await this.stmt(`UPDATE ultravox_calls SET status='stopping' WHERE id=? AND status='active'`, id).run(); return changed(result);
  }
  async failCallCreation(id: string, now: number, confirmedNotCreated: true): Promise<boolean> {
    if (confirmedNotCreated !== true) return false;
    const call = await this.getCall(id); if (!call || !['reserved', 'unknown'].includes(call.status)) return false;
    const session = await this.requireSession(call.sessionId);
    const next = { ...session.state, revision: session.state.revision + 1 };
    const nonce = crypto.randomUUID();
    const guard = `EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND mutation_nonce=?)`;
    const results = await this.db.batch([
      this.stmt(`UPDATE audit_sessions SET revision=?,state_json=?,active_call_id=NULL,mutation_nonce=?,updated_at=? WHERE id=? AND revision=? AND active_call_id=? AND EXISTS(SELECT 1 FROM ultravox_calls WHERE id=? AND status IN ('reserved','unknown'))`, next.revision, stringify(next), nonce, now, session.id, session.state.revision, call.id, call.id),
      this.stmt(`UPDATE ultravox_slots SET reserved_ms=MAX(0,reserved_ms-?),active_calls=MAX(0,active_calls-1) WHERE id=? AND ${guard}`, call.reservedMs, call.slotId, session.id, nonce),
      this.stmt(`UPDATE ultravox_calls SET status='failed',ended_at=?,history_status='complete' WHERE id=? AND ${guard}`, now, call.id, session.id, nonce),
    ]); return changed(results[0]!);
  }
  async updateCallHistory(id: string, sessionId: string, historyStatus: 'pending' | 'complete' | 'incomplete'): Promise<boolean> {
    const result = await this.stmt(`UPDATE ultravox_calls SET history_status=? WHERE id=? AND session_id=?`, historyStatus, id, sessionId).run(); return changed(result);
  }
  async confirmCallStopped(id: string, now: number, historyStatus = 'pending'): Promise<boolean> {
    const call = await this.getCall(id); if (!call || ['stopped', 'failed'].includes(call.status)) return false;
    const session = await this.requireSession(call.sessionId);
    const used = call.startedAt === null ? call.reservedMs : Math.min(call.reservedMs, Math.max(0, now - call.startedAt));
    const next = { ...session.state, revision: session.state.revision + 1, elapsed_ms: call.startedAt === null ? Math.min(INTERVIEW_BUDGET_MS, elapsedMs(session.state, now) + used) : elapsedMs(session.state, now), active_since: null, paused: true };
    const nonce = crypto.randomUUID();
    const guard = `EXISTS(SELECT 1 FROM audit_sessions WHERE id=? AND mutation_nonce=?)`;
    const results = await this.db.batch([
      this.stmt(`UPDATE audit_sessions SET revision=?,state_json=?,used_ms=?,active_started_at=NULL,active_call_id=NULL,mutation_nonce=?,updated_at=? WHERE id=? AND revision=? AND active_call_id=? AND EXISTS(SELECT 1 FROM ultravox_calls WHERE id=? AND status NOT IN ('stopped','failed'))`, next.revision, stringify(next), next.elapsed_ms, nonce, now, session.id, session.state.revision, call.id, call.id),
      this.stmt(`UPDATE ultravox_slots SET reserved_ms=MAX(0,reserved_ms-?),available_ms=MAX(0,available_ms-?),active_calls=MAX(0,active_calls-1) WHERE id=? AND ${guard}`, call.reservedMs, used, call.slotId, session.id, nonce),
      this.stmt(`UPDATE ultravox_calls SET status='stopped',ended_at=?,used_ms=?,history_status=?,stopped_revision=? WHERE id=? AND ${guard}`, now, used, historyStatus, next.revision, call.id, session.id, nonce),
    ]); return changed(results[0]!);
  }

  async closeExpiredSessions(now: number, limit = 10): Promise<number> {
    const rows = await this.stmt(`SELECT id FROM audit_sessions WHERE status='in_progress' AND MIN(access_expires_at, CASE WHEN active_channel='voice' AND active_started_at IS NOT NULL THEN active_started_at + ${INTERVIEW_BUDGET_MS} - used_ms ELSE access_expires_at END)<=? ORDER BY MIN(access_expires_at, CASE WHEN active_channel='voice' AND active_started_at IS NOT NULL THEN active_started_at + ${INTERVIEW_BUDGET_MS} - used_ms ELSE access_expires_at END) LIMIT ?`, now, Math.min(limit, 50)).all<Row>();
    let closed = 0;
    for (const row of rows.results) {
      const session = await this.requireSession(String(row.id));
      const operationId = `server-close:${session.id}`;
      const result = await this.finish({ sessionId: session.id, expectedRevision: session.state.revision, channelRevision: session.state.channel_revision, operationId, event: this.systemEvent(operationId, 'finish', now), state: session.state, now, reason: elapsedMs(session.state, now) >= INTERVIEW_BUDGET_MS ? 'time_limit' : 'session_expired' });
      if (result.kind === 'accepted') closed++;
    }
    return closed;
  }
  async cleanup(now: number, limit = 20): Promise<number> {
    const result = await this.stmt(`DELETE FROM audit_sessions WHERE id IN(SELECT session_id FROM reports WHERE published_at IS NOT NULL AND report_expires_at<=? UNION ALL SELECT session_id FROM reports WHERE published_at IS NULL AND status='failed' AND failed_at<=? UNION ALL SELECT id FROM audit_sessions WHERE status='in_progress' AND access_expires_at<=? LIMIT ?)`, now, now - 86400000, now, Math.min(limit, 100)).run();
    await this.stmt(`DELETE FROM usage_counters WHERE (period,kind) IN(SELECT period,kind FROM usage_counters WHERE expires_at<=? AND reserved=0 LIMIT ?)`, now, Math.min(limit, 100)).run();
    return result.meta.changes;
  }
}
