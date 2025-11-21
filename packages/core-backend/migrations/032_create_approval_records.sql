-- 032_create_approval_records.sql
-- 审批记录表：记录每次动作、版本与状态变化
-- 支持并发控制和完整的审批历史追踪

CREATE TABLE IF NOT EXISTS approval_records (
  id BIGSERIAL PRIMARY KEY,
  instance_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('approve', 'reject', 'return', 'revoke', 'transfer', 'sign')),
  actor_id TEXT NOT NULL,
  actor_name TEXT,
  comment TEXT NULL,
  reason TEXT NULL,
  from_status TEXT NULL,
  to_status TEXT NOT NULL,
  from_version INT NULL,
  to_version INT NOT NULL,
  target_user_id TEXT NULL,  -- for transfer/sign
  target_step_id TEXT NULL,  -- for return
  attachments JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  ip_address INET,
  user_agent TEXT,
  platform TEXT DEFAULT 'web',
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_approval_records_instance ON approval_records(instance_id);
-- Ensure timestamp columns exist before creating time-based index (idempotent on legacy tables)
DO $$
BEGIN
  -- Ensure key columns exist for indexes and compatibility with legacy tables
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'instance_id'
  ) THEN
    ALTER TABLE approval_records ADD COLUMN instance_id TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'action'
  ) THEN
    ALTER TABLE approval_records ADD COLUMN action TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'actor_id'
  ) THEN
    ALTER TABLE approval_records ADD COLUMN actor_id TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'occurred_at'
  ) THEN
    ALTER TABLE approval_records
      ADD COLUMN occurred_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'created_at'
  ) THEN
    ALTER TABLE approval_records
      ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_approval_records_time ON approval_records(occurred_at DESC);

-- Create indexes conditionally if columns exist (for legacy compatibility)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'actor_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_approval_records_actor ON approval_records(actor_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'action'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_approval_records_action ON approval_records(action);
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_records' AND column_name = 'instance_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_approval_records_instance_action ON approval_records(instance_id, action, occurred_at DESC);
  END IF;
END $$;

-- Add version column to approval_instances if table exists and column not exists
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'approval_instances'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_instances'
    AND column_name = 'version'
  ) THEN
    ALTER TABLE approval_instances
    ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;
