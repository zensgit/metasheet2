-- 079_create_integration_stock_prep_source_binding.sql
-- plugin-integration-core · 工作台里选源 — the PERSISTED SOURCE BINDING for the stock-preparation
-- pull table action.
--
-- WHY THIS TABLE EXISTS. The action's `source.externalSystemId` came from
-- INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON, parsed once at plugin activation into an
-- in-process Map. Pointing a deployment at a customer's own PLM therefore required editing an env
-- file on the server and restarting the backend — an implementer with a shell, per customer, for a
-- change whose whole content is "which of the systems already registered in this tenant do we
-- read?". This row IS that answer, and because it is read per request the change takes effect on
-- the next call rather than on the next restart.
--
--   * action_id           —— the frozen table-action id (today exactly
--                            'plm.stock-preparation.pull-bom.v1'); carried as a column, not assumed,
--                            so a second bindable action does not need a second table.
--   * external_system_id  —— a REFERENCE into integration_external_systems. Deliberately NOT a
--                            foreign key: that table lives in the same schema but is owned by the
--                            plugin's own scoped db helper, and the eligibility check that actually
--                            matters (kind is one of the two BOM read kinds, status active, role not
--                            target, and the caller may use the core data source behind it — #5401)
--                            is not expressible as a constraint. A dangling id fails CLOSED at read
--                            time in loadTableActionSourceAdapter (TABLE_ACTION_SOURCE_INVALID),
--                            which is where a repointed-then-deleted system must be caught anyway.
--   * updated_by          —— operator identity (user id / email), same posture as 062 and 066.
--
-- ENV REMAINS THE FALLBACK DEFAULT. No row for a scope means the action keeps resolving the env
-- value exactly as it did before this migration, so an existing deployment is byte-identical until
-- someone actually picks a source. That is why there is no seeding step and no NOT NULL default:
-- "unset" must stay distinguishable from "bound", because the two resolve differently.
--
-- SCOPING 惯例与 057/062/066 对齐:tenant_id NOT NULL;workspace_id 可为 NULL,并用 COALESCE 收敛到
-- 唯一索引(PG14 无 NULLS NOT DISTINCT,与 057 的 external-systems 名称唯一索引同一处理)。
-- integration_ 前缀与 plugin-integration-core/lib/db.cjs 的 ALLOWED_PREFIX 对齐。
--
-- VALUES-FREE: every column is a handle or a server clock. No credential, no host, no connection
-- string and no customer business value can land here — the thing stored is a pointer at the row
-- where (encrypted) connection material already lives.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_source_binding (
  id                  TEXT PRIMARY KEY,
  tenant_id           TEXT NOT NULL,
  workspace_id        TEXT,
  action_id           TEXT NOT NULL,
  external_system_id  TEXT NOT NULL,
  updated_by          TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ONE live binding per (tenant, workspace, action). This index is the whole concurrency story: two
-- admins repointing the same action at the same moment resolve to one row at the database, and the
-- store's transaction reads the value it replaced inside the same unit of work, so the audit row can
-- never name a source that was not actually replaced.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_source_binding_scope
  ON integration_stock_prep_source_binding (tenant_id, COALESCE(workspace_id, ''), action_id);

CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_source_binding_system
  ON integration_stock_prep_source_binding (tenant_id, external_system_id);

COMMENT ON TABLE integration_stock_prep_source_binding IS
  'Persisted per-(tenant,workspace,action) override for the stock-preparation table action source external system. Resolved per REQUEST (registry resolveSourceBinding seam), so rebinding takes effect without a backend restart; absent row = fall back to the INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON default.';
