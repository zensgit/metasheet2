-- Host-only, one-row CREATE approval and durable admission. No sender or route.
-- These append-only facts never refund a consumed attempt or release 091 fences.
CREATE TABLE IF NOT EXISTS integration_yida_send_approvals (
  grant_id TEXT PRIMARY KEY CHECK (grant_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  confirmation_id TEXT NOT NULL CHECK (length(confirmation_id) BETWEEN 1 AND 128),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  target_ref TEXT NOT NULL REFERENCES integration_yida_approved_target(target_ref) ON DELETE RESTRICT,
  operation_id TEXT NOT NULL REFERENCES integration_yida_draft_operations(operation_id) ON DELETE RESTRICT,
  row_key TEXT NOT NULL REFERENCES integration_yida_draft_rows(row_key) ON DELETE RESTRICT,
  target_revision TEXT NOT NULL CHECK (target_revision = 'evidence-1'),
  plan_revision TEXT NOT NULL CHECK (plan_revision ~ '^[0-9a-f]{64}$'),
  plan_digest TEXT NOT NULL CHECK (plan_digest = plan_revision),
  credential_ref TEXT NOT NULL REFERENCES integration_yida_credential_materials(credential_ref) ON DELETE RESTRICT,
  credential_generation INTEGER NOT NULL CHECK (credential_generation BETWEEN 1 AND 2147483647),
  business_key_digest TEXT NOT NULL CHECK (business_key_digest ~ '^[0-9a-f]{64}$'),
  row_payload_digest TEXT NOT NULL CHECK (row_payload_digest ~ '^[0-9a-f]{64}$'),
  execution_payload_digest TEXT NOT NULL CHECK (execution_payload_digest ~ '^[0-9a-f]{64}$'),
  ttl_ms INTEGER NOT NULL CHECK (ttl_ms BETWEEN 1 AND 900000),
  approved_at_ms BIGINT NOT NULL CHECK (approved_at_ms BETWEEN 1 AND 9007199253840991),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms = approved_at_ms + ttl_ms),
  max_attempts INTEGER NOT NULL CHECK (max_attempts = 1),
  snapshot_encrypted TEXT NOT NULL CHECK (snapshot_encrypted LIKE 'enc:%'
    AND octet_length(snapshot_encrypted) BETWEEN 5 AND 25165824),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uniq_yida_send_approval_confirmation UNIQUE (tenant_id, owner_id, confirmation_id)
);

CREATE TABLE IF NOT EXISTS integration_yida_send_revocations (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  grant_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_send_approvals(grant_id) ON DELETE RESTRICT,
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS integration_yida_send_admissions (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  grant_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_send_approvals(grant_id) ON DELETE RESTRICT,
  ledger_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT,
  submission_id TEXT NOT NULL CHECK (length(submission_id) BETWEEN 1 AND 128),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  admitted_at_ms BIGINT NOT NULL CHECK (admitted_at_ms BETWEEN 1 AND 9007199254740991),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS integration_yida_send_approval_audit (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  grant_id TEXT NOT NULL REFERENCES integration_yida_send_approvals(grant_id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK (event IN ('approve', 'revoke', 'admit')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uniq_yida_send_approval_audit_event UNIQUE (grant_id, event)
);

CREATE OR REPLACE FUNCTION integration_yida_send_approval_immutable_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_SEND_APPROVAL_IMMUTABLE';
END;
$$;

DROP TRIGGER IF EXISTS trg_yida_send_approvals_immutable ON integration_yida_send_approvals;
CREATE TRIGGER trg_yida_send_approvals_immutable BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_send_approvals
  FOR EACH ROW EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_approvals_truncate ON integration_yida_send_approvals;
CREATE TRIGGER trg_yida_send_approvals_truncate BEFORE TRUNCATE ON integration_yida_send_approvals
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_revocations_immutable ON integration_yida_send_revocations;
CREATE TRIGGER trg_yida_send_revocations_immutable BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_send_revocations
  FOR EACH ROW EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_revocations_truncate ON integration_yida_send_revocations;
CREATE TRIGGER trg_yida_send_revocations_truncate BEFORE TRUNCATE ON integration_yida_send_revocations
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_admissions_immutable ON integration_yida_send_admissions;
CREATE TRIGGER trg_yida_send_admissions_immutable BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_send_admissions
  FOR EACH ROW EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_admissions_truncate ON integration_yida_send_admissions;
CREATE TRIGGER trg_yida_send_admissions_truncate BEFORE TRUNCATE ON integration_yida_send_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_approval_audit_immutable ON integration_yida_send_approval_audit;
CREATE TRIGGER trg_yida_send_approval_audit_immutable BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_send_approval_audit
  FOR EACH ROW EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
DROP TRIGGER IF EXISTS trg_yida_send_approval_audit_truncate ON integration_yida_send_approval_audit;
CREATE TRIGGER trg_yida_send_approval_audit_truncate BEFORE TRUNCATE ON integration_yida_send_approval_audit
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_send_approval_immutable_guard();
