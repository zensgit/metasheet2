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

-- Create indexes for view_configs
CREATE INDEX IF NOT EXISTS idx_view_configs_type ON view_configs(type);
CREATE INDEX IF NOT EXISTS idx_view_configs_created_by ON view_configs(created_by);
CREATE INDEX IF NOT EXISTS idx_view_configs_deleted ON view_configs(deleted_at);

-- Create view_states table to store user-specific view states (filters, sorting, etc.)
CREATE TABLE IF NOT EXISTS view_states (
  view_id TEXT NOT NULL REFERENCES view_configs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  state_data JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (view_id, user_id)
);

-- Create index for view_states
CREATE INDEX IF NOT EXISTS idx_view_states_user ON view_states(user_id);

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

-- Create indexes for form_responses
CREATE INDEX IF NOT EXISTS idx_form_responses_form_id ON form_responses(form_id);
CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_by ON form_responses(submitted_by);
CREATE INDEX IF NOT EXISTS idx_form_responses_submitted_at ON form_responses(submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_responses_status ON form_responses(status);

-- Insert sample gallery view configuration
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

-- Insert sample form view configuration
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

-- Create a trigger function to automatically update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Create trigger for view_configs
DROP TRIGGER IF EXISTS update_view_configs_updated_at ON view_configs;
CREATE TRIGGER update_view_configs_updated_at
    BEFORE UPDATE ON view_configs
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Create trigger for view_states
DROP TRIGGER IF EXISTS update_view_states_updated_at ON view_states;
CREATE TRIGGER update_view_states_updated_at
    BEFORE UPDATE ON view_states
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Add comments for documentation
COMMENT ON TABLE view_configs IS 'Stores configuration for different view types (grid, kanban, calendar, gallery, form)';
COMMENT ON TABLE view_states IS 'Stores user-specific view states like filters, sorting, and pagination';
COMMENT ON TABLE form_responses IS 'Stores form submission responses with metadata';

COMMENT ON COLUMN view_configs.config_data IS 'JSONB field containing view-specific configuration (cardTemplate for gallery, fields for form, etc.)';
COMMENT ON COLUMN view_states.state_data IS 'JSONB field containing user view state (filters, sorting, pagination, selectedItems)';
COMMENT ON COLUMN form_responses.response_data IS 'JSONB field containing form submission data';
COMMENT ON COLUMN form_responses.submitted_by IS 'User ID of submitter, NULL for anonymous submissions';
COMMENT ON COLUMN form_responses.status IS 'Processing status: submitted, processed, or archived';