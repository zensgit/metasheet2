-- SA05B1: inert, private YiDa per-row delivery evidence. No sender or route.
-- Historical target/credential references are not live external-system pointers.
CREATE TABLE IF NOT EXISTS integration_yida_delivery_ledger (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 128),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 128),
  row_key TEXT NOT NULL CHECK (length(row_key) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  target_ref TEXT NOT NULL CHECK (length(target_ref) BETWEEN 1 AND 128),
  target_revision TEXT NOT NULL CHECK (length(target_revision) BETWEEN 1 AND 128),
  plan_revision TEXT NOT NULL CHECK (length(plan_revision) BETWEEN 1 AND 128),
  payload_digest TEXT NOT NULL CHECK (payload_digest ~ '^[0-9a-f]{64}$'),
  business_key_digest TEXT NOT NULL CHECK (business_key_digest ~ '^[0-9a-f]{64}$'),
  credential_ref TEXT NOT NULL CHECK (length(credential_ref) BETWEEN 1 AND 128),
  credential_generation INTEGER NOT NULL CHECK (credential_generation BETWEEN 1 AND 2147483647),
  intent TEXT NOT NULL CHECK (intent IN ('create', 'update')),
  instance_id TEXT,
  status TEXT NOT NULL DEFAULT 'prepared'
    CHECK (status IN ('prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent')),
  claim_token TEXT CHECK (claim_token IS NULL OR claim_token ~ '^[0-9a-f]{64}$'),
  claim_actor_id TEXT CHECK (claim_actor_id IS NULL OR length(claim_actor_id) BETWEEN 1 AND 128),
  ack_status_code INTEGER CHECK (ack_status_code IS NULL OR ack_status_code BETWEEN 200 AND 299),
  ack_instance_id TEXT CHECK (ack_instance_id IS NULL OR length(ack_instance_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_delivery_intent_shape CHECK (
    (intent = 'create' AND instance_id IS NULL)
    OR (intent = 'update' AND instance_id IS NOT NULL AND length(instance_id) BETWEEN 1 AND 128)
  ),
  CONSTRAINT integration_yida_delivery_status_shape CHECK (
    (status IN ('prepared', 'not_sent') AND claim_token IS NULL AND claim_actor_id IS NULL
      AND ack_status_code IS NULL AND ack_instance_id IS NULL)
    OR (status IN ('dispatching', 'outcome_unknown') AND claim_token IS NOT NULL
      AND claim_actor_id IS NOT NULL AND ack_status_code IS NULL AND ack_instance_id IS NULL)
    OR (status = 'acknowledged' AND claim_token IS NOT NULL AND claim_actor_id IS NOT NULL
      AND ack_status_code IS NOT NULL AND ack_instance_id IS NOT NULL)
  ),
  CONSTRAINT integration_yida_delivery_ack_instance CHECK (
    status <> 'acknowledged' OR intent = 'create' OR ack_instance_id = instance_id
  )
);

-- PG14-compatible NULL workspace identity. Empty workspace IDs are forbidden.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_yida_delivery_scope_row
  ON integration_yida_delivery_ledger
  (tenant_id, COALESCE(workspace_id, ''), operation_id, row_key);

CREATE TABLE IF NOT EXISTS integration_yida_delivery_audit (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK (event IN ('prepare', 'claim', 'acknowledgement', 'unknown', 'cancel')),
  status TEXT NOT NULL CHECK (status IN ('prepared', 'dispatching', 'acknowledged', 'outcome_unknown', 'not_sent')),
  reason TEXT CHECK (reason IS NULL OR reason IN
    ('transport_unknown', 'commit_unknown', 'receipt_invalid', 'manual_recovery')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_delivery_audit_shape CHECK (
    (event = 'prepare' AND status = 'prepared' AND reason IS NULL)
    OR (event = 'claim' AND status = 'dispatching' AND reason IS NULL)
    OR (event = 'acknowledgement' AND status = 'acknowledged' AND reason IS NULL)
    OR (event = 'unknown' AND status = 'outcome_unknown' AND reason IS NOT NULL)
    OR (event = 'cancel' AND status = 'not_sent' AND reason IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_integration_yida_delivery_audit_ledger
  ON integration_yida_delivery_audit (ledger_id, created_at);

-- A direct SQL edit cannot recycle a dispatch marker or rewrite its identity.
CREATE OR REPLACE FUNCTION integration_yida_delivery_ledger_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE'; END IF;
  IF OLD.id IS DISTINCT FROM NEW.id
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.operation_id IS DISTINCT FROM NEW.operation_id
    OR OLD.row_key IS DISTINCT FROM NEW.row_key
    OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.target_ref IS DISTINCT FROM NEW.target_ref
    OR OLD.target_revision IS DISTINCT FROM NEW.target_revision
    OR OLD.plan_revision IS DISTINCT FROM NEW.plan_revision
    OR OLD.payload_digest IS DISTINCT FROM NEW.payload_digest
    OR OLD.business_key_digest IS DISTINCT FROM NEW.business_key_digest
    OR OLD.credential_ref IS DISTINCT FROM NEW.credential_ref
    OR OLD.credential_generation IS DISTINCT FROM NEW.credential_generation
    OR OLD.intent IS DISTINCT FROM NEW.intent
    OR OLD.instance_id IS DISTINCT FROM NEW.instance_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE';
  END IF;
  IF NOT ((OLD.status = 'prepared' AND NEW.status IN ('dispatching', 'not_sent'))
    OR (OLD.status = 'dispatching' AND NEW.status IN ('acknowledged', 'outcome_unknown'))) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_TRANSITION';
  END IF;
  IF OLD.status = 'prepared' AND NEW.status = 'dispatching'
    AND (NEW.claim_token IS NULL OR NEW.claim_actor_id IS NULL) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CLAIM';
  END IF;
  IF OLD.status = 'dispatching'
    AND (NEW.claim_token IS DISTINCT FROM OLD.claim_token
      OR NEW.claim_actor_id IS DISTINCT FROM OLD.claim_actor_id) THEN
    RAISE EXCEPTION 'YIDA_DELIVERY_CLAIM';
  END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_delivery_ledger_guard ON integration_yida_delivery_ledger;
CREATE TRIGGER trg_integration_yida_delivery_ledger_guard
  BEFORE UPDATE OR DELETE ON integration_yida_delivery_ledger
  FOR EACH ROW EXECUTE FUNCTION integration_yida_delivery_ledger_guard();

CREATE OR REPLACE FUNCTION integration_yida_delivery_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'YIDA_DELIVERY_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_delivery_ledger_truncate ON integration_yida_delivery_ledger;
CREATE TRIGGER trg_integration_yida_delivery_ledger_truncate
  BEFORE TRUNCATE ON integration_yida_delivery_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_delivery_truncate_guard();

CREATE OR REPLACE FUNCTION integration_yida_delivery_audit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'YIDA_DELIVERY_AUDIT_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_delivery_audit_guard ON integration_yida_delivery_audit;
CREATE TRIGGER trg_integration_yida_delivery_audit_guard
  BEFORE UPDATE OR DELETE ON integration_yida_delivery_audit
  FOR EACH ROW EXECUTE FUNCTION integration_yida_delivery_audit_guard();
DROP TRIGGER IF EXISTS trg_integration_yida_delivery_audit_truncate ON integration_yida_delivery_audit;
CREATE TRIGGER trg_integration_yida_delivery_audit_truncate
  BEFORE TRUNCATE ON integration_yida_delivery_audit
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_delivery_audit_guard();
