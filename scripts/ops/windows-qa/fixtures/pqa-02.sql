-- PQA-02 — Overnight attribution — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- The overnight two-segment shift, assignment, and punches are produced by the PRODUCT in the
-- steps (POST /api/attendance/shifts, /assignments, /punch). This fixture seeds the admin +
-- punching-user substrate only.
--
-- Table/column citations (pinned SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b):
--   attendance_events.work_date  -> src/db/migrations/zzzz20260114090000_create_attendance_tables.ts:35
--   attendance_records.work_date -> zzzz20260114090000_create_attendance_tables.ts:58
--   attendance_shift_assignments -> zzzz20260114120000_add_attendance_scheduling_tables.ts:35
--
-- NOTE (UNVERIFIED — operator to confirm): login sessions for qa_synth_admin (attendance:admin)
-- and qa_synth_u1 (attendance:write) depend on the running server's auth flow.

-- ============================ CREATE ============================
BEGIN;

INSERT INTO users (id, email, name, password_hash, role, permissions, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_admin@qa.invalid', 'QA Synth Admin', 'qa_synth_no_login', 'user', '["attendance:admin"]'::jsonb, true),
  ('qa_synth_u1',    'qa_synth_u1@qa.invalid',    'QA Synth U1',    'qa_synth_no_login', 'user', '["attendance:write"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_org_a', true),
  ('qa_synth_u1',    'qa_synth_org_a', true)
ON CONFLICT (user_id, org_id) DO NOTHING;

COMMIT;

-- ============================ CLEANUP (FK-safe, comprehensive) ============================
-- Deletes every qa_synth_* row this campaign could create, in FK-dependency order.
-- Deleting from empty tables is a no-op; safe to run even if a step produced nothing.
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
