ALTER TABLE ultravox_slots ADD COLUMN provider_account_id TEXT;
ALTER TABLE ultravox_slots ADD COLUMN config_hash TEXT;
ALTER TABLE ultravox_slots ADD COLUMN provider_remaining_ms INTEGER;
ALTER TABLE ultravox_slots ADD COLUMN provider_active_calls INTEGER;
ALTER TABLE ultravox_slots ADD COLUMN provider_max_concurrency INTEGER;
ALTER TABLE ultravox_slots ADD COLUMN refresh_token TEXT;
ALTER TABLE ultravox_slots ADD COLUMN refresh_expires_at INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX ultravox_slots_account ON ultravox_slots(provider_account_id) WHERE provider_account_id IS NOT NULL;
