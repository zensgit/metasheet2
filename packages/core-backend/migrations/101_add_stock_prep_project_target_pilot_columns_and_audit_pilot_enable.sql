-- 101_add_stock_prep_project_target_pilot_columns_and_audit_pilot_enable.sql
-- 备料分批拉取第一期 step 3, PR B (plan §5.1 / §7 G5, G7 / §9.4 L01–L05 / §9.5 U05; decision register R-53, R-54):
-- the PILOT MARKER of one project's 备料表, held by the plugin registry row that already decides
-- "project number -> sheet" (migration 087), plus the audit vocabulary for the act of enabling it.
--
-- WHY THE REGISTRY ROW. The marker is read by the five large-BOM routes (expansion start / run, plan,
-- approve, every chunk — inside the sheet write lease, before status 'running'), by the small lane's
-- over-cap refusal and by the step-4 governance consult (continuation detection runs on pilot projects
-- only). All of those already resolve the registry row; a second table would be a second read with its
-- own failure mode. The host's own half of the pilot — meta_sheets.grid_export_closure (PR A, #6507) —
-- stays a HOST column: the plugin asks for the stamp through the narrow port and never writes it.
--
-- THE THREE COLUMNS (all nullable; a row with them NULL is a non-pilot project, byte-identical to
-- before this migration for every reader that projects the public target):
--   * pilot_enabled_at        — when an administrator (stock-prep:admin) enabled the pilot;
--   * pilot_enabled_by        — who (a user id, never a name);
--   * pilot_readiness_version — the version of the readiness check list that passed at enablement
--                               (stock-preparation-pilot-readiness.cjs PILOT_READINESS_VERSION), so a
--                               later list can tell which projects were enabled under an older one.
-- The CHECK ties the stamp to its version: (pilot_enabled_at IS NULL) = (pilot_readiness_version IS NULL),
-- so neither a half-written enable nor a half-cleared runbook edit can read as "pilot without a
-- readiness version" or "a version without the stamp". The version itself must be a positive integer.
--
-- NO UNSET (R-53 ②, owner default; see the register): the plugin has no route, service or store method
-- that clears these columns. A mistaken enable is corrected by an owner-approved runbook database
-- operation — ONE statement that clears all three columns together (the CHECK refuses anything else):
--   UPDATE integration_stock_prep_project_target
--      SET pilot_enabled_at = NULL, pilot_enabled_by = NULL, pilot_readiness_version = NULL
--    WHERE tenant_id = $1 AND project_no = $2;
-- That clears the LARGE-LANE refusal and the readiness state only. The sheet's grid-export closure is
-- the host's column and stays closed (PR A has no reopen port either; reopening it is a second,
-- separate owner-approved runbook operation on meta_sheets). Nothing the later step-4 PRs persist
-- (continuations, holds, executions) is touched by clearing the marker — those protect the project
-- regardless of it (plan §7 last paragraph, C10 / U07).
--
-- ROLLBACK OF THIS MIGRATION: plugin SQL migrations are up-only (packages/core-backend/src/db/
-- migration-provider.ts); there is no down(). The columns are additive and nullable, so an older plugin
-- build runs against them unchanged (it never reads them — a reader that does not know the column sees
-- nothing). To take the feature out of service without a code rollback: clear the markers with the
-- statement above (owner-approved) — the enable route refuses while readiness is not met anyway. The
-- audit CHECK below can only be re-listed by a later, higher-numbered migration (never narrowed by hand
-- while a 'project_pilot_enable' row exists: such a row would violate the narrowed constraint).

ALTER TABLE integration_stock_prep_project_target
  ADD COLUMN IF NOT EXISTS pilot_enabled_at TIMESTAMPTZ;
ALTER TABLE integration_stock_prep_project_target
  ADD COLUMN IF NOT EXISTS pilot_enabled_by TEXT;
ALTER TABLE integration_stock_prep_project_target
  ADD COLUMN IF NOT EXISTS pilot_readiness_version INTEGER;

ALTER TABLE integration_stock_prep_project_target
  DROP CONSTRAINT IF EXISTS integration_stock_prep_project_target_pilot_check;
ALTER TABLE integration_stock_prep_project_target
  ADD CONSTRAINT integration_stock_prep_project_target_pilot_check
    CHECK ((pilot_enabled_at IS NULL) = (pilot_readiness_version IS NULL));

ALTER TABLE integration_stock_prep_project_target
  DROP CONSTRAINT IF EXISTS integration_stock_prep_project_target_pilot_readiness_version_check;
ALTER TABLE integration_stock_prep_project_target
  ADD CONSTRAINT integration_stock_prep_project_target_pilot_readiness_version_check
    CHECK (pilot_readiness_version IS NULL OR pilot_readiness_version >= 1);

COMMENT ON COLUMN integration_stock_prep_project_target.pilot_enabled_at IS
  'Batch-refresh phase 1 pilot marker (step 3 PR B): set once by the admin enable route (never unset by code; owner-approved runbook UPDATE only). NOT NULL = pilot project: large-BOM lane refused, over-cap previews refused, generic grid export closed on the sheet (host column), step-4 continuation detection enabled.';
COMMENT ON COLUMN integration_stock_prep_project_target.pilot_readiness_version IS
  'The version of the pilot readiness check list that passed at enablement (plugin stock-preparation-pilot-readiness.cjs). Tied to pilot_enabled_at by the pilot CHECK.';

-- The closed values-free audit vocabulary, RE-LISTED IN FULL (every vocabulary migration replaces the
-- CHECK; a lower-numbered re-listing that forgets a later action silently undoes it — 086/088 headers).
-- Added here: project_pilot_enable — an administrator enabled the pilot of ONE project
-- (project_id = the project NUMBER, subject_id = the sheet id, mode = enabled, detail = the readiness
-- version, the objectId handle and booleans about the host stamp — never a value, never a row).
-- The store constant STOCK_PREP_AUDIT_ACTIONS is SET-EQUAL to this list in both directions
-- (__tests__/stock-preparation-audit-migration.test.cjs resolves the HIGHEST-numbered migration that
-- installs this constraint, which this file now is).

ALTER TABLE integration_stock_prep_audit
  DROP CONSTRAINT IF EXISTS integration_stock_prep_audit_action_check;

ALTER TABLE integration_stock_prep_audit
  ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK (action IN (
    'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire',
    'unit_confirm', 'unit_retire',
    'generation_run', 'exception_resolve', 'exception_bulk_resolve',
    'persist_repair_once',
    'source_binding_set',
    'prep_line_export',
    'project_directory_read',
    'handoff_advance',
    'project_board_read',
    -- 088 (一个项目一张备料表). Re-listed, not inherited: this constraint is a full replacement.
    'project_target_create',
    'project_target_archive',
    'project_target_restore',
    'project_target_grant',
    'project_fields_update',
    'project_overview_refresh',
    -- 101 (备料分批拉取第一期 step 3 PR B): the pilot enablement of one project sheet.
    'project_pilot_enable'
  ));
