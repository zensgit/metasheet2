-- PQA-05 — Shadow posture — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- Seeds the admin+user substrate in qa_synth_org_shadow plus a BOOTSTRAP rollout-state row
-- (state='legacy'), the only INSERT shape the attendance_w4_rollout_state_guard trigger admits.
-- Moving legacy -> shadow is done by the internal command transitionAttendanceCalculationRolloutV1
-- (packages/core-backend/src/attendance/w4c3a-rollout-control.ts:1125 — NO HTTP route), plus the
-- env allowlist ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED=qa_synth_org_shadow. Both are
-- UNVERIFIED — operator to confirm.
--
-- Table/column citations (pinned SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b):
--   attendance_calculation_rollout_state -> src/db/migrations/zzzz20260725120000_w4c0_attendance_segment_calculation_durable_storage.ts:993
--     (org_id PK :994, state :995, engine_version :996, reason_code :997, actor_id :998,
--      version :1000, prior_state :1001, scope :1002; CHECK chk_acrs_scope='synthetic_staging' :1005;
--      INSERT-guard trigger admits state='legacy'/prior_state NULL/version=1 :1040-1050)
--   attendance_record_calculations       -> zzzz20260725120000_...:655 (mode :661; chk_arc_shadow_effect :749)

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

-- Bootstrap rollout state = 'legacy' (prior_state NULL, scope 'synthetic_staging').
-- The legacy -> shadow transition is applied afterwards via the internal command (no route).
INSERT INTO attendance_calculation_rollout_state
  (org_id, state, engine_version, reason_code, actor_id, version, prior_state, scope) VALUES
  ('qa_synth_org_shadow', 'legacy', 'qa_synth_engine_v1', 'qa_synth_bootstrap', 'qa_synth_admin', 1, NULL, 'synthetic_staging')
ON CONFLICT (org_id) DO NOTHING;

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
