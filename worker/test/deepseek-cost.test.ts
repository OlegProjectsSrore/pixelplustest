import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveDeepseekMicros, measuredDeepseekMicros } from '../src/deepseek-cost.ts';

test('USD accounting separates cache, uncached input and output and rounds up to micro-USD', () => {
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }), 1_500_000);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0 }), 6_000);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 }), 1);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }), 48);
});
test('missing and inconsistent usage retains reserves; incomplete cache details grant no discount', () => {
  assert.equal(measuredDeepseekMicros(null), null);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 100, completion_tokens: 1, total_tokens: 100 }), null);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 100, completion_tokens: 0, total_tokens: 100, prompt_cache_hit_tokens: 101 }), null);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 100, completion_tokens: 0, total_tokens: 100, prompt_cache_hit_tokens: 10, prompt_cache_miss_tokens: 80 }), null);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 100, completion_tokens: 0, total_tokens: 100, prompt_cache_hit_tokens: 100 }), 30);
});
test('reservation bounds input/output independently and rejects an unpriced model or invalid sizes', () => {
  const request = { provider: 'deepseek' as const, model: 'deepseek-flash' as const, input_utf8_bytes: 1000, max_tokens: 4096 };
  assert.equal(reserveDeepseekMicros(request), 5292);
  for (const input of [{ ...request, input_utf8_bytes: -1 }, { ...request, max_tokens: 0 }, { ...request, input_utf8_bytes: 262145 }]) assert.throws(() => reserveDeepseekMicros(input));
  assert.throws(() => reserveDeepseekMicros({ ...request, model: 'unpriced-model' } as never));
});
test('DeepSeek V4 Pro is priced on its own peak rates for both the reservation and the settlement', () => {
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 1_000_000, completion_tokens: 1_000_000, total_tokens: 2_000_000 }, 'deepseek-v4-pro'), 5_280_000);
  assert.equal(measuredDeepseekMicros({ prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000, prompt_cache_hit_tokens: 1_000_000, prompt_cache_miss_tokens: 0 }, 'deepseek-v4-pro'), 44_000);
  const request = { provider: 'deepseek' as const, model: 'deepseek-v4-pro' as const, input_utf8_bytes: 1000, max_tokens: 900 };
  // (1000 + 256) × 1.32 + 900 × 3.96 micro-USD, rounded up.
  assert.equal(reserveDeepseekMicros(request), 5222);
});
