-- PQA-08 — Fingerprint freeze — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- Seeds admin + user in qa_synth_org_shadow (W4 enabled per PQA-05). The request, snapshot,
-- shift change, and re-evaluation are produced by the product/boundary in the steps.
--
-- Citations: computeAttendanceRequestPayloadFingerprintV1 w4c3b-request-snapshots.ts:430;
--   attendance_request_calculation_snapshots zzzz20260725120000_...:625 (payload_fingerprint :632,
--   non-unique fp index :645-649, append-only); mismatch->review w4c2-live-scheduled-boundary.ts:1630-1635.
-- NOTE: snapshot FK to attendance_requests is ON DELETE RESTRICT — the cleanup deletes snapshots
-- before requests.

-- ============================ CREATE ============================
BEGIN;

INSERT INTO users (id, email, name, password_hash, role, permissions, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_admin@qa.invalid', 'QA Synth Admin', 'qa_synth_no_login', 'user', '["attendance:admin"]'::jsonb, true),
  ('qa_synth_u1',    'qa_synth_u1@qa.invalid',    'QA Synth U1',    'qa_synth_no_login', 'user', '["attendance:write"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_org_shadow', true),
  ('qa_synth_u1',    'qa_synth_org_shadow', true)
ON CONFLICT (user_id, org_id) DO NOTHING;

COMMIT;

-- ============================ CLEANUP (FK-safe, comprehensive) ============================
BEGIN;

DELETE FROM attendance_scheduled_run_target_outcomes WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_scheduled_run_targets         WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_result_event_outbox           WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_scheduled_runs                WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_record_segments               WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_record_calculations           WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_request_calculation_snapshots WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_result_operations             WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_result_operation_batches      WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_calculation_rollout_events    WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_calculation_rollout_state     WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_requests                      WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%';
DELETE FROM attendance_records                       WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%';
DELETE FROM attendance_events                        WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%';
DELETE FROM attendance_shift_assignments             WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%';
DELETE FROM attendance_shift_segments                WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_shifts                        WHERE org_id LIKE 'qa_synth_%';
DELETE FROM user_orgs                                WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%';
DELETE FROM users                                    WHERE id LIKE 'qa_synth_%';

COMMIT;
