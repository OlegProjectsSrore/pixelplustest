import type { Json } from '../audit/contracts.ts';
import type { AdapterContext, AdapterHandler } from '../integration.ts';
import type { StoredSession } from '../storage/types.ts';
import type { ProviderCall, VoiceCallConfig, VoiceDependencies } from './types.ts';
import { buildCallConfig } from './call-config.ts';
import { createVoiceProvider, VoiceProviderError } from './provider.ts';

export interface VoiceStartResult { call: ProviderCall; join_url: string }
export type VoiceStartPlan =
  | { kind: 'existing'; response: Json }
  | {
    kind: 'create'; call_record_id: string; config: VoiceCallConfig; provider_dependencies: VoiceDependencies;
    /** Persist provider ID before returning its join URL; return the authoritative session view. */
    on_created: (result: VoiceStartResult) => Promise<Json>;
    /** Owner retains an unknown reservation until reconciled; this module never releases a slot. */
    on_failure: (error: unknown) => Promise<void>;
  };
export type VoicePlanProvider = (core: AdapterContext['core'], session: StoredSession, body: Record<string, unknown>) => Promise<VoiceStartPlan>;

/** The router authenticates/validates Turnstile; plan_provider atomically authorizes/reserves/deduplicates. */
export function createVoiceStartHandler(plan_provider: VoicePlanProvider): AdapterHandler {
  return async (_request, context) => {
    if (!context.session || !context.body) throw new Error('Voice start requires an authenticated session and parsed request');
    const plan = await plan_provider(context.core, context.session, context.body);
    if (plan.kind === 'existing') return plan.response;
    let result: VoiceStartResult | undefined;
    try {
      // Bad local configuration is a definite non-creation, before any provider operation.
      try { buildCallConfig(plan.config); }
      catch { throw new VoiceProviderError('ULTRAVOX_INVALID_CONFIG', null, 'not_created'); }
      result = await createVoiceProvider(plan.provider_dependencies).createCall(plan.config);
      const session = await plan.on_created(result);
      return { call_id: plan.call_record_id, provider_call_id: result.call.call_id, join_url: result.join_url, session };
    } catch (error) {
      const failure = result ? new VoiceProviderError('ULTRAVOX_ATTACH_FAILED', 201, 'unknown', null, result.call.call_id) : error;
      await plan.on_failure(failure);
      throw failure;
    }
  };
}
