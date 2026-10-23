import type { ExternalRequest, ProviderUsage } from './chat/types.ts';

/** USD per million tokens, expressed in micro-USD. Verified 2026-10-23:
 * https://api-docs.deepseek.com/quick_start/pricing/
 * Use peak prices even off-peak: this is a conservative project spending ledger,
 * not the provider's invoice. Recheck these rates when changing the model/pricing.
 */
export const DEEPSEEK_PRICING = {
  model: 'deepseek-flash', verifiedOn: '2026-10-23',
  inputMiss: 300_000, inputHit: 6_000, output: 1_200_000,
} as const;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function cost(miss: number, hit: number, output: number): number {
  const numerator = BigInt(miss) * BigInt(DEEPSEEK_PRICING.inputMiss) + BigInt(hit) * BigInt(DEEPSEEK_PRICING.inputHit) + BigInt(output) * BigInt(DEEPSEEK_PRICING.output);
  const rounded = Number((numerator + 999_999n) / 1_000_000n);
  if (!Number.isSafeInteger(rounded)) throw new Error('DeepSeek cost exceeds safe range');
  return rounded;
}
export function reserveDeepseekMicros(input: ExternalRequest): number {
  if (input.provider !== 'deepseek' || input.model !== DEEPSEEK_PRICING.model || !integer(input.input_utf8_bytes) || input.input_utf8_bytes > 262144 ||
    !integer(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 16384) throw new Error('Unsupported DeepSeek billing request');
  // Text bytes upper-bound tokens; 256 covers framing of the two fixed text messages.
  return cost(input.input_utf8_bytes + 256, 0, input.max_tokens);
}
export function measuredDeepseekMicros(usage: ProviderUsage | null): number | null {
  if (!usage || !integer(usage.prompt_tokens) || !integer(usage.completion_tokens) || !integer(usage.total_tokens) ||
    usage.prompt_tokens + usage.completion_tokens !== usage.total_tokens) return null;
  const hit = usage.prompt_cache_hit_tokens, miss = usage.prompt_cache_miss_tokens;
  if ((hit !== undefined && (!integer(hit) || hit > usage.prompt_tokens)) || (miss !== undefined && (!integer(miss) || miss > usage.prompt_tokens))) return null;
  // Only a complete, consistent cache breakdown can lower the input charge.
  if (hit !== undefined && miss !== undefined) return hit + miss === usage.prompt_tokens ? cost(miss, hit, usage.completion_tokens) : null;
  return cost(usage.prompt_tokens, 0, usage.completion_tokens);
}
