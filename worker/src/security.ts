import type { Env } from './env.ts';
import type { MutationRequest } from './audit/contracts.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  /** Internal reason for server logs only; never sent to the client. */
  readonly detail?: string;
  constructor(status: number, code: string, message: string, retryable = false, detail?: string) {
    super(message); this.status = status; this.code = code; this.retryable = retryable; this.detail = detail;
  }
}
export const fail = (status: number, code: string, message: string, retryable = false): never => { throw new HttpError(status, code, message, retryable); };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request', 'Ожидался JSON-объект.');
  return value as Record<string, unknown>;
}
export function textField(value: unknown, name: string, max = 128): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'invalid_request', `Некорректное поле ${name}.`);
  return value as string;
}
export function identifier(value: unknown, name: string): string {
  const text = textField(value, name);
  if (!/^[a-zA-Z0-9_.:-]+$/.test(text)) fail(400, 'invalid_request', `Некорректное поле ${name}.`);
  return text;
}
export function revision(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(400, 'invalid_request', `Некорректное поле ${name}.`);
  return value as number;
}
export function mutation(body: Record<string, unknown>): MutationRequest {
  if (body.api_version !== undefined && body.api_version !== '1') fail(400, 'invalid_request', 'Неизвестная версия API.');
  return { session_id: identifier(body.session_id, 'session_id'), operation_id: identifier(body.operation_id, 'operation_id'),
    expected_revision: revision(body.expected_revision, 'expected_revision'), channel_revision: revision(body.channel_revision, 'channel_revision'),
    library_version: textField(body.library_version, 'library_version', 64) };
}
export async function requestHash(body: Record<string, unknown>): Promise<string> {
  function canonical(value: unknown, depth = 0): string {
    if (depth > 16) fail(400, 'invalid_request', 'Слишком глубокая структура запроса.');
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    return JSON.stringify(value);
  }
  return hashToken(canonical(body));
}
export async function readBytes(request: Request, maxBytes = 64 * 1024): Promise<Uint8Array> {
  const length = request.headers.get('Content-Length');
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) fail(413, 'body_too_large', 'Запрос слишком большой.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'invalid_json', 'Пустой запрос.');
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) {
      const part = await reader!.read(); if (part.done) break;
      total += part.value.length;
      if (total > maxBytes) { await reader!.cancel(); fail(413, 'body_too_large', 'Запрос слишком большой.'); }
      chunks.push(part.value);
    }
  } finally { reader!.releaseLock(); }
  const data = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return data;
}
export async function readJson(request: Request, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') ?? '')) fail(415, 'content_type', 'Требуется application/json.');
  const data = await readBytes(request, maxBytes);
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(data))); }
  catch (error) { if (error instanceof HttpError) throw error; return fail(400, 'invalid_json', 'Некорректный JSON.'); }
}
export function bearer(request: Request): string {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('Authorization') ?? '');
  return match?.[1] ?? fail(401, 'unauthorized', 'Требуется право доступа.');
}
function base64url(bytes: Uint8Array): string { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
export function randomToken(): string { return base64url(crypto.getRandomValues(new Uint8Array(32))); }
export async function hashToken(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashIp(ip: string, salt: string | undefined): Promise<string> {
  if (!salt || salt.length < 32) fail(503, 'configuration_required', 'Не настроена защита запросов.');
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt!), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(ip))));
}
export function budgets(env: Env): Record<string, number> {
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(env.BUDGETS_JSON || '{}')); } catch { return fail(503, 'configuration_required', 'Некорректные лимиты сервиса.'); }
  const result: Record<string, number> = Object.create(null);
  for (const [key, limit] of Object.entries(value)) {
    if (!Number.isSafeInteger(limit) || (limit as number) < 0) fail(503, 'configuration_required', 'Некорректные лимиты сервиса.');
    result[key] = limit as number;
  }
  return result;
}
export function originAllowed(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) fail(403, 'origin_denied', 'Источник запроса не разрешён.');
  return origin;
}
export async function verifyTurnstile(request: Request, token: unknown, env: Env, action: 'session' | 'voice_start', fetcher: typeof fetch = fetch): Promise<void> {
  if (env.TURNSTILE_ENABLED === 'false') return;
  const responseToken = textField(token, 'turnstile_token', 2048);
  const hostnames = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (!env.TURNSTILE_SECRET || !hostnames.length) fail(503, 'configuration_required', 'Не настроена проверка доступа.');
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET!, response: responseToken });
  const ip = request.headers.get('CF-Connecting-IP'); if (ip) form.set('remoteip', ip);
  let data: Record<string, unknown>;
  try {
    const response = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form, signal: AbortSignal.timeout(8000) });
    if (!response.ok) fail(503, 'verification_unavailable', 'Проверка доступа временно недоступна.', true);
    data = object(await response.json());
  } catch { return fail(503, 'verification_unavailable', 'Проверка доступа временно недоступна.', true); }
  if (data.success !== true || typeof data.hostname !== 'string' || !hostnames.includes(data.hostname) || data.action !== action) {
    fail(403, 'verification_failed', 'Обновите проверку доступа и повторите запрос.');
  }
}
