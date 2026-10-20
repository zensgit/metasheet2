-- SA06D private infrastructure. No route, capability, sender or enablement.
CREATE TABLE IF NOT EXISTS integration_yida_auto_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  activation_id TEXT NOT NULL,
  confirmation_id TEXT NOT NULL,
  contract JSONB NOT NULL CHECK (jsonb_typeof(contract) = 'object'),
  material_revision TEXT NOT NULL CHECK (material_revision ~ '^[0-9a-f]{64}$'),
  max_executions INTEGER NOT NULL CHECK (max_executions BETWEEN 1 AND 10),
  row_count INTEGER NOT NULL CHECK (row_count BETWEEN 1 AND max_executions),
  ttl_ms INTEGER NOT NULL CHECK (ttl_ms BETWEEN 1 AND 900000),
  approved_at_ms BIGINT NOT NULL CHECK (approved_at_ms > 0),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms = approved_at_ms + ttl_ms),
  approved_monotonic_ms BIGINT NOT NULL CHECK (approved_monotonic_ms >= 0),
  last_db_ms BIGINT NOT NULL CHECK (last_db_ms >= approved_at_ms),
  last_monotonic_ms BIGINT NOT NULL CHECK (last_monotonic_ms >= approved_monotonic_ms),
  used_executions INTEGER NOT NULL DEFAULT 0 CHECK (used_executions BETWEEN 0 AND max_executions),
  active_request_id TEXT,
  UNIQUE (tenant_id, owner_id, confirmation_id)
);

CREATE TABLE IF NOT EXISTS integration_yida_auto_revocations (
  grant_id TEXT PRIMARY KEY REFERENCES integration_yida_auto_grants(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS integration_yida_auto_requests (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL REFERENCES integration_yida_auto_grants(id) ON DELETE RESTRICT,
  occurrence_key TEXT NOT NULL CHECK (occurrence_key ~ '^[0-9a-f]{64}$'),
  row_ordinal INTEGER NOT NULL CHECK (row_ordinal BETWEEN 0 AND 9),
  status TEXT NOT NULL CHECK (status IN ('queued', 'admitted', 'closed_observed', 'closed_unknown', 'closed_not_sent')),
  UNIQUE (grant_id, occurrence_key),
  UNIQUE (grant_id, row_ordinal),
  UNIQUE (grant_id, id)
);

CREATE TABLE IF NOT EXISTS integration_yida_auto_admissions (
  id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  ledger_id TEXT NOT NULL UNIQUE REFERENCES integration_yida_delivery_ledger(id) ON DELETE RESTRICT,
  worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 128),
  worker_fence BIGINT NOT NULL CHECK (worker_fence > 0),
  admitted_at_ms BIGINT NOT NULL,
  FOREIGN KEY (grant_id, request_id) REFERENCES integration_yida_auto_requests(grant_id, id) ON DELETE RESTRICT
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='integration_yida_auto_grants'::regclass
    AND conname='fk_yida_auto_active_request') THEN
    ALTER TABLE integration_yida_auto_grants ADD CONSTRAINT fk_yida_auto_active_request
      FOREIGN KEY (id, active_request_id) REFERENCES integration_yida_auto_requests(grant_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION integration_yida_auto_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='integration_yida_auto_grants' THEN
    IF (to_jsonb(NEW)-ARRAY['used_executions','active_request_id','last_db_ms','last_monotonic_ms'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['used_executions','active_request_id','last_db_ms','last_monotonic_ms'])
      OR NEW.used_executions < OLD.used_executions OR NEW.used_executions > OLD.used_executions+1
      OR NEW.last_db_ms < OLD.last_db_ms OR NEW.last_monotonic_ms < OLD.last_monotonic_ms THEN
      RAISE EXCEPTION 'YIDA_AUTO_IMMUTABLE';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='UPDATE' AND TG_TABLE_NAME='integration_yida_auto_requests' THEN
    IF (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') OR NOT
      (OLD.status='queued' AND NEW.status='admitted' OR OLD.status='admitted'
        AND NEW.status IN ('closed_observed','closed_unknown','closed_not_sent')) THEN
      RAISE EXCEPTION 'YIDA_AUTO_REQUEST_TRANSITION';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_AUTO_IMMUTABLE';
END;
$$;

DO $$ DECLARE item TEXT; BEGIN
  FOREACH item IN ARRAY ARRAY['integration_yida_auto_grants','integration_yida_auto_revocations',
    'integration_yida_auto_requests','integration_yida_auto_admissions'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS yida_auto_immutable ON %I', item);
    EXECUTE format('CREATE TRIGGER yida_auto_immutable BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_immutable()', item);
    EXECUTE format('DROP TRIGGER IF EXISTS yida_auto_no_truncate ON %I', item);
    EXECUTE format('CREATE TRIGGER yida_auto_no_truncate BEFORE TRUNCATE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_auto_immutable()', item);
  END LOOP;
END $$;

-- A committed counter and its admissions must agree, including direct SQL or
-- a transaction which loses its COMMIT response. Neither fact may be refunded.
CREATE OR REPLACE FUNCTION integration_yida_auto_budget_integrity() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE grant_key TEXT; used INTEGER; actual BIGINT;
BEGIN
  IF TG_TABLE_NAME='integration_yida_auto_grants' THEN grant_key:=NEW.id;
  ELSE grant_key:=NEW.grant_id; END IF;
  SELECT used_executions INTO STRICT used FROM integration_yida_auto_grants WHERE id=grant_key;
  SELECT count(*) INTO actual FROM integration_yida_auto_admissions WHERE grant_id=grant_key;
  IF used<>actual THEN RAISE EXCEPTION 'YIDA_AUTO_BUDGET_INTEGRITY'; END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS yida_auto_budget_integrity ON integration_yida_auto_grants;
CREATE CONSTRAINT TRIGGER yida_auto_budget_integrity AFTER INSERT OR UPDATE ON integration_yida_auto_grants
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_budget_integrity();
DROP TRIGGER IF EXISTS yida_auto_budget_integrity ON integration_yida_auto_admissions;
CREATE CONSTRAINT TRIGGER yida_auto_budget_integrity AFTER INSERT ON integration_yida_auto_admissions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION integration_yida_auto_budget_integrity();
