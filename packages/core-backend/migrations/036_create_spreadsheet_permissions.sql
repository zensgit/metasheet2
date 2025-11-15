-- 036_create_spreadsheet_permissions.sql

CREATE TABLE IF NOT EXISTS spreadsheet_permissions (
  sheet_id TEXT NOT NULL REFERENCES spreadsheets(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  perm_code TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet_id, user_id, perm_code)
);

-- Guard legacy cases where table exists without expected columns
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheet_permissions' AND column_name = 'sheet_id'
  ) THEN
    ALTER TABLE spreadsheet_permissions ADD COLUMN sheet_id TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheet_permissions' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE spreadsheet_permissions ADD COLUMN user_id TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheet_permissions' AND column_name = 'perm_code'
  ) THEN
    ALTER TABLE spreadsheet_permissions ADD COLUMN perm_code TEXT;
  END IF;
END $$;

-- Create indexes only if the columns exist
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheet_permissions' AND column_name = 'sheet_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_sheet_perms_sheet ON spreadsheet_permissions(sheet_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'spreadsheet_permissions' AND column_name = 'user_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_sheet_perms_user ON spreadsheet_permissions(user_id);
  END IF;
END $$;
