-- Internal YiDa material lifecycle only. No runtime consumer or sending authority.
-- Keep one encrypted bundle: rotation overwrites it; revocation erases it.
-- The permanent audit retains identity/generation/state, never historical secrets.
CREATE TABLE IF NOT EXISTS integration_yida_credential_materials (
  credential_ref TEXT PRIMARY KEY CHECK (credential_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 128),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  status TEXT NOT NULL CHECK (status IN ('current', 'revoked')),
  material_encrypted TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_credential_material_shape CHECK (
    (status = 'current' AND material_encrypted IS NOT NULL
      AND length(material_encrypted) BETWEEN 5 AND 262144 AND material_encrypted LIKE 'enc:%')
    OR (status = 'revoked' AND material_encrypted IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS integration_yida_credential_audit (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  credential_ref TEXT NOT NULL REFERENCES integration_yida_credential_materials(credential_ref) ON DELETE RESTRICT,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  event TEXT NOT NULL CHECK (event IN ('create', 'rotate', 'revoke')),
  status TEXT NOT NULL CHECK (status IN ('current', 'revoked')),
  actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_yida_credential_audit_shape CHECK (
    (event = 'create' AND generation = 1 AND status = 'current')
    OR (event = 'rotate' AND generation > 1 AND status = 'current')
    OR (event = 'revoke' AND status = 'revoked')
  ),
  CONSTRAINT uniq_integration_yida_credential_audit_event UNIQUE (credential_ref, generation, event)
);

CREATE OR REPLACE FUNCTION integration_yida_credential_material_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'YIDA_CREDENTIAL_IMMUTABLE'; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.generation IS DISTINCT FROM 1 OR NEW.status IS DISTINCT FROM 'current'
      OR NEW.material_encrypted IS NULL OR NEW.material_encrypted NOT LIKE 'enc:%'
      OR length(NEW.material_encrypted) NOT BETWEEN 5 AND 262144 THEN
      RAISE EXCEPTION 'YIDA_CREDENTIAL_TRANSITION';
    END IF;
    NEW.created_at := NOW();
    NEW.updated_at := NOW();
    RETURN NEW;
  END IF;
  IF OLD.credential_ref IS DISTINCT FROM NEW.credential_ref
    OR OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
    OR OLD.workspace_id IS DISTINCT FROM NEW.workspace_id
    OR OLD.owner_id IS DISTINCT FROM NEW.owner_id
    OR OLD.created_at IS DISTINCT FROM NEW.created_at THEN
    RAISE EXCEPTION 'YIDA_CREDENTIAL_IMMUTABLE';
  END IF;
  -- bigint comparison avoids overflowing at max generation; revoke still works.
  IF NOT (
    (NEW.status = 'current' AND NEW.generation::bigint = OLD.generation::bigint + 1
      AND NEW.material_encrypted IS NOT NULL AND NEW.material_encrypted LIKE 'enc:%'
      AND length(NEW.material_encrypted) BETWEEN 5 AND 262144)
    OR (OLD.status = 'current' AND NEW.status = 'revoked' AND NEW.generation = OLD.generation
      AND NEW.material_encrypted IS NULL)
  ) THEN RAISE EXCEPTION 'YIDA_CREDENTIAL_TRANSITION'; END IF;
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_credential_material_guard ON integration_yida_credential_materials;
CREATE TRIGGER trg_integration_yida_credential_material_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_credential_materials
  FOR EACH ROW EXECUTE FUNCTION integration_yida_credential_material_guard();

CREATE OR REPLACE FUNCTION integration_yida_credential_material_truncate_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'YIDA_CREDENTIAL_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_credential_material_truncate ON integration_yida_credential_materials;
CREATE TRIGGER trg_integration_yida_credential_material_truncate
  BEFORE TRUNCATE ON integration_yida_credential_materials
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_credential_material_truncate_guard();

CREATE OR REPLACE FUNCTION integration_yida_credential_audit_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.created_at := NOW();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'YIDA_CREDENTIAL_AUDIT_IMMUTABLE';
END;
$$;
DROP TRIGGER IF EXISTS trg_integration_yida_credential_audit_guard ON integration_yida_credential_audit;
CREATE TRIGGER trg_integration_yida_credential_audit_guard
  BEFORE INSERT OR UPDATE OR DELETE ON integration_yida_credential_audit
  FOR EACH ROW EXECUTE FUNCTION integration_yida_credential_audit_guard();
DROP TRIGGER IF EXISTS trg_integration_yida_credential_audit_truncate ON integration_yida_credential_audit;
CREATE TRIGGER trg_integration_yida_credential_audit_truncate
  BEFORE TRUNCATE ON integration_yida_credential_audit
  FOR EACH STATEMENT EXECUTE FUNCTION integration_yida_credential_audit_guard();
