-- 061_create_integration_templates.sql
-- plugin-integration-core · S3-1 first-class integration-template object (contract + storage; NO instantiation).
-- Scoping mirrors 057 (tenant_id NOT NULL / workspace_id nullable / project_id optional; integration_ prefix per db.cjs ALLOWED_PREFIX).
-- The template is DECLARATIVE: it references a target adapter KIND + object + keyFields + field mappings; it does NOT
-- redefine C6 write-safety (that is the target's write profile). Instantiation (template -> pipeline+mappings+system.config)
-- is a later slice (S3-2) and is NOT part of this migration.
CREATE TABLE IF NOT EXISTS integration_templates (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  workspace_id         TEXT,
  project_id           TEXT,
  name                 TEXT NOT NULL,
  version              INTEGER NOT NULL DEFAULT 1,
  description          TEXT,
  source_kind          TEXT,
  source_object        TEXT,
  target_kind          TEXT NOT NULL,
  target_object        TEXT,
  key_fields           JSONB NOT NULL DEFAULT '[]'::jsonb,
  mapping_def          JSONB NOT NULL DEFAULT '[]'::jsonb,
  orchestration_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_templates_scope_name
  ON integration_templates (tenant_id, COALESCE(workspace_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_integration_templates_scope ON integration_templates(tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_templates_status ON integration_templates(status);
CREATE INDEX IF NOT EXISTS idx_integration_templates_target_kind ON integration_templates(target_kind);
