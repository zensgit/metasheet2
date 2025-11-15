-- 035_create_files.sql

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  url TEXT NULL,
  owner_id TEXT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'files' AND column_name = 'owner_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);
  END IF;
END $$;
