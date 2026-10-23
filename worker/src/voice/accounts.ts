import { callId, record, ULTRAVOX_API_ORIGIN } from './validation.ts';

export class AccountCheckError extends Error {
  constructor(readonly code: string, readonly status = 0, readonly retryAfter: string | null = null) { super(code); }
}
export interface AccountSnapshot {
  accountId: string; remainingMs: number; activeCalls: number; maxConcurrency: number;
}
/** The live account API returns protobuf seconds (e.g. "1800s"). Unknown units fail closed. */
export function freeTimeMs(value: unknown): number {
  if (typeof value !== 'string' || !/^-?\d+(?:\.\d{1,9})?s$/.test(value)) throw new AccountCheckError('invalid_free_time');
  const ms = Math.floor(Number(value.slice(0, -1)) * 1000);
  if (!Number.isSafeInteger(ms)) throw new AccountCheckError('invalid_free_time');
  return Math.max(0, ms);
}
export function parseAccount(value: unknown): AccountSnapshot {
  if (!record(value) || !Number.isSafeInteger(value.activeCalls) || Number(value.activeCalls) < 0 ||
    !Number.isSafeInteger(value.allowedConcurrentCalls) || Number(value.allowedConcurrentCalls) < 0) throw new AccountCheckError('unknown_account_limits');
  return { accountId: callId(value.accountId), remainingMs: freeTimeMs(value.freeTimeRemaining),
    activeCalls: Number(value.activeCalls), maxConcurrency: Number(value.allowedConcurrentCalls) };
}
/** GET only. One bounded check covers voice/model visibility and then the freshest account state. */
export async function inspectAccount(key: string, model: string, voice: string, fetcher: typeof fetch): Promise<AccountSnapshot> {
  const signal = AbortSignal.timeout(12_000);
  async function get(path: string): Promise<unknown> {
    const url = new URL(path, ULTRAVOX_API_ORIGIN);
    if (url.origin !== ULTRAVOX_API_ORIGIN || url.username || url.password || url.hash) throw new AccountCheckError('invalid_provider_url');
    // workerd supports manual/follow, not redirect:error. Non-2xx is rejected below.
    const response = await fetcher(url.href, { method: 'GET', redirect: 'manual', headers: { 'X-API-Key': key }, signal });
    if (!response.ok) throw new AccountCheckError('provider_http', response.status, response.headers.get('Retry-After'));
    return response.json();
  }
  const selectedVoice = await get(`/api/voices/${callId(voice)}`);
  if (!record(selectedVoice) || selectedVoice.voiceId !== voice || selectedVoice.billingStyle !== 'VOICE_BILLING_STYLE_INCLUDED') throw new AccountCheckError('voice_unavailable_or_external_billing');
  let path: string | null = '/api/models', found = false;
  const visited = new Set<string>();
  for (let page = 0; path && page < 5; page++) {
    const url = new URL(path, ULTRAVOX_API_ORIGIN);
    if (!['/api/models', '/api/models/'].includes(url.pathname) || visited.has(url.href)) throw new AccountCheckError('invalid_models_page');
    visited.add(url.href);
    const data = await get(url.href);
    if (!record(data) || !Array.isArray(data.results)) throw new AccountCheckError('invalid_models');
    if (data.results.some(item => record(item) && item.name === model)) { found = true; break; }
    if (data.next !== null && typeof data.next !== 'string') throw new AccountCheckError('invalid_models_page');
    path = data.next;
  }
  if (!found) throw new AccountCheckError('model_unavailable');
  return parseAccount(await get('/api/accounts/me'));
}
