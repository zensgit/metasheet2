-- Internal human-attested single-target pilot. No grant or online authority.
-- Exactly one permanent slot in this deployment, even after material changes.
-- No owner/tenant/material/key/locator dimension can allocate another slot.
CREATE TABLE IF NOT EXISTS integration_yida_approved_target (
  slot INTEGER PRIMARY KEY CHECK (slot = 1),
  target_ref TEXT NOT NULL UNIQUE CHECK (target_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  evidence_version INTEGER NOT NULL CHECK (evidence_version = 1),
  status TEXT NOT NULL CHECK (status = 'manually_confirmed'),
  operation_id TEXT NOT NULL REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  draft_target_ref TEXT NOT NULL REFERENCES integration_yida_draft_targets(target_ref) ON DELETE RESTRICT,
  plan_digest TEXT NOT NULL CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  locator_digest TEXT NOT NULL CHECK (locator_digest ~ '^[0-9a-f]{64}$'),
  key_definition_digest TEXT NOT NULL CHECK (key_definition_digest ~ '^[0-9a-f]{64}$'),
  credential_ref TEXT NOT NULL REFERENCES integration_yida_credential_materials(credential_ref) ON DELETE RESTRICT,
  credential_generation INTEGER NOT NULL CHECK (credential_generation BETWEEN 1 AND 2147483647),
  evidence_encrypted TEXT NOT NULL CHECK (evidence_encrypted LIKE 'enc:%' AND octet_length(evidence_encrypted) BETWEEN 5 AND 262144),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS integration_yida_approved_target_audit (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  slot INTEGER NOT NULL UNIQUE REFERENCES integration_yida_approved_target(slot) ON DELETE RESTRICT CHECK (slot = 1),
  target_ref TEXT NOT NULL REFERENCES integration_yida_approved_target(target_ref) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  evidence_version INTEGER NOT NULL CHECK (evidence_version = 1),
  event TEXT NOT NULL CHECK (event = 'register_target'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION integration_yida_approved_target_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_APPROVED_TARGET_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS trg_yida_approved_target_immutable ON integration_yida_approved_target;
CREATE TRIGGER trg_yida_approved_target_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_approved_target
  FOR EACH ROW EXECUTE FUNCTION integration_yida_approved_target_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_approved_target_truncate ON integration_yida_approved_target;
CREATE TRIGGER trg_yida_approved_target_truncate
  BEFORE TRUNCATE ON integration_yida_approved_target
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_approved_target_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_approved_target_audit_immutable ON integration_yida_approved_target_audit;
CREATE TRIGGER trg_yida_approved_target_audit_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_approved_target_audit
  FOR EACH ROW EXECUTE FUNCTION integration_yida_approved_target_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_approved_target_audit_truncate ON integration_yida_approved_target_audit;
CREATE TRIGGER trg_yida_approved_target_audit_truncate
  BEFORE TRUNCATE ON integration_yida_approved_target_audit
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_approved_target_immutable_guard();
