-- 057_create_integration_core_tables.sql
-- plugin-integration-core · MVP 数据模型（M0-T07 / M1-T01, M1-T02）
--
-- Scoping 惯例（与 bpmn_* / plugin_configs / plugin-after-sales ledger 对齐）：
--   tenant_id     TEXT NOT NULL    —— 多租户必填
--   workspace_id  TEXT             —— 租户内工作区；单工作区部署可为 NULL
--   project_id    TEXT             —— 关联平台应用项目；可选
-- K3 WISE 账套、Yuantus PLM 的 org_id 等外部系统维度不在本层拆列，
-- 存放于 integration_external_systems.config JSONB 中，避免每家 ERP/PLM
-- 拉一个专属列。
--
-- 所有表以 integration_ 前缀开头，与 plugin-integration-core/lib/db.cjs
-- 的 ALLOWED_PREFIX 对齐。
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. External systems —— 已注册的 PLM / ERP / DB 连接
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_external_systems (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  workspace_id          TEXT,
  project_id            TEXT,
  name                  TEXT NOT NULL,
  kind                  TEXT NOT NULL,       -- 'plm:yuantus' | 'erp:k3-wise-webapi' | 'erp:k3-wise-sqlserver' | 'http' | 'postgres' | ...
  role                  TEXT NOT NULL CHECK (role IN ('source', 'target', 'bidirectional')),
  config                JSONB NOT NULL DEFAULT '{}'::jsonb,        -- base_url / host / port / db_name / account_set_id / env / 其它非密码字段
  credentials_encrypted TEXT,                                       -- lib/credential-store.cjs ciphertext；新写 enc:，兼容读旧 v1:，永不明文
  capabilities          JSONB NOT NULL DEFAULT '{}'::jsonb,        -- { read, write, introspect, watermarkFields: [] }
  status                TEXT NOT NULL DEFAULT 'inactive' CHECK (status IN ('active', 'inactive', 'error')),
  last_tested_at        TIMESTAMPTZ,
  last_error            TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NULL is not equal to NULL in Postgres's default UNIQUE semantics, so a
-- plain UNIQUE(tenant_id, workspace_id, name) would allow duplicate rows
-- when workspace_id IS NULL (single-workspace deployments). PG 14 has no
-- NULLS NOT DISTINCT, so use an expression index that coerces NULL to ''.
-- Application MUST treat '' and NULL workspace_id as equivalent — or simpler,
-- never store '' — callers should pass NULL for "no workspace".
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_external_systems_scope_name
  ON integration_external_systems (tenant_id, COALESCE(workspace_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_integration_external_systems_scope ON integration_external_systems(tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_external_systems_kind ON integration_external_systems(kind);
CREATE INDEX IF NOT EXISTS idx_integration_external_systems_status ON integration_external_systems(status);

-- ---------------------------------------------------------------------------
-- 2. Pipelines —— 清洗/同步作业定义
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_pipelines (
  id                        TEXT PRIMARY KEY,
  tenant_id                 TEXT NOT NULL,
  workspace_id              TEXT,
  project_id                TEXT,
  name                      TEXT NOT NULL,
  description               TEXT,
  source_system_id          TEXT NOT NULL REFERENCES integration_external_systems(id) ON DELETE RESTRICT,
  source_object             TEXT NOT NULL,                         -- 源对象名（物料 / BOM / 表名 / endpoint）
  target_system_id          TEXT NOT NULL REFERENCES integration_external_systems(id) ON DELETE RESTRICT,
  target_object             TEXT NOT NULL,
  staging_sheet_id          TEXT,                                  -- 多维表格 staging 表 id（staging-installer 管理）
  mode                      TEXT NOT NULL DEFAULT 'incremental' CHECK (mode IN ('incremental', 'full', 'manual')),
  idempotency_key_fields    JSONB NOT NULL DEFAULT '[]'::jsonb,   -- ['sourceSystem','objectType','sourceId','revision']
  options                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  status                    TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'disabled')),
  created_by                TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- See note on integration_external_systems above — same NULL-handling trap.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_pipelines_scope_name
  ON integration_pipelines (tenant_id, COALESCE(workspace_id, ''), name);
CREATE INDEX IF NOT EXISTS idx_integration_pipelines_scope ON integration_pipelines(tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_pipelines_status ON integration_pipelines(status);
CREATE INDEX IF NOT EXISTS idx_integration_pipelines_source_system ON integration_pipelines(source_system_id);
CREATE INDEX IF NOT EXISTS idx_integration_pipelines_target_system ON integration_pipelines(target_system_id);

-- ---------------------------------------------------------------------------
-- 3. Field mappings —— 字段映射 + transform + 校验
--    作用域跟随 pipeline，不单独持 tenant_id（外键级联即可）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_field_mappings (
  id                TEXT PRIMARY KEY,
  pipeline_id       TEXT NOT NULL REFERENCES integration_pipelines(id) ON DELETE CASCADE,
  source_field      TEXT NOT NULL,
  target_field      TEXT NOT NULL,
  transform         JSONB,                                         -- { fn: 'trim'|'upper'|'toNumber'|'dictMap', args: {...} }
  validation        JSONB,                                         -- FieldValidationConfig: [{ type, params?, message? }, ...]
  default_value     JSONB,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_field_mappings_pipeline ON integration_field_mappings(pipeline_id);

-- ---------------------------------------------------------------------------
-- 4. Runs —— 每次 pipeline 执行记录
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_runs (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  workspace_id      TEXT,
  pipeline_id       TEXT NOT NULL REFERENCES integration_pipelines(id) ON DELETE CASCADE,
  mode              TEXT NOT NULL,                                 -- 'incremental' | 'full' | 'manual' | 'replay'
  triggered_by      TEXT NOT NULL,                                 -- 'cron' | 'manual' | 'api' | 'replay'
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
  rows_read         INTEGER NOT NULL DEFAULT 0,
  rows_cleaned      INTEGER NOT NULL DEFAULT 0,
  rows_written      INTEGER NOT NULL DEFAULT 0,
  rows_failed       INTEGER NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  finished_at       TIMESTAMPTZ,
  duration_ms       INTEGER,
  error_summary     TEXT,
  details           JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_runs_scope ON integration_runs(tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_runs_pipeline ON integration_runs(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_integration_runs_status ON integration_runs(status);
CREATE INDEX IF NOT EXISTS idx_integration_runs_created_at ON integration_runs(created_at DESC);

-- ---------------------------------------------------------------------------
-- 5. Watermarks —— 增量水位（作用域跟随 pipeline）
--    NOTE: tenant/workspace scope is inherited from integration_pipelines.
--    DB-level cross-row scope enforcement is deferred to the M1 service layer.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_watermarks (
  pipeline_id       TEXT PRIMARY KEY REFERENCES integration_pipelines(id) ON DELETE CASCADE,
  watermark_type    TEXT NOT NULL CHECK (watermark_type IN ('updated_at', 'monotonic_id')),
  watermark_value   TEXT NOT NULL,                                 -- ISO8601 or integer-as-string
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- 6. Dead letters —— 失败记录 + 可重放
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_dead_letters (
  id                    TEXT PRIMARY KEY,
  tenant_id             TEXT NOT NULL,
  workspace_id          TEXT,
  run_id                TEXT NOT NULL REFERENCES integration_runs(id) ON DELETE CASCADE,
  pipeline_id           TEXT NOT NULL REFERENCES integration_pipelines(id) ON DELETE CASCADE,
  idempotency_key       TEXT,
  source_payload        JSONB NOT NULL,
  transformed_payload   JSONB,
  error_code            TEXT NOT NULL,
  error_message         TEXT NOT NULL,
  retry_count           INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'replayed', 'discarded')),
  last_replay_run_id    TEXT,                                      -- references integration_runs.id；replay 保留原 run 关联
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_scope ON integration_dead_letters(tenant_id, workspace_id);
CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_pipeline ON integration_dead_letters(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_run ON integration_dead_letters(run_id);
CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_status ON integration_dead_letters(status);
CREATE INDEX IF NOT EXISTS idx_integration_dead_letters_idempotency_key ON integration_dead_letters(idempotency_key);

-- ---------------------------------------------------------------------------
-- 7. Schedules —— 定时触发（cron）
--    作用域跟随 pipeline。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_schedules (
  id                TEXT PRIMARY KEY,
  pipeline_id       TEXT NOT NULL REFERENCES integration_pipelines(id) ON DELETE CASCADE,
  cron_expression   TEXT NOT NULL,
  timezone          TEXT NOT NULL DEFAULT 'UTC',
  enabled           BOOLEAN NOT NULL DEFAULT true,
  last_run_at       TIMESTAMPTZ,
  next_run_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_schedules_pipeline ON integration_schedules(pipeline_id);
CREATE INDEX IF NOT EXISTS idx_integration_schedules_enabled_next_run ON integration_schedules(enabled, next_run_at);

-- ---------------------------------------------------------------------------
-- updated_at 触发器
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION integration_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_external_systems_updated_at') THEN
    CREATE TRIGGER trg_integration_external_systems_updated_at
      BEFORE UPDATE ON integration_external_systems
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_pipelines_updated_at') THEN
    CREATE TRIGGER trg_integration_pipelines_updated_at
      BEFORE UPDATE ON integration_pipelines
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_watermarks_updated_at') THEN
    CREATE TRIGGER trg_integration_watermarks_updated_at
      BEFORE UPDATE ON integration_watermarks
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_dead_letters_updated_at') THEN
    CREATE TRIGGER trg_integration_dead_letters_updated_at
      BEFORE UPDATE ON integration_dead_letters
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_schedules_updated_at') THEN
    CREATE TRIGGER trg_integration_schedules_updated_at
      BEFORE UPDATE ON integration_schedules
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
