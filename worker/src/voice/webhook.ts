import { normalizeProviderCall } from './provider.ts';
import { record } from './validation.ts';
import { verifyWebhookSignature, type WebhookVerificationOptions } from './webhook-signature.ts';
import type { ProviderWebhook, UltravoxEventName } from './types.ts';

export function normalizeWebhook(value: unknown): ProviderWebhook {
  if (!record(value) || !['call.started', 'call.joined', 'call.ended', 'call.billed'].includes(String(value.event))) throw new Error('Unsupported Ultravox webhook');
  const call = normalizeProviderCall(value.call);
  if (value.event === 'call.joined' && call.joined_at === null) throw new Error('Joined webhook lacks joined timestamp');
  if (['call.ended', 'call.billed'].includes(String(value.event)) && call.ended_at === null) throw new Error('Ended webhook lacks ended timestamp');
  return { event: value.event as UltravoxEventName, call };
}
/** Signature proves sender, not ownership of a session. Caller must match call_id against its own records. */
export async function parseVerifiedWebhook(body: Uint8Array, headers: Headers, options: WebhookVerificationOptions): Promise<ProviderWebhook> {
  if (body.byteLength > 1_048_576) throw new Error('Ultravox webhook is too large');
  if (!await verifyWebhookSignature(body, headers, options)) throw new Error('Invalid Ultravox webhook signature');
  return normalizeWebhook(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)));
}
