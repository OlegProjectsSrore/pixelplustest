import { buildClassifierPrompt } from './prompt.ts';
import { parseClassification, ClassificationValidationError } from './validation.ts';
import type { ClassificationResult, ClassifierContext, ClassifierRuntime, DeepseekModel, ProviderExchange, ProviderUsage } from './types.ts';

export { buildClassifierPrompt, parseClassification, ClassificationValidationError };
export type * from './types.ts';

const MAX_BODY_BYTES = 131072;
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function usageOf(body: unknown): ProviderUsage | null {
  if (!object(body) || !object(body.usage)) return null;
  const v = body.usage;
  if (!integer(v.prompt_tokens) || !integer(v.completion_tokens) || !integer(v.total_tokens) || v.prompt_tokens + v.completion_tokens !== v.total_tokens) return null;
  const usage: ProviderUsage = { prompt_tokens: v.prompt_tokens, completion_tokens: v.completion_tokens, total_tokens: v.total_tokens };
  for (const key of ['prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'] as const) {
    if (v[key] !== undefined) { if (!integer(v[key])) return null; usage[key] = v[key]; }
  }
  if (usage.prompt_cache_hit_tokens !== undefined && usage.prompt_cache_miss_tokens !== undefined && usage.prompt_cache_hit_tokens + usage.prompt_cache_miss_tokens !== usage.prompt_tokens) return null;
  return usage;
}
class ReadError extends Error {
  readonly code: 'timeout' | 'body_too_large' | 'invalid_envelope';
  constructor(code: 'timeout' | 'body_too_large' | 'invalid_envelope') { super(code); this.code = code; }
}
async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new ReadError('invalid_envelope');
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const decoder = new TextDecoder();
  let size = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new ReadError('body_too_large'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { signal.removeEventListener('abort', cancel); reader.releaseLock(); }
  try { return JSON.parse(text); } catch { throw new ReadError('invalid_envelope'); }
}

/** One metered DeepSeek completion with a JSON object reply; the caller interprets the exchange.
 * reasoning switches thinking on at that effort (temperature is then ignored by the provider) and allows a longer wait. */
export async function requestDeepseek(messages: { role: 'system' | 'user'; content: string }[], runtime: ClassifierRuntime, temperature = 0, model: DeepseekModel = 'deepseek-flash', reasoning?: 'low' | 'high' | 'max'): Promise<ProviderExchange> {
  if (!Number.isSafeInteger(runtime.max_tokens) || runtime.max_tokens < 1 || runtime.max_tokens > 16384 || !Number.isFinite(runtime.timeout_ms) || runtime.timeout_ms < 1 || runtime.timeout_ms > (reasoning ? 300000 : 60000)) throw new Error('Invalid classifier limits');
  const body = JSON.stringify(reasoning
    ? { model, thinking: { type: 'enabled' }, reasoning_effort: reasoning, response_format: { type: 'json_object' }, stream: false, max_tokens: runtime.max_tokens, messages }
    : { model, thinking: { type: 'disabled' }, response_format: { type: 'json_object' }, stream: false, temperature, max_tokens: runtime.max_tokens, messages });
  const inputBytes = new TextEncoder().encode(JSON.stringify(messages)).byteLength;
  if (inputBytes > 262144) throw new Error('Classifier context is too large');
  let invoked = false;
  return runtime.runAuthorized({ provider: 'deepseek', model, max_tokens: runtime.max_tokens, input_utf8_bytes: inputBytes }, async (): Promise<ProviderExchange> => {
    if (invoked) throw new Error('Classifier attempt already invoked');
    invoked = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let status: number | null = null;
    let timedOut = false;
    try {
      const work = async (): Promise<ProviderExchange> => {
        const response = await (runtime.fetch ?? globalThis.fetch)('https://api.deepseek.com/chat/completions', {
          method: 'POST', headers: { Authorization: `Bearer ${runtime.api_key}`, 'Content-Type': 'application/json' }, body, signal: controller.signal, redirect: 'manual',
        });
        status = response.status;
        if (!response.ok) {
          await response.body?.cancel();
          return { outcome: 'http_error', status, body: null, usage: null, error: null };
        }
        const result = await readBody(response, controller.signal);
        return { outcome: 'completed', status, body: result, usage: usageOf(result), error: null };
      };
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new ReadError('timeout')); }, runtime.timeout_ms);
      });
      return await Promise.race([work(), deadline]);
    } catch (error) {
      controller.abort();
      return { outcome: 'unknown', status, body: null, usage: null, error: timedOut ? 'timeout' : error instanceof ReadError ? error.code : 'network' };
    } finally { if (timer !== undefined) clearTimeout(timer); }
  });
}

/** One metered attempt. The core owns any retry, persistence and user-facing response. */
export async function classifyTurn(context: ClassifierContext, runtime: ClassifierRuntime): Promise<ClassificationResult> {
  if (!runtime.api_key?.trim()) return { ok: false, error: { code: 'not_configured', retryable: false }, usage: null, provider_request_id: null };
  const exchange = await requestDeepseek(buildClassifierPrompt(context), runtime);
  const requestId = object(exchange.body) && typeof exchange.body.id === 'string' && exchange.body.id.length <= 200 ? exchange.body.id : null;
  const failure = (code: Extract<ClassificationResult, { ok: false }>['error']['code'], retryable: boolean): ClassificationResult => ({ ok: false, error: { code, retryable }, usage: exchange.usage, provider_request_id: requestId });
  if (exchange.outcome === 'unknown') return failure(exchange.error === 'timeout' ? 'provider_timeout' : 'provider_unavailable', true);
  if (exchange.outcome === 'http_error') {
    if (exchange.status === 401 || exchange.status === 403) return failure('provider_auth', false);
    if (exchange.status === 402) return failure('provider_balance', false);
    if (exchange.status === 400 || exchange.status === 422) return failure('provider_request', false);
    return failure('provider_unavailable', exchange.status === 429 || (exchange.status !== null && exchange.status >= 500));
  }
  const result = exchange.body;
  if (!object(result) || !Array.isArray(result.choices) || result.choices.length !== 1 || !object(result.choices[0])) return failure('provider_output', true);
  const choice = result.choices[0];
  if (choice.finish_reason !== 'stop') return failure('provider_output', choice.finish_reason !== 'content_filter');
  if (!object(choice.message) || typeof choice.message.content !== 'string') return failure('provider_output', true);
  try {
    return { ok: true, classification: parseClassification(choice.message.content, context), usage: exchange.usage, provider_request_id: requestId };
  } catch (error) {
    if (!(error instanceof ClassificationValidationError)) throw error;
    return failure('provider_output', true);
  }
}
