-- SA02: immutable, scoped PLM stock-preparation read-plan versions and an
-- independent explicit activation pointer. Neither grants execution authority;
-- system_id is a handle only, never source content or credentials.
CREATE TABLE IF NOT EXISTS integration_stock_prep_read_plan_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (tenant_id <> ''),
  workspace_id TEXT CHECK (workspace_id IS NULL OR workspace_id <> ''),
  action_id TEXT NOT NULL CHECK (action_id = 'plm.stock-preparation.pull-bom.v1'),
  system_id TEXT NOT NULL CHECK (system_id <> ''),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  config JSONB NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  content_key TEXT NOT NULL CHECK (content_key ~ '^[0-9a-f]{64}$'),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by TEXT NOT NULL CHECK (created_by <> ''),
  updated_by TEXT NOT NULL CHECK (updated_by <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- PG14-compatible NULL equality. Empty workspace ids are forbidden above.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_read_plan_content
  ON integration_stock_prep_read_plan_versions
  (tenant_id, COALESCE(workspace_id, ''), action_id, system_id, content_key);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_read_plan_family_version
  ON integration_stock_prep_read_plan_versions
  (tenant_id, COALESCE(workspace_id, ''), action_id, system_id, version);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_read_plan_scope
  ON integration_stock_prep_read_plan_versions
  (tenant_id, COALESCE(workspace_id, ''), action_id, system_id, status);

-- One exact-scope pointer per action. Disabled rows remain to preserve the
-- generation fence across deactivate/reactivate (no ABA via physical deletion).
CREATE TABLE IF NOT EXISTS integration_stock_prep_read_plan_activation (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (tenant_id <> ''),
  workspace_id TEXT CHECK (workspace_id IS NULL OR workspace_id <> ''),
  action_id TEXT NOT NULL CHECK (action_id = 'plm.stock-preparation.pull-bom.v1'),
  version_id TEXT NOT NULL REFERENCES integration_stock_prep_read_plan_versions(id),
  system_id TEXT NOT NULL CHECK (system_id <> ''),
  content_key TEXT NOT NULL CHECK (content_key ~ '^[0-9a-f]{64}$'),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 2147483647),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_by TEXT NOT NULL CHECK (created_by <> ''),
  updated_by TEXT NOT NULL CHECK (updated_by <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_read_plan_activation_scope
  ON integration_stock_prep_read_plan_activation
  (tenant_id, COALESCE(workspace_id, ''), action_id);

CREATE TABLE IF NOT EXISTS integration_stock_prep_read_plan_audit (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL CHECK (tenant_id <> ''),
  workspace_id TEXT CHECK (workspace_id IS NULL OR workspace_id <> ''),
  version_id TEXT NOT NULL REFERENCES integration_stock_prep_read_plan_versions(id),
  action TEXT NOT NULL CHECK (action IN ('save_version', 'reuse_version', 'status_change', 'activate', 'deactivate')),
  actor TEXT NOT NULL CHECK (actor <> ''),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_read_plan_audit_version
  ON integration_stock_prep_read_plan_audit (tenant_id, COALESCE(workspace_id, ''), version_id, created_at);
