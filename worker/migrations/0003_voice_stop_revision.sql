ALTER TABLE ultravox_calls ADD COLUMN stopped_revision INTEGER;
CREATE INDEX idx_voice_pending_recovery ON ultravox_calls(status, created_at);
