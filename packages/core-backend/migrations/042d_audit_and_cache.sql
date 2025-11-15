-- 042d: Audit signatures and query cache extracted from 042

-- Audit signatures for audit log integrity
CREATE TABLE IF NOT EXISTS audit_signatures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  audit_log_id UUID NOT NULL,
  signature BYTEA NOT NULL,
  signature_type VARCHAR(20) NOT NULL,
  algorithm VARCHAR(50) NOT NULL,
  key_id VARCHAR(255),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  previous_signature_id UUID,
  CONSTRAINT valid_signature_type CHECK (signature_type IN ('HMAC','RSA','ECDSA','ED25519'))
);

CREATE INDEX IF NOT EXISTS idx_audit_signatures_log ON audit_signatures(audit_log_id);
CREATE INDEX IF NOT EXISTS idx_audit_signatures_chain ON audit_signatures(previous_signature_id);

-- Query cache for performance
CREATE TABLE IF NOT EXISTS query_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash VARCHAR(64) NOT NULL,
  params_hash VARCHAR(64) NOT NULL,
  result JSONB,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP WITH TIME ZONE,
  invalidated_at TIMESTAMP WITH TIME ZONE,
  table_id UUID,
  CONSTRAINT unique_query_cache UNIQUE (query_hash, params_hash)
);

CREATE INDEX IF NOT EXISTS idx_query_cache_hash ON query_cache(query_hash);
CREATE INDEX IF NOT EXISTS idx_query_cache_expires ON query_cache(expires_at) WHERE invalidated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_query_cache_table ON query_cache(table_id) WHERE table_id IS NOT NULL;

