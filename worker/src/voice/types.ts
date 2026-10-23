import type { AuditAnswer, AuditFact, Json, QuestionView } from '../audit/contracts.ts';

/** Ultravox wire names/enum values were checked against GET /api/schema/ (2026-10-22). */
export type UltravoxRole = 'MESSAGE_ROLE_UNSPECIFIED' | 'MESSAGE_ROLE_USER' | 'MESSAGE_ROLE_AGENT' | 'MESSAGE_ROLE_TOOL_CALL' | 'MESSAGE_ROLE_TOOL_RESULT';
export type UltravoxMedium = 'MESSAGE_MEDIUM_UNSPECIFIED' | 'MESSAGE_MEDIUM_VOICE' | 'MESSAGE_MEDIUM_TEXT';
export interface UltravoxInitialMessage { role: 'MESSAGE_ROLE_USER' | 'MESSAGE_ROLE_AGENT'; text: string }
export interface UltravoxClientTool {
  temporaryTool: {
    modelToolName: string; description: string; client: Record<string, never>; precomputable: false;
    dynamicParameters: { name: string; location: 'PARAMETER_LOCATION_BODY'; schema: Record<string, Json>; required: boolean }[];
  };
}
export type UltravoxSelectedTool = UltravoxClientTool | { toolName: 'hangUp'; parameterOverrides: { strict: true } };
export interface UltravoxCallRequest {
  systemPrompt: string; model: string; voice: string; languageHint: 'ru'; temperature: 0;
  voiceOverrides?: { inworld: { speakingRate: number } };
  maxDuration: string; joinTimeout: string; recordingEnabled: false; transcriptOptional: false;
  medium: { webRtc: { dataMessages: { transcript: true; clientToolInvocation: true } } };
  initialOutputMedium: 'MESSAGE_MEDIUM_VOICE'; timeExceededMessage: string;
  selectedTools: UltravoxSelectedTool[]; firstSpeakerSettings: { agent: { text: string; uninterruptible: false } } | { user: Record<string, never> };
  callbacks: Record<'joined' | 'ended' | 'billed', { url: string; secrets: string[] }>;
  metadata: Record<string, string>; initialMessages?: UltravoxInitialMessage[];
}

/** Application DTOs use snake_case and epoch milliseconds. Never persist join_url in this record. */
export interface ProviderCall {
  provider: 'ultravox'; call_id: string; created_at: number; joined_at: number | null;
  ended_at: number | null; end_reason: string | null; billed_duration: string | null;
  billing_status: string | null;
}
export type VoiceOperation = 'create_call' | 'get_call' | 'get_history';
export interface VoiceRequestContext { provider: 'ultravox'; operation: VoiceOperation; account_slot: string; mutating: boolean }
/** Mandatory gate; the owner of the session reserves/authorizes/settles outside this module. */
export type AuthorizedVoiceRunner = <T>(context: VoiceRequestContext, execute: () => Promise<T>) => Promise<T>;
export interface VoiceDependencies {
  api_key: string; account_slot: string; fetch: typeof fetch; run_authorized: AuthorizedVoiceRunner;
}
export interface VoiceCallConfig {
  system_prompt: string; model: string; voice: string; remaining_seconds: number; first_message: string;
  callback_url: string; webhook_secrets: string[]; metadata?: Record<string, string>;
  prior_call_id?: string; initial_messages?: { role: 'user' | 'assistant'; text: string }[]; user_first?: boolean;
}
export interface VoicePromptInput {
  library_version: string; questions: QuestionView[]; current_question_id: string | null;
  accepted_facts: AuditFact[]; remaining_seconds: number; humor_enabled: boolean;
  off_topic_categories?: { id: string; selection_source: string; do_not_use_when: string }[];
  service_faq?: { question: string; answer: string }[];
}
export interface VoiceAnswerCandidate {
  question_id: string; fact_id: string; answer_id?: string;
  state: Exclude<AuditAnswer['state'], 'not_asked' | 'conflicting'>;
  value: Json; parameters?: Record<string, Json>; confirmation_candidate?: AuditAnswer['confirmation'];
  source_quotes: string[]; source_ordinals?: number[]; is_correction?: boolean;
}
export type VoiceFinishReason = 'sufficient' | 'visitor_request' | 'declined' | 'time_limit' | 'recovery_expired';
export interface VoiceAnswerPayload { answers: VoiceAnswerCandidate[] }
export interface VoiceFinishPayload extends VoiceAnswerPayload { reason: VoiceFinishReason }
export interface ProviderMessage {
  source: 'provider'; call_id: string; call_stage_id: string | null; call_stage_message_index: number | null;
  provider_order: number; role: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'unknown';
  text: string; medium: 'voice' | 'text' | 'unknown'; invocation_id: string | null; tool_name: string | null;
  timespan: { start: string | null; end: string | null } | null;
  /** Provider durations relative to joined, NOT absolute ISO timestamps. */
  wall_clock_timespan: { start: string | null; end: string | null } | null;
}
export type UltravoxEventName = 'call.started' | 'call.joined' | 'call.ended' | 'call.billed';
export interface ProviderWebhook { event: UltravoxEventName; call: ProviderCall }
