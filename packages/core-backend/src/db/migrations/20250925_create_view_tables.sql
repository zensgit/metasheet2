-- Multi-View System Database Schema
-- Based on Baserow/SeaTable architecture

-- Tables for spreadsheet-like data structure
CREATE TABLE IF NOT EXISTS tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  schema JSONB NOT NULL DEFAULT '{}', -- Column definitions
  owner_id INTEGER, -- REFERENCES users(id) - FK added conditionally below
  workspace_id UUID,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,
  UNIQUE(name, workspace_id, deleted_at)
);

-- Add FK constraint only if users table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    BEGIN
      ALTER TABLE tables ADD CONSTRAINT tables_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Views configuration (Grid, Kanban, Calendar, Gallery, Form)
CREATE TABLE IF NOT EXISTS views (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL CHECK (type IN ('grid', 'kanban', 'calendar', 'gallery', 'form')),
  name VARCHAR(255) NOT NULL,
  config JSONB NOT NULL DEFAULT '{}', -- View-specific configuration
  filters JSONB DEFAULT '[]', -- Array of filter conditions
  sorting JSONB DEFAULT '[]', -- Array of sort rules
  visible_fields JSONB DEFAULT '[]', -- Array of visible field IDs
  is_default BOOLEAN DEFAULT FALSE,
  is_public BOOLEAN DEFAULT FALSE,
  created_by INTEGER, -- REFERENCES users(id) - FK added conditionally below
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP,

  -- Ensure only one default view per table
  CONSTRAINT unique_default_view EXCLUDE (table_id WITH =) WHERE (is_default = TRUE AND deleted_at IS NULL)
);

-- Add FK constraint only if users table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    BEGIN
      ALTER TABLE views ADD CONSTRAINT views_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- User-specific view states (personalization)
CREATE TABLE IF NOT EXISTS view_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID REFERENCES views(id) ON DELETE CASCADE,
  user_id INTEGER, -- REFERENCES users(id) ON DELETE CASCADE - FK added conditionally below
  state JSONB NOT NULL DEFAULT '{}', -- User-specific filters, sorting, column widths
  last_accessed TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(view_id, user_id)
);

-- Add FK constraint only if users table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    BEGIN
      ALTER TABLE view_states ADD CONSTRAINT view_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- View-specific configurations
