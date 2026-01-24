-- zzzz20260113_create_spreadsheets_table.sql
-- Placeholder migration to satisfy historical chain; schema matches 034_create_spreadsheets.sql

CREATE TABLE IF NOT EXISTS spreadsheets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NULL,
  deleted_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_spreadsheets_deleted ON spreadsheets(deleted_at);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheets' AND column_name = 'owner_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_spreadsheets_owner ON spreadsheets(owner_id);
  END IF;
END $$;
