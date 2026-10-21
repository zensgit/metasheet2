-- GOV-08 operator declarations only. No delivery state/budget/fence updates.
CREATE TABLE IF NOT EXISTS integration_yida_reconciliation_observations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  grant_id TEXT NOT NULL REFERENCES integration_yida_auto_grants(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL REFERENCES integration_yida_auto_requests(id) ON DELETE RESTRICT,
  admission_id TEXT NOT NULL REFERENCES integration_yida_auto_admissions(id) ON DELETE RESTRICT,
  ledger_id TEXT NOT NULL REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  command_key TEXT NOT NULL,
  content_sha256 TEXT NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
  content JSONB NOT NULL CHECK(jsonb_typeof(content)='object' AND octet_length(content::text)<=4096),
  supersedes_id TEXT REFERENCES integration_yida_reconciliation_observations(id) ON DELETE RESTRICT,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(tenant_id,owner_id,grant_id,command_key),
  UNIQUE(ledger_id,sequence)
);
CREATE TABLE IF NOT EXISTS integration_yida_reconciliation_audit (
  observation_id TEXT PRIMARY KEY REFERENCES integration_yida_reconciliation_observations(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK(action='OPERATOR_OBSERVATION_APPENDED'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE OR REPLACE FUNCTION yida_reconciliation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'YIDA_RECONCILIATION_IMMUTABLE'; END;
$$;
DO $$ DECLARE item TEXT; BEGIN
  FOREACH item IN ARRAY ARRAY['integration_yida_reconciliation_observations','integration_yida_reconciliation_audit'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS yida_reconciliation_immutable ON %I',item);
    EXECUTE format('CREATE TRIGGER yida_reconciliation_immutable BEFORE UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION yida_reconciliation_immutable()',item);
    EXECUTE format('DROP TRIGGER IF EXISTS yida_reconciliation_no_truncate ON %I',item);
    EXECUTE format('CREATE TRIGGER yida_reconciliation_no_truncate BEFORE TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION yida_reconciliation_immutable()',item);
  END LOOP;
END $$;
CREATE OR REPLACE FUNCTION yida_reconciliation_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous INTEGER;
BEGIN
  -- Serialize even direct application SQL; no counter in a sending table changes.
  PERFORM id FROM integration_yida_auto_grants WHERE id=NEW.grant_id
    AND tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND workspace_id IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_SCOPE'; END IF;
  PERFORM a.id FROM integration_yida_auto_admissions a
    JOIN integration_yida_auto_requests r ON r.id=a.request_id AND r.grant_id=a.grant_id
    JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
    WHERE a.id=NEW.admission_id AND a.grant_id=NEW.grant_id AND a.request_id=NEW.request_id
      AND l.id=NEW.ledger_id AND l.tenant_id=NEW.tenant_id AND l.owner_id=NEW.owner_id AND l.workspace_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_CHAIN'; END IF;
  SELECT COALESCE(MAX(sequence),0) INTO previous FROM integration_yida_reconciliation_observations WHERE ledger_id=NEW.ledger_id;
  IF NEW.sequence<>previous+1 THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_SEQUENCE'; END IF;
  IF NEW.supersedes_id IS NOT NULL THEN
    PERFORM id FROM integration_yida_reconciliation_observations WHERE id=NEW.supersedes_id
      AND tenant_id=NEW.tenant_id AND owner_id=NEW.owner_id AND grant_id=NEW.grant_id AND ledger_id=NEW.ledger_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_SUPERSEDES'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS yida_reconciliation_chain ON integration_yida_reconciliation_observations;
CREATE TRIGGER yida_reconciliation_chain BEFORE INSERT ON integration_yida_reconciliation_observations
  FOR EACH ROW EXECUTE FUNCTION yida_reconciliation_chain();
CREATE OR REPLACE FUNCTION yida_reconciliation_audit_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM observation_id FROM integration_yida_reconciliation_audit WHERE observation_id=NEW.id;
  IF NOT FOUND THEN RAISE EXCEPTION 'YIDA_RECONCILIATION_AUDIT_REQUIRED'; END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS yida_reconciliation_audit_required ON integration_yida_reconciliation_observations;
CREATE CONSTRAINT TRIGGER yida_reconciliation_audit_required AFTER INSERT ON integration_yida_reconciliation_observations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION yida_reconciliation_audit_required();
