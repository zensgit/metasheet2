-- 108_create_integration_stock_prep_sheet_repair.sql
-- plugin-integration-core · 备料 batch-refresh step 6d-2a (S6-6; register row R-91) — the DOUBLED-SHEET REPAIR ledger:
-- the run row with its BACKUP, written before the first sheet write, and the ONE-SHOT OWNER CLAIM of an approved plan.
-- Step-6 design §6.6 / §7.3, as amended by the 2026-11-09 rebaseline (items B-9, B-10, B-18).
--
-- WHY (plan §6, §12.1 「两张历史表 | 修复核对、工具与预演并入第一期；实际写入逐表另批」). A sheet that holds a component twice
-- — once as its own root subtree and once as a copy nested under another parent — cannot be piloted (design §6.1 D1).
-- The repair's two recipes write the machine cells 有效 (`active`) and three RUN stamps on rows of the customer's
-- production sheet, so every real run is OWNER GATE ② per sheet (design §14.2 O6-6): the repair switch on, one
-- approvalRef per approved preview digest, the project's pulls paused. These two tables make that gate a database fact:
--   * integration_stock_prep_sheet_repair_run — ONE row per run, inserted (status `running`) in the SAME transaction as
--     the claim below and BEFORE the first sheet write. It carries the recipe, the plan digest the caller echoed, the
--     approvalRef, the lease that ran it, and the BACKUP: one entry per planned row,
--       [recordId, versionBefore, activeBefore, runIdBefore, decisionBefore, summaryBefore]
--     — exactly the four cells a recipe writes, as they were read under the lease. A restore puts those four cells back
--     and nothing else, so a retire followed by its restore leaves a row's stored data byte-identical (its version is
--     two higher). `status` is `completed` (every planned row written), `stopped` (a row moved, was locked or was gone;
--     a host refusal; or the run was found abandoned by a later run that took the sheet lease over) or `running`.
--     AT MOST ONE OPEN RUN PER SHEET is the partial unique index below, not a convention.
--   * integration_stock_prep_sheet_repair_claim — the one-shot claim: claim_key (PRIMARY KEY) =
--     sha256 over (scheme, tenant, sheet, project, recipe, plan digest). Claiming is a plain INSERT in the run's begin
--     transaction (before the run row), so an approved plan can be executed AT MOST ONCE; two concurrent claimers
--     resolve to one holder at the unique index. PERMANENT: no TTL, no steal, never UPDATEd or DELETEd by the runtime
--     (the migration 078 precedent, design F6-26). A second run of the same approved plan is 409
--     STOCK_PREP_SHEET_REPAIR_ALREADY_CONSUMED; a different plan has a different digest and needs its own approval.
--     The plan digest also covers `sequence_no` (the number of runs this sheet's project had when the plan was
--     previewed), so a run that began and wrote nothing does not leave an identical, already-consumed digest behind.
--
-- THE VOCABULARIES below are EXACTLY the library's closed lists
-- (plugins/plugin-integration-core/lib/stock-preparation-sheet-repair.cjs); a hermetic test reads this file and pins
-- the two to each other (stock-preparation-sheet-repair-store.test.cjs).
--
-- VALUES. Both tables are values-free. `project_no` is a customer value stored exactly as the project registry (087)
-- stores it. Everything else is ids, closed tokens, digests, integers and server clocks. `component_handle` is the
-- census's private component handle (a digest; design §6.4 keeps it out of public evidence). `backup` holds record-id
-- handles, integer versions, the boolean `active` cell and the three RUN stamp cells as read: a run id, a decision token
-- of the planner's closed vocabulary and the planner's own conflict-summary JSON (type tokens, field ids, ids,
-- counts). The library refuses, before any write, a row whose stamp cells are not of that machine shape, so no cell a
-- person typed and no material value is ever stored here. Owner gate Q-B is not widened (design §14.2 O6-9).
--
-- AUDIT: no vocabulary change. Run starts and finishes ride the EXISTING action `exception_resolve` with closed modes
-- (`sheet_repair_started` / `sheet_repair_completed` / `sheet_repair_stopped`), the reads the EXISTING
-- `project_board_read` (`sheet_repair_preview_read` / `sheet_fills_report_read` / `sheet_repair_runs_read`) — the D9
-- precedent (design T6-12).
--
-- DEPLOY SHAPE (design §7.4). Nothing but the repair routes reads these tables, and those routes answer 404 before
-- any IO while MULTITABLE_STOCK_PREP_SHEET_REPAIR_WRITE_ENABLED is not exactly 'true' (default OFF). With the switch
-- on and this migration missing, the repair routes answer 503 STOCK_PREP_SHEET_REPAIR_STORE_FAILED and write
-- nothing; no pull, export or readiness check is affected.
--
-- RUNBOOK: the plugin runtime role needs SELECT, INSERT and UPDATE on integration_stock_prep_sheet_repair_run, and
-- SELECT and INSERT on integration_stock_prep_sheet_repair_claim.
--
-- ROLLBACK. Plugin SQL migrations are up-only; there is no down(). Roll back with the older build and RunMigrations 0;
-- the two tables then stay, inert (no older build reads them). Before rolling back, no run may be open:
--   SELECT count(*) FROM integration_stock_prep_sheet_repair_run WHERE status = 'running';
-- must answer 0 (an open run is closed by the next repair request on that sheet, or by restoring it). Rows a retire
-- wrote stay retired on the sheet: an older build reads them as ordinary inactive rows.

