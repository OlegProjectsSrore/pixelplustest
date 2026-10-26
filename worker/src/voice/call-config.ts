import type { UltravoxCallRequest, VoiceCallConfig } from './types.ts';
import { createInterviewTools } from './client-tools.ts';
import { callId, nonempty, remainingSeconds } from './validation.ts';

export const CLOSING_MESSAGE = 'Спасибо за предоставленную информацию, сейчас подготовим результат предварительного аудита.';
const NIKOLAI_VOICE_ID = '83b2a94f-8078-4321-935c-a0798b2ac621';

/** Only assembles provider configuration; authorization and account selection belong to the caller. */
export function buildCallConfig(input: VoiceCallConfig): { body: UltravoxCallRequest; prior_call_id?: string } {
  if (input.prior_call_id !== undefined && input.initial_messages !== undefined) throw new Error('prior_call_id and initial_messages are mutually exclusive');
  const callback = new URL(input.callback_url);
  if (callback.protocol !== 'https:' || callback.username || callback.password || callback.hash) throw new Error('Webhook must use a public HTTPS URL');
  if (!Array.isArray(input.webhook_secrets) || input.webhook_secrets.length < 1 || input.webhook_secrets.length > 4) throw new Error('Webhook signing secrets are required');
  const secrets = input.webhook_secrets.map(secret => nonempty(secret, 'webhook signing secret', 4096));
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.metadata ?? {})) {
    if (!key || key.startsWith('ultravox.') || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid metadata key');
    if (typeof value !== 'string') throw new Error('Metadata values must be strings');
    metadata[key] = value;
  }
  const body: UltravoxCallRequest = {
    systemPrompt: nonempty(input.system_prompt, 'system prompt'), model: nonempty(input.model, 'model', 256),
    voice: nonempty(input.voice, 'voice', 256), languageHint: 'ru', temperature: 0,
    ...(input.voice === NIKOLAI_VOICE_ID ? { voiceOverrides: { inworld: { speakingRate: 1 } } } : {}),
    maxDuration: `${remainingSeconds(input.remaining_seconds)}s`, joinTimeout: '30s', recordingEnabled: false,
    transcriptOptional: false, initialOutputMedium: 'MESSAGE_MEDIUM_VOICE',
    medium: { webRtc: { dataMessages: { transcript: true, clientToolInvocation: true } } },
    timeExceededMessage: CLOSING_MESSAGE, selectedTools: createInterviewTools(),
    firstSpeakerSettings: input.user_first ? { user: {} } : { agent: { text: nonempty(input.first_message, 'first message', 4000), uninterruptible: false } },
    callbacks: { joined: { url: callback.href, secrets: [...secrets] }, ended: { url: callback.href, secrets: [...secrets] }, billed: { url: callback.href, secrets: [...secrets] } },
    metadata,
  };
  if (input.initial_messages !== undefined) {
    if (!Array.isArray(input.initial_messages) || input.initial_messages.length > 100) throw new Error('Invalid initial history');
    body.initialMessages = input.initial_messages.map(message => {
      if (!['user', 'assistant'].includes(message.role)) throw new Error('Initial history must contain user/assistant messages');
      return { role: message.role === 'user' ? 'MESSAGE_ROLE_USER' : 'MESSAGE_ROLE_AGENT', text: nonempty(message.text, 'initial message', 8000) };
    });
  }
  return { body, ...(input.prior_call_id === undefined ? {} : { prior_call_id: callId(input.prior_call_id) }) };
}
