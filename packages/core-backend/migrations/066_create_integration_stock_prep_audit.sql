-- 066_create_integration_stock_prep_audit.sql
-- plugin-integration-core · stock-prep MVP W5b (#3751 / #3890)
--
-- VALUES-FREE audit trail for the stock-preparation write surface (mapping/unit confirms + retires,
-- candidate sync, generation runs, exception resolution). One row per successful write operation.
--   * action     —— closed vocabulary, enforced in lib/stock-preparation-audit-store.cjs
--   * subject_id —— internal handle only (mappingId / conversionRuleId / exceptionId /
--                   snapshotBatchId — content-hash or stable ids, never business values)
--   * detail     —— values-free by construction (store-side guard: scalars/enum-shaped strings and
--                   one nested level of numeric count maps only; never a drawing number, unit
--                   symbol, quantity, or exception message)
--   * actor      —— operator identity (user id / email), same posture as the read-source audit
--
-- Scoping 惯例与 057/062 对齐：tenant_id NOT NULL；workspace_id 可为 NULL。
-- integration_ 前缀与 plugin-integration-core/lib/db.cjs 的 ALLOWED_PREFIX 对齐。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_audit (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  project_id    TEXT,                             -- business project handle (nullable: confirm ops are tenant-scoped)
  action        TEXT NOT NULL CHECK (action IN (
                  'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire',
                  'unit_confirm', 'unit_retire',
                  'generation_run', 'exception_resolve', 'exception_bulk_resolve'
                )),
  subject_id    TEXT,                             -- internal handle only
  mode          TEXT,                             -- result mode enum (created / confirmed / retired / skipped_* / refreshed / resolved)
  actor         TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_audit_tenant_time
  ON integration_stock_prep_audit (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_audit_action
  ON integration_stock_prep_audit (tenant_id, action, created_at DESC);
