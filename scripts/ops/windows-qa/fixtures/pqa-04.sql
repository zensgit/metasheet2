-- PQA-04 — Legacy compatibility — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- Seeds admin + user in qa_synth_org_legacy. CRITICAL: qa_synth_org_legacy MUST NOT appear in
-- ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED (env), so the org resolves to legacy_projection_only
-- and the W4 path is a no-op (legacy_no_operation w4c0-operation-registry.ts:604-608;
-- W4C0_OUTBOX_LEGACY_FORBIDDEN :827-831). The legacy attendance_records projection is written by the
-- pre-W4 punch path in the steps. Env check is UNVERIFIED — operator to confirm.

-- ============================ CREATE ============================
BEGIN;

INSERT INTO users (id, email, name, password_hash, role, permissions, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_admin@qa.invalid', 'QA Synth Admin', 'qa_synth_no_login', 'user', '["attendance:admin"]'::jsonb, true),
  ('qa_synth_u1',    'qa_synth_u1@qa.invalid',    'QA Synth U1',    'qa_synth_no_login', 'user', '["attendance:write"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_org_legacy', true),
  ('qa_synth_u1',    'qa_synth_org_legacy', true)
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