-- Kanban configuration
CREATE TABLE IF NOT EXISTS kanban_configs (
  view_id UUID PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
  group_by_field VARCHAR(255) NOT NULL,
  swimlanes_field VARCHAR(255),
  card_fields JSONB DEFAULT '[]',
  card_cover_field VARCHAR(255),
  show_empty_groups BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Calendar configuration
CREATE TABLE IF NOT EXISTS calendar_configs (
  view_id UUID PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
  date_field VARCHAR(255) NOT NULL,
  end_date_field VARCHAR(255),
  title_field VARCHAR(255) NOT NULL,
  time_zone VARCHAR(50) DEFAULT 'UTC',
  default_view VARCHAR(20) DEFAULT 'month' CHECK (default_view IN ('month', 'week', 'day', 'list')),
  week_starts_on SMALLINT DEFAULT 1 CHECK (week_starts_on IN (0, 1)),
  color_rules JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Gallery configuration
CREATE TABLE IF NOT EXISTS gallery_configs (
  view_id UUID PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
  cover_field VARCHAR(255),
  title_field VARCHAR(255) NOT NULL,
  fields_to_show JSONB DEFAULT '[]',
  columns INTEGER DEFAULT 3 CHECK (columns BETWEEN 2 AND 6),
  card_size VARCHAR(20) DEFAULT 'medium' CHECK (card_size IN ('small', 'medium', 'large')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Form configuration
CREATE TABLE IF NOT EXISTS form_configs (
  view_id UUID PRIMARY KEY REFERENCES views(id) ON DELETE CASCADE,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  field_layout JSONB NOT NULL DEFAULT '[]', -- Field ordering and layout
  submit_button_text VARCHAR(100) DEFAULT 'Submit',
  success_message TEXT,
  allow_multiple_submissions BOOLEAN DEFAULT FALSE,
  require_auth BOOLEAN DEFAULT FALSE,
  enable_public_access BOOLEAN DEFAULT TRUE,
  redirect_url VARCHAR(500),
  notification_emails JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Form submissions/responses
CREATE TABLE IF NOT EXISTS form_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID REFERENCES views(id) ON DELETE CASCADE,
  data JSONB NOT NULL,
  submitted_by INTEGER, -- REFERENCES users(id) - FK added conditionally below
  ip_address INET,
  user_agent TEXT,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  status VARCHAR(20) DEFAULT 'submitted' CHECK (status IN ('submitted', 'processed', 'archived'))
);

-- Add FK constraint only if users table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    BEGIN
      ALTER TABLE form_responses ADD CONSTRAINT form_responses_submitted_by_fkey FOREIGN KEY (submitted_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- View sharing and permissions
CREATE TABLE IF NOT EXISTS view_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  view_id UUID REFERENCES views(id) ON DELETE CASCADE,
  user_id INTEGER, -- REFERENCES users(id) - FK added conditionally below
  role_id TEXT, -- REFERENCES roles(id) - FK added conditionally below (roles.id is TEXT in migration 033)
  permission VARCHAR(20) NOT NULL CHECK (permission IN ('read', 'write', 'admin')),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by INTEGER, -- REFERENCES users(id) - FK added conditionally below

  -- Ensure unique permission per user/role and view
  CONSTRAINT unique_view_permission UNIQUE(view_id, user_id, role_id),
  CONSTRAINT user_or_role CHECK (
    (user_id IS NOT NULL AND role_id IS NULL) OR
    (user_id IS NULL AND role_id IS NOT NULL)
  )
);

-- Add FK constraints only if referenced tables exist with matching types
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    BEGIN
      ALTER TABLE view_permissions ADD CONSTRAINT view_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN
      ALTER TABLE view_permissions ADD CONSTRAINT view_permissions_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
  -- Only add role FK if roles table exists AND roles.id type matches (TEXT)
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'roles' AND column_name = 'id' AND data_type = 'text'
  ) THEN
    BEGIN
      ALTER TABLE view_permissions ADD CONSTRAINT view_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES roles(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- View activity log
-- Note: Partitioned tables require partition key (created_at) in primary key
CREATE TABLE IF NOT EXISTS view_activity (
  id UUID DEFAULT gen_random_uuid(),
  view_id UUID REFERENCES views(id) ON DELETE CASCADE,
  user_id INTEGER, -- REFERENCES users(id) - FK added conditionally below
  action VARCHAR(50) NOT NULL,
  details JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id, created_at)  -- Must include partition key created_at
) PARTITION BY RANGE (created_at);

-- Add FK constraint only if users table exists
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users') THEN
    BEGIN
      ALTER TABLE view_activity ADD CONSTRAINT view_activity_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Create initial partitions for view_activity (idempotent)
CREATE TABLE IF NOT EXISTS view_activity_2025_01 PARTITION OF view_activity
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE IF NOT EXISTS view_activity_2025_02 PARTITION OF view_activity
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE IF NOT EXISTS view_activity_2025_03 PARTITION OF view_activity
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');

-- Indexes for performance (with column existence checks)
-- Only create indexes if corresponding columns exist
DO $$ BEGIN
  -- Check both index column and deleted_at column for filtered indexes
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'owner_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'deleted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_tables_owner ON tables(owner_id) WHERE deleted_at IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'workspace_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'tables' AND column_name = 'deleted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_tables_workspace ON tables(workspace_id) WHERE deleted_at IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'table_id')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'deleted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_views_table ON views(table_id) WHERE deleted_at IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'type')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'deleted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_views_type ON views(type) WHERE deleted_at IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'created_by')
     AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'deleted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_views_created_by ON views(created_by) WHERE deleted_at IS NULL;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'user_id') THEN
    CREATE INDEX IF NOT EXISTS idx_view_states_user ON view_states(user_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'last_accessed') THEN
    CREATE INDEX IF NOT EXISTS idx_view_states_accessed ON view_states(last_accessed DESC);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'view_id') THEN
    CREATE INDEX IF NOT EXISTS idx_form_responses_view_id ON form_responses(view_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'submitted_at') THEN
    CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_at ON form_responses(submitted_at DESC);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'view_activity' AND column_name = 'created_at') THEN
    CREATE INDEX IF NOT EXISTS idx_view_activity_created_at ON view_activity(created_at DESC);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'view_activity' AND column_name = 'view_id') THEN
    CREATE INDEX IF NOT EXISTS idx_view_activity_view_id ON view_activity(view_id);
  END IF;
END $$;

-- Functions for automatic timestamp updates
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply update triggers (idempotent)
DROP TRIGGER IF EXISTS update_tables_updated_at ON tables;
CREATE TRIGGER update_tables_updated_at BEFORE UPDATE ON tables
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_views_updated_at ON views;
CREATE TRIGGER update_views_updated_at BEFORE UPDATE ON views
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states;
CREATE TRIGGER update_view_states_updated_at BEFORE UPDATE ON view_states
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_kanban_configs_updated_at ON kanban_configs;
CREATE TRIGGER update_kanban_configs_updated_at BEFORE UPDATE ON kanban_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_calendar_configs_updated_at ON calendar_configs;
CREATE TRIGGER update_calendar_configs_updated_at BEFORE UPDATE ON calendar_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_gallery_configs_updated_at ON gallery_configs;
CREATE TRIGGER update_gallery_configs_updated_at BEFORE UPDATE ON gallery_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS update_form_configs_updated_at ON form_configs;
CREATE TRIGGER update_form_configs_updated_at BEFORE UPDATE ON form_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Sample data for development
-- INSERT INTO tables (name, description, schema, owner_id) VALUES
-- ('Project Tasks', 'Project management tasks',
--  '{"columns": [
--    {"id": "title", "name": "Title", "type": "text"},
--    {"id": "status", "name": "Status", "type": "select"},
--    {"id": "priority", "name": "Priority", "type": "select"},
--    {"id": "assignee", "name": "Assignee", "type": "user"},
--    {"id": "due_date", "name": "Due Date", "type": "date"}
--  ]}', 1);

-- Comments for documentation (with column existence checks)
COMMENT ON TABLE tables IS 'Base table definitions for multi-view system';
COMMENT ON TABLE views IS 'View configurations for different visualization types';
COMMENT ON TABLE view_states IS 'User-specific view customizations and preferences';
COMMENT ON TABLE form_responses IS 'Submitted data from form views';

-- Only add column comments if columns exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'views' AND column_name = 'config') THEN
    COMMENT ON COLUMN views.config IS 'View-specific configuration in JSON format';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'state') THEN
    COMMENT ON COLUMN view_states.state IS 'User preferences: filters, sorting, column widths, etc';
  END IF;
END $$;