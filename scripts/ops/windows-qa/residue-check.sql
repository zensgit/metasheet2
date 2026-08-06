-- Attendance Windows-native QA v2 — GLOBAL residue check.
-- Returns ONE integer: the count of leftover qa_synth_* rows across every attendance
-- (and platform-substrate) table the PQA-01..10 fixtures + steps can populate.
-- Put the returned value in summary.json.residue; PASS requires 0 AFTER every case cleanup.
--
-- Draft/HOLD. Run against the isolated database metasheet_windows_qa ONLY.
--
-- PRECONDITION: run against a FULLY MIGRATED metasheet_windows_qa (the package setup applies
-- the entire migration set). Every table below is created by a migration in that set, so a
-- "relation does not exist" error means the DB is NOT fully migrated (a setup failure), NOT a
-- residue result. Synthetic marking lives ONLY on text columns (org_id / user_id / id) because
-- every *.id is a uuid that cannot carry the qa_synth_ prefix.
--
-- Table -> creation site (pinned SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b), all under
-- packages/core-backend/src/db/migrations/ unless noted:
--   users                                     zzzz20260119100000_create_users_table.ts:9
--   user_orgs                                 zzzz20260114110000_create_user_orgs_table.ts:11
--   attendance_shifts                         zzzz20260114120000_add_attendance_scheduling_tables.ts:13
--   attendance_shift_segments                 zzzz20260724120000_create_attendance_shift_segments.ts:109  (org_id :112)
--   attendance_shift_assignments              zzzz20260114120000_add_attendance_scheduling_tables.ts:35   (org_id :38)
--   attendance_records                        zzzz20260114090000_create_attendance_tables.ts:54 ; org_id  zzzz20260114100000_add_attendance_org_id.ts:39
--   attendance_events                         zzzz20260114090000_create_attendance_tables.ts:31 ; org_id  zzzz20260114100000_add_attendance_org_id.ts (attendance_events org_id/index :30-34)
--   attendance_requests                       zzzz20260114090000_create_attendance_tables.ts:80 ; org_id  zzzz20260114100000_add_attendance_org_id.ts:53
--   attendance_record_calculations            zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:655 (org_id :657)
--   attendance_record_segments                zzzz20260725120000_...durable_storage.ts:860 (org_id :862)
--   attendance_result_operations              zzzz20260725120000_...durable_storage.ts:470 (org_id :471)
--   attendance_result_operation_batches       zzzz20260725120000_...durable_storage.ts:428 (org_id :429)
--   attendance_result_event_outbox            zzzz20260725120000_...durable_storage.ts:590 (org_id :592)
--   attendance_request_calculation_snapshots  zzzz20260725120000_...durable_storage.ts:625 (org_id :626)
--   attendance_calculation_rollout_state      zzzz20260725120000_...durable_storage.ts:993 (org_id :994)
--   attendance_calculation_rollout_events     zzzz20260725120000_...durable_storage.ts:1011 (org_id :1013)
--   attendance_scheduled_runs                 zzzz20260727100000_w4c2_scheduled_run_identity_and_outbox_union.ts:120 (org_id :122)
--   attendance_scheduled_run_targets          zzzz20260727100000_...outbox_union.ts:237 (org_id :239)
--   attendance_scheduled_run_target_outcomes  zzzz20260727100000_...outbox_union.ts:348 (org_id :350)

SELECT
    (SELECT count(*) FROM users                                     WHERE id      LIKE 'qa_synth_%')
  + (SELECT count(*) FROM user_orgs                                 WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shifts                         WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_segments                 WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_shift_assignments              WHERE org_id  LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_records                        WHERE org_id  LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_events                         WHERE org_id  LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_requests                       WHERE org_id  LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_calculations            WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_record_segments                WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_operations             WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_operation_batches      WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_result_event_outbox           WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_request_calculation_snapshots WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_calculation_rollout_state     WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_calculation_rollout_events    WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_runs                WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_targets         WHERE org_id  LIKE 'qa_synth_%')
  + (SELECT count(*) FROM attendance_scheduled_run_target_outcomes WHERE org_id  LIKE 'qa_synth_%')
  AS residue;
