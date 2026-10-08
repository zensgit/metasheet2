-- 067_extend_stock_prep_audit_repair_action.sql
-- P4 Option C: add the bounded one-shot persist repair action to the closed values-free audit
-- vocabulary. Existing operational W5b/T4 acceptance remains an 8-action business-flow check; this
-- ninth action is owner-operated migration evidence and is not required on every normal smoke run.

ALTER TABLE integration_stock_prep_audit
  DROP CONSTRAINT IF EXISTS integration_stock_prep_audit_action_check;

ALTER TABLE integration_stock_prep_audit
  ADD CONSTRAINT integration_stock_prep_audit_action_check CHECK (action IN (
    'mapping_candidates_sync', 'mapping_confirm', 'mapping_retire',
    'unit_confirm', 'unit_retire',
    'generation_run', 'exception_resolve', 'exception_bulk_resolve',
    'persist_repair_once'
  ));
