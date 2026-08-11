-- 073_create_sealed_export_stock_prep_runtime_authority.sql
-- S6-A controlled SQL Server sealed-snapshot runtime (#4693).
--
-- Role names are deployment inputs, not repository constants. Supply both
-- settings through PGOPTIONS when migrations run:
--
--   -c metasheet.sealed_export_runtime_role=<runtime role>
--   -c metasheet.sealed_export_provisioning_role=<provisioning role>
--
-- With neither setting, the schema remains installable for latent/default-OFF
-- environments. Supplying only one setting, a missing role, an unsafe role, or
-- the same role for both duties fails the migration closed.

CREATE TABLE IF NOT EXISTS integration_sealed_export_stock_prep_bindings (
  binding_id                 TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL,
  workspace_id               TEXT,
  workspace_scope_key        TEXT GENERATED ALWAYS AS (COALESCE(workspace_id, '')) STORED,
  external_system_id         TEXT NOT NULL,
  object_key                 TEXT NOT NULL,
  relation_id                TEXT NOT NULL CHECK (
    relation_id = 'sqlserver.relation.rowid_payload.v1'
  ),
  table_ref                  TEXT NOT NULL,
  approved_config_version_id TEXT NOT NULL,
  binding_version            TEXT NOT NULL,
  config_content_key         TEXT NOT NULL,
  canonical_object_version   TEXT NOT NULL,
  tenant_domain_binding      TEXT NOT NULL,
  system_content_key         TEXT NOT NULL,
  role_binding_fingerprint   TEXT NOT NULL,
  status                     TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
  expires_at                 TIMESTAMPTZ NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_sealed_export_stock_prep_binding_version
    UNIQUE (
      tenant_id,
      workspace_scope_key,
      object_key,
      binding_version
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_integration_sealed_export_stock_prep_active_binding
  ON integration_sealed_export_stock_prep_bindings (
    tenant_id,
    workspace_scope_key,
    object_key
  )
  WHERE status = 'ACTIVE';

-- S6-A is deliberately single-customer. A later multi-customer profile must
-- use a separately ratified schema/version rather than widening this index.
CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_integration_sealed_export_stock_prep_single_customer
  ON integration_sealed_export_stock_prep_bindings ((1))
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS
  idx_integration_sealed_export_stock_prep_binding_runtime
  ON integration_sealed_export_stock_prep_bindings (
    tenant_id,
    workspace_scope_key,
    status,
    expires_at
  );

CREATE TABLE IF NOT EXISTS integration_sealed_export_stock_prep_runs (
  run_id                      TEXT PRIMARY KEY,
  tenant_id                   TEXT NOT NULL,
  workspace_id                TEXT,
  workspace_scope_key         TEXT GENERATED ALWAYS AS (
    COALESCE(workspace_id, '')
  ) STORED,
  operation_id                TEXT NOT NULL,
  actor_id                    TEXT NOT NULL,
  binding_id                  TEXT NOT NULL REFERENCES
    integration_sealed_export_stock_prep_bindings(binding_id)
    ON DELETE RESTRICT,
  status                      TEXT NOT NULL CHECK (
    status IN (
      'CAPTURING',
      'CAPTURE_FAILED',
      'CAPTURED',
      'INGESTING',
      'INGESTED',
      'GENERATION_VERIFIED',
      'ACTIVATED',
      'COMPLETED'
    )
  ),
  source_read_count           SMALLINT NOT NULL DEFAULT 1 CHECK (
    source_read_count = 1
  ),
  export_request_envelope     JSONB,
  manifest                    JSONB,
  manifest_digest             TEXT,
  artifact_directory          TEXT,
  chunk_paths                 JSONB,
  ingestion_session_id        TEXT,
  generation_id               TEXT,
  stock_preparation_run_id    TEXT,
  business_line_count         INTEGER CHECK (
    business_line_count BETWEEN 1 AND 24999
  ),
  failure_reason              TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  captured_at                 TIMESTAMPTZ,
  ingested_at                 TIMESTAMPTZ,
  generation_verified_at      TIMESTAMPTZ,
  activated_at                TIMESTAMPTZ,
  completed_at                TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_integration_sealed_export_stock_prep_operation
    UNIQUE (
      tenant_id,
      workspace_scope_key,
      operation_id
    ),
  CONSTRAINT ck_integration_sealed_export_stock_prep_capture_shape CHECK (
    (
      status IN (
        'CAPTURED',
        'INGESTING',
        'INGESTED',
        'GENERATION_VERIFIED',
        'ACTIVATED',
        'COMPLETED'
      )
      AND export_request_envelope IS NOT NULL
      AND jsonb_typeof(export_request_envelope) = 'object'
      AND manifest IS NOT NULL
      AND jsonb_typeof(manifest) = 'object'
      AND manifest_digest IS NOT NULL
      AND artifact_directory IS NOT NULL
      AND chunk_paths IS NOT NULL
      AND jsonb_typeof(chunk_paths) = 'array'
      AND captured_at IS NOT NULL
    )
    OR (
      status IN ('CAPTURING', 'CAPTURE_FAILED')
      AND export_request_envelope IS NULL
      AND manifest IS NULL
      AND manifest_digest IS NULL
      AND artifact_directory IS NULL
      AND chunk_paths IS NULL
      AND captured_at IS NULL
    )
  ),
  CONSTRAINT ck_integration_sealed_export_stock_prep_ingestion_shape CHECK (
    (
      status IN (
        'INGESTING',
        'INGESTED',
        'GENERATION_VERIFIED',
        'ACTIVATED',
        'COMPLETED'
      )
      AND ingestion_session_id IS NOT NULL
      AND ingested_at IS NOT NULL
    )
    OR (
      status IN ('CAPTURING', 'CAPTURE_FAILED', 'CAPTURED')
      AND ingestion_session_id IS NULL
      AND ingested_at IS NULL
    )
  ),
  CONSTRAINT ck_integration_sealed_export_stock_prep_generation_shape CHECK (
    (
      status IN ('GENERATION_VERIFIED', 'ACTIVATED', 'COMPLETED')
      AND generation_id IS NOT NULL
      AND generation_verified_at IS NOT NULL
    )
    OR (
      status IN (
        'CAPTURING',
        'CAPTURE_FAILED',
        'CAPTURED',
        'INGESTING',
        'INGESTED'
      )
      AND generation_id IS NULL
      AND generation_verified_at IS NULL
    )
  ),
  CONSTRAINT ck_integration_sealed_export_stock_prep_completion_shape CHECK (
    (
      status = 'ACTIVATED'
      AND activated_at IS NOT NULL
      AND completed_at IS NULL
      AND stock_preparation_run_id IS NULL
      AND business_line_count IS NULL
    )
    OR (
      status = 'COMPLETED'
      AND activated_at IS NOT NULL
      AND completed_at IS NOT NULL
      AND stock_preparation_run_id IS NOT NULL
      AND business_line_count IS NOT NULL
    )
    OR (
      status NOT IN ('ACTIVATED', 'COMPLETED')
      AND activated_at IS NULL
      AND completed_at IS NULL
      AND stock_preparation_run_id IS NULL
      AND business_line_count IS NULL
    )
  ),
  CONSTRAINT ck_integration_sealed_export_stock_prep_failure_shape CHECK (
    (
      status = 'CAPTURE_FAILED'
      AND failure_reason IS NOT NULL
    )
    OR (
      status <> 'CAPTURE_FAILED'
      AND failure_reason IS NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS
  idx_integration_sealed_export_stock_prep_run_runtime
  ON integration_sealed_export_stock_prep_runs (
    tenant_id,
    workspace_scope_key,
    status,
    updated_at
  );

CREATE UNIQUE INDEX IF NOT EXISTS
  uniq_integration_sealed_export_stock_prep_active_run
  ON integration_sealed_export_stock_prep_runs (binding_id)
  WHERE status NOT IN ('CAPTURE_FAILED', 'COMPLETED');

CREATE OR REPLACE FUNCTION
  integration_sealed_export_stock_prep_binding_anchors_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW.binding_id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.external_system_id,
    NEW.object_key,
    NEW.relation_id,
    NEW.table_ref,
    NEW.approved_config_version_id,
    NEW.binding_version,
    NEW.config_content_key,
    NEW.canonical_object_version,
    NEW.tenant_domain_binding,
    NEW.system_content_key,
    NEW.role_binding_fingerprint,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.binding_id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.external_system_id,
    OLD.object_key,
    OLD.relation_id,
    OLD.table_ref,
    OLD.approved_config_version_id,
    OLD.binding_version,
    OLD.config_content_key,
    OLD.canonical_object_version,
    OLD.tenant_domain_binding,
    OLD.system_content_key,
    OLD.role_binding_fingerprint,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'sealed-export stock-prep binding anchors are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION
  integration_sealed_export_stock_prep_run_anchors_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF ROW(
    NEW.run_id,
    NEW.tenant_id,
    NEW.workspace_id,
    NEW.operation_id,
    NEW.actor_id,
    NEW.binding_id,
    NEW.source_read_count,
    NEW.created_at
  ) IS DISTINCT FROM ROW(
    OLD.run_id,
    OLD.tenant_id,
    OLD.workspace_id,
    OLD.operation_id,
    OLD.actor_id,
    OLD.binding_id,
    OLD.source_read_count,
    OLD.created_at
  ) THEN
    RAISE EXCEPTION 'sealed-export stock-prep run identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF
    (OLD.export_request_envelope IS NOT NULL AND
      NEW.export_request_envelope IS DISTINCT FROM
        OLD.export_request_envelope)
    OR (OLD.manifest IS NOT NULL AND
      NEW.manifest IS DISTINCT FROM OLD.manifest)
    OR (OLD.manifest_digest IS NOT NULL AND
      NEW.manifest_digest IS DISTINCT FROM OLD.manifest_digest)
    OR (OLD.artifact_directory IS NOT NULL AND
      NEW.artifact_directory IS DISTINCT FROM OLD.artifact_directory)
    OR (OLD.chunk_paths IS NOT NULL AND
      NEW.chunk_paths IS DISTINCT FROM OLD.chunk_paths)
    OR (OLD.ingestion_session_id IS NOT NULL AND
      NEW.ingestion_session_id IS DISTINCT FROM OLD.ingestion_session_id)
    OR (OLD.generation_id IS NOT NULL AND
      NEW.generation_id IS DISTINCT FROM OLD.generation_id)
    OR (OLD.stock_preparation_run_id IS NOT NULL AND
      NEW.stock_preparation_run_id IS DISTINCT FROM
        OLD.stock_preparation_run_id)
    OR (OLD.business_line_count IS NOT NULL AND
      NEW.business_line_count IS DISTINCT FROM
        OLD.business_line_count)
    OR (OLD.failure_reason IS NOT NULL AND
      NEW.failure_reason IS DISTINCT FROM OLD.failure_reason)
    OR (OLD.captured_at IS NOT NULL AND
      NEW.captured_at IS DISTINCT FROM OLD.captured_at)
    OR (OLD.ingested_at IS NOT NULL AND
      NEW.ingested_at IS DISTINCT FROM OLD.ingested_at)
    OR (OLD.generation_verified_at IS NOT NULL AND
      NEW.generation_verified_at IS DISTINCT FROM
        OLD.generation_verified_at)
    OR (OLD.activated_at IS NOT NULL AND
      NEW.activated_at IS DISTINCT FROM OLD.activated_at)
    OR (OLD.completed_at IS NOT NULL AND
      NEW.completed_at IS DISTINCT FROM OLD.completed_at)
  THEN
    RAISE EXCEPTION 'sealed-export stock-prep run anchors are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'CAPTURING' AND NEW.status IN (
      'CAPTURE_FAILED',
      'CAPTURED'
    ))
    OR (OLD.status = 'CAPTURED' AND NEW.status = 'INGESTING')
    OR (OLD.status = 'INGESTING' AND NEW.status = 'INGESTED')
    OR (
      OLD.status = 'INGESTED'
      AND NEW.status = 'GENERATION_VERIFIED'
    )
    OR (
      OLD.status = 'GENERATION_VERIFIED'
      AND NEW.status = 'ACTIVATED'
    )
    OR (OLD.status = 'ACTIVATED' AND NEW.status = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION 'sealed-export stock-prep run transition is invalid'
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
    WHERE tgname =
      'trg_integration_sealed_export_stock_prep_binding_anchors_immutable'
      AND tgrelid =
        'integration_sealed_export_stock_prep_bindings'::regclass
  ) THEN
    CREATE TRIGGER
      trg_integration_sealed_export_stock_prep_binding_anchors_immutable
      BEFORE UPDATE ON integration_sealed_export_stock_prep_bindings
      FOR EACH ROW
      EXECUTE FUNCTION
        integration_sealed_export_stock_prep_binding_anchors_immutable();
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname =
      'trg_integration_sealed_export_stock_prep_bindings_updated_at'
      AND tgrelid =
        'integration_sealed_export_stock_prep_bindings'::regclass
  ) THEN
    CREATE TRIGGER
      trg_integration_sealed_export_stock_prep_bindings_updated_at
      BEFORE UPDATE ON integration_sealed_export_stock_prep_bindings
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname =
      'trg_integration_sealed_export_stock_prep_run_anchors_immutable'
      AND tgrelid =
        'integration_sealed_export_stock_prep_runs'::regclass
  ) THEN
    CREATE TRIGGER
      trg_integration_sealed_export_stock_prep_run_anchors_immutable
      BEFORE UPDATE ON integration_sealed_export_stock_prep_runs
      FOR EACH ROW
      EXECUTE FUNCTION
        integration_sealed_export_stock_prep_run_anchors_immutable();
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname =
      'trg_integration_sealed_export_stock_prep_runs_updated_at'
      AND tgrelid =
        'integration_sealed_export_stock_prep_runs'::regclass
  ) THEN
    CREATE TRIGGER
      trg_integration_sealed_export_stock_prep_runs_updated_at
      BEFORE UPDATE ON integration_sealed_export_stock_prep_runs
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;

REVOKE ALL ON TABLE
  integration_sealed_export_ingestion_sessions,
  integration_sealed_export_ingestion_receipts,
  integration_sealed_export_ingestion_tombstones,
  integration_sealed_export_generations,
  integration_sealed_export_generation_staging_rows,
  integration_sealed_export_generation_rows,
  integration_sealed_export_authority_state,
  integration_sealed_export_active_pointers,
  integration_sealed_export_generation_audit,
  integration_sealed_export_signer_public_keys,
  integration_sealed_export_terminal_signer_keys,
  integration_sealed_export_stock_prep_bindings,
  integration_sealed_export_stock_prep_runs
FROM PUBLIC;

DO $$
DECLARE
  runtime_role TEXT := NULLIF(
    current_setting('metasheet.sealed_export_runtime_role', TRUE),
    ''
  );
  provisioning_role TEXT := NULLIF(
    current_setting('metasheet.sealed_export_provisioning_role', TRUE),
    ''
  );
  schema_name TEXT := current_schema();
  candidate TEXT;
  candidate_row RECORD;
BEGIN
  IF runtime_role IS NULL AND provisioning_role IS NULL THEN
    RAISE NOTICE
      'sealed-export roles are not configured; privilege grants remain latent';
    RETURN;
  END IF;
  IF runtime_role IS NULL OR provisioning_role IS NULL THEN
    RAISE EXCEPTION
      'sealed-export runtime and provisioning roles must be configured together'
      USING ERRCODE = '55000';
  END IF;
  IF runtime_role = provisioning_role THEN
    RAISE EXCEPTION
      'sealed-export runtime and provisioning roles must be distinct'
      USING ERRCODE = '55000';
  END IF;

  FOREACH candidate IN ARRAY ARRAY[runtime_role, provisioning_role]
  LOOP
    SELECT
      oid,
      rolname,
      rolsuper,
      rolcreatedb,
      rolcreaterole,
      rolreplication,
      rolbypassrls,
      rolcanlogin,
      rolinherit
    INTO candidate_row
    FROM pg_roles
    WHERE rolname = candidate;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'sealed-export role does not exist'
        USING ERRCODE = '55000';
    END IF;
    IF
      candidate_row.rolsuper
      OR candidate_row.rolcreatedb
      OR candidate_row.rolcreaterole
      OR candidate_row.rolreplication
      OR candidate_row.rolbypassrls
      OR NOT candidate_row.rolcanlogin
      OR candidate_row.rolinherit
      OR candidate = current_user
      OR pg_has_role(candidate, current_user, 'MEMBER')
      OR EXISTS (
        SELECT 1
        FROM pg_auth_members membership
        WHERE
          membership.member = candidate_row.oid
          OR membership.roleid = candidate_row.oid
      )
    THEN
      RAISE EXCEPTION 'sealed-export role has unsafe authority'
        USING ERRCODE = '55000';
    END IF;
  END LOOP;

  IF
    pg_has_role(runtime_role, provisioning_role, 'MEMBER')
    OR pg_has_role(provisioning_role, runtime_role, 'MEMBER')
  THEN
    RAISE EXCEPTION
      'sealed-export runtime and provisioning roles must not inherit each other'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'GRANT USAGE ON SCHEMA %I TO %I',
    schema_name,
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_ingestion_sessions',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, DELETE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_ingestion_receipts',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_ingestion_tombstones',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_generations',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, DELETE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_generation_staging_rows',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_generation_rows',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_authority_state',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_active_pointers',
    runtime_role
  );
  EXECUTE format(
    'GRANT INSERT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_generation_audit',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_signer_public_keys',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_stock_prep_bindings',
    runtime_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_stock_prep_runs',
    runtime_role
  );

  EXECUTE format(
    'GRANT USAGE ON SCHEMA %I TO %I',
    schema_name,
    provisioning_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_authority_state',
    provisioning_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_signer_public_keys',
    provisioning_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_terminal_signer_keys',
    provisioning_role
  );
  EXECUTE format(
    'GRANT SELECT, INSERT, UPDATE ON TABLE %I.%I TO %I',
    schema_name,
    'integration_sealed_export_stock_prep_bindings',
    provisioning_role
  );
END $$;
