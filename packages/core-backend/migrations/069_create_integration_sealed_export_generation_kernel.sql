-- 069_create_integration_sealed_export_generation_kernel.sql
-- Sealed-export S4 latent generation kernel (#4684).
--
-- This schema is private and tenant/system scoped. It has no route, scheduler,
-- runtime flag, deployment hook or external-system write surface.

ALTER TABLE integration_sealed_export_ingestion_sessions
  ADD COLUMN IF NOT EXISTS generation_claim_id TEXT,
  ADD COLUMN IF NOT EXISTS generation_claimed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chk_integration_sealed_export_ingestion_generation_claim'
      AND conrelid = 'integration_sealed_export_ingestion_sessions'::regclass
  ) THEN
    ALTER TABLE integration_sealed_export_ingestion_sessions
      ADD CONSTRAINT chk_integration_sealed_export_ingestion_generation_claim
      CHECK (
        (
          generation_claim_id IS NULL
          AND generation_claimed_at IS NULL
        )
        OR
        (
          generation_claim_id IS NOT NULL
          AND generation_claimed_at IS NOT NULL
          AND status = 'UPLOAD_COMPLETE'
        )
      );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS integration_sealed_export_generations (
  generation_id              TEXT PRIMARY KEY,
  session_id                 TEXT NOT NULL UNIQUE,
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  manifest_digest            TEXT NOT NULL,
  signer_key_id              TEXT NOT NULL,
  qualification_digest       TEXT NOT NULL,
  canonical_object_version   TEXT NOT NULL,
  approved_config_version_id TEXT NOT NULL,
  config_content_key         TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (
    status IN ('STAGING', 'SEALED', 'APPLYING', 'VERIFIED', 'ACTIVE', 'QUARANTINED')
  ),
  manifest_row_count         INTEGER NOT NULL CHECK (manifest_row_count > 0),
  manifest_byte_count        BIGINT NOT NULL CHECK (manifest_byte_count > 0),
  manifest_chunk_count       INTEGER NOT NULL CHECK (manifest_chunk_count > 0),
  manifest_artifact_digest   TEXT NOT NULL,
  manifest_rowset_digest     TEXT NOT NULL,
  manifest_chunk_set_digest  TEXT NOT NULL,
  manifest_expires_at        TIMESTAMPTZ NOT NULL,
  staged_row_count           INTEGER NOT NULL DEFAULT 0 CHECK (staged_row_count >= 0),
  sealed_row_count           INTEGER CHECK (sealed_row_count >= 0),
  sealed_byte_count          BIGINT CHECK (sealed_byte_count >= 0),
  sealed_chunk_count         INTEGER CHECK (sealed_chunk_count >= 0),
  sealed_artifact_digest     TEXT,
  sealed_rowset_digest       TEXT,
  sealed_receipt_set_digest  TEXT,
  applied_row_count          INTEGER NOT NULL DEFAULT 0 CHECK (applied_row_count >= 0),
  applied_rowset_digest      TEXT,
  lease_token                TEXT,
  lease_fence                BIGINT NOT NULL DEFAULT 0 CHECK (lease_fence >= 0),
  lease_expires_at           TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sealed_at                  TIMESTAMPTZ,
  verified_at                TIMESTAMPTZ,
  activated_at               TIMESTAMPTZ,
  quarantined_at             TIMESTAMPTZ,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (staged_row_count <= manifest_row_count),
  CHECK (applied_row_count <= manifest_row_count),
  CHECK (
    (
      lease_token IS NULL
      AND lease_expires_at IS NULL
    )
    OR
    (
      lease_token IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND lease_fence > 0
      AND status IN ('STAGING', 'APPLYING')
    )
  ),
  CHECK (
    status IN ('STAGING', 'QUARANTINED')
    OR (
      sealed_row_count IS NOT NULL
      AND sealed_byte_count IS NOT NULL
      AND sealed_chunk_count IS NOT NULL
      AND sealed_artifact_digest IS NOT NULL
      AND sealed_rowset_digest IS NOT NULL
      AND sealed_receipt_set_digest IS NOT NULL
      AND sealed_at IS NOT NULL
      AND staged_row_count = sealed_row_count
      AND sealed_row_count = manifest_row_count
      AND sealed_byte_count = manifest_byte_count
      AND sealed_chunk_count = manifest_chunk_count
      AND sealed_artifact_digest = manifest_artifact_digest
      AND sealed_rowset_digest = manifest_rowset_digest
      AND sealed_receipt_set_digest = manifest_chunk_set_digest
    )
  ),
  CHECK (
    status NOT IN ('VERIFIED', 'ACTIVE')
    OR (
      applied_rowset_digest IS NOT NULL
      AND applied_row_count = sealed_row_count
      AND applied_rowset_digest = sealed_rowset_digest
      AND verified_at IS NOT NULL
    )
  ),
  CHECK (status <> 'ACTIVE' OR activated_at IS NOT NULL),
  CHECK (status <> 'QUARANTINED' OR quarantined_at IS NOT NULL),
  CONSTRAINT uq_integration_sealed_export_generation_scope
    UNIQUE (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_sealed_export_generation_manifest
  ON integration_sealed_export_generations (
    tenant_id,
    COALESCE(workspace_id, ''),
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    manifest_digest
  );

CREATE INDEX IF NOT EXISTS idx_integration_sealed_export_generation_status
  ON integration_sealed_export_generations (
    tenant_id,
    COALESCE(workspace_id, ''),
    tenant_domain_binding,
    system_content_key,
    role_binding_fingerprint,
    status
  );

CREATE TABLE IF NOT EXISTS integration_sealed_export_generation_staging_rows (
  generation_id             TEXT NOT NULL,
  tenant_id                 TEXT NOT NULL,
  workspace_id              TEXT,
  workspace_scope_key       TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding     TEXT NOT NULL,
  system_content_key        TEXT NOT NULL,
  role_binding_fingerprint  TEXT NOT NULL,
  manifest_digest           TEXT NOT NULL,
  row_index                 INTEGER NOT NULL CHECK (row_index >= 0),
  canonical_row_text        TEXT NOT NULL,
  row_sort_key              BYTEA NOT NULL,
  row_digest                TEXT NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (generation_id, row_index),
  CONSTRAINT fk_integration_sealed_export_generation_staging_scope
    FOREIGN KEY (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    REFERENCES integration_sealed_export_generations (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_sealed_export_generation_staging_digest
  ON integration_sealed_export_generation_staging_rows (
    generation_id,
    row_sort_key
  );

CREATE TABLE IF NOT EXISTS integration_sealed_export_generation_rows (
  generation_id             TEXT NOT NULL,
  tenant_id                 TEXT NOT NULL,
  workspace_id              TEXT,
  workspace_scope_key       TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding     TEXT NOT NULL,
  system_content_key        TEXT NOT NULL,
  role_binding_fingerprint  TEXT NOT NULL,
  manifest_digest           TEXT NOT NULL,
  row_index                 INTEGER NOT NULL CHECK (row_index >= 0),
  canonical_row_text        TEXT NOT NULL,
  row_sort_key              BYTEA NOT NULL,
  row_digest                TEXT NOT NULL,
  apply_fence               BIGINT NOT NULL CHECK (apply_fence > 0),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (generation_id, row_index),
  CONSTRAINT fk_integration_sealed_export_generation_row_scope
    FOREIGN KEY (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    REFERENCES integration_sealed_export_generations (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_integration_sealed_export_generation_rows_digest
  ON integration_sealed_export_generation_rows (
    generation_id,
    row_sort_key
  );

CREATE TABLE IF NOT EXISTS integration_sealed_export_authority_state (
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  signer_key_id              TEXT NOT NULL,
  signer_status              TEXT NOT NULL CHECK (
    signer_status IN ('ACTIVE', 'EXPIRED', 'REVOKED')
  ),
  signer_expires_at          TIMESTAMPTZ NOT NULL,
  binding_current            BOOLEAN NOT NULL,
  binding_expires_at         TIMESTAMPTZ NOT NULL,
  qualification_digest       TEXT NOT NULL,
  qualification_current      BOOLEAN NOT NULL,
  qualification_expires_at   TIMESTAMPTZ NOT NULL,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_sealed_export_authority_state_scope
    UNIQUE (
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint
    )
);

CREATE TABLE IF NOT EXISTS integration_sealed_export_active_pointers (
  pointer_id                 TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  canonical_object_version   TEXT NOT NULL,
  active_generation_id       TEXT,
  active_manifest_digest     TEXT,
  pointer_version            BIGINT NOT NULL CHECK (pointer_version >= 0),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_sealed_export_active_pointer_scope
    UNIQUE (
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      canonical_object_version
    ),
  CHECK (
    (active_generation_id IS NULL AND active_manifest_digest IS NULL)
    OR
    (active_generation_id IS NOT NULL AND active_manifest_digest IS NOT NULL)
  ),
  CHECK (
    (active_generation_id IS NULL AND pointer_version = 0)
    OR
    (active_generation_id IS NOT NULL AND pointer_version > 0)
  ),
  CONSTRAINT fk_integration_sealed_export_active_pointer_generation_scope
    FOREIGN KEY (
      active_generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      active_manifest_digest
    )
    REFERENCES integration_sealed_export_generations (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
);

CREATE TABLE IF NOT EXISTS integration_sealed_export_generation_audit (
  audit_id                   TEXT PRIMARY KEY,
  generation_id             TEXT NOT NULL,
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  manifest_digest            TEXT NOT NULL,
  event_type                 TEXT NOT NULL CHECK (
    event_type IN ('SEALED', 'VERIFIED', 'ACTIVE', 'QUARANTINED')
  ),
  reason                     TEXT,
  row_count                  INTEGER NOT NULL CHECK (row_count >= 0),
  external_write             BOOLEAN NOT NULL DEFAULT FALSE CHECK (external_write = FALSE),
  occurred_at                TIMESTAMPTZ NOT NULL,
  UNIQUE (generation_id, event_type),
  CHECK (
    (
      event_type <> 'QUARANTINED'
      AND reason IS NULL
    )
    OR
    (
      event_type = 'QUARANTINED'
      AND reason IN (
        'SEALED_EXPORT_BINDING_UNQUALIFIED',
        'SEALED_EXPORT_SIGNER_UNENROLLED',
        'SEALED_EXPORT_SIGNER_EXPIRED',
        'SEALED_EXPORT_SIGNER_REVOKED',
        'SEALED_EXPORT_ARTIFACT_EXPIRED',
        'SEALED_EXPORT_GENERATION_VERIFY_FAILED'
      )
    )
  ),
  CONSTRAINT fk_integration_sealed_export_generation_audit_scope
    FOREIGN KEY (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    REFERENCES integration_sealed_export_generations (
      generation_id,
      tenant_id,
      workspace_scope_key,
      tenant_domain_binding,
      system_content_key,
      role_binding_fingerprint,
      manifest_digest
    )
    ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION integration_sealed_export_generation_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW.generation_id,
    NEW.session_id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.tenant_domain_binding,
    NEW.system_content_key,
    NEW.role_binding_fingerprint,
    NEW.manifest_digest,
    NEW.signer_key_id,
    NEW.qualification_digest,
    NEW.canonical_object_version,
    NEW.approved_config_version_id,
    NEW.config_content_key,
    NEW.manifest_row_count,
    NEW.manifest_byte_count,
    NEW.manifest_chunk_count,
    NEW.manifest_artifact_digest,
    NEW.manifest_rowset_digest,
    NEW.manifest_chunk_set_digest,
    NEW.manifest_expires_at,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.generation_id,
    OLD.session_id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.tenant_domain_binding,
    OLD.system_content_key,
    OLD.role_binding_fingerprint,
    OLD.manifest_digest,
    OLD.signer_key_id,
    OLD.qualification_digest,
    OLD.canonical_object_version,
    OLD.approved_config_version_id,
    OLD.config_content_key,
    OLD.manifest_row_count,
    OLD.manifest_byte_count,
    OLD.manifest_chunk_count,
    OLD.manifest_artifact_digest,
    OLD.manifest_rowset_digest,
    OLD.manifest_chunk_set_digest,
    OLD.manifest_expires_at,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'sealed-export generation anchors are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.lease_fence < OLD.lease_fence THEN
    RAISE EXCEPTION 'sealed-export generation lease fence cannot decrease'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.lease_token IS NOT NULL
    AND NEW.lease_fence = OLD.lease_fence
    AND clock_timestamp() >= OLD.lease_expires_at
  THEN
    RAISE EXCEPTION 'sealed-export generation lease expired'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status <> OLD.status AND NOT (
    (OLD.status = 'STAGING' AND NEW.status IN ('SEALED', 'QUARANTINED'))
    OR (OLD.status = 'SEALED' AND NEW.status IN ('APPLYING', 'QUARANTINED'))
    OR (OLD.status = 'APPLYING' AND NEW.status IN ('VERIFIED', 'QUARANTINED'))
    OR (OLD.status = 'VERIFIED' AND NEW.status IN ('ACTIVE', 'QUARANTINED'))
  ) THEN
    RAISE EXCEPTION 'illegal sealed-export generation transition'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION integration_sealed_export_rows_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'sealed-export generation rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION integration_sealed_export_generation_rows_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM integration_sealed_export_generations
      WHERE generation_id = NEW.generation_id
        AND status = 'APPLYING'
        AND lease_token IS NOT NULL
        AND lease_fence = NEW.apply_fence
        AND clock_timestamp() < lease_expires_at
    ) THEN
      RAISE EXCEPTION 'sealed-export generation row insert lacks an active lease'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'sealed-export generation rows are immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION integration_sealed_export_audit_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'sealed-export generation audit is immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION integration_sealed_export_active_pointer_guard()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW.pointer_id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.tenant_domain_binding,
    NEW.system_content_key,
    NEW.role_binding_fingerprint,
    NEW.canonical_object_version,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.pointer_id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.tenant_domain_binding,
    OLD.system_content_key,
    OLD.role_binding_fingerprint,
    OLD.canonical_object_version,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'sealed-export active pointer anchors are immutable'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.pointer_version <> OLD.pointer_version + 1 THEN
    RAISE EXCEPTION 'sealed-export active pointer version must increment by one'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_generation_guard'
      AND tgrelid = 'integration_sealed_export_generations'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_generation_guard
      BEFORE UPDATE ON integration_sealed_export_generations
      FOR EACH ROW EXECUTE FUNCTION integration_sealed_export_generation_guard();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_generation_updated_at'
      AND tgrelid = 'integration_sealed_export_generations'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_generation_updated_at
      BEFORE UPDATE ON integration_sealed_export_generations
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_generation_staging_immutable'
      AND tgrelid = 'integration_sealed_export_generation_staging_rows'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_generation_staging_immutable
      BEFORE UPDATE ON integration_sealed_export_generation_staging_rows
      FOR EACH ROW EXECUTE FUNCTION integration_sealed_export_rows_immutable();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_generation_rows_immutable'
      AND tgrelid = 'integration_sealed_export_generation_rows'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_generation_rows_immutable
      BEFORE INSERT OR UPDATE OR DELETE ON integration_sealed_export_generation_rows
      FOR EACH ROW EXECUTE FUNCTION integration_sealed_export_generation_rows_guard();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_generation_audit_immutable'
      AND tgrelid = 'integration_sealed_export_generation_audit'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_generation_audit_immutable
      BEFORE UPDATE OR DELETE ON integration_sealed_export_generation_audit
      FOR EACH ROW EXECUTE FUNCTION integration_sealed_export_audit_immutable();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_active_pointer_guard'
      AND tgrelid = 'integration_sealed_export_active_pointers'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_active_pointer_guard
      BEFORE UPDATE ON integration_sealed_export_active_pointers
      FOR EACH ROW EXECUTE FUNCTION integration_sealed_export_active_pointer_guard();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_active_pointer_updated_at'
      AND tgrelid = 'integration_sealed_export_active_pointers'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_active_pointer_updated_at
      BEFORE UPDATE ON integration_sealed_export_active_pointers
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname = 'trg_integration_sealed_export_authority_state_updated_at'
      AND tgrelid = 'integration_sealed_export_authority_state'::regclass
  ) THEN
    CREATE TRIGGER trg_integration_sealed_export_authority_state_updated_at
      BEFORE UPDATE ON integration_sealed_export_authority_state
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
