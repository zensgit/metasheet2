-- 082_extend_stock_prep_audit_project_directory_read_action.sql
-- 一线看得见自己工厂的项目: add the operator project-directory READ to the closed values-free
-- stock-prep audit vocabulary.
--
-- WHY THIS ACTION BELONGS HERE, AND WHY IT IS A GATE AND NOT A CONVENIENCE.
--
-- The OD-E3 ruling that kept the value plane closed
-- (docs/development/real-external-integration-line-design-lock-20260712.md:121) ratified 否 with an
-- explicit reopening condition: 「首个现场 UAT 若提出具名读值需求，须重开 RBAC 范围+审计词表设计门」 —
-- reopen the RBAC-scope gate AND the AUDIT-VOCABULARY gate. This file is the second of those two.
-- The H0 plane-boundary lock states the same requirement as a conjunction: a value-bearing read needs
-- RBAC + a server-side field whitelist + AUDIT, 三重门,缺一不可
-- (stock-preparation-ui-humanization-h0-plane-boundary-design-lock-20260712.md:29-39).
--
-- Note what makes this action different from every other one on this trail. 081 was the first entry
-- that recorded values LEAVING the system (an xlsx download). This is the first that records a plain
-- READ — no write, no file. It is audited anyway, because under the reopened gate the thing worth
-- answering is 「谁看了哪个租户的项目名册、什么时候」, and a read that carries customer values is
-- exactly as answerable as an export that does.
--
-- The 067/080/081 shape is reused verbatim (DROP the constraint, ADD it back with the widened list)
-- rather than invented, and the store constant STOCK_PREP_AUDIT_ACTIONS stays SET-EQUAL to this list —
-- __tests__/stock-preparation-audit-migration.test.cjs asserts exactly that, in both directions.
--
-- THE AUDITED ROW STAYS VALUES-FREE EVEN THOUGH THE RESPONSE DOES NOT. This is the load-bearing
-- property of this migration and it is asserted by a suite, not left to discipline:
--   * `project_id` is NULL — this read is not about one project, and writing a projectNo here would
--     put a customer business value on the trail for the first time;
--   * `mode` is the enum operator_directory | operator_directory_idle;
--   * `detail` carries COUNTS and BOOLEANS only (projectCount, pendingProjectCount, directoryReady,
--     ledgerReady, tenantClaimVerified) plus the fixed `operation` token — never a projectNo, never a
--     projectName, and never the `projects` array itself.
-- All of those pass the store's structural gate (assertValuesFreeDetail). See the route's
-- audit.append call in http-routes.cjs (stockPreparationOperatorProjectDirectory) — the only caller.

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
    'project_directory_read'
  ));
