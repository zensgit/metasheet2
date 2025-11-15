-- 042c_audit_placeholder: Minimal audit log table to satisfy startup dependencies

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS operation_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id VARCHAR(100),
  actor_type VARCHAR(50),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(100),
  resource_id VARCHAR(200),
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Add created_at column if it doesn't exist (for tables created by migration 031)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'operation_audit_logs' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE operation_audit_logs ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

-- Only create index on created_at if column exists
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'operation_audit_logs' AND column_name = 'created_at'
  ) THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_created ON operation_audit_logs(created_at);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_actor ON operation_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_operation_audit_logs_resource ON operation_audit_logs(resource_type, resource_id);
