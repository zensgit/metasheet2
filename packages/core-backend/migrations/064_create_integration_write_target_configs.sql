-- 064_create_integration_write_target_configs.sql
-- plugin-integration-core · External-API WRITE self-service W1
--
-- Persists consultant-authored write-target configs as immutable content-keyed
-- versions plus a values-free audit trail. This is CONFIG-TIME ONLY:
-- no dry-run, no apply, no runtime route, and no external write.
--
-- Stores references only:
--   * system_id         production target external-system REFERENCE
--   * sandbox_system_id sandbox target external-system REFERENCE (must differ, enforced in app validator)
-- It never stores resolved base URLs, credential material, row payload values,
-- dry-run responses, or adapter responses.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_write_target_configs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  workspace_id      TEXT,
  system_id         TEXT NOT NULL,
  sandbox_system_id TEXT NOT NULL,
  object            TEXT NOT NULL,
  operation         TEXT NOT NULL CHECK (operation IN ('upsert', 'save_only')),
  config            JSONB NOT NULL,
  content_key       TEXT NOT NULL,
  version           INTEGER NOT NULL,
  status            TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by        TEXT,
  updated_by        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_write_target_configs_content
  ON integration_write_target_configs (
    tenant_id,
    COALESCE(workspace_id, ''),
    system_id,
    sandbox_system_id,
    object,
    operation,
    content_key
  );

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_write_target_configs_family_version
  ON integration_write_target_configs (
    tenant_id,
    COALESCE(workspace_id, ''),
    system_id,
    sandbox_system_id,
    object,
    operation,
    version
  );

CREATE INDEX IF NOT EXISTS idx_integration_write_target_configs_system
  ON integration_write_target_configs (tenant_id, COALESCE(workspace_id, ''), system_id, sandbox_system_id);

CREATE INDEX IF NOT EXISTS idx_integration_write_target_configs_status
  ON integration_write_target_configs (status);

-- ---------------------------------------------------------------------------
-- Audit is values-free: only coarse actions and enum/count-style details.
-- It must never contain config bodies, endpoints, field names, payload values,
-- credentials, host names, or error messages.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_write_target_config_audit (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  config_id     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('save_version', 'reuse_version', 'status_change')),
  actor         TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_write_target_config_audit_config
  ON integration_write_target_config_audit (tenant_id, config_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_write_target_configs_updated_at') THEN
    CREATE TRIGGER trg_integration_write_target_configs_updated_at
      BEFORE UPDATE ON integration_write_target_configs
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
