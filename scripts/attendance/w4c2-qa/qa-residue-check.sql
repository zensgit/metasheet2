-- W4C-2 QA — post-run residue check for the ISOLATED QA database.
-- Interpretation guide (see docs/development/attendance-w4c2-qa-handoff-20260726.md §5):
--   * Non-zero totals in section 1 are EXPECTED on an isolated DB after the
--     suites ran (W4 storage is append-only by design; records with
--     calculations are FK-RESTRICT + trigger protected and cannot be deleted).
--   * Defect signals are: dangling claimed operations (2), pending outbox
--     after a drain (3), orphans (4), and any W4 rows for a
--     legacy-posture org (6).
--   * Reset = drop/recreate the whole DB via qa-db-reset.sh.

-- 1) Totals per W4 table (reconcile against what the run itself wrote).
SELECT 'attendance_result_operations' AS t, count(*) FROM attendance_result_operations
UNION ALL SELECT 'attendance_result_operation_batches', count(*) FROM attendance_result_operation_batches
UNION ALL SELECT 'attendance_result_event_outbox', count(*) FROM attendance_result_event_outbox
UNION ALL SELECT 'attendance_record_calculations', count(*) FROM attendance_record_calculations
UNION ALL SELECT 'attendance_record_segments', count(*) FROM attendance_record_segments
UNION ALL SELECT 'attendance_request_calculation_snapshots', count(*) FROM attendance_request_calculation_snapshots
ORDER BY 1;

-- 2) Non-terminal operations (a lingering 'claimed' row is a leak signal).
SELECT org_id, entrypoint, operation_id, state, created_at
  FROM attendance_result_operations
 WHERE state <> 'completed'
 ORDER BY created_at;

-- 3) Undelivered outbox rows (should be 0 after a drain pass).
SELECT count(*) AS pending_outbox
  FROM attendance_result_event_outbox
 WHERE delivery_state = 'pending';

-- 4) Orphan checks (should all be 0).
SELECT count(*) AS orphan_segments
  FROM attendance_record_segments s
 WHERE NOT EXISTS (SELECT 1 FROM attendance_record_calculations c WHERE c.id = s.calculation_id);
SELECT count(*) AS orphan_calculations
  FROM attendance_record_calculations c
 WHERE NOT EXISTS (SELECT 1 FROM attendance_records r WHERE r.id = c.attendance_record_id);

-- 5) QA-fixture namespace residue (synthetic-data markers; informational).
SELECT count(*) AS qa_users FROM users WHERE email LIKE '%@w4c2-qa.test';
SELECT count(*) AS qa_shifts FROM attendance_shifts WHERE name LIKE 'W4C2-QA-%';
SELECT count(*) AS qa_rollout_rows FROM attendance_calculation_rollout_state WHERE reason_code = 'QA_FIXTURE';

-- 6) Orgs CURRENTLY in legacy posture must have zero calculation/outbox
--    evidence (G23 spot-check). NOTE: a legacy org MAY legitimately hold
--    compatibility operation rows (accepted_write_posture =
--    'legacy_projection_only'; gate-matrix leg 7 first half), so operations
--    are only a defect when their posture is NOT legacy_projection_only.
SELECT count(*) AS legacy_org_calculations
  FROM attendance_record_calculations c
  JOIN attendance_records r ON r.id = c.attendance_record_id
  JOIN attendance_calculation_rollout_state rs ON rs.org_id = r.org_id
 WHERE rs.state = 'legacy';
SELECT count(*) AS legacy_org_outbox
  FROM attendance_result_event_outbox e
  JOIN attendance_calculation_rollout_state rs ON rs.org_id = e.org_id
 WHERE rs.state = 'legacy';
SELECT count(*) AS legacy_org_nonlegacy_operations
  FROM attendance_result_operations o
  JOIN attendance_calculation_rollout_state rs ON rs.org_id = o.org_id
 WHERE rs.state = 'legacy'
   AND o.accepted_write_posture <> 'legacy_projection_only';
