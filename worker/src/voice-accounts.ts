import type { CoreServices } from './core.ts';
import { hashToken } from './security.ts';
import { AccountCheckError, inspectAccount } from './voice/accounts.ts';

export const VOICE_SLOT_IDS = ['1', '2', '3', '4'] as const;
export async function voiceConfigHash(core: CoreServices, id: string): Promise<string> {
  return hashToken(JSON.stringify([core.env[`ULTRAVOX_KEY_${id}`], core.env.ULTRAVOX_MODEL, core.env.ULTRAVOX_VOICE]));
}
/** Refresh leases prevent cron/start races; successful observations never clear local reservations. */
export async function refreshVoiceAccounts(core: CoreServices): Promise<void> {
  await Promise.all(VOICE_SLOT_IDS.map(async id => {
    const db = core.store.db, key = core.env[`ULTRAVOX_KEY_${id}`], model = core.env.ULTRAVOX_MODEL, voice = core.env.ULTRAVOX_VOICE;
    if (typeof key !== 'string' || !key.trim() || !model || !voice) {
      await db.prepare("UPDATE ultravox_slots SET state='disabled',config_hash=NULL,last_error='configuration_missing',refresh_token=NULL,refresh_expires_at=0 WHERE id=?").bind(id).run();
      return;
    }
    const hash = await voiceConfigHash(core, id), now = core.now(), token = crypto.randomUUID();
    await db.prepare("INSERT OR IGNORE INTO ultravox_slots(id,state,checked_at) VALUES(?,'unknown',0)").bind(id).run();
    const lease = await db.prepare(`UPDATE ultravox_slots SET state='unknown',refresh_token=?,refresh_expires_at=? WHERE id=? AND refresh_expires_at<=? AND
      (config_hash IS NULL OR config_hash<>? OR (next_attempt_at<=? AND checked_at<=?))`).bind(token, now + 30_000, id, now, hash, now, now - 60_000).run();
    if (lease.meta.changes !== 1) return;
    const guard = 'id=? AND refresh_token=? AND refresh_expires_at>?';
    try {
      const snapshot = await inspectAccount(key.trim(), model, voice, core.fetcher);
      const previous = await db.prepare('SELECT provider_account_id FROM ultravox_slots WHERE id=?').bind(id).first<{provider_account_id: string | null}>();
      if (previous?.provider_account_id && previous.provider_account_id !== snapshot.accountId) throw new AccountCheckError('account_changed');
      const duplicate = await db.prepare('SELECT id FROM ultravox_slots WHERE provider_account_id=? AND id<>?').bind(snapshot.accountId, id).first();
      if (duplicate) throw new AccountCheckError('duplicate_account');
      const capacity = Math.max(0, snapshot.maxConcurrency - snapshot.activeCalls);
      // Account freeTimeRemaining already includes provider holds. Deduct local holds as well:
      // the API has no atomic per-call snapshot to prove overlap, especially after unknown POSTs.
      const ready = capacity > 0 && snapshot.remainingMs > 0;
      await db.prepare(`UPDATE ultravox_slots SET state=?,provider_account_id=?,config_hash=?,available_ms=?,max_concurrency=?,
        provider_remaining_ms=?,provider_active_calls=?,provider_max_concurrency=?,checked_at=?,next_attempt_at=0,last_error=?,refresh_token=NULL,refresh_expires_at=0 WHERE ${guard}`)
        .bind(ready ? 'available' : 'unknown', snapshot.accountId, hash, snapshot.remainingMs, Math.max(1, capacity),
          snapshot.remainingMs, snapshot.activeCalls, snapshot.maxConcurrency, now, ready ? null : capacity === 0 ? 'provider_slots_exhausted' : 'free_time_exhausted', id, token, core.now()).run();
    } catch (error) {
      const known = error instanceof AccountCheckError ? error : new AccountCheckError('account_check_failed');
      const disabled = [401, 403].includes(known.status) || ['account_changed', 'duplicate_account', 'voice_unavailable_or_external_billing', 'model_unavailable'].includes(known.code);
      const retry = known.retryAfter && /^\d+$/.test(known.retryAfter) ? Number(known.retryAfter) * 1000 : known.retryAfter ? Date.parse(known.retryAfter) - core.now() : 0;
      const delay = Math.max(disabled ? 300_000 : 60_000, Math.min(Number.isFinite(retry) ? retry : 0, 3600_000));
      await db.prepare(`UPDATE ultravox_slots SET state=?,config_hash=?,last_error=?,next_attempt_at=?,refresh_token=NULL,refresh_expires_at=0 WHERE ${guard}`)
        .bind(disabled ? 'disabled' : 'cooldown', hash, known.status ? `${known.code}_${known.status}` : known.code, core.now() + delay, id, token, core.now()).run();
    }
  }));
}
