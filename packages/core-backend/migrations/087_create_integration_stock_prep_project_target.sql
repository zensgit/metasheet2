-- 087_create_integration_stock_prep_project_target.sql
-- plugin-integration-core · 一个项目一张备料表 —— the PROJECT-SHEET REGISTRY (ADR
-- adr-stock-prep-project-sheets-20261008 §1, slice S1, decision register R-35).
--
-- WHY THIS TABLE EXISTS. The stock-preparation target used to be ONE deployment-level sheet named
-- by an env JSON (`action.target`), shared by every project — and #5860's one-sheet-one-project
-- guard therefore refused every second project on a tenant (409 TARGET_SHEET_FOREIGN_PROJECT). The
-- owner ruled on 2026-10-08: one business project = one managed sheet, created by a 拉取人员, and
-- this row is the ONLY authority for "project number -> sheet". Every read and write route the
-- project-sheets switch governs resolves its target through it; the env target's CONTENT is no
-- longer read while the switch is on (its `sheetId` is still required by the config normalizer and
-- its `objectId` is the fourth condition of the apply write gate — values, not rows).
--
--   * project_no         —— the BUSINESS project number, trimmed exactly as the pull parameter is
--                           (`normalizeActionParameters`). The same navigation handle the audit
--                           trail carries in `project_id` and the handoff cursor (084) keys on.
--   * sheet_id/object_id —— the managed sheet this plugin created for it. objectId is
--                           `plm_stock_preparation_sandbox_p_<24 hex of sha256(tenant:project)>`:
--                           inside the sandbox namespace, never the raw project number. NO
--                           `origin` column: the old mixed sheet is NOT registered (Q3 「不要了」).
--   * status             —— 'active' | 'archived'. Archiving (S4) replaces deletion: the sheet is
--                           neither soft- nor hard-deleted, its grants are untouched; the CHECK
--                           below ties the status to `archived_at` so the two cannot disagree.
--   * responsible_label / note / planned_finish_on —— O2(a) PROJECT-LEVEL columns (负责人 / 备注 /
--                           计划完成), free text BY DESIGN, written only by the S3 project-fields
--                           route, never read into a refusal, a log line or an audit row.
--                           `responsible_label` is a label, NOT a user id, and is never an
--                           authorization input (ADR §9).
--   * last_pull_*        —— the most recent dry-run / apply outcome, as a CLOSED enum + a closed
--                           error-code token (never a message). Written from S3 on.
--   * row_count / active_row_count / counts_bounded / missing_components_count /
--     procurement_open_count / warehouse_open_count / counts_at —— the overview's (S3) bounded
--                           projection of the sheet; integers, a boolean and a clock.
--
-- UNIQUENESS ARBITRATES THE CREATE RACE. Two pullers creating the same project's sheet at the same
-- moment provision the SAME deterministic sheet and then both insert here; the scope index makes
-- the second insert a 23505 which the store turns into a typed 409 — never a second row and never
-- a second table. `uniq_..._sheet` is the other direction: one sheet is one project's.
--
-- SCOPING: tenant_id NOT NULL; no workspace dimension (084's reasoning: the fact is per project).
-- integration_ prefix per plugin-integration-core/lib/db.cjs ALLOWED_PREFIX. Mutations go through
-- the plugin's structured db helper only (no raw SQL from the plugin).
--
-- VALUES-FREE (except the three O2(a) columns named above, which are the point of that feature):
-- handles, closed enums, small integers, server clocks. No material name, spec, drawing number or
-- quantity has a column to land in.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS integration_stock_prep_project_target (
  id                         TEXT PRIMARY KEY,
  tenant_id                  TEXT NOT NULL,
  project_no                 TEXT NOT NULL,
  sheet_id                   TEXT NOT NULL,
  object_id                  TEXT NOT NULL,
  status                     TEXT NOT NULL DEFAULT 'active',
  created_by                 TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_by                TEXT,
  archived_at                TIMESTAMPTZ,
  restored_by                TEXT,
  restored_at                TIMESTAMPTZ,
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responsible_label          TEXT,
  note                       TEXT,
  planned_finish_on          DATE,
  project_fields_updated_by  TEXT,
  project_fields_updated_at  TIMESTAMPTZ,
  last_pull_at               TIMESTAMPTZ,
  last_pull_outcome          TEXT,
  last_pull_code             TEXT,
  row_count                  INTEGER,
  active_row_count           INTEGER,
  counts_bounded             BOOLEAN,
  missing_components_count   INTEGER,
  procurement_open_count     INTEGER,
  warehouse_open_count       INTEGER,
  counts_at                  TIMESTAMPTZ,
  CONSTRAINT integration_stock_prep_project_target_status_check
    CHECK (status IN ('active', 'archived')),
  CONSTRAINT integration_stock_prep_project_target_archived_check
    CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  CONSTRAINT integration_stock_prep_project_target_last_pull_outcome_check
    CHECK (last_pull_outcome IS NULL OR last_pull_outcome IN ('applied', 'previewed', 'refused')),
  CONSTRAINT integration_stock_prep_project_target_counts_check
    CHECK (
      (row_count IS NULL OR row_count >= 0)
      AND (active_row_count IS NULL OR active_row_count >= 0)
      AND (missing_components_count IS NULL OR missing_components_count >= 0)
      AND (procurement_open_count IS NULL OR procurement_open_count >= 0)
      AND (warehouse_open_count IS NULL OR warehouse_open_count >= 0)
    )
);

-- ONE row per (tenant, project): the create race lands here (23505 -> typed 409 in the store).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_project_target_scope
  ON integration_stock_prep_project_target (tenant_id, project_no);

-- ONE project per sheet: a sheet id can never be registered to two projects.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_integration_stock_prep_project_target_sheet
  ON integration_stock_prep_project_target (sheet_id);

-- The tenant's list (overview, cap count), in creation order.
CREATE INDEX IF NOT EXISTS idx_integration_stock_prep_project_target_tenant_created
  ON integration_stock_prep_project_target (tenant_id, created_at);

COMMENT ON TABLE integration_stock_prep_project_target IS
  'Per-(tenant,projectNo) registry of the managed stock-preparation sheet created for that business project (ADR adr-stock-prep-project-sheets-20261008). The ONLY authority for project number -> sheet while MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED is true. Archive replaces delete; the old mixed sheet is never registered.';
