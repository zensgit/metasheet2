-- 083_extend_stock_prep_audit_project_board_read_action.sql
-- 项目备料页: add the operator PROJECT BOARD read to the closed values-free stock-prep audit
-- vocabulary.
--
-- WHAT THE BOARD IS, AND WHY IT IS AUDITED.
--
-- The board is the read behind 项目备料页 — the one page that strings the operator's four steps
-- together (从 PLM 拉取 / 通知下一步 / 导出 Excel / 到多维表填写) for ONE project. It answers with that
-- project's NUMBER and NAME, so it is the fourth value-bearing read on this trail, after
-- value-entry, prep_line_export and project_directory_read.
--
-- 082 established the rule this file follows rather than restating it: under the reopened OD-E3 gate
-- (docs/development/real-external-integration-line-design-lock-20260712.md:121,
-- 「首个现场 UAT 若提出具名读值需求，须重开 RBAC 范围+审计词表设计门」) a read that carries customer
-- values is exactly as answerable as an export that does. The H0 plane-boundary lock states it as a
-- conjunction: RBAC + a server-side field whitelist + AUDIT, 三重门,缺一不可. This file is the third.
--
-- THE AUDITED ROW STAYS VALUES-FREE EVEN THOUGH THE RESPONSE DOES NOT — the same load-bearing
-- property 082 pinned, asserted here by __tests__/stock-preparation-project-board.test.cjs (B-04):
--   * `project_id` is NULL. The board is ABOUT one project, which makes this the one place the
--     temptation to write a projectNo here is strongest — and the one place it must be refused, or
--     the first customer business value lands on the trail.
--   * `mode` is the enum operator_project_board | operator_project_board_miss. A read that found
--     nothing is recorded as having happened, without recording what was asked for: a miss row that
--     carried the number would make the trail itself the existence oracle the route refuses to be.
--   * `detail` carries COUNTS and BOOLEANS only (projectCount, found, fillTargetPresent,
--     pendingDecisionCount, tenantClaimVerified) plus the fixed `operation` token.
-- All of those pass the store's structural gate (assertValuesFreeDetail). The route's audit.append
-- call in http-routes.cjs (stockPreparationOperatorProjectBoard) is the only caller.
--
-- The 067/080/081/082 shape is reused verbatim (DROP the constraint, ADD it back with the widened
-- list) rather than invented, and the store constant STOCK_PREP_AUDIT_ACTIONS stays SET-EQUAL to
-- this list — __tests__/stock-preparation-audit-migration.test.cjs asserts exactly that, in both
-- directions, against the HIGHEST-NUMBERED migration that installs the constraint. That is also the
-- tripwire that catches a parallel branch adding its own action in a later-numbered file without
-- carrying this one forward: the widened list is a full replacement, never a delta.

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
    'project_board_read'
  ));
