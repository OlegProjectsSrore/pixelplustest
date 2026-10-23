ALTER TABLE audit_events ADD COLUMN request_hash TEXT;
ALTER TABLE email_jobs ADD COLUMN request_hash TEXT;
