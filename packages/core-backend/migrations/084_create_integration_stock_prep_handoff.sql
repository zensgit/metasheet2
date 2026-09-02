-- 084_create_integration_stock_prep_handoff.sql
-- plugin-integration-core · 通知下一步 —— 备料多人接力的「轮到谁了」。
--
-- WHY THIS TABLE EXISTS. On a real 备料 project several people each fill their own fields on the same
-- prep rows, in an agreed order; the first finishes and tells the next it is their turn, and when the
-- last one finishes 仓库/采购 export the project's materials. The product recorded NONE of that:
-- 「通知下一步」 was a zero-hit string in the codebase, no advance/notify route existed in the
-- stock-prep family, and nothing anywhere said whose turn it was. This row IS that answer.
--
--   * project_no          —— the BUSINESS project number (plm_stock_preparation_main's own projectNo
--                            field), not the MVP ledger's projectId. Same identifier the
--                            confirmation-decision family and the materials export already scope on,
--                            so "the project" means one thing across the whole operator surface.
--   * step_index          —— 0-based cursor into the deployment's CONFIGURED ordered step list
--                            (server-config key `stockPreparationHandoff`). An index and not a step
--                            NAME on purpose: the name lives in config, the config is allowed to be
--                            re-ordered between releases, and a stored name would silently re-point
--                            at a different position in the chain when it was. A cursor equal to the
--                            step count means the chain is finished.
--   * notified_step_index —— the highest step whose COMPLETION has had a notification dispatched.
--                            This is the at-most-once claim: it is stamped in the same transaction as
--                            the cursor move, BEFORE the send is attempted, so a double click cannot
--                            produce a second ping and a failed send is not silently retried into a
--                            stream of them. NULL = nothing notified yet.
--   * updated_by          —— operator identity (user id / email), same posture as 062 / 066 / 079.
--
-- ABSENT CONFIG = NO ROWS, EVER. A deployment that never sets `stockPreparationHandoff` cannot reach
-- the advance route (it refuses with a named 501 before touching the database), so this table stays
-- empty and the deployment behaves exactly as it did before the feature existed. There is no seeding
-- step and no default row: "never handed off" and "at step 0" are the same state and are represented
-- by the ABSENCE of a row, which is why the store reads a missing row as cursor 0 rather than
-- treating it as an error.
--
-- THIS IS NOT A PERMISSION RECORD. `step_index` is a VISIBLE TURN SIGNAL. It does not gate who may
-- write which column on a prep row. Per-column write scoping DOES exist in stock-prep as of #5447 —
-- the customer pack's `fieldWritePolicies` are applied by the host into `field_permissions`, the ONE
-- table the grid's write gate actually reads (packages/core-backend
-- src/services/stock-preparation-field-permissions.ts) — but it is a SEPARATE mechanism with a
-- separate lifetime: it is written once at pack install, keyed by ROLE and COLUMN, and it never
-- consults this table. Nothing here widens or narrows it, and advancing the cursor grants and
-- revokes nothing. Anyone reading this column as if it were an authorization decision is reading it
-- wrong; see plugins/plugin-integration-core/lib/stock-preparation-handoff.cjs for the full
-- statement.
--
-- THIS IS NOT AN APPROVAL INSTANCE. Owner ruling: the light version first, not a binding to the
-- Approval engine, because the ordered sequence is not yet proven stable in real use. Hence one
-- integer and no graph — no nodes, no epochs, no delegation, no return path. If the order proves
-- stable the successor is an approval template, not more columns here.
--
-- SCOPING 惯例与 057/062/066/079 对齐:tenant_id NOT NULL;workspace_id 可为 NULL,并用 COALESCE 收敛
-- 到唯一索引(PG14 无 NULLS NOT DISTINCT)。integration_ 前缀与 plugin-integration-core/lib/db.cjs 的
-- ALLOWED_PREFIX 对齐。
--
-- VALUES-FREE: every column is a handle, a small integer or a server clock. No material name, spec,
-- drawing number or quantity can land here — there is no column that could hold one.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_handoff (
  id                   TEXT PRIMARY KEY,
  tenant_id            TEXT NOT NULL,
  workspace_id         TEXT,
  project_no           TEXT NOT NULL,
  step_index           INTEGER NOT NULL DEFAULT 0,
  notified_step_index  INTEGER,
  updated_by           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_stock_prep_handoff_step_index_check
    CHECK (step_index >= 0),
  CONSTRAINT integration_stock_prep_handoff_notified_step_index_check
    CHECK (notified_step_index IS NULL OR notified_step_index >= 0)
);

-- ONE cursor per (tenant, workspace, project): two people clicking 通知下一步 on the same project at
-- the same moment resolve to ONE row at the database, and a first advance that loses the insert race
-- gets 23505 rather than a second row.
--
-- THIS INDEX IS NOT, BY ITSELF, THE CONCURRENCY STORY, and an earlier version of this comment claimed
-- it was. Uniqueness stops a duplicate ROW; it does not stop two transactions from both reading
-- step_index = 3 and both writing step_index = 4. Under READ COMMITTED that is exactly what happens,
-- and the visible symptom is two DingTalk pings for one handoff. What actually arbitrates lives in
-- plugins/plugin-integration-core/lib/stock-preparation-handoff-store.cjs and is TWO things: the
-- in-transaction read is SELECT … FOR UPDATE (so the second advance waits and then re-reads), and the
-- UPDATE carries `step_index` / `notified_step_index` predicates so zero updated rows is a refusal.
-- Anyone tightening or relaxing this table's concurrency behaviour must change that file, not this one.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_handoff_scope
  ON integration_stock_prep_handoff (tenant_id, COALESCE(workspace_id, ''), project_no);

COMMENT ON TABLE integration_stock_prep_handoff IS
  'Per-(tenant,workspace,projectNo) cursor into the deployment-configured stock-preparation handoff step list: whose turn it is, and which step completion has already been notified. A VISIBLE TURN SIGNAL, not a permission record and not an approval instance. Absent server-config key stockPreparationHandoff = the advance route refuses before touching this table = no rows.';
