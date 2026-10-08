-- 081_extend_stock_prep_audit_prep_line_export_action.sql
-- 按项目导出物料 Excel: add the project materials export to the closed values-free stock-prep audit
-- vocabulary.
--
-- WHY THIS ACTION BELONGS HERE. Every other action on this trail records a decision about DATA
-- already inside the system (a mapping confirmed, an exception resolved, a source rebound). This one
-- records that customer VALUES (material names, quantities) LEFT the system as a downloadable file —
-- a GET, not a write, but the audit discipline this trail exists for applies just as much to an
-- export as to a write: "who pulled this project's materials out, and when" must be answerable the
-- same way "who confirmed this mapping" already is.
--
-- The 067/080 shape is reused verbatim (DROP the constraint, ADD it back with the widened list)
-- rather than invented, and the store constant STOCK_PREP_AUDIT_ACTIONS stays SET-EQUAL to this list —
-- __tests__/stock-preparation-audit-migration.test.cjs asserts exactly that, in both directions, so a
-- store action the DB would reject (or a DB action nothing can write) reds a test instead of becoming
-- a 500 on an operator's download.
--
-- The audited row stays values-free: `project_id` carries the business projectNo (a navigation
-- handle, the same class as the mappingId/snapshotBatchId the existing actions carry, NOT a material
-- name), `mode` is the enum export|export_empty, and `detail` carries row/column COUNTS only
-- (totalRowCount/activeRowCount/columnCount) — all of which pass the store's structural gate
-- (assertValuesFreeDetail). No drawing number, material name, spec or quantity is reachable from any
-- of them — see plugins/plugin-integration-core/lib/stock-preparation-prep-line-export.cjs and the
-- route's audit.append call in http-routes.cjs.

ALTER TABLE integration_stock_prep_audit
  DROP CONSTRAINT IF EXISTS integration_stock_prep_audit_action_check;

ALTER TABLE integration_stock_prep_audit
  ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK (action IN (
    'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire',
    'unit_confirm', 'unit_retire',
    'generation_run', 'exception_resolve', 'exception_bulk_resolve',
    'persist_repair_once',
    'source_binding_set',
    'prep_line_export'
  ));