CREATE TABLE IF NOT EXISTS integration_stock_prep_sheet_repair_run (
  id                TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  sheet_id          TEXT NOT NULL,
  project_no        TEXT NOT NULL,
  write_scope_key   TEXT NOT NULL,
  recipe            TEXT NOT NULL,
  sequence_no       INTEGER NOT NULL,
  plan_digest       TEXT NOT NULL,
  approval_ref      TEXT NOT NULL,
  component_handle  TEXT,
  source_run_id     TEXT,
  backup            JSONB NOT NULL,
  planned_count     INTEGER NOT NULL,
  written_count     INTEGER,
  status            TEXT NOT NULL,
  stop_reason       TEXT,
  lease_id          TEXT NOT NULL,
  fencing_epoch     INTEGER NOT NULL,
  started_by        TEXT NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at       TIMESTAMPTZ,
  CONSTRAINT integration_stock_prep_sheet_repair_run_recipe_check
    CHECK (recipe IN ('retire_superseded_root_subtree','restore_retired_rows')),
  CONSTRAINT integration_stock_prep_sheet_repair_run_status_check
    CHECK (status IN ('running','completed','stopped')),
  CONSTRAINT integration_stock_prep_sheet_repair_run_stop_reason_check
    CHECK (stop_reason IS NULL OR stop_reason IN ('version_conflict','record_locked','record_missing','host_version_unexpected','host_write_failed','abandoned')),
  CONSTRAINT integration_stock_prep_sheet_repair_run_open_check
    CHECK ((status = 'running') = (finished_at IS NULL)),
  CONSTRAINT integration_stock_prep_sheet_repair_run_stop_check
    CHECK ((status = 'stopped') = (stop_reason IS NOT NULL)),
  CONSTRAINT integration_stock_prep_sheet_repair_run_subject_check
    CHECK ((recipe = 'retire_superseded_root_subtree' AND component_handle IS NOT NULL AND source_run_id IS NULL)
           OR (recipe = 'restore_retired_rows' AND source_run_id IS NOT NULL AND component_handle IS NULL)),
  CONSTRAINT integration_stock_prep_sheet_repair_run_digest_check
    CHECK (plan_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT integration_stock_prep_sheet_repair_run_counts_check
    CHECK (sequence_no >= 0 AND fencing_epoch >= 0 AND planned_count >= 1
           AND (written_count IS NULL OR (written_count >= 0 AND written_count <= planned_count))),
  CONSTRAINT integration_stock_prep_sheet_repair_run_written_check
    CHECK ((status = 'completed' AND written_count = planned_count)
           OR (status = 'stopped' AND (written_count IS NOT NULL OR stop_reason = 'abandoned'))
           OR (status = 'running' AND written_count IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_sheet_repair_run_open
  ON integration_stock_prep_sheet_repair_run (sheet_id) WHERE status = 'running';
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_sheet_repair_run_sequence
  ON integration_stock_prep_sheet_repair_run (sheet_id, project_no, sequence_no);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_sheet_repair_run_project
  ON integration_stock_prep_sheet_repair_run (tenant_id, project_no, started_at DESC);

CREATE TABLE IF NOT EXISTS integration_stock_prep_sheet_repair_claim (
  claim_key     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL,
  sheet_id      TEXT NOT NULL,
  project_no    TEXT NOT NULL,
  recipe        TEXT NOT NULL,
  plan_digest   TEXT NOT NULL,
  run_id        TEXT NOT NULL,
  approval_ref  TEXT NOT NULL,
  claimed_by    TEXT NOT NULL,
  claimed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integration_stock_prep_sheet_repair_claim_recipe_check
    CHECK (recipe IN ('retire_superseded_root_subtree','restore_retired_rows')),
  CONSTRAINT integration_stock_prep_sheet_repair_claim_digest_check
    CHECK (plan_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_sheet_repair_claim_project
  ON integration_stock_prep_sheet_repair_claim (tenant_id, project_no);
