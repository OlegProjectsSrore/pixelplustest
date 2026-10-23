CREATE TABLE voice_recovery_results (
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL REFERENCES ultravox_calls(id) ON DELETE CASCADE,
  boundary_hash TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, call_id, boundary_hash)
);
