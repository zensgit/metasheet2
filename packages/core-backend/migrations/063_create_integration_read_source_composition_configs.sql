-- 063_create_integration_read_source_composition_configs.sql
-- plugin-integration-core · Read-source resolver composition C-R1 (#1709)
--
-- Persists approved-read composition chain configs as immutable content-keyed
-- versions plus a values-free audit trail. This table stores STRUCTURE ONLY:
-- approved read-source config references + handoff metadata. It never stores
-- runtime keys, intermediate resolved values, row payloads, credentials, hosts,
-- or probe/runtime responses.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_read_source_composition_configs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  name          TEXT NOT NULL,
  config        JSONB NOT NULL,                   -- C-R1 normalized chain structure only
  content_key   TEXT NOT NULL,                    -- sha256(stable-stringify(config without version))
  version       INTEGER NOT NULL,                 -- family = scope + name
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_composition_configs_content
  ON integration_read_source_composition_configs (tenant_id, COALESCE(workspace_id, ''), name, content_key);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_composition_configs_family_version
  ON integration_read_source_composition_configs (tenant_id, COALESCE(workspace_id, ''), name, version);
CREATE INDEX IF NOT EXISTS idx_integration_read_source_composition_configs_status
  ON integration_read_source_composition_configs (status);

CREATE TABLE IF NOT EXISTS integration_read_source_composition_config_audit (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  config_id     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('save_version', 'reuse_version', 'status_change')),
  actor         TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- coarse only: { version } or { from, to }
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_read_source_composition_config_audit_config
  ON integration_read_source_composition_config_audit (tenant_id, config_id, created_at);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_read_source_composition_configs_updated_at') THEN
    CREATE TRIGGER trg_integration_read_source_composition_configs_updated_at
      BEFORE UPDATE ON integration_read_source_composition_configs
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
