-- 055_create_attendance_import_tokens.sql
-- Persist commit tokens for attendance import across restarts/instances

CREATE TABLE IF NOT EXISTS attendance_import_tokens (
  token TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS attendance_import_tokens_org_idx
  ON attendance_import_tokens(org_id);

CREATE INDEX IF NOT EXISTS attendance_import_tokens_expires_idx
  ON attendance_import_tokens(expires_at);
