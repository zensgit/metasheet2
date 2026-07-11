-- 065_create_integration_bridge_agent_checklists.sql
-- plugin-integration-core · Bridge Agent controlled apply — BA-APPLY-2a (design-lock
-- docs/development/bridge-agent-controlled-apply-design-lock-20260708.md §2 形态 B backend channel,
-- §4 hard locks)
--
-- Persists a submitted "implementation checklist" (the SAME values-free, machine-readable artifact
-- BA-APPLY-1's buildImplementationChecklist renders: { schemaVersion, operations:
-- [{ op, objectName, fieldKeys }] } — object/field-key NAMES and a closed
-- add_readonly_object/add_readonly_field operation enum, NEVER a value/host/credential) as
-- immutable content-keyed VERSIONS plus a values-free audit trail:
--   * checklist    —— the validated (lib/bridge-agent-change-checklist-contract.cjs) normalized
--                     structure only. No systemId/host/credential column — this table never
--                     resolves or contacts any external system.
--   * content_key  —— sha256 hex over a stable (sorted-key) stringify of the checklist. An identical
--                     save is a NO-OP that returns the existing version; a changed save mints the
--                     next version in its (tenant, workspace) family.
--   * status       —— draft -> approved -> retired. Only an APPROVED version is fetchable by the
--                     apply consumer (lib/bridge-agent-change-checklist-store.cjs's getForApply,
--                     fail-closed on draft/retired); transitions are audited.
--
-- HARD LOCK: this table, and everything that reads/writes it, never applies a checklist to the
-- Bridge Agent. Applying stays a human/ops-script action per the design-lock's form-A handoff (form
-- B's "backend writes the Agent's readonly config" capability does not exist yet — the Agent has no
-- config-write endpoint; see the BA-APPLY-2a verification MD for that blocker). There is no apply
-- column, no host column, no credential column, and no code path here that ever contacts the Agent.
--
-- Scoping 惯例与 057/062 对齐：tenant_id NOT NULL；workspace_id 可为 NULL。
-- 所有表以 integration_ 前缀开头，与 plugin-integration-core/lib/db.cjs 的 ALLOWED_PREFIX 对齐。
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_bridge_agent_checklists (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  checklist     JSONB NOT NULL,                   -- { schemaVersion, operations: [{ op, objectName, fieldKeys }] } — values-free
  content_key   TEXT NOT NULL,                    -- sha256(stable-stringify(checklist))，幂等保存键
  version       INTEGER NOT NULL,                 -- 家族内单调递增（家族 = tenant_id + workspace_id）
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'retired')),
  created_by    TEXT,
  updated_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- NULL is not equal to NULL in Postgres's default UNIQUE semantics, so a plain UNIQUE(...,
-- workspace_id, ...) would allow duplicate rows when workspace_id IS NULL (single-workspace
-- deployments). PG 14 has no NULLS NOT DISTINCT, so use an expression index that coerces NULL to ''.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_bridge_agent_checklists_content
  ON integration_bridge_agent_checklists (tenant_id, COALESCE(workspace_id, ''), content_key);
-- Version-minting backstop: the store computes max(version)+1 inside a transaction, but two
-- concurrent minters could still read the same max — this index turns that race into a 23505 the
-- store retries (bounded), instead of silently minting duplicate family versions.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_bridge_agent_checklists_family_version
  ON integration_bridge_agent_checklists (tenant_id, COALESCE(workspace_id, ''), version);
CREATE INDEX IF NOT EXISTS idx_integration_bridge_agent_checklists_status
  ON integration_bridge_agent_checklists (status);

-- ---------------------------------------------------------------------------
-- Audit —— values-free：只存粗粒度动作/状态枚举与版本号，
-- 永不存 checklist 内容（operations/objectName/fieldKeys/op）、host 或凭据。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_bridge_agent_checklist_audit (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  workspace_id  TEXT,
  checklist_id  TEXT NOT NULL,
  action        TEXT NOT NULL CHECK (action IN ('save_version', 'reuse_version', 'status_change')),
  actor         TEXT,
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 粗粒度：{ version } 或 { from, to } — 永不含 checklist 内容
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_integration_bridge_agent_checklist_audit_checklist
  ON integration_bridge_agent_checklist_audit (tenant_id, checklist_id, created_at);

-- ---------------------------------------------------------------------------
-- updated_at 触发器（复用 057 的 integration_set_updated_at）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_integration_bridge_agent_checklists_updated_at') THEN
    CREATE TRIGGER trg_integration_bridge_agent_checklists_updated_at
      BEFORE UPDATE ON integration_bridge_agent_checklists
      FOR EACH ROW EXECUTE FUNCTION integration_set_updated_at();
  END IF;
END $$;
