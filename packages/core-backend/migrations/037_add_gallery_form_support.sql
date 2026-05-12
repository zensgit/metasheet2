-- 037_add_gallery_form_support.sql
-- Adds support for Gallery and Form views in the MetaSheet multi-view system

-- Create view_configs table to store view configurations
CREATE TABLE IF NOT EXISTS view_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('grid', 'kanban', 'calendar', 'gallery', 'form')),
  description TEXT,
  config_data JSONB NOT NULL DEFAULT '{}',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ NULL
);

-- Create indexes for view_configs.
-- Guard each column so this migration can run after timestamp-based view
-- migrations that may have already created a narrower/different table shape.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'type'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_view_configs_type ON view_configs(type);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'created_by'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_view_configs_created_by ON view_configs(created_by);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'deleted_at'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_view_configs_deleted ON view_configs(deleted_at);
  END IF;
END $$;

-- Create view_states table to store user-specific view states (filters, sorting, etc.)
CREATE TABLE IF NOT EXISTS view_states (
  view_id TEXT NOT NULL REFERENCES view_configs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  state_data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (view_id, user_id)
);

-- Create index for view_states. Some deployments already have the
-- timestamp-based view_states table; keep the migration column-aware.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'user_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_view_states_user ON view_states(user_id);
  END IF;
END $$;

-- Create form_responses table to store form submissions
CREATE TABLE IF NOT EXISTS form_responses (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES view_configs(id) ON DELETE CASCADE,
  response_data JSONB NOT NULL DEFAULT '{}',
  submitted_by TEXT NULL, -- NULL for anonymous submissions
  ip_address TEXT NULL,
  user_agent TEXT NULL,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'processed', 'archived'))
);

-- Create indexes for form_responses.
-- Compatibility note: newer timestamp migrations create form_responses with
-- view_id/data instead of this older migration's form_id/response_data names.
-- If that schema already exists, CREATE TABLE IF NOT EXISTS above is a no-op;
-- these guards prevent the missing form_id column from blocking upgrades.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'form_id'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_form_responses_form_id ON form_responses(form_id);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'submitted_by'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_by ON form_responses(submitted_by);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'submitted_at'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_at ON form_responses(submitted_at DESC);
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'status'
  ) THEN
    CREATE INDEX IF NOT EXISTS idx_form_responses_status ON form_responses(status);
  END IF;
END $$;

-- Insert sample gallery/form view configurations when the active view_configs
-- table has the legacy 037 seed shape.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'id'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'name'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'type'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'description'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'config_data'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'created_by'
  ) THEN
    INSERT INTO view_configs (id, name, type, description, config_data, created_by) VALUES
    ('gallery-demo', '示例图库视图', 'gallery', '用于演示的图库视图配置', '{
      "cardTemplate": {
        "titleField": "title",
        "contentFields": ["content"],
        "imageField": "image",
        "tagFields": ["tags"]
      },
      "layout": {
        "columns": 3,
        "cardSize": "medium",
        "spacing": "normal"
      },
      "display": {
        "showTitle": true,
        "showContent": true,
        "showImage": true,
        "showTags": true,
        "truncateContent": true,
        "maxContentLength": 150
      }
    }', 'system') ON CONFLICT (id) DO NOTHING;

    INSERT INTO view_configs (id, name, type, description, config_data, created_by) VALUES
    ('form-demo', '示例表单视图', 'form', '用于演示的表单视图配置', '{
      "fields": [
        {
          "id": "1",
          "name": "name",
          "label": "姓名",
          "type": "text",
          "required": true,
          "placeholder": "请输入您的姓名",
          "order": 1,
          "width": "full"
        },
        {
          "id": "2",
          "name": "email",
          "label": "邮箱",
          "type": "email",
          "required": true,
          "placeholder": "请输入您的邮箱",
          "order": 2,
          "width": "full"
        },
        {
          "id": "3",
          "name": "message",
          "label": "留言",
          "type": "textarea",
          "required": false,
          "placeholder": "请输入您的留言",
          "order": 3,
          "width": "full"
        },
        {
          "id": "4",
          "name": "rating",
          "label": "评分",
          "type": "rating",
          "required": false,
          "order": 4,
          "width": "half"
        }
      ],
      "settings": {
        "title": "反馈表单",
        "description": "请填写以下信息，我们会及时回复您",
        "submitButtonText": "提交反馈",
        "successMessage": "感谢您的反馈！我们会认真处理您的建议。",
        "allowMultiple": true,
        "requireAuth": false,
        "enablePublicAccess": true,
        "notifyOnSubmission": false
      },
      "validation": {
        "enableValidation": true
      },
      "styling": {
        "theme": "default",
        "layout": "single-column"
      }
    }', 'system') ON CONFLICT (id) DO NOTHING;
  END IF;
END $$;

-- Create a trigger function to automatically update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for view_configs when the table has updated_at.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS update_view_configs_updated_at ON view_configs;
    CREATE TRIGGER update_view_configs_updated_at
        BEFORE UPDATE ON view_configs
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Create trigger for view_states only when the active schema has updated_at.
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'updated_at'
  ) THEN
    DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states;
    CREATE TRIGGER update_view_states_updated_at
        BEFORE UPDATE ON view_states
        FOR EACH ROW
        EXECUTE FUNCTION update_updated_at_column();
  END IF;
END $$;

-- Add comments for documentation
COMMENT ON TABLE view_configs IS 'Stores configuration for different view types (grid, kanban, calendar, gallery, form)';
COMMENT ON TABLE view_states IS 'Stores user-specific view states like filters, sorting, and pagination';
COMMENT ON TABLE form_responses IS 'Stores form submission responses with metadata';

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_configs' AND column_name = 'config_data'
  ) THEN
    COMMENT ON COLUMN view_configs.config_data IS 'JSONB field containing view-specific configuration (cardTemplate for gallery, fields for form, etc.)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'view_states' AND column_name = 'state_data'
  ) THEN
    COMMENT ON COLUMN view_states.state_data IS 'JSONB field containing user view state (filters, sorting, pagination, selectedItems)';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'response_data'
  ) THEN
    COMMENT ON COLUMN form_responses.response_data IS 'JSONB field containing form submission data';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'submitted_by'
  ) THEN
    COMMENT ON COLUMN form_responses.submitted_by IS 'User ID of submitter, NULL for anonymous submissions';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'form_responses' AND column_name = 'status'
  ) THEN
    COMMENT ON COLUMN form_responses.status IS 'Processing status: submitted, processed, or archived';
  END IF;
END $$;
