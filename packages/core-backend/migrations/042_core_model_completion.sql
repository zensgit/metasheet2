-- MetaSheet V2 Core Model Completion
-- This migration adds missing core tables identified in the framework requirements

-- ============================================
-- 1. WORKFLOW ENGINE TABLES
-- ============================================

-- Workflow execution tokens for parallel flow management
CREATE TABLE IF NOT EXISTS workflow_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL,
  node_id VARCHAR(255) NOT NULL,
  token_type VARCHAR(50) NOT NULL, -- 'EXECUTION', 'WAIT', 'COMPENSATE'
  status VARCHAR(50) NOT NULL DEFAULT 'ACTIVE', -- 'ACTIVE', 'CONSUMED', 'CANCELLED'
  parent_token_id UUID,
  variables JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  consumed_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT valid_token_type CHECK (token_type IN ('EXECUTION', 'WAIT', 'COMPENSATE')),
  CONSTRAINT valid_token_status CHECK (status IN ('ACTIVE', 'CONSUMED', 'CANCELLED'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_tokens_instance ON workflow_tokens(instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_tokens_status ON workflow_tokens(status) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS idx_workflow_tokens_parent ON workflow_tokens(parent_token_id);

-- Workflow incidents for error tracking and recovery
CREATE TABLE IF NOT EXISTS workflow_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id UUID NOT NULL,
  token_id UUID,
  incident_type VARCHAR(50) NOT NULL, -- 'ERROR', 'TIMEOUT', 'COMPENSATION_FAILED'
  severity VARCHAR(20) NOT NULL DEFAULT 'ERROR', -- 'WARNING', 'ERROR', 'CRITICAL'
  node_id VARCHAR(255),
  error_code VARCHAR(100),
  error_message TEXT,
  stack_trace TEXT,
  incident_data JSONB DEFAULT '{}',
  resolution_status VARCHAR(50) DEFAULT 'OPEN', -- 'OPEN', 'IN_PROGRESS', 'RESOLVED', 'IGNORED'
  resolved_by UUID,
  resolved_at TIMESTAMP WITH TIME ZONE,
  resolution_notes TEXT,
  retry_count INTEGER DEFAULT 0,
  max_retries INTEGER DEFAULT 3,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT valid_incident_type CHECK (incident_type IN ('ERROR', 'TIMEOUT', 'COMPENSATION_FAILED', 'VALIDATION_ERROR', 'SYSTEM_ERROR')),
  CONSTRAINT valid_severity CHECK (severity IN ('WARNING', 'ERROR', 'CRITICAL')),
  CONSTRAINT valid_resolution_status CHECK (resolution_status IN ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'IGNORED'))
);

CREATE INDEX IF NOT EXISTS idx_workflow_incidents_instance ON workflow_incidents(instance_id);
CREATE INDEX IF NOT EXISTS idx_workflow_incidents_status ON workflow_incidents(resolution_status) WHERE resolution_status IN ('OPEN', 'IN_PROGRESS');
CREATE INDEX IF NOT EXISTS idx_workflow_incidents_created ON workflow_incidents(created_at);

-- ============================================
-- 2. UNIFIED DATA MODEL TABLES
-- ============================================

-- Unified tables definition (base for all views)
CREATE TABLE IF NOT EXISTS tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  icon VARCHAR(100),
  color VARCHAR(7), -- Hex color code

  -- Table configuration
  table_type VARCHAR(50) NOT NULL DEFAULT 'STANDARD', -- 'STANDARD', 'EXTERNAL', 'MATERIALIZED', 'VIRTUAL'
  source_config JSONB DEFAULT '{}', -- External source configuration

  -- Schema definition
  fields JSONB NOT NULL DEFAULT '[]', -- Array of field definitions
  primary_key VARCHAR(255) DEFAULT 'id',
  indexes JSONB DEFAULT '[]',

  -- Data settings
  row_count BIGINT DEFAULT 0,
  storage_size BIGINT DEFAULT 0,
  last_modified TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  -- Features
  features JSONB DEFAULT '{
    "versioning": true,
    "audit": true,
    "trash": true,
    "comments": true,
    "attachments": true
  }',

  -- Metadata
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_by UUID,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT unique_table_name_workspace UNIQUE (workspace_id, name),
  CONSTRAINT valid_table_type CHECK (table_type IN ('STANDARD', 'EXTERNAL', 'MATERIALIZED', 'VIRTUAL'))
);

