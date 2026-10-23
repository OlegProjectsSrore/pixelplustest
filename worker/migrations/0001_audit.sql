PRAGMA foreign_keys = ON;

CREATE TABLE audit_sessions (
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
  used_ms INTEGER NOT NULL DEFAULT 0 CHECK(used_ms BETWEEN 0 AND 900000),
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
CREATE INDEX audit_sessions_active ON audit_sessions(status, active_started_at);
CREATE INDEX audit_sessions_expiry ON audit_sessions(access_expires_at);
CREATE INDEX audit_sessions_deadline ON audit_sessions(status, MIN(access_expires_at, COALESCE(active_started_at + 900000 - used_ms, access_expires_at)));

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_event_key TEXT NOT NULL,
  source_revision INTEGER NOT NULL DEFAULT 0,
  source_order INTEGER,
  call_id TEXT,
  role TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  source_timestamp INTEGER,
  received_at INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  result_json TEXT,
  UNIQUE(session_id, seq),
  UNIQUE(session_id, source, source_event_key, source_revision),
  UNIQUE(session_id, operation_id)
);
CREATE INDEX audit_events_session_source ON audit_events(session_id, source, source_event_key);

CREATE TABLE audit_answers (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL,
  answer_id TEXT,
  status TEXT NOT NULL,
  answer_json TEXT NOT NULL CHECK(json_valid(answer_json)),
  replaces_answer_id TEXT REFERENCES audit_answers(id),
  library_version TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_answers_session ON audit_answers(session_id, event_seq);

CREATE TABLE audit_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  report_version INTEGER NOT NULL,
  library_version TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  hash TEXT NOT NULL,
  snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, report_version)
);
CREATE TRIGGER audit_snapshots_immutable BEFORE UPDATE ON audit_snapshots
BEGIN SELECT RAISE(ABORT, 'audit snapshots are immutable'); END;

CREATE TABLE ultravox_slots (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('available','disabled','cooldown','unknown')),
  available_ms INTEGER NOT NULL DEFAULT 0 CHECK(available_ms >= 0),
  max_concurrency INTEGER NOT NULL DEFAULT 1 CHECK(max_concurrency > 0),
  reserved_ms INTEGER NOT NULL DEFAULT 0 CHECK(reserved_ms >= 0),
  active_calls INTEGER NOT NULL DEFAULT 0 CHECK(active_calls >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE TABLE ultravox_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  slot_id TEXT NOT NULL REFERENCES ultravox_slots(id),
  provider_call_id TEXT UNIQUE,
  previous_call_id TEXT,
  channel_revision INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('reserved','active','stopping','stopped','unknown','failed')),
  reserved_ms INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER,
  used_ms INTEGER NOT NULL DEFAULT 0,
  history_status TEXT NOT NULL DEFAULT 'pending',
  operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(session_id, operation_id)
);
CREATE INDEX ultravox_calls_session ON ultravox_calls(session_id, created_at);
CREATE INDEX ultravox_calls_slot ON ultravox_calls(slot_id, status);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  snapshot_id TEXT REFERENCES audit_snapshots(id),
  result_json TEXT,
  content_json TEXT,
  library_version TEXT NOT NULL,
  rules_version TEXT,
  tariffs_version TEXT,
  template_version TEXT,
  content_hash TEXT,
  pdf_hash TEXT,
  status TEXT NOT NULL CHECK(status IN ('in_progress','closing','preparing','ready','failed')),
  kv_key TEXT,
  prepare_deadline INTEGER,
  report_expires_at INTEGER,
  published_at INTEGER,
  failed_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, version)
);
CREATE INDEX reports_expiry ON reports(report_expires_at);
CREATE INDEX reports_deadline ON reports(status, prepare_deadline);
CREATE INDEX reports_failure ON reports(status, failed_at);
CREATE TABLE report_access_tokens (
  token_hash TEXT PRIMARY KEY,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN ('browser','email')),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX report_tokens_report ON report_access_tokens(report_id);

CREATE TABLE audit_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL UNIQUE REFERENCES reports(id) ON DELETE CASCADE,
  report_version INTEGER NOT NULL,
  stage TEXT NOT NULL CHECK(stage IN ('reconcile','analyze','render')),
  state TEXT NOT NULL CHECK(state IN ('pending','running','retry_wait','done','failed')),
  attempts_json TEXT NOT NULL DEFAULT '{"reconcile":0,"analyze":0,"render":0}',
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  error_code TEXT,
  mutation_nonce TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, report_version)
);
CREATE INDEX audit_jobs_due ON audit_jobs(state, next_attempt_at);
CREATE INDEX audit_jobs_lease ON audit_jobs(state, lease_expires_at);

CREATE TABLE email_jobs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES audit_sessions(id) ON DELETE CASCADE,
  report_id TEXT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  consent_json TEXT NOT NULL CHECK(json_valid(consent_json)),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','sent','unknown','failed')),
  next_attempt_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_expires_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  smtp_started_at INTEGER,
  outcome TEXT,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(session_id, operation_id)
);
CREATE INDEX email_jobs_due ON email_jobs(status, next_attempt_at);
CREATE INDEX email_jobs_lease ON email_jobs(status, lease_expires_at);
CREATE INDEX email_jobs_session ON email_jobs(session_id);

CREATE TABLE usage_counters (
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  used REAL NOT NULL DEFAULT 0 CHECK(used >= 0),
  reserved REAL NOT NULL DEFAULT 0 CHECK(reserved >= 0),
  next_allowed_at INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  mutation_nonce TEXT,
  PRIMARY KEY(period, kind)
);
CREATE INDEX usage_counters_expiry ON usage_counters(expires_at);
CREATE INDEX usage_counters_interval ON usage_counters(kind, next_allowed_at);
CREATE TABLE usage_reservations (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  state TEXT NOT NULL CHECK(state IN ('reserved','settled','released','unknown')),
  actual REAL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  mutation_nonce TEXT,
  FOREIGN KEY(period,kind) REFERENCES usage_counters(period,kind) ON DELETE CASCADE
);
CREATE INDEX usage_reservations_period ON usage_reservations(period, kind);
