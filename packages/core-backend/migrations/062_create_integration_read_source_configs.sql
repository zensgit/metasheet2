-- 062_create_integration_read_source_configs.sql
-- plugin-integration-core · External-API read self-service S2-c (#1709)
--
-- Persists consultant-authored read-source configs as immutable content-keyed
-- VERSIONS plus a values-free audit trail (S2 design-lock locks 5/6):
--   * config       —— the S1 NORMALIZED structure only (validateReadSourceConfig
--                     output). Stores the systemId REFERENCE — never a resolved
--                     base URL, never credential material, never a probe response.
--                     Resolution stays dynamic at probe/read time.
--   * content_key  —— sha256 hex over a stable (sorted-key) stringify of the
--                     normalized config. An identical save is a NO-OP that
--                     returns the existing version; a changed save mints the
--                     next version in its family.
--   * status       —— draft → approved → retired. Only approved versions are
--                     runtime-consumable (S3); transitions are enforced in
--                     lib/read-source-config-store.cjs and audited.
--
-- Scoping 惯例与 057 对齐：tenant_id NOT NULL；workspace_id 可为 NULL。
-- 所有表以 integration_ 前缀开头，与 plugin-integration-core/lib/db.cjs
-- 的 ALLOWED_PREFIX 对齐。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_read_source_configs (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  system_id     TEXT NOT NULL,                    -- external-system REFERENCE only（永不存解析后的 base URL / 凭证）
  object        TEXT NOT NULL,
  mode          TEXT NOT NULL CHECK (mode IN ('single_record', 'list_page', 'detail_with_lines', 'resolver_lookup')),
  config        JSONB NOT NULL,                   -- S1 normalized structure（结构，非值；无凭证，无探针响应）
  content_key   TEXT NOT NULL,                    -- sha256(stable-stringify(config))，幂等保存键
  version       INTEGER NOT NULL,                 -- 家族内单调递增（家族 = scope + system_id + object + mode）
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NULL is not equal to NULL in Postgres's default UNIQUE semantics, so a
-- plain UNIQUE(..., workspace_id, ...) would allow duplicate rows when
-- workspace_id IS NULL (single-workspace deployments). PG 14 has no
-- NULLS NOT DISTINCT, so use an expression index that coerces NULL to ''.
-- Application MUST treat '' and NULL workspace_id as equivalent — or simpler,
-- never store '' — callers should pass NULL for "no workspace".
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_read_source_configs_content
  ON integration_read_source_configs (tenant_id, COALESCE(workspace_id, ''), system_id, object, mode, content_key);
CREATE INDEX IF NOT EXISTS idx_integration_read_source_configs_system
  ON integration_read_source_configs (tenant_id, COALESCE(workspace_id, ''), system_id);
CREATE INDEX IF NOT EXISTS idx_integration_read_source_configs_status
  ON integration_read_source_configs (status);

-- ---------------------------------------------------------------------------
-- Audit —— values-free：只存粗粒度动作/状态枚举与版本号，
-- 永不存 config 内容、路径、字段名或错误消息文本。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_read_source_config_audit (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  config_id     TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('save_version', 'reuse_version', 'status_change')),
  actor         TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 粗粒度：{ version } 或 { from, to } — 永不含配置内容
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_read_source_config_audit_config
  ON integration_read_source_config_audit (tenant_id, config_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at 触发器（复用 057 的 integration_set_updated_at）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_read_source_configs_updated_at') THEN
    CREATE TRIGGER trg_integration_read_source_configs_updated_at
      BEFORE UPDATE ON integration_read_source_configs
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
