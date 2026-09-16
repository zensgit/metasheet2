-- ============================================================================
-- 04-adm13-declared-admins.sql — ADM-13 read-only inventory segment
-- ============================================================================
-- Unlocks: PR #5665 / #5677 (INVENTORY ONLY — this file deliberately does NOT
-- backfill `user_roles`, per the task brief: "只盘点不回填"). It counts users
-- who are ADMIN BY A DECLARATIVE FIELD on `users` but have NO corresponding
-- `user_roles` row with `role_id = 'admin'` — i.e. users `rbac/service.ts`'s
-- `isAdmin()` would say "no" about, even though most of the rest of the
-- codebase's own admin checks would say "yes".
--
-- WHAT "DECLARATIVE ADMIN FIELD" MEANS HERE (read from rbac/service.ts +
-- users migrations, not assumed):
--   `rbac/service.ts` `isAdmin()` (:19-34) is role-table-only:
--     `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`.
--   It does NOT consult `users.role` or `users.is_admin` at all.
--   Meanwhile `users` has TWO columns that read as a declared admin flag:
--     `role text NOT NULL DEFAULT 'user'` —
--       packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:15
--       (also packages/core-backend/migrations/054_create_users_table.sql:9)
--     `is_admin boolean NOT NULL DEFAULT false` —
--       packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:19
--       (db/types.ts:761 confirms the app-code type is `boolean`; NOT present
--       in the older 054_create_users_table.sql shape at all — see Q1)
--   And the predicate `(is_admin = TRUE OR role = 'admin')` is the one the
--   REST of the codebase actually uses to decide "is this user an admin",
--   independently of `rbac/service.ts`'s `user_roles`-only `isAdmin()` — e.g.:
--     packages/core-backend/src/services/approval-admin-capability.ts:71
--       (literal string `'is_active = TRUE AND (is_admin = TRUE OR role = \'admin\')'`)
--     packages/core-backend/src/services/approval-instance-readability.ts:259
--       (`u.is_admin = TRUE OR u.role = 'admin'`)
--     packages/core-backend/src/services/ApprovalBridgeService.ts:258
--       (`scope_admin.is_admin = TRUE OR scope_admin.role = 'admin'`)
--     packages/core-backend/src/services/approval-record-link-txn-auth.ts:571,608
--     packages/core-backend/src/routes/admin-users.ts:1171,1823
--       (`row.role === 'admin' || row.is_admin || roles.includes(PLATFORM_ADMIN_ROLE_ID)`)
--     packages/core-backend/src/routes/api-tokens.ts:89
--   THIS IS THE GAP ADM-13 asks to inventory: a user these call sites treat
--   as admin, but `isAdmin()` (and anything gated on `user_roles` alone,
--   e.g. `rbac/service.ts` role-based permission resolution) does not.
--
-- SCOPE. This file counts and lists — it does not judge whether `users.role`/
-- `users.is_admin` or `user_roles` is "the truth" (that is ADM-13's actual
-- decision, out of scope for a mechanical inventory pack). It also does not
-- filter by `is_active` — `is_active` is returned as a column for context,
-- not used as a WHERE filter, since the task brief did not ask to scope to
-- active users only and several of the call sites above DO filter on it
-- (meaning an inactive declared-admin user may or may not matter depending
-- on which call site you're worried about).
--
-- VALUES-FREE: only `id`, `role` (a fixed small enum: 'user'/'admin'/…, not a
-- secret), `is_admin` (boolean), and `is_active` (boolean) are ever selected.
-- No email, name, password_hash, or other PII/secret column.
--
-- RUN WITH: psql "$DATABASE_URL" -f 04-adm13-declared-admins.sql
-- ============================================================================


-- ── Q1. Column probe (RUN THIS FIRST) ───────────────────────────────────────
-- Purpose: confirm `users.role`, `users.is_admin`, `users.is_active` and
--   `user_roles.role_id` all exist on this database before running Q2/Q3.
--   `is_admin` is the one column NOT guaranteed by the older raw-SQL shape
--   (054_create_users_table.sql has no `is_admin` column at all) — if it is
--   missing, Q2/Q3 must be run with only the `role = 'admin'` half of the
--   predicate (see the fallback note after Q1).
-- Depends on: zzzz20260119100000_create_users_table.ts:11,15,17,19 (id, role,
--   is_active, is_admin); 054_create_users_table.sql:5,9 (id, role — no
--   is_active/is_admin in this shape); 033_create_rbac_core.sql:34-36
--   (user_roles: user_id, role_id).
-- Expected output shape: up to 4 rows of (table_name, column_name, data_type).
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE (table_name = 'users' AND column_name IN ('id', 'role', 'is_admin', 'is_active'))
    OR (table_name = 'user_roles' AND column_name IN ('user_id', 'role_id'))
 ORDER BY table_name, column_name;

-- FALLBACK if Q1 shows NO `is_admin` row for `users` (older 054_ shape,
-- no Kysely users migration ever ran on this database): replace every
-- `(is_admin = TRUE OR role = 'admin')` below with plain `role = 'admin'`,
-- and drop `is_admin` from the SELECT lists.


-- ── Q2. Declared-admin-but-not-in-user_roles — COUNT ────────────────────────
-- Purpose: THE primary ADM-13 inventory number. Users where the declarative
--   field says admin but `user_roles` (what `rbac/service.ts` `isAdmin()`
--   actually reads, :22) has no corresponding `('$id','admin')` row.
-- Depends on: same migration lines as Q1; rbac/service.ts:22 for the
--   `user_roles` predicate this is checking the ABSENCE of.
-- Expected output shape: 1 row, 1 column `declared_admin_not_in_user_roles`.
SELECT count(*)::int AS declared_admin_not_in_user_roles
  FROM users u
 WHERE (u.is_admin = TRUE OR u.role = 'admin')
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       );


-- ── Q3. Declared-admin-but-not-in-user_roles — IDS, classified by which ────
-- ── declarative field fired (helps ADM-13 triage: was it `role`, `is_admin`, ──
-- ── or both?) plus `is_active` for context (not a filter — see header).    ──
-- Depends on: same as Q2.
-- Expected output shape: 0..N rows of
--   (id, role_says_admin bool, is_admin_flag bool, is_active bool).
SELECT u.id,
       (u.role = 'admin') AS role_says_admin,
       u.is_admin AS is_admin_flag,
       u.is_active
  FROM users u
 WHERE (u.is_admin = TRUE OR u.role = 'admin')
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       )
 ORDER BY u.id;


-- ── Q4 (SUPPLEMENTARY, denominator context). How many users have an ────────
-- ── explicit `user_roles` admin row at all, and how many of THOSE also    ──
-- ── carry the declarative field (the "already consistent" population, so ──
-- ── the owner can see Q2's count against a total, not in isolation).      ──
-- Depends on: same as Q2.
-- Expected output shape: 1 row of
--   (user_roles_admin_rows int, also_declared_admin int).
SELECT count(*)::int AS user_roles_admin_rows,
       count(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.id = ur.user_id AND (u.is_admin = TRUE OR u.role = 'admin')
         )
       )::int AS also_declared_admin
  FROM user_roles ur
 WHERE ur.role_id = 'admin';
