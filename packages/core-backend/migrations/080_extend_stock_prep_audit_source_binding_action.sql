-- 080_extend_stock_prep_audit_source_binding_action.sql
-- 工作台里选源: add the source-binding change to the closed values-free stock-prep audit vocabulary.
--
-- WHY THIS ACTION BELONGS HERE. The other nine actions record decisions a human made about DATA
-- (which material maps to which, which unit rule holds, which exception is resolved). This one
-- records a decision a human made about WHERE THE DATA COMES FROM — the highest-consequence choice
-- on the whole surface, because every subsequent row the action writes inherits it. It used to be
-- unauditable by construction: the source lived in an env file, so "who repointed us and when" was
-- a question only the server's shell history could answer, and only until the next deploy.
--
-- The 067 shape is reused verbatim (DROP the constraint, ADD it back with the widened list) rather
-- than invented, and the store constant STOCK_PREP_AUDIT_ACTIONS stays SET-EQUAL to this list —
-- __tests__/stock-preparation-audit-migration.test.cjs asserts exactly that, in both directions, so
-- a store action the DB would reject (or a DB action nothing can write) reds a test instead of
-- becoming a 500 on an operator's Save.
--
-- The audited row stays values-free: `subject_id` is the newly bound external-system row id (an
-- internal handle, the same class as the mappingId / snapshotBatchId the existing actions carry),
-- `mode` is the enum bound|rebound, and `detail` carries the previous binding id plus booleans —
-- all of which pass the store's structural gate (assertValuesFreeDetail). No connection string, no
-- host and no credential is reachable from any of them.

ALTER TABLE integration_stock_prep_audit
  DROP CONSTRAINT IF EXISTS integration_stock_prep_audit_action_check;

ALTER TABLE integration_stock_prep_audit
  ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK (action IN (
    'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire',
    'unit_confirm', 'unit_retire',
    'generation_run', 'exception_resolve', 'exception_bulk_resolve',
    'persist_repair_once',
    'source_binding_set'
  ));
