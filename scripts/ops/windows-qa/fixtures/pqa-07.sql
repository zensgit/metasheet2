-- PQA-07 — Authorization isolation — synthetic fixtures (create + cleanup).
-- Draft/HOLD. Synthetic data only (all identifiers prefixed qa_synth_).
-- Run against the isolated database metasheet_windows_qa ONLY. Never a shared/customer DB.
--
-- Real table/column citations (pinned SHA 0dc3596ddb59ed1d2a292bea246b3b6ea8ff1e1b):
--   users            -> src/db/migrations/zzzz20260119100000_create_users_table.ts:9
--                       (id:11 text PK, email:12 NOT NULL unique, password_hash:14 NOT NULL,
--                        permissions:16 jsonb, is_active:18 boolean)
--   user_orgs        -> src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts:11
--                       (user_id:13, org_id:14, is_active:15; PK (user_id,org_id) :25)
--   attendance_records -> src/db/migrations/zzzz20260114090000_create_attendance_tables.ts:54
--                       (user_id:57, work_date:58, timezone:59);
--                       org_id added zzzz20260114100000_add_attendance_org_id.ts:39
--                       (text NOT NULL DEFAULT 'default'); current_calculation_id left NULL
--                       (nullable, zzzz20260725120000_...durable_storage.ts:1085).
--
-- NOTE (UNVERIFIED — operator to confirm): password_hash below is a placeholder; obtaining a
-- real login session for qa_synth_u1/qa_synth_u3 that carries attendance:read depends on the
-- running server's auth flow. If a real credential is required, provision it through the
-- platform's user setup rather than editing the hash blindly.

-- ============================ CREATE ============================
BEGIN;

INSERT INTO users (id, email, name, password_hash, role, permissions, is_active) VALUES
  ('qa_synth_u1', 'qa_synth_u1@qa.invalid', 'QA Synth U1', 'qa_synth_no_login', 'user', '["attendance:read"]'::jsonb, true),
  ('qa_synth_u2', 'qa_synth_u2@qa.invalid', 'QA Synth U2', 'qa_synth_no_login', 'user', '["attendance:read"]'::jsonb, true),
  ('qa_synth_u3', 'qa_synth_u3@qa.invalid', 'QA Synth U3', 'qa_synth_no_login', 'user', '["attendance:read"]'::jsonb, true)
ON CONFLICT (id) DO NOTHING;

-- Active memberships for u1/u2 in org_a; INACTIVE membership for u3 in org_a.
INSERT INTO user_orgs (user_id, org_id, is_active) VALUES
  ('qa_synth_u1', 'qa_synth_org_a', true),
  ('qa_synth_u2', 'qa_synth_org_a', true),
  ('qa_synth_u3', 'qa_synth_org_a', false)
ON CONFLICT (user_id, org_id) DO NOTHING;

-- One record per user in org_a; no calculation seeded (current_calculation_id NULL) so the
-- self read returns HTTP 200 { calculation: null } as a positive control.
INSERT INTO attendance_records (user_id, work_date, org_id) VALUES
  ('qa_synth_u1', DATE '2026-01-05', 'qa_synth_org_a'),
  ('qa_synth_u2', DATE '2026-01-05', 'qa_synth_org_a')
ON CONFLICT (user_id, work_date, org_id) DO NOTHING;

COMMIT;

-- Capture the record ids the steps reference ({u1_record_id}, {u2_record_id}):
--   SELECT id, user_id FROM attendance_records
--    WHERE org_id = 'qa_synth_org_a' AND user_id IN ('qa_synth_u1','qa_synth_u2')
--    ORDER BY user_id;

-- ============================ CLEANUP ============================
-- Deletes ONLY this case's synthetic rows. Run after the steps; residue must be 0.
BEGIN;

DELETE FROM attendance_records WHERE org_id LIKE 'qa_synth_%' OR user_id LIKE 'qa_synth_%';
DELETE FROM user_orgs         WHERE user_id LIKE 'qa_synth_%' OR org_id LIKE 'qa_synth_%';
DELETE FROM users             WHERE id LIKE 'qa_synth_%';

COMMIT;
