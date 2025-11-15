-- 042b: External data source auxiliary tables extracted from 042 for staged rollout

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Data source credentials (secure storage)
CREATE TABLE IF NOT EXISTS data_source_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  data_source_id UUID NOT NULL,
  credential_type VARCHAR(50) NOT NULL,
  encrypted_value TEXT NOT NULL,
  encryption_key_id VARCHAR(255) NOT NULL,
  oauth_provider VARCHAR(100),
  oauth_scopes JSONB DEFAULT '[]',
  refresh_token TEXT,
  token_expiry TIMESTAMP WITH TIME ZONE,
  cert_fingerprint VARCHAR(255),
  cert_expiry TIMESTAMP WITH TIME ZONE,
  created_by UUID,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  last_used TIMESTAMP WITH TIME ZONE,
  expires_at TIMESTAMP WITH TIME ZONE,
  CONSTRAINT valid_credential_type CHECK (credential_type IN ('PASSWORD','API_KEY','OAUTH','CERTIFICATE','SSH_KEY','BEARER_TOKEN'))
);

CREATE INDEX IF NOT EXISTS idx_data_source_credentials_source ON data_source_credentials(data_source_id);
CREATE INDEX IF NOT EXISTS idx_data_source_credentials_expiry ON data_source_credentials(expires_at) WHERE expires_at IS NOT NULL;

-- External tables mapping (virtual tables)
CREATE TABLE IF NOT EXISTS external_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID,
  data_source_id UUID NOT NULL,
  external_schema VARCHAR(255),
  external_table VARCHAR(255) NOT NULL,
  external_primary_key VARCHAR(255),
  sync_mode VARCHAR(50) DEFAULT 'LAZY',
  sync_interval INTEGER,
  last_sync TIMESTAMP WITH TIME ZONE,
  next_sync TIMESTAMP WITH TIME ZONE,
  field_mappings JSONB NOT NULL DEFAULT '{}',
  transform_rules JSONB DEFAULT '[]',
  query_hints JSONB DEFAULT '{}',
  cache_ttl INTEGER DEFAULT 300,
  max_cache_size BIGINT DEFAULT 10485760,
  total_rows BIGINT,
  sync_duration_ms BIGINT,
  error_count INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_external_tables_table ON external_tables(table_id);
CREATE INDEX IF NOT EXISTS idx_external_tables_source ON external_tables(data_source_id);
CREATE INDEX IF NOT EXISTS idx_external_tables_next_sync ON external_tables(next_sync) WHERE sync_mode = 'SCHEDULED';

-- Add FKs only if referenced tables exist
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='users') THEN
    BEGIN
      ALTER TABLE data_source_credentials
        ADD CONSTRAINT fk_dscred_user FOREIGN KEY (created_by) REFERENCES users(id);
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='tables') THEN
    BEGIN
      ALTER TABLE external_tables
        ADD CONSTRAINT fk_external_tables_table FOREIGN KEY (table_id) REFERENCES tables(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL; END;
  END IF;
END $$;
