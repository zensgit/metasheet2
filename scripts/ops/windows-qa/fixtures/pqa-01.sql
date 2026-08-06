-- PQA-01 — Multi-segment authoring — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- The two-segment shift is created by the PRODUCT (POST /api/attendance/shifts) in step A1,
-- not hand-seeded, so this fixture only seeds the admin actor + membership. Cleanup removes
-- the shift + its segments for the synthetic org.
--
-- Real table/column citations (pinned SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b):
--   users       -> src/db/migrations/zzzz20260119100000_create_users_table.ts:9
--   user_orgs   -> src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts:11
--   attendance_shifts          -> zzzz20260114120000_add_attendance_scheduling_tables.ts:13
--                                 (org_id:16, name:17, timezone:18)
--   attendance_shift_segments  -> zzzz20260724120000_create_attendance_shift_segments.ts:109
--                                 (org_id:112, shift_id:113, segment_index:114, start_time:115,
--                                  start_day_offset:116, end_time:117, end_day_offset:118;
--                                  UNIQUE (shift_id, segment_index) :152)
--
-- NOTE (UNVERIFIED — operator to confirm): login session for qa_synth_admin carrying
-- attendance:admin depends on the running server's auth flow.

-- ============================ CREATE ============================
BEGIN;

INSERT INTO users (id, email, name, password_hash, role, permissions, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_admin@qa.invalid', 'QA Synth Admin', 'qa_synth_no_login', 'user', '["attendance:admin"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_org_a', true)
ON CONFLICT (user_id, org_id) DO NOTHING;

COMMIT;

-- After step A2, verify ordering/times/timezone directly if desired:
--   SELECT s.name, s.timezone, seg.segment_index, seg.start_time, seg.end_time, seg.end_day_offset
--     FROM attendance_shifts s
--     JOIN attendance_shift_segments seg ON seg.shift_id = s.id AND seg.org_id = s.org_id
--    WHERE s.org_id = 'qa_synth_org_a' AND s.name = 'qa_synth_shift_2seg'
--    ORDER BY seg.segment_index;

-- ============================ CLEANUP ============================
BEGIN;

DELETE FROM attendance_shift_segments WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_shifts         WHERE org_id LIKE 'qa_synth_%';
DELETE FROM user_orgs                 WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%';
DELETE FROM users                     WHERE id LIKE 'qa_synth_%';

COMMIT;
