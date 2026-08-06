-- PQA-03 — Timezone validation — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- The shift itself is created by the PRODUCT (POST /api/attendance/shifts), not hand-seeded,
-- so this fixture only seeds the admin actor + membership. Cleanup removes any shift the
-- steps created for the synthetic org.
--
-- Real table/column citations (pinned SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b):
--   users       -> src/db/migrations/zzzz20260119100000_create_users_table.ts:9
--                  (id:11, email:12 unique, password_hash:14, permissions:16, is_active:18)
--   user_orgs   -> src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts:11
--                  (user_id:13, org_id:14, is_active:15)
--   attendance_shifts          -> zzzz20260114120000_add_attendance_scheduling_tables.ts:13
--                                 (org_id:16, name:17, timezone:18 varchar(64))
--   attendance_shift_segments  -> zzzz20260724120000_create_attendance_shift_segments.ts:109
--                                 (org_id:112, shift_id:113; FK ON DELETE CASCADE :143-149)
--
-- NOTE (UNVERIFIED — operator to confirm): obtaining a login session for qa_synth_admin that
-- carries attendance:admin depends on the running server's auth flow; provision credentials
-- through the platform user setup if a real password is required.

-- ============================ CREATE ============================
BEGIN;

INSERT INTO users (id, email, name, password_hash, role, permissions, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_admin@qa.invalid', 'QA Synth Admin', 'qa_synth_no_login', 'user', '["attendance:admin"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('qa_synth_admin', 'qa_synth_org_a', true)
ON CONFLICT (user_id, org_id) DO NOTHING;

COMMIT;

-- ============================ CLEANUP ============================
-- Deletes ONLY this case's synthetic rows. Segments are deleted first (the composite FK is
-- ON DELETE CASCADE, but the explicit delete keeps the residue query unambiguous).
BEGIN;

DELETE FROM attendance_shift_segments WHERE org_id LIKE 'qa_synth_%';
DELETE FROM attendance_shifts         WHERE org_id LIKE 'qa_synth_%';
DELETE FROM user_orgs                 WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%';
DELETE FROM users                     WHERE id LIKE 'qa_synth_%';

COMMIT;