CREATE INDEX IF NOT EXISTS idx_tables_workspace ON tables(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tables_type ON tables(table_type);
CREATE INDEX IF NOT EXISTS idx_tables_deleted ON tables(deleted_at);

-- NOTE: view_states table is defined in 043_core_model_views.sql
-- Removed from here to avoid conflicts with 037 and 043

-- ============================================
-- 3. EXTERNAL DATA SOURCE TABLES
-- ============================================

-- Data source credentials (secure storage)
CREATE TABLE IF NOT EXISTS data_source_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID NOT NULL,
  credential_type VARCHAR(50) NOT NULL, -- 'PASSWORD', 'API_KEY', 'OAUTH', 'CERTIFICATE'

  -- Encrypted credential storage
  encrypted_value TEXT NOT NULL, -- Encrypted with KMS
  encryption_key_id VARCHAR(255) NOT NULL, -- KMS key reference

  -- OAuth specific
  oauth_provider VARCHAR(100),
  oauth_scopes JSONB DEFAULT '[]',
  refresh_token TEXT,
  token_expiry TIMESTAMP WITH TIME ZONE,

  -- Certificate specific
  cert_fingerprint VARCHAR(255),
  cert_expiry TIMESTAMP WITH TIME ZONE,

  -- Metadata
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_used TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,

  CONSTRAINT valid_credential_type CHECK (credential_type IN ('PASSWORD', 'API_KEY', 'OAUTH', 'CERTIFICATE', 'SSH_KEY', 'BEARER_TOKEN'))
);

CREATE INDEX IF NOT EXISTS idx_data_source_credentials_source ON data_source_credentials(data_source_id);
CREATE INDEX IF NOT EXISTS idx_data_source_credentials_expiry ON data_source_credentials(expires_at) WHERE expires_at IS NOT NULL;

-- External tables mapping (virtual tables)
CREATE TABLE IF NOT EXISTS external_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID,
  data_source_id UUID NOT NULL,

  -- External mapping
  external_schema VARCHAR(255),
  external_table VARCHAR(255) NOT NULL,
  external_primary_key VARCHAR(255),

  -- Sync configuration
  sync_mode VARCHAR(50) DEFAULT 'LAZY', -- 'LAZY', 'EAGER', 'SCHEDULED', 'REALTIME'
  sync_interval INTEGER, -- seconds
  last_sync TIMESTAMP WITH TIME ZONE,
  next_sync TIMESTAMP WITH TIME ZONE,

  -- Field mapping
  field_mappings JSONB NOT NULL DEFAULT '{}', -- Internal to external field mapping
  transform_rules JSONB DEFAULT '[]', -- Data transformation rules

  -- Query optimization
  query_hints JSONB DEFAULT '{}',
  cache_ttl INTEGER DEFAULT 300, -- seconds
  max_cache_size BIGINT DEFAULT 10485760, -- 10MB default

  -- Statistics
  total_rows BIGINT,
  sync_duration_ms BIGINT,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT unique_external_table UNIQUE (data_source_id, external_schema, external_table),
  CONSTRAINT valid_sync_mode CHECK (sync_mode IN ('LAZY', 'EAGER', 'SCHEDULED', 'REALTIME'))
);

CREATE INDEX IF NOT EXISTS idx_external_tables_table ON external_tables(table_id);
CREATE INDEX IF NOT EXISTS idx_external_tables_source ON external_tables(data_source_id);
CREATE INDEX IF NOT EXISTS idx_external_tables_next_sync ON external_tables(next_sync) WHERE sync_mode = 'SCHEDULED';

-- NOTE: plugin_manifests and plugin_dependencies tables are defined in:
-- - 008_plugin_infrastructure.sql (legacy version)
-- - 046_plugins_and_templates.sql (current version)
-- Removed from here to avoid schema conflicts

-- ============================================
-- 4. SCRIPT EXECUTION TRACKING
-- ============================================

-- NOTE: script_executions table is defined in 041_script_sandbox.sql
-- Removed from here to avoid conflicts with 041

-- ============================================
-- 6. TEMPLATE SYSTEM
-- ============================================

