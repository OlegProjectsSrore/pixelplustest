import type { CoreServices } from './core.ts';
import type { Env } from './env.ts';
import type { Json } from './audit/contracts.ts';
import type { StoredSession } from './storage/types.ts';
import { createChatAdapter, voiceKnowledgeAnswer } from './channel-runtime.ts';
import { createRealtimeAdapters } from './channel-realtime.ts';
import { createRecoveryClassifier, defaultVoiceIntentClassifier } from './channel-recovery.ts';
import { createKnowledgeSearchHandler } from './search/service.ts';

export interface AdapterContext { core: CoreServices; env: Env; execution: ExecutionContext; session?: StoredSession; body?: Record<string, unknown> }
export type AdapterHandler = (request: Request, context: AdapterContext) => Promise<Response | Json>;
export interface ChannelAdapters {
  chat?: AdapterHandler;
  voiceStart?: AdapterHandler;
  voiceTranscript?: AdapterHandler;
  voiceAnswers?: AdapterHandler;
  voiceControl?: AdapterHandler;
  search?: AdapterHandler;
  ultravoxWebhook?: AdapterHandler;
  reconcile?: (session: StoredSession, now: number, core: CoreServices) => Promise<{ complete: boolean; limitations: string[] }>;
  pollVoice?: (session: StoredSession, now: number, core: CoreServices) => Promise<{ status: 'idle' | 'pending' | 'stopped' | 'conflict'; session: StoredSession; stoppedFromRevision?: number }>;
  recoverVoice?: (core: CoreServices) => Promise<{ checked: number; stopped: number }>;
}
/** Wire the separately implemented channel parsers into the shared durable core. */
export const channelAdapters: ChannelAdapters = {
  chat: createChatAdapter(),
  search: createKnowledgeSearchHandler(voiceKnowledgeAnswer),
  ...createRealtimeAdapters({ recoverAnswers: createRecoveryClassifier(), assessIntent: defaultVoiceIntentClassifier }),
};
