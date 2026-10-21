-- 088_extend_stock_prep_audit_project_target_actions.sql
-- 一个项目一张备料表: add the project-sheet lifecycle to the closed values-free stock-prep audit
-- vocabulary (ADR adr-stock-prep-project-sheets-20261008 §1.2; slices S1 / S3 / S4).
--
-- SIX ACTIONS, LISTED ONCE FOR THE WHOLE ADR. Each vocabulary migration REPLACES the CHECK
-- constraint (the 067/080/081/082/085/086 shape), so adding one action per slice would mean four
-- more full re-listings of this same vocabulary — and, as 086's own header records, a lower-numbered
-- re-listing that forgets a later action silently undoes it. So S1 lists every action the ADR names
-- and the later slices add rows, not constraints:
--   * project_target_create   (S1) — a 拉取人员 created and registered ONE project's sheet.
--                                    project_id = the project NUMBER (the same handle
--                                    prep_line_export carries), subject_id = the sheet id, mode is
--                                    sheet_created | sheet_adopted, detail is booleans + a source
--                                    token (own-base rule) — never a name, never a row.
--   * project_target_grant    (S1) — G1: the host granted the server-configured roles
--                                    spreadsheet:write on that sheet. subject_id = the sheet id,
--                                    mode is granted | already_granted, detail is COUNTS (roleCount,
--                                    granted, alreadyGranted). The role ids themselves are recorded
--                                    by the host's own config-revision history, keyed by sheet.
--   * project_target_archive  (S4) / project_target_restore (S4) — the lifecycle that replaces
--                                    deletion (Q2). project_id = the project number.
--   * project_fields_update   (S3) — the O2(a) project-level columns changed; detail names WHICH
--                                    column(s) changed and never a value.
--   * project_overview_refresh (S3) — the overview sheet was recomputed; counts only.
--
-- Every row passes the store's structural gate (assertValuesFreeDetail): detail scalars are
-- enum-shaped strings, booleans or finite numbers; mode and subject_id are shape-gated. The store
-- constant STOCK_PREP_AUDIT_ACTIONS is SET-EQUAL to this list in both directions —
-- __tests__/stock-preparation-audit-migration.test.cjs asserts it against the HIGHEST-NUMBERED
-- migration that installs the constraint, which this file now is.

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
    'project_overview_refresh'
  ));
