-- 083_extend_stock_prep_audit_handoff_action.sql
-- 通知下一步: add the 备料 handoff advance to the closed values-free stock-prep audit vocabulary.
--
-- WHY THIS ACTION BELONGS HERE. Every other action on this trail records a human decision about the
-- data (a mapping confirmed, an exception resolved, a source rebound) or, since 081, that data LEFT
-- the system as a file. This one records a human decision about the WORK: "I am done with my step,
-- it is now the next person's turn" — and, on the last step, "this project is finished and 仓库/采购
-- have been told". That is precisely the class of fact this trail exists to make answerable, and it
-- was previously unauditable by construction because the handoff itself did not exist: people said
-- 「好了」 in a chat window and nothing recorded who, or when.
--
-- The 067/080/081/082 shape is reused verbatim (DROP the constraint, ADD it back with the widened list)
-- rather than invented. Because that shape REPLACES the whole constraint rather than adding to it, the
-- list below must carry EVERY action installed before it — including 082's `project_directory_read`,
-- which landed while this migration was in review. Dropping it here would have silently un-installed
-- the operator project-directory audit action and 500'd that route on its first click.
-- The store constant STOCK_PREP_AUDIT_ACTIONS stays SET-EQUAL to this list —
-- __tests__/stock-preparation-audit-migration.test.cjs discovers the LATEST migration installing this
-- constraint and asserts exactly that, in both directions, so a store action the DB would reject (or
-- a DB action nothing can write) reds a test instead of becoming a 500 on an operator's click.
--
-- THE AUDITED ROW STAYS VALUES-FREE. `project_id` carries the business projectNo (a navigation
-- handle, the same class as the mappingId/snapshotBatchId the existing actions carry, NOT a material
-- name); `subject_id` carries the step key, drawn from the CLOSED handoff vocabulary committed in
-- plugins/plugin-integration-core/lib/stock-preparation-handoff.cjs; `mode` is the enum
-- advanced|replayed|completed; and `detail` carries the two cursor INTEGERS plus booleans
-- (fromStepIndex / toStepIndex / stepCount / changed / notified / terminal). All of them pass the
-- store's structural gate (assertValuesFreeDetail, which admits only enum-shaped ASCII strings,
-- finite numbers and booleans). No drawing number, material name, spec or quantity is reachable from
-- any of them, and the suite proves it against every seeded value rather than spot-checking.
--
-- NOTE ON WHAT IS DELIBERATELY *NOT* RECORDED: the handler identities configured for each step. They
-- are deploy config, they are already in the config file a reviewer can read, and putting a roster
-- into an append-only trail on every click would turn a personnel list into permanent history. The
-- ACTOR who clicked is recorded (the `actor` column), which is the fact a reviewer asking "who handed
-- this off" actually needs.

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
    'handoff_advance'
  ));
