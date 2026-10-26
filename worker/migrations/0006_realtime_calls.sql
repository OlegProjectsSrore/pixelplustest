-- Keep the existing call ownership, reservations and history for both providers.
CREATE TABLE realtime_calls (
  call_id TEXT PRIMARY KEY REFERENCES ultravox_calls(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  delivery_complete INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL
);
