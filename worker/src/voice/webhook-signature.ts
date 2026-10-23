export interface WebhookVerificationOptions {
  secrets: readonly string[]; now?: () => number; max_age_ms?: number; future_skew_ms?: number; subtle?: SubtleCrypto;
}
/** Verify bytes before parsing. Signature format is HMAC-SHA256(raw body || timestamp), hexadecimal. */
export async function verifyWebhookSignature(body: Uint8Array, headers: Headers, options: WebhookVerificationOptions): Promise<boolean> {
  const timestamp = headers.get('X-Ultravox-Webhook-Timestamp'), signature = headers.get('X-Ultravox-Webhook-Signature');
  if (!timestamp || !signature || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return false;
  const parsed = Date.parse(timestamp), now = (options.now ?? Date.now)(), maxAge = options.max_age_ms ?? 60_000, future = options.future_skew_ms ?? 5_000;
  if (!Number.isFinite(parsed) || !Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge < 0 || !Number.isFinite(future) || future < 0 || now - parsed > maxAge || parsed - now > future) return false;
  if (!options.secrets.length || options.secrets.length > 4 || options.secrets.some(secret => typeof secret !== 'string' || !secret)) return false;
  const signatures = signature.split(',').map(item => item.trim());
  if (signatures.length > 8) return false;
  const suffix = new TextEncoder().encode(timestamp), signed = new Uint8Array(body.length + suffix.length);
  signed.set(body); signed.set(suffix, body.length);
  const subtle = options.subtle ?? crypto.subtle;
  for (const secret of options.secrets) {
    const key = await subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    for (const candidate of signatures) {
      if (!/^[0-9a-f]{64}$/i.test(candidate)) continue;
      const bytes = Uint8Array.from(candidate.match(/../g)!, pair => Number.parseInt(pair, 16));
      if (await subtle.verify('HMAC', key, bytes, signed)) return true;
    }
  }
  return false;
}
