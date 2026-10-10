-- Approved A: non-HTTP deployment anchor, local initialization only; NOT a send grant.
CREATE TABLE IF NOT EXISTS integration_yida_initialization_anchor (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  command_id TEXT NOT NULL UNIQUE CHECK (command_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (slot, command_id, owner_id, tenant_id)
);
CREATE TABLE IF NOT EXISTS integration_yida_initializations (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  command_id TEXT NOT NULL UNIQUE,
  owner_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT CHECK (workspace_id IS NULL),
  target_ref TEXT NOT NULL UNIQUE REFERENCES integration_yida_approved_target(target_ref) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  credential_ref TEXT NOT NULL REFERENCES integration_yida_credential_materials(credential_ref) ON DELETE RESTRICT,
  credential_generation INTEGER NOT NULL CHECK (credential_generation = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (slot, command_id, owner_id, tenant_id)
    REFERENCES integration_yida_initialization_anchor(slot, command_id, owner_id, tenant_id) ON DELETE RESTRICT
);
CREATE OR REPLACE FUNCTION integration_yida_initialization_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_INITIALIZATION_IMMUTABLE' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS trg_yida_initialization_anchor_immutable ON integration_yida_initialization_anchor;
CREATE TRIGGER trg_yida_initialization_anchor_immutable BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_initialization_anchor
  FOR EACH ROW EXECUTE FUNCTION integration_yida_initialization_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_initialization_anchor_truncate ON integration_yida_initialization_anchor;
CREATE TRIGGER trg_yida_initialization_anchor_truncate BEFORE TRUNCATE ON integration_yida_initialization_anchor
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_initialization_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_initializations_immutable ON integration_yida_initializations;
CREATE TRIGGER trg_yida_initializations_immutable BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_initializations
  FOR EACH ROW EXECUTE FUNCTION integration_yida_initialization_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_initializations_truncate ON integration_yida_initializations;
CREATE TRIGGER trg_yida_initializations_truncate BEFORE TRUNCATE ON integration_yida_initializations
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_initialization_immutable_guard();
REVOKE ALL ON TABLE integration_yida_initialization_anchor, integration_yida_initializations FROM PUBLIC;
-- Online host code only SELECTs the anchor; the operator module is the only
-- approved provision path. PUBLIC revoke is not a restriction on the table owner.
-- Distinct operator/runtime database credentials require separate deployment review.
