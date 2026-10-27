import type { AuditAnswer, AuditEvent, AuditFact, FactStatus, Json } from '../audit/contracts.ts';
import type { FactDefinition, Question } from '../audit/library.ts';

export const INTENTS = ['answer', 'mixed', 'clarify', 'faq', 'question', 'off_topic', 'sensitive', 'role_change', 'humor_preference', 'decline', 'pause', 'resume', 'finish', 'start_diagnostic', 'unknown'] as const;
export type Intent = typeof INTENTS[number];

/** A strict, deliberately small schema supplied by the core, never by the visitor/model. */
export type ValueSchema =
  | { type: 'string'; enum?: readonly string[]; max_length?: number }
  | { type: 'number'; minimum?: number; maximum?: number }
  | { type: 'boolean' | 'null' }
  | { type: 'array'; items: ValueSchema; max_items?: number }
  | { type: 'object'; properties: Readonly<Record<string, ValueSchema>>; required?: readonly string[] }
  | { type: 'union'; any_of: readonly ValueSchema[] };

export interface ClassifierFact extends Pick<FactDefinition, 'id' | 'label' | 'value_type' | 'states'> {
  value_schema: ValueSchema;
  parameters_schema?: Extract<ValueSchema, { type: 'object' }>;
  /** Includes core-reserved IDs for new attempts. The model may not mint an ID. */
  allowed_attempt_ids?: readonly string[];
}
export interface AllowedAnswer {
  id: string;
  question_id: string;
  fact_id: string;
  state: Exclude<FactStatus, 'not_asked' | 'conflicting'>;
  value: Json;
  meaning: string;
  entailment?: string;
  examples?: readonly string[];
  counterexamples?: readonly string[];
}
export interface ClassifierContext {
  library_version: string;
  mode: 'chat' | 'voice_recovery';
  current_question_id: string | null;
  /** The current question as the visitor sees it (the chat's own wording); absent when none is on screen. */
  current_question_text?: string;
  questions: readonly Pick<Question, 'id' | 'chat' | 'voice' | 'fact_ids'>[];
  facts: readonly ClassifierFact[];
  allowed_answers: readonly AllowedAnswer[];
  accepted_facts: readonly AuditFact[];
  correctable_answers: readonly Pick<AuditAnswer, 'id' | 'fact_id' | 'value' | 'event_ids'>[];
  /** Only these user events can substantiate new candidates. */
  source_events: readonly Pick<AuditEvent, 'id' | 'role' | 'text'>[];
  /** Conversational context, not an alternative source of new evidence. */
  history: readonly Pick<AuditEvent, 'id' | 'role' | 'text'>[];
  clarification_questions: readonly { id: string; text: string }[];
  faqs: readonly { id: string; question: string }[];
  joke_categories: readonly { id: string; meaning: string; do_not_use_when: string }[];
  mapping_rules: readonly string[];
  humor_enabled: boolean;
}

export interface AnswerCandidate extends Pick<AuditAnswer, 'question_id' | 'fact_id' | 'answer_id' | 'value' | 'parameters' | 'event_ids' | 'replaces_answer_id'> {
  state: Exclude<FactStatus, 'not_asked' | 'conflicting'>;
  evidence: { event_id: string; text: string }[];
}
export interface Classification {
  intent: Intent;
  answers: AnswerCandidate[];
  clarification_question_id: string | null;
  faq_id: string | null;
  joke_category_id: string | null;
  humor_preference: 'allow' | 'decline' | null;
}
export interface ProviderUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}
export interface ProviderExchange {
  outcome: 'completed' | 'http_error' | 'unknown';
  status: number | null;
  body: unknown;
  usage: ProviderUsage | null;
  error: 'timeout' | 'network' | 'body_too_large' | 'invalid_envelope' | null;
}
export type DeepseekModel = 'deepseek-flash' | 'deepseek-v4-pro';
export interface ExternalRequest {
  provider: 'deepseek';
  /** V4 Pro for every chat call (CHAT_MODEL); Flash remains priced for older reservations. */
  model: DeepseekModel;
  max_tokens: number;
  /** Conservative input size for the core's reservation policy. Not a token count. */
  input_utf8_bytes: number;
}
export interface ClassifierRuntime {
  api_key: string;
  max_tokens: number;
  timeout_ms: number;
  fetch?: typeof fetch;
  /**
   * Reserve before invoking call, invoke it at most once, then account for its usage.
   * Missing usage / unknown outcome must not release the reservation as zero cost.
   * The callback includes reading the body. Denial must not invoke it.
   * Reservation/settlement errors propagate to the core; this adapter never retries.
   */
  runAuthorized(request: ExternalRequest, call: () => Promise<ProviderExchange>): Promise<ProviderExchange>;
}
export type ClassificationResult =
  | { ok: true; classification: Classification; usage: ProviderUsage | null; provider_request_id: string | null }
  | { ok: false; error: { code: 'not_configured' | 'provider_timeout' | 'provider_unavailable' | 'provider_auth' | 'provider_balance' | 'provider_request' | 'provider_output'; retryable: boolean }; usage: ProviderUsage | null; provider_request_id: string | null };
