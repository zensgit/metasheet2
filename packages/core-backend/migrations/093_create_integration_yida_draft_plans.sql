-- Internal, local-unverified YiDa drafts only. No authority or sender.
-- All four tables are append-only; encrypted snapshots are not live pointers.
CREATE TABLE IF NOT EXISTS integration_yida_draft_targets (
  target_ref TEXT PRIMARY KEY CHECK (target_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  locator_digest TEXT NOT NULL CHECK (locator_digest ~ '^[0-9a-f]{64}$'),
  key_definition_digest TEXT NOT NULL CHECK (key_definition_digest ~ '^[0-9a-f]{64}$'),
  target_encrypted TEXT NOT NULL CHECK (target_encrypted LIKE 'enc:%' AND octet_length(target_encrypted) BETWEEN 5 AND 8388608),
  status TEXT NOT NULL CHECK (status = 'unverified'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Owner/key definition/material generation are deliberately NOT namespace keys.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_yida_draft_target_locator
  ON integration_yida_draft_targets (tenant_id, COALESCE(workspace_id, ''), locator_digest);

CREATE TABLE IF NOT EXISTS integration_yida_draft_operations (
  operation_id TEXT PRIMARY KEY CHECK (operation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  target_ref TEXT NOT NULL REFERENCES integration_yida_draft_targets(target_ref) ON DELETE RESTRICT,
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  snapshot_encrypted TEXT NOT NULL CHECK (snapshot_encrypted LIKE 'enc:%' AND octet_length(snapshot_encrypted) BETWEEN 5 AND 8388608),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status = 'unverified'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_yida_draft_operation_plan UNIQUE (target_ref, plan_digest)
);

CREATE TABLE IF NOT EXISTS integration_yida_draft_rows (
  row_key TEXT PRIMARY KEY CHECK (row_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
  business_key_digest TEXT NOT NULL CHECK (business_key_digest ~ '^[0-9a-f]{64}$'),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_yida_draft_row_ordinal UNIQUE (operation_id, ordinal),
  CONSTRAINT uniq_yida_draft_row_business UNIQUE (operation_id, business_key_digest)
);

CREATE TABLE IF NOT EXISTS integration_yida_draft_audit (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  operation_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  target_ref TEXT NOT NULL REFERENCES integration_yida_draft_targets(target_ref) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  event TEXT NOT NULL CHECK (event = 'create_draft'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION integration_yida_draft_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_DRAFT_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS trg_yida_draft_targets_immutable ON integration_yida_draft_targets;
CREATE TRIGGER trg_yida_draft_targets_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_draft_targets
  FOR EACH ROW EXECUTE FUNCTION integration_yida_draft_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_draft_targets_truncate ON integration_yida_draft_targets;
CREATE TRIGGER trg_yida_draft_targets_truncate
  BEFORE TRUNCATE ON integration_yida_draft_targets
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_draft_immutable_guard();

DROP TRIGGER IF EXISTS trg_yida_draft_operations_immutable ON integration_yida_draft_operations;
CREATE TRIGGER trg_yida_draft_operations_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_draft_operations
  FOR EACH ROW EXECUTE FUNCTION integration_yida_draft_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_draft_operations_truncate ON integration_yida_draft_operations;
CREATE TRIGGER trg_yida_draft_operations_truncate
  BEFORE TRUNCATE ON integration_yida_draft_operations
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_draft_immutable_guard();

DROP TRIGGER IF EXISTS trg_yida_draft_rows_immutable ON integration_yida_draft_rows;
CREATE TRIGGER trg_yida_draft_rows_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_draft_rows
  FOR EACH ROW EXECUTE FUNCTION integration_yida_draft_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_draft_rows_truncate ON integration_yida_draft_rows;
CREATE TRIGGER trg_yida_draft_rows_truncate
  BEFORE TRUNCATE ON integration_yida_draft_rows
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_draft_immutable_guard();

DROP TRIGGER IF EXISTS trg_yida_draft_audit_immutable ON integration_yida_draft_audit;
CREATE TRIGGER trg_yida_draft_audit_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_draft_audit
  FOR EACH ROW EXECUTE FUNCTION integration_yida_draft_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_draft_audit_truncate ON integration_yida_draft_audit;
CREATE TRIGGER trg_yida_draft_audit_truncate
  BEFORE TRUNCATE ON integration_yida_draft_audit
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_draft_immutable_guard();
