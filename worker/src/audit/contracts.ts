/** Project contracts, not provider API fields. All persisted timestamps are epoch milliseconds. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Channel = 'chat' | 'voice';
export type SessionStatus = 'in_progress' | 'closing' | 'preparing' | 'ready' | 'failed';
export type FactStatus = 'known' | 'unknown' | 'not_measured' | 'not_applicable' | 'declined' | 'ambiguous' | 'other' | 'not_asked' | 'conflicting';
export type Confirmation = 'explicit' | 'unconfirmed' | 'disputed';
export type AnswerMethod = 'selection' | 'classification' | 'voice_batch' | 'recovery';

export interface AuditEvent {
  id: string;
  source: 'chat' | 'voice' | 'webhook' | 'system';
  source_key: string;
  source_revision: number;
  local_order: number;
  role: 'user' | 'assistant' | 'system';
  kind: 'utterance' | 'answer' | 'service' | 'correction' | 'delivery' | 'channel' | 'finish';
  text?: string;
  data?: Json;
  call_id?: string;
  occurred_at: number;
  received_at: number;
  seq?: number;
}

export interface AuditAnswer {
  id: string;
  question_id: string;
  answer_id?: string;
  fact_id: string;
  state: FactStatus;
  value: Json;
  parameters?: Record<string, Json>;
  event_ids: string[];
  channel: Channel;
  method: AnswerMethod;
  confirmation: Confirmation;
  replaces_answer_id?: string;
  library_version: string;
  created_at: number;
}

export interface AuditFact {
  fact_id: string;
  state: FactStatus;
  value: Json;
  answer_ids: string[];
  confirmation: Confirmation;
  parameters?: Record<string, Json>;
}

export interface Contradiction { fact_id: string; answer_ids: string[]; reason: string }
export interface HumorState {
  enabled: boolean;
  reserved_ids: string[];
  used_ids: string[];
  operations: Record<string, { joke_id: string | null; text: string; status: 'reserved' | 'delivered'; question_id: string | null }>;
}

export interface AuditState {
  library_version: string;
  revision: number;
  channel_revision: number;
  active_channel: Channel;
  status: SessionStatus;
  current_question_id: string | null;
  facts: Record<string, AuditFact>;
  contradictions: Contradiction[];
  missing_facts: string[];
  candidate_blocks: string[];
  elapsed_ms: number;
  active_since: number | null;
  paused: boolean;
  finish_reason: string | null;
  humor: HumorState;
  through_seq: number;
  extracted_through_seq: number;
  history_status: 'pending' | 'complete' | 'incomplete';
}

export interface AuditSnapshot {
  id: string;
  session_id: string;
  library_version: string;
  created_at: number;
  through_seq: number;
  answers: AuditAnswer[];
  state: AuditState;
  limitations: string[];
}

export interface AuditSituation {
  id: string;
  title: string;
  kind: 'problem' | 'hypothesis' | 'verification' | 'opportunity';
  evidence_status: 'supported' | 'hypothesis' | 'insufficient';
  evidence_answer_ids: string[];
  significance: { level: 'high' | 'medium' | 'low' | 'unknown'; reason: string };
  limitations: string[];
}
export interface AuditSolution { id: string; title: string; text: string; service_ids: string[]; action_ids: string[]; limitations: string[] }
export interface AuditAction { id: string; text: string; after: string[]; parallel_with: string[]; deferred_reason: string | null }
export interface AuditTariff { id: string; title: string; details: Record<string, Json>; source_urls: string[] }
export interface AuditResult {
  snapshot_id: string;
  library_version: string;
  rules_version: string;
  tariffs_version: string;
  template_version: string;
  profile: Record<string, Json>;
  goal: Json;
  facts: AuditFact[];
  previous_work: AuditFact[];
  situations: AuditSituation[];
  solutions: AuditSolution[];
  actions: AuditAction[];
  tariffs: AuditTariff[];
  gaps: string[];
  contradictions: Contradiction[];
  limitations: string[];
  summary: string;
}

export interface QuestionView {
  id: string;
  text: string;
  fact_ids: string[];
  options: { id: string; text: string }[];
}

export interface MutationRequest {
  session_id: string;
  operation_id: string;
  expected_revision: number;
  channel_revision: number;
  library_version: string;
}
export interface ApiErrorBody {
  error: { code: string; message: string; retryable: boolean };
  request_id: string;
}
export const INTERVIEW_BUDGET_MS = 15 * 60 * 1000;
export const SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const REPORT_PREPARATION_MS = 48 * 60 * 60 * 1000;
export const HISTORY_WAIT_MS = 90 * 1000;
export const REPORT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export function initialAuditState(libraryVersion: string, channel: Channel, now: number): AuditState {
  return {
    library_version: libraryVersion, revision: 0, channel_revision: 0, active_channel: channel,
    status: 'in_progress', current_question_id: null, facts: {}, contradictions: [], missing_facts: [], candidate_blocks: [],
    elapsed_ms: 0, active_since: channel === 'chat' ? now : null, paused: channel === 'voice', finish_reason: null,
    humor: { enabled: true, reserved_ids: [], used_ids: [], operations: {} }, through_seq: 0, extracted_through_seq: 0, history_status: 'pending',
  };
}
