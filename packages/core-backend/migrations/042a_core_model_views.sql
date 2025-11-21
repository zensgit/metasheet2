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

-- Add last_accessed column if it doesn't exist (for tables created by earlier migrations)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'last_accessed'
  ) THEN
    ALTER TABLE view_states ADD COLUMN last_accessed TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_view_states_view ON view_states(view_id);
CREATE INDEX IF NOT EXISTS idx_view_states_user ON view_states(user_id);
CREATE INDEX IF NOT EXISTS idx_view_states_accessed ON view_states(last_accessed);

-- Conditionally add FK once users table exists (skip if type mismatch)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    BEGIN
      ALTER TABLE view_states
        ADD CONSTRAINT fk_view_states_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    EXCEPTION
      WHEN duplicate_object THEN NULL;
      WHEN datatype_mismatch THEN NULL; -- Skip if type incompatible (text vs uuid)
    END;
  END IF;
END $$;
