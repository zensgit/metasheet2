-- 038_config_and_secrets.sql
-- Configuration and Secret Management Tables

-- System configuration table
CREATE TABLE IF NOT EXISTS system_configs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  key VARCHAR(255) UNIQUE NOT NULL,
  value JSONB NOT NULL,
  description TEXT,
  category VARCHAR(100),
  is_encrypted BOOLEAN DEFAULT FALSE,
  is_secret BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT
);

-- Indexes for configuration
CREATE INDEX IF NOT EXISTS idx_configs_category ON system_configs(category);
CREATE INDEX IF NOT EXISTS idx_configs_key ON system_configs(key);
CREATE INDEX IF NOT EXISTS idx_configs_encrypted ON system_configs(is_encrypted) WHERE is_encrypted = true;

-- Comments
COMMENT ON TABLE system_configs IS 'System-wide configuration storage with encryption support';
COMMENT ON COLUMN system_configs.key IS 'Configuration key in dot notation (e.g., app.port)';
COMMENT ON COLUMN system_configs.value IS 'Configuration value stored as JSONB';
COMMENT ON COLUMN system_configs.is_encrypted IS 'Whether the value is encrypted';
COMMENT ON COLUMN system_configs.is_secret IS 'Whether this is a secret that should not be exposed';

-- Secrets management table
CREATE TABLE IF NOT EXISTS secrets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  name VARCHAR(255) UNIQUE NOT NULL,
  encrypted_value TEXT NOT NULL,
  key_version INTEGER DEFAULT 1,
  rotation_policy JSONB DEFAULT '{"enabled": false}',
  last_rotated_at TIMESTAMP,
  expires_at TIMESTAMP,
  tags JSONB DEFAULT '[]',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_by TEXT
);

-- Indexes for secrets
CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name);
CREATE INDEX IF NOT EXISTS idx_secrets_expires ON secrets(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_secrets_rotation ON secrets(last_rotated_at);
CREATE INDEX IF NOT EXISTS idx_secrets_tags ON secrets USING gin(tags);

-- Comments
COMMENT ON TABLE secrets IS 'Encrypted secrets storage with rotation support';
COMMENT ON COLUMN secrets.name IS 'Unique secret identifier';
COMMENT ON COLUMN secrets.encrypted_value IS 'AES-256-GCM encrypted value';
COMMENT ON COLUMN secrets.key_version IS 'Version of encryption key used';
COMMENT ON COLUMN secrets.rotation_policy IS 'Automatic rotation policy configuration';

-- Secret access audit table
CREATE TABLE IF NOT EXISTS secret_access_logs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  secret_id TEXT REFERENCES secrets(id) ON DELETE CASCADE,
  secret_name VARCHAR(255) NOT NULL,
  accessed_by TEXT NOT NULL,
  access_type VARCHAR(50) NOT NULL, -- read, write, delete, rotate
  ip_address INET,
  user_agent TEXT,
  success BOOLEAN DEFAULT true,
  error_message TEXT,
  accessed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for audit
CREATE INDEX IF NOT EXISTS idx_secret_access_secret ON secret_access_logs(secret_id);
CREATE INDEX IF NOT EXISTS idx_secret_access_user ON secret_access_logs(accessed_by);
CREATE INDEX IF NOT EXISTS idx_secret_access_time ON secret_access_logs(accessed_at DESC);

-- Configuration change history
CREATE TABLE IF NOT EXISTS config_history (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  config_id TEXT REFERENCES system_configs(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  old_value JSONB,
  new_value JSONB,
  changed_by TEXT,
  change_reason TEXT,
  changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for history
CREATE INDEX IF NOT EXISTS idx_config_history_config ON config_history(config_id);
CREATE INDEX IF NOT EXISTS idx_config_history_key ON config_history(key);
CREATE INDEX IF NOT EXISTS idx_config_history_time ON config_history(changed_at DESC);

-- Insert default configurations
INSERT INTO system_configs (key, value, description, category, is_secret)
VALUES
  ('app.name', '"MetaSheet"', 'Application name', 'app', false),
  ('app.version', '"2.0.0"', 'Application version', 'app', false),
  ('app.env', '"development"', 'Environment mode', 'app', false),
  ('logging.level', '"info"', 'Logging level', 'logging', false),
  ('logging.format', '"json"', 'Log output format', 'logging', false),
  ('metrics.enabled', 'true', 'Enable metrics collection', 'metrics', false),
  ('security.rateLimit.enabled', 'true', 'Enable rate limiting', 'security', false),
  ('security.rateLimit.max', '100', 'Max requests per window', 'security', false),
  ('workflow.maxRetries', '3', 'Maximum workflow retry attempts', 'workflow', false),
  ('workflow.retryDelay', '60000', 'Delay between retries (ms)', 'workflow', false)
ON CONFLICT (key) DO NOTHING;

-- Create trigger to update updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to tables
CREATE TRIGGER update_system_configs_updated_at
  BEFORE UPDATE ON system_configs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_secrets_updated_at
  BEFORE UPDATE ON secrets
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Function to rotate encryption key
CREATE OR REPLACE FUNCTION rotate_encryption_key(old_key_version INTEGER, new_key_version INTEGER)
RETURNS INTEGER AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  -- This is a placeholder for key rotation logic
  -- Actual implementation would re-encrypt all secrets with new key
  UPDATE secrets
  SET key_version = new_key_version,
      last_rotated_at = CURRENT_TIMESTAMP
  WHERE key_version = old_key_version;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$ LANGUAGE plpgsql;

-- Function to clean up expired secrets
CREATE OR REPLACE FUNCTION cleanup_expired_secrets()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM secrets
  WHERE expires_at IS NOT NULL
    AND expires_at < CURRENT_TIMESTAMP;

  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;