-- Immutable encrypted execution anchors. No sender or global activation.
CREATE TABLE IF NOT EXISTS integration_yida_auto_execution_snapshots (
  admission_id TEXT PRIMARY KEY REFERENCES integration_yida_auto_admissions(id) ON DELETE RESTRICT,
  grant_id TEXT NOT NULL REFERENCES integration_yida_auto_grants(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_auto_requests(id) ON DELETE RESTRICT,
  ledger_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT,
  worker_id TEXT NOT NULL,
  worker_fence BIGINT NOT NULL CHECK (worker_fence>0),
  activation_id TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms>0),
  material_revision TEXT NOT NULL CHECK (material_revision ~ '^[0-9a-f]{64}$'),
  execution_payload_digest TEXT NOT NULL CHECK (execution_payload_digest ~ '^[0-9a-f]{64}$'),
  snapshot_encrypted TEXT NOT NULL CHECK (snapshot_encrypted LIKE 'enc:%' AND length(snapshot_encrypted)>4)
);
CREATE OR REPLACE FUNCTION integration_yida_auto_execution_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM integration_yida_auto_admissions a
    JOIN integration_yida_auto_grants g ON g.id=a.grant_id
    JOIN integration_yida_delivery_ledger l ON l.id=a.ledger_id
    WHERE a.id=NEW.admission_id AND a.grant_id=NEW.grant_id AND a.request_id=NEW.request_id
      AND a.ledger_id=NEW.ledger_id AND a.worker_id=NEW.worker_id AND a.worker_fence=NEW.worker_fence
      AND g.activation_id=NEW.activation_id AND g.material_revision=NEW.material_revision
      AND NEW.expires_at_ms<=g.expires_at_ms AND l.payload_digest=NEW.execution_payload_digest) THEN
    RAISE EXCEPTION 'YIDA_AUTO_EXECUTION_IDENTITY';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS yida_auto_execution_identity ON integration_yida_auto_execution_snapshots;
CREATE TRIGGER yida_auto_execution_identity BEFORE INSERT ON integration_yida_auto_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_execution_identity();
DROP TRIGGER IF EXISTS yida_auto_immutable ON integration_yida_auto_execution_snapshots;
CREATE TRIGGER yida_auto_immutable BEFORE UPDATE OR DELETE ON integration_yida_auto_execution_snapshots
  FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_immutable();
DROP TRIGGER IF EXISTS yida_auto_no_truncate ON integration_yida_auto_execution_snapshots;
CREATE TRIGGER yida_auto_no_truncate BEFORE TRUNCATE ON integration_yida_auto_execution_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_auto_immutable();
