import type { ProviderCall, VoiceCallConfig, VoiceDependencies, VoiceOperation } from './types.ts';
import { buildCallConfig } from './call-config.ts';
import { callId, nonempty, nullableString, record, timestamp, ULTRAVOX_API_ORIGIN } from './validation.ts';
import { fetchCallHistory, type HistoryOptions } from './history.ts';

export class VoiceProviderError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly creation_outcome: 'not_created' | 'unknown' | 'not_applicable';
  readonly retry_after: string | null;
  readonly provider_call_id: string | null;
  constructor(code: string, status: number | null, creation_outcome: 'not_created' | 'unknown' | 'not_applicable', retry_after: string | null = null, provider_call_id: string | null = null) {
    super(code); this.name = 'VoiceProviderError';
    this.code = code; this.status = status; this.creation_outcome = creation_outcome;
    this.retry_after = retry_after; this.provider_call_id = provider_call_id;
  }
}
export function normalizeProviderCall(value: unknown): ProviderCall {
  if (!record(value)) throw new Error('Invalid provider call');
  return {
    provider: 'ultravox', call_id: callId(value.callId), created_at: timestamp(value.created, 'created')!,
    joined_at: timestamp(value.joined, 'joined', true), ended_at: timestamp(value.ended, 'ended', true),
    end_reason: nullableString(value.endReason, 'end reason'), billed_duration: nullableString(value.billedDuration, 'billed duration'),
    billing_status: nullableString(value.billingStatus, 'billing status'),
  };
}

export function createVoiceProvider(deps: VoiceDependencies) {
  const fetcher = deps.fetch;
  nonempty(deps.api_key, 'API key', 4096); nonempty(deps.account_slot, 'account slot', 128);
  if (typeof deps.fetch !== 'function' || typeof deps.run_authorized !== 'function') throw new Error('Authorized runner and fetch are required');
  async function request(operation: VoiceOperation, url: URL, body?: unknown): Promise<unknown> {
    if (url.origin !== ULTRAVOX_API_ORIGIN || url.username || url.password || url.hash) throw new Error('Invalid provider URL');
    return deps.run_authorized({ provider: 'ultravox', operation, account_slot: deps.account_slot, mutating: operation === 'create_call' }, async () => {
      let response: Response;
      try {
        response = await fetcher(url.href, {
          method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
          headers: { 'X-API-Key': deps.api_key, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      } catch {
        // Do not retry here: a failed POST response may conceal a created/billable call.
        throw new VoiceProviderError('ULTRAVOX_NETWORK_ERROR', null, operation === 'create_call' ? 'unknown' : 'not_applicable');
      }
      if (!response.ok || (operation === 'create_call' && response.status !== 201)) {
        // HTTP timeout/conflict or an unfamiliar status cannot prove that a call was not created.
        const definiteRejection = [400, 401, 403, 404, 405, 415, 422, 429].includes(response.status);
        const outcome = operation !== 'create_call' ? 'not_applicable' : definiteRejection ? 'not_created' : 'unknown';
        throw new VoiceProviderError('ULTRAVOX_HTTP_ERROR', response.status, outcome, response.headers.get('Retry-After'));
      }
      try { return await response.json(); }
      catch { throw new VoiceProviderError('ULTRAVOX_INVALID_JSON', response.status, operation === 'create_call' ? 'unknown' : 'not_applicable'); }
    });
  }
  return {
    async createCall(input: VoiceCallConfig): Promise<{ call: ProviderCall; join_url: string }> {
      const config = buildCallConfig(input), url = new URL('/api/calls', ULTRAVOX_API_ORIGIN);
      if (config.prior_call_id) url.searchParams.set('priorCallId', config.prior_call_id);
      const raw = await request('create_call', url, config.body);
      try {
        const call = normalizeProviderCall(raw);
        if (!record(raw)) throw new Error('Invalid call');
        const join = new URL(nonempty(raw.joinUrl, 'join URL', 8192));
        if (join.protocol !== 'wss:' || join.username || join.password) throw new Error('Invalid join URL');
        return { call, join_url: join.href };
      } catch {
        let knownId: string | null = null;
        if (record(raw)) { try { knownId = callId(raw.callId); } catch { /* Invalid IDs cannot identify a created call. */ } }
        throw new VoiceProviderError('ULTRAVOX_INVALID_CREATE_RESPONSE', 201, 'unknown', null, knownId);
      }
    },
    async getCall(id: string): Promise<ProviderCall> {
      const requested = callId(id), call = normalizeProviderCall(await request('get_call', new URL(`/api/calls/${requested}`, ULTRAVOX_API_ORIGIN)));
      if (call.call_id !== requested) throw new Error('Provider returned another call');
      return call;
    },
    getCallHistory(id: string, options?: HistoryOptions) {
      return fetchCallHistory(id, url => request('get_history', url), options);
    },
  };
}
