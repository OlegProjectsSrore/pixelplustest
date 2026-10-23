import type { AuditAnswer, AuditEvent, AuditResult, AuditSnapshot, AuditState, Channel, Json, SessionStatus } from '../audit/contracts.ts';

export interface StoredSession {
  id: string; tokenHash: string; createdAt: number; accessExpiresAt: number;
  state: AuditState; activeCallId: string | null; reportId: string; closedAt: number | null;
}
export interface CreateSessionInput {
  id: string; tokenHash: string; reportId: string; reportTokenHash: string; state: AuditState; now: number;
}
export interface CommitInput {
  sessionId: string; expectedRevision: number; channelRevision: number; operationId: string;
  requestHash?: string;
  event: AuditEvent; answers?: AuditAnswer[]; state: AuditState; result?: Json; now: number;
}
export interface MutationResult {
  kind: 'accepted' | 'duplicate' | 'conflict'; session: StoredSession; result?: Json;
}
export interface ChangeChannelInput {
  sessionId: string; expectedRevision: number; channelRevision: number; operationId: string; now: number; channel: Channel;
  requestHash?: string;
}
export interface ReportRecord {
  id: string; sessionId: string; version: number; snapshotId: string | null; result: AuditResult | null;
  content: Json | null; libraryVersion: string; rulesVersion: string | null; tariffsVersion: string | null;
  templateVersion: string | null; contentHash: string | null; pdfHash: string | null; status: SessionStatus; kvKey: string | null;
  prepareDeadline: number | null; reportExpiresAt: number | null; publishedAt: number | null;
  failedAt: number | null; errorCode: string | null; createdAt: number; updatedAt: number;
}
export type JobStage = 'reconcile' | 'analyze' | 'render';
export type JobState = 'pending' | 'running' | 'retry_wait' | 'done' | 'failed';
export interface AuditJob {
  id: string; sessionId: string; reportId: string; reportVersion: number; stage: JobStage; state: JobState;
  attempts: Record<JobStage, number>; nextAttemptAt: number; leaseToken: string | null;
  leaseExpiresAt: number | null; errorCode: string | null; createdAt: number; updatedAt: number;
}
export interface ReportPatch {
  snapshotId?: string; result?: AuditResult; content?: Json; rulesVersion?: string; tariffsVersion?: string;
  templateVersion?: string; contentHash?: string; pdfHash?: string; status?: SessionStatus; kvKey?: string;
  reportExpiresAt?: number; publishedAt?: number; failedAt?: number; errorCode?: string | null;
}
export interface CheckpointInput {
  stage?: JobStage; state?: JobState; nextAttemptAt?: number; errorCode?: string | null;
  reportPatch?: ReportPatch; snapshot?: { data: AuditSnapshot; hash: string };
  sessionState?: AuditState; incrementAttempt?: JobStage; leaseMs?: number;
  expectedSessionRevision?: number;
}
export type EmailStatus = 'pending' | 'sending' | 'sent' | 'unknown' | 'failed';
export interface EmailJob {
  id: string; sessionId: string; reportId: string; operationId: string; recipient: string; consent: Json;
  requestHash: string | null;
  status: EmailStatus; nextAttemptAt: number; leaseToken: string | null; leaseExpiresAt: number | null;
  attempts: number; smtpStartedAt: number | null; outcome: string | null; errorCode: string | null;
  createdAt: number; updatedAt: number;
}
export interface EnqueueEmailInput {
  id: string; sessionId: string; reportId: string; operationId: string; recipient: string; consent: Json; now: number;
  requestHash?: string;
}
export interface VoiceCall {
  id: string; sessionId: string; slotId: string; providerCallId: string | null; previousCallId: string | null;
  channelRevision: number; status: 'reserved' | 'active' | 'stopping' | 'stopped' | 'unknown' | 'failed';
  reservedMs: number; startedAt: number | null; endedAt: number | null; usedMs: number;
  historyStatus: string; operationId: string; createdAt: number; stoppedRevision: number | null;
}
export interface UsageReservationInput {
  id: string; period: string; kind: string; amount: number; limit: number; now: number;
  expiresAt: number; minIntervalMs?: number;
}
export interface UsageReservation {
  id: string; period: string; kind: string; amount: number;
  /** True only for the caller whose atomic reservation write succeeded. Never persisted. */
  newlyCreated?: boolean;
  state: 'reserved' | 'settled' | 'released' | 'unknown'; actual: number | null; createdAt: number; settledAt: number | null;
}
