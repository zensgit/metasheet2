-- 042a: Extracted view-related indexes and personalization tables from 042 to reduce blast radius
-- Idempotent indexes and tables only; no seeds

-- Ensure uuid generator
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- View states for user personalization (safe to apply independently)
CREATE TABLE IF NOT EXISTS view_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID NOT NULL,
  user_id UUID NOT NULL,
  state_data JSONB NOT NULL DEFAULT '{}',
  filters JSONB DEFAULT '[]',
  sorts JSONB DEFAULT '[]',
  hidden_fields JSONB DEFAULT '[]',
  field_widths JSONB DEFAULT '{}',
  row_height VARCHAR(20) DEFAULT 'medium',
  view_settings JSONB DEFAULT '{}',
  cursor_position JSONB,
  scroll_position JSONB,
  version INTEGER DEFAULT 1,
  is_default BOOLEAN DEFAULT FALSE,
  is_shared BOOLEAN DEFAULT FALSE,
  shared_with JSONB DEFAULT '[]',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_accessed TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT unique_user_view_state UNIQUE (view_id, user_id, is_default)
);

CREATE INDEX IF NOT EXISTS idx_view_states_view ON view_states(view_id);
CREATE INDEX IF NOT EXISTS idx_view_states_user ON view_states(user_id);

-- Only create index on last_accessed if column exists (may not exist if table was created by 037)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'last_accessed'
  ) THEN
    BEGIN
      CREATE INDEX IF NOT EXISTS idx_view_states_accessed ON view_states(last_accessed);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Conditionally add FK once users table exists
DO $$ BEGIN
  -- Only add FK if users.id is UUID and view_states.user_id is UUID to avoid 42804 type mismatch
  IF EXISTS (
    SELECT 1 FROM information_schema.columns c1
    JOIN information_schema.columns c2 ON c2.table_schema='public' AND c2.table_name='users' AND c2.column_name='id'
    WHERE c1.table_schema='public' AND c1.table_name='view_states' AND c1.column_name='user_id'
      AND c1.data_type='uuid' AND c2.data_type='uuid'
  ) THEN
    BEGIN
      ALTER TABLE view_states
        ADD CONSTRAINT fk_view_states_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
