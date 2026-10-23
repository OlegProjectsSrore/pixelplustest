export interface BrowserBinding {
  quickAction(action: 'pdf', options: { html: string }): Promise<Response>;
}
export interface Env {
  DB: D1Database;
  REPORTS_KV: KVNamespace;
  BROWSER?: BrowserBinding;
  REQUEST_LIMITER?: { limit(input: { key: string }): Promise<{ success: boolean }> };
  ALLOWED_ORIGINS?: string;
  TURNSTILE_HOSTNAMES?: string;
  TURNSTILE_SECRET?: string;
  IP_HASH_SALT?: string;
  ALLOW_DRAFT_LIBRARY?: string;
  PUBLIC_SESSIONS_ENABLED?: string;
  BUDGETS_JSON?: string;
  PUBLIC_WORKER_URL?: string;
  DEEPSEEK_API_KEY?: string;
  ULTRAVOX_MODEL?: string;
  ULTRAVOX_KEY_1?: string;
  ULTRAVOX_KEY_2?: string;
  ULTRAVOX_KEY_3?: string;
  ULTRAVOX_KEY_4?: string;
  ULTRAVOX_VOICE?: string;
  ULTRAVOX_WEBHOOK_SECRET?: string;
  VOICE_REPLAY_SECRET?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  [key: string]: unknown;
}