-- Templates marketplace
CREATE TABLE IF NOT EXISTS templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) NOT NULL UNIQUE,
  category VARCHAR(100) NOT NULL,
  subcategory VARCHAR(100),

  -- Template details
  description TEXT,
  preview_url VARCHAR(500),
  thumbnail_url VARCHAR(500),

  -- Template content
  template_type VARCHAR(50) NOT NULL, -- 'TABLE', 'WORKFLOW', 'VIEW', 'APP', 'PLUGIN'
  template_data JSONB NOT NULL,

  -- Metadata
  tags TEXT[],
  features TEXT[],
  industries TEXT[],
  use_cases TEXT[],

  -- Usage stats
  install_count INTEGER DEFAULT 0,
  rating_avg DECIMAL(3,2),
  rating_count INTEGER DEFAULT 0,

  -- Publishing
  author_id UUID,
  is_official BOOLEAN DEFAULT FALSE,
  is_featured BOOLEAN DEFAULT FALSE,
  published_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT valid_template_type CHECK (template_type IN ('TABLE', 'WORKFLOW', 'VIEW', 'APP', 'PLUGIN', 'DASHBOARD'))
);

CREATE INDEX IF NOT EXISTS idx_templates_slug ON templates(slug);
CREATE INDEX IF NOT EXISTS idx_templates_category ON templates(category);
CREATE INDEX IF NOT EXISTS idx_templates_featured ON templates(is_featured) WHERE is_featured = TRUE;
CREATE INDEX IF NOT EXISTS idx_templates_published ON templates(published_at) WHERE published_at IS NOT NULL;

-- ============================================
-- 7. AUDIT ENHANCEMENTS
-- ============================================

-- Audit log signatures for tamper detection
CREATE TABLE IF NOT EXISTS audit_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_log_id UUID NOT NULL,
  signature_type VARCHAR(50) NOT NULL DEFAULT 'HMAC', -- 'HMAC', 'RSA', 'ECDSA'
  signature_value TEXT NOT NULL,
  signing_key_id VARCHAR(255) NOT NULL,

  -- Chain of custody
  previous_signature_id UUID,
  chain_hash VARCHAR(255), -- Hash of current + previous

  -- Verification
  verified_at TIMESTAMP WITH TIME ZONE,
  verified_by VARCHAR(255),
  verification_status VARCHAR(50), -- 'VALID', 'INVALID', 'PENDING'

  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT valid_signature_type CHECK (signature_type IN ('HMAC', 'RSA', 'ECDSA', 'ED25519'))
);

CREATE INDEX IF NOT EXISTS idx_audit_signatures_log ON audit_signatures(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_signatures_chain ON audit_signatures(previous_signature_id);

-- ============================================
-- 8. PERFORMANCE OPTIMIZATION TABLES
-- ============================================

-- Query cache for expensive operations
CREATE TABLE IF NOT EXISTS query_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash VARCHAR(255) NOT NULL,
  query_type VARCHAR(50) NOT NULL, -- 'VIEW', 'AGGREGATION', 'REPORT'

  -- Cache key components
  table_id UUID,
  view_id UUID,
  user_id UUID,
  params_hash VARCHAR(255),

  -- Cache data
  result_data JSONB NOT NULL,
  result_count INTEGER,

  -- Validity
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  invalidated_at TIMESTAMP WITH TIME ZONE,

  -- Statistics
  hit_count INTEGER DEFAULT 0,
  last_accessed TIMESTAMP WITH TIME ZONE,
  size_bytes BIGINT,

  CONSTRAINT unique_query_cache UNIQUE (query_hash, params_hash)
);

CREATE INDEX IF NOT EXISTS idx_query_cache_hash ON query_cache(query_hash);
CREATE INDEX IF NOT EXISTS idx_query_cache_expires ON query_cache(expires_at) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_query_cache_table ON query_cache(table_id) WHERE table_id IS NOT NULL;

-- ============================================
-- TRIGGERS AND FUNCTIONS
-- ============================================

-- Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at trigger to new tables
DO $$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'workflow_tokens', 'workflow_incidents', 'tables',
      'data_source_credentials', 'external_tables', 'templates'
    ])
  LOOP
    -- Only create trigger if table exists and trigger doesn't exist
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = t) THEN
      BEGIN
        EXECUTE format('
          CREATE TRIGGER update_%I_updated_at
          BEFORE UPDATE ON %I
          FOR EACH ROW
          EXECUTE FUNCTION update_updated_at_column()',
          t, t
        );
      EXCEPTION WHEN duplicate_object THEN NULL; END;
    END IF;
  END LOOP;
END $$;

-- NOTE: view_states, plugin_manifests, plugin_dependencies triggers are defined in their respective migrations

-- Create function to validate JSON schema
CREATE OR REPLACE FUNCTION validate_json_schema(data JSONB, schema JSONB)
RETURNS BOOLEAN AS $$
BEGIN
  -- Basic validation, can be extended with pg_jsonschema extension
  RETURN data IS NOT NULL;
