-- 068_create_integration_sealed_export_ingestion.sql
-- Sealed-export S3 private ingestion (#4682).
--
-- This schema persists private upload metadata only. Row-bearing chunk bytes
-- remain in the tenant-private blob area managed by the S3 blob adapter.

CREATE TABLE IF NOT EXISTS integration_sealed_export_ingestion_sessions (
  session_id                TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  workspace_id              TEXT,
  workspace_scope_key       TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding     TEXT NOT NULL,
  system_content_key        TEXT NOT NULL,
  role_binding_fingerprint  TEXT NOT NULL,
  manifest_digest           TEXT NOT NULL,
  export_request_envelope   JSONB NOT NULL,
  manifest                  JSONB NOT NULL,
  status                    TEXT NOT NULL CHECK (
    status IN ('UPLOADING', 'CHUNK_WRITING', 'UPLOAD_COMPLETE', 'CLEANING')
  ),
  expected_chunk_count      INTEGER NOT NULL CHECK (expected_chunk_count > 0),
  accepted_chunk_count      INTEGER NOT NULL DEFAULT 0 CHECK (accepted_chunk_count >= 0),
  pending_chunk_index       INTEGER CHECK (pending_chunk_index >= 0),
  pending_chunk_digest      TEXT,
  pending_byte_count        INTEGER CHECK (pending_byte_count >= 0),
  pending_write_token       TEXT,
  expires_at                TIMESTAMPTZ NOT NULL,
  completed_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (accepted_chunk_count <= expected_chunk_count),
  CHECK (
    (
      status = 'UPLOAD_COMPLETE'
      AND completed_at IS NOT NULL
      AND accepted_chunk_count = expected_chunk_count
    )
    OR status <> 'UPLOAD_COMPLETE'
  ),
  CHECK (
    status IN ('UPLOAD_COMPLETE', 'CLEANING')
    OR completed_at IS NULL
  ),
  CHECK (
    (
      status = 'CHUNK_WRITING'
      AND pending_chunk_index IS NOT NULL
      AND pending_chunk_digest IS NOT NULL
      AND pending_byte_count IS NOT NULL
      AND pending_write_token IS NOT NULL
      AND pending_chunk_index = accepted_chunk_count
    )
    OR
    (
      status <> 'CHUNK_WRITING'
      AND pending_chunk_index IS NULL
      AND pending_chunk_digest IS NULL
      AND pending_byte_count IS NULL
      AND pending_write_token IS NULL
    )
  ),
  CONSTRAINT uq_integration_sealed_export_ingestion_session_scope
    UNIQUE (
      session_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_sealed_export_ingestion_identity
  ON integration_sealed_export_ingestion_sessions (
    tenant_id,
    COALESCE(workspace_id, ''),
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    manifest_digest
  );

CREATE INDEX IF NOT EXISTS idx_integration_sealed_export_ingestion_expiry
  ON integration_sealed_export_ingestion_sessions (status, expires_at);

CREATE TABLE IF NOT EXISTS integration_sealed_export_ingestion_receipts (
  session_id       TEXT NOT NULL,
  tenant_id        TEXT NOT NULL,
  workspace_id     TEXT,
  workspace_scope_key       TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding     TEXT NOT NULL,
  system_content_key        TEXT NOT NULL,
  role_binding_fingerprint  TEXT NOT NULL,
  manifest_digest  TEXT NOT NULL,
  chunk_index      INTEGER NOT NULL CHECK (chunk_index >= 0),
  chunk_digest     TEXT NOT NULL,
  byte_count       INTEGER NOT NULL CHECK (byte_count >= 0),
  accepted_at      TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (session_id, chunk_index),
  CONSTRAINT fk_integration_sealed_export_ingestion_receipt_scope
    FOREIGN KEY (
      session_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    REFERENCES integration_sealed_export_ingestion_sessions (
      session_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_sealed_export_ingestion_receipts_scope
  ON integration_sealed_export_ingestion_receipts (
    tenant_id,
    COALESCE(workspace_id, ''),
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    session_id,
    chunk_index
  );

CREATE TABLE IF NOT EXISTS integration_sealed_export_ingestion_tombstones (
  session_id                 TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  manifest_digest            TEXT NOT NULL,
  cleanup_reason             TEXT NOT NULL CHECK (cleanup_reason IN ('COMPLETED', 'EXPIRED')),
  cleaned_at                 TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_sealed_export_ingestion_tombstone_identity
  ON integration_sealed_export_ingestion_tombstones (
    tenant_id,
    COALESCE(workspace_id, ''),
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    manifest_digest
  );

CREATE OR REPLACE FUNCTION integration_sealed_export_ingestion_session_anchors_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW.session_id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.tenant_domain_binding,
    NEW.system_content_key,
    NEW.role_binding_fingerprint,
    NEW.manifest_digest,
    NEW.export_request_envelope,
    NEW.manifest,
    NEW.expected_chunk_count,
    NEW.expires_at
  ) IS DISTINCT FROM ROW(
    OLD.session_id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.tenant_domain_binding,
    OLD.system_content_key,
    OLD.role_binding_fingerprint,
    OLD.manifest_digest,
    OLD.export_request_envelope,
    OLD.manifest,
    OLD.expected_chunk_count,
    OLD.expires_at
  ) THEN
    RAISE EXCEPTION 'sealed-export ingestion session anchors are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_ingestion_sessions_anchors_immutable'
      AND tgrelid = 'integration_sealed_export_ingestion_sessions'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_ingestion_sessions_anchors_immutable
      BEFORE UPDATE ON integration_sealed_export_ingestion_sessions
      FOR EACH ROW EXECUTE FUNCTION integration_sealed_export_ingestion_session_anchors_immutable();
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_ingestion_sessions_updated_at'
      AND tgrelid = 'integration_sealed_export_ingestion_sessions'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_ingestion_sessions_updated_at
      BEFORE UPDATE ON integration_sealed_export_ingestion_sessions
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
