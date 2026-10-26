-- The interview budget grows from 15 to 25 minutes, so audit_sessions.used_ms may now reach 1 500 000 ms.
-- SQLite cannot change a CHECK constraint in place, and dropping the parent table cascades into every child row
-- (D1 always enforces foreign keys), so the child tables are copied aside, the parent is rebuilt with the new
-- bound, and the copies are restored unchanged.
PRAGMA defer_foreign_keys = on;

CREATE TABLE keep_audit_events AS SELECT * FROM audit_events;
CREATE TABLE keep_audit_answers AS SELECT * FROM audit_answers;
CREATE TABLE keep_audit_snapshots AS SELECT * FROM audit_snapshots;
CREATE TABLE keep_ultravox_calls AS SELECT * FROM ultravox_calls;
CREATE TABLE keep_voice_recovery_results AS SELECT * FROM voice_recovery_results;
CREATE TABLE keep_realtime_calls AS SELECT * FROM realtime_calls;
CREATE TABLE keep_reports AS SELECT * FROM reports;
CREATE TABLE keep_report_access_tokens AS SELECT * FROM report_access_tokens;
CREATE TABLE keep_audit_jobs AS SELECT * FROM audit_jobs;
CREATE TABLE keep_email_jobs AS SELECT * FROM email_jobs;

CREATE TABLE audit_sessions_rebuilt (
  id TEXT PRIMARY KEY,
  access_token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  access_expires_at INTEGER NOT NULL,
  library_version TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  channel_revision INTEGER NOT NULL DEFAULT 0 CHECK(channel_revision >= 0),
  status TEXT NOT NULL CHECK(status IN ('in_progress','closing','preparing','ready','failed')),
  active_channel TEXT CHECK(active_channel IN ('chat','voice')),
  active_call_id TEXT,
  active_started_at INTEGER,
  used_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_ms BETWEEN 0 AND 1500000),
  current_question_id TEXT,
  state_json TEXT NOT NULL CHECK(json_valid(state_json)),
  last_seq INTEGER NOT NULL DEFAULT 0,
  extracted_through_seq INTEGER NOT NULL DEFAULT 0,
  finish_operation_id TEXT,
  finish_reason TEXT,
  closed_at INTEGER,
  mutation_nonce TEXT NOT NULL,
  contact_json TEXT,
  consent_json TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(id, finish_operation_id)
);
INSERT INTO audit_sessions_rebuilt SELECT * FROM audit_sessions;
DROP TABLE audit_sessions;
ALTER TABLE audit_sessions_rebuilt RENAME TO audit_sessions;
CREATE INDEX audit_sessions_active ON audit_sessions(status, active_started_at);
CREATE INDEX audit_sessions_deadline ON audit_sessions(status, MIN(access_expires_at, COALESCE(active_started_at + 1500000 - used_ms, access_expires_at)));
CREATE INDEX audit_sessions_expiry ON audit_sessions(access_expires_at);

INSERT INTO audit_snapshots SELECT * FROM keep_audit_snapshots;
INSERT INTO audit_answers SELECT * FROM keep_audit_answers;
INSERT INTO audit_events SELECT * FROM keep_audit_events;
INSERT INTO ultravox_calls SELECT * FROM keep_ultravox_calls;
INSERT INTO realtime_calls SELECT * FROM keep_realtime_calls;
INSERT INTO voice_recovery_results SELECT * FROM keep_voice_recovery_results;
INSERT INTO reports SELECT * FROM keep_reports;
INSERT INTO report_access_tokens SELECT * FROM keep_report_access_tokens;
INSERT INTO audit_jobs SELECT * FROM keep_audit_jobs;
INSERT INTO email_jobs SELECT * FROM keep_email_jobs;

DROP TABLE keep_audit_events;
DROP TABLE keep_audit_answers;
DROP TABLE keep_audit_snapshots;
DROP TABLE keep_ultravox_calls;
DROP TABLE keep_voice_recovery_results;
DROP TABLE keep_realtime_calls;
DROP TABLE keep_reports;
DROP TABLE keep_report_access_tokens;
DROP TABLE keep_audit_jobs;
DROP TABLE keep_email_jobs;

PRAGMA defer_foreign_keys = off;