END;
$$ LANGUAGE plpgsql;

-- ============================================
-- INITIAL DATA AND INDEXES
-- ============================================

-- Create indexes for foreign keys and common queries
CREATE INDEX IF NOT EXISTS idx_workflow_tokens_created ON workflow_tokens(created_at);
CREATE INDEX IF NOT EXISTS idx_tables_created ON tables(created_at);
CREATE INDEX IF NOT EXISTS idx_templates_tags ON templates USING GIN (tags);
-- NOTE: script_executions indexes are defined in 041_script_sandbox.sql

-- Add comments for documentation
COMMENT ON TABLE workflow_tokens IS 'Execution tokens for parallel workflow processing (Camunda-style)';
COMMENT ON TABLE workflow_incidents IS 'Workflow error tracking and incident management';
COMMENT ON TABLE tables IS 'Unified table definitions for multi-view system';
-- NOTE: view_states comment is in 043_core_model_views.sql
COMMENT ON TABLE data_source_credentials IS 'Secure storage for external data source credentials';
COMMENT ON TABLE external_tables IS 'Virtual table mappings to external data sources';
-- NOTE: plugin_manifests comment is in 046_plugins_and_templates.sql
-- NOTE: script_executions comment is in 041_script_sandbox.sql
COMMENT ON TABLE templates IS 'Template marketplace for sharing configurations';
COMMENT ON TABLE audit_signatures IS 'Cryptographic signatures for audit log integrity';
COMMENT ON TABLE query_cache IS 'Performance cache for expensive queries';

-- ============================================
-- CONDITIONAL FOREIGN KEYS
-- ============================================
-- Add foreign keys only if referenced tables exist

-- Workflow tokens -> workflow_instances
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_instances'
  ) THEN
    BEGIN
      ALTER TABLE workflow_tokens
        ADD CONSTRAINT fk_workflow_tokens_instance FOREIGN KEY (instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Workflow tokens -> workflow_tokens (parent)
DO $$ BEGIN
  BEGIN
    ALTER TABLE workflow_tokens
      ADD CONSTRAINT fk_workflow_tokens_parent FOREIGN KEY (parent_token_id) REFERENCES workflow_tokens(id);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- Workflow incidents -> workflow_instances
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'workflow_instances'
  ) THEN
    BEGIN
      ALTER TABLE workflow_incidents
        ADD CONSTRAINT fk_workflow_incidents_instance FOREIGN KEY (instance_id) REFERENCES workflow_instances(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Workflow incidents -> workflow_tokens
DO $$ BEGIN
  BEGIN
    ALTER TABLE workflow_incidents
      ADD CONSTRAINT fk_workflow_incidents_token FOREIGN KEY (token_id) REFERENCES workflow_tokens(id);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- Workflow incidents -> users (resolved_by)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    BEGIN
      ALTER TABLE workflow_incidents
        ADD CONSTRAINT fk_workflow_incidents_resolved_by FOREIGN KEY (resolved_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Tables -> users (created_by, updated_by)
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    BEGIN
      ALTER TABLE tables
        ADD CONSTRAINT fk_tables_created_by FOREIGN KEY (created_by) REFERENCES users(id);
      ALTER TABLE tables
        ADD CONSTRAINT fk_tables_updated_by FOREIGN KEY (updated_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- NOTE: view_states FK is defined in 043_core_model_views.sql

-- Data source credentials -> users
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    BEGIN
      ALTER TABLE data_source_credentials
        ADD CONSTRAINT fk_data_source_credentials_created_by FOREIGN KEY (created_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- External tables -> tables
DO $$ BEGIN
  BEGIN
    ALTER TABLE external_tables
      ADD CONSTRAINT fk_external_tables_table FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE;
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;

-- NOTE: plugin_manifests and plugin_dependencies FKs are defined in 046_plugins_and_templates.sql
-- NOTE: script_executions FK is defined in 041_script_sandbox.sql

-- Templates -> users
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'users'
  ) THEN
    BEGIN
      ALTER TABLE templates
        ADD CONSTRAINT fk_templates_author FOREIGN KEY (author_id) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;

-- Audit signatures chain
DO $$ BEGIN
  BEGIN
    ALTER TABLE audit_signatures
      ADD CONSTRAINT fk_audit_signatures_previous FOREIGN KEY (previous_signature_id) REFERENCES audit_signatures(id);
  EXCEPTION WHEN duplicate_object THEN NULL; END;
END $$;
