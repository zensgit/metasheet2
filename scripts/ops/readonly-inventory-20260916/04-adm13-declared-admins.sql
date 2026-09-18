-- ============================================================================
-- 04-adm13-declared-admins.sql — ADM-13 read-only inventory segment
-- ============================================================================
-- Unlocks: PR #5665 / #5677 (INVENTORY ONLY — this file deliberately does NOT
-- backfill `user_roles`). It counts users who are ADMIN BY A DECLARATIVE FIELD
-- on `users` but have NO `user_roles` row with `role_id = 'admin'` — i.e. users
-- `rbac/service.ts`'s `isAdmin()` says "no" about, while most of the rest of
-- the codebase's own admin checks say "yes".
--
-- WHAT "DECLARATIVE ADMIN FIELD" MEANS HERE:
--   `rbac/service.ts` `isAdmin()` (:19-34) is role-table-only:
--     `SELECT 1 FROM user_roles WHERE user_id = $1 AND role_id = 'admin'`.
--   `users` has two columns that read as a declared admin flag:
--     `role text NOT NULL DEFAULT 'user'` —
--       packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:15
--       (also packages/core-backend/migrations/054_create_users_table.sql:9)
--     `is_admin boolean NOT NULL DEFAULT false` —
--       packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:19
--       (NOT present in the older 054_create_users_table.sql shape at all)
--   `(is_admin = TRUE OR role = 'admin')` is the predicate the rest of the
--   codebase uses (approval-admin-capability.ts:71,
--   approval-instance-readability.ts:259, ApprovalBridgeService.ts:258,
--   approval-record-link-txn-auth.ts:571,608, admin-users.ts:1171,1823,
--   api-tokens.ts:89).
--
-- 2026-09-18 REVIEW REPAIR — F5: the old file carried a PROSE fallback ("if Q1
--   shows no is_admin, rewrite the predicate by hand") that (a) required the
--   operator to edit SQL mid-run and (b) MISSED the second missing column in
--   the same legacy shape — `is_active`, selected by the old Q3, which would
--   have aborted that query with 42703 on exactly the database the fallback
--   claimed to cover. Both columns are now probed and BOTH branches are
--   dispatched automatically (`\gset` + `\if`). ON_ERROR_STOP is armed by
--   _preamble.sql, and the file ends with an explicit `INVENTORY_RESULT …
--   status=complete|incomplete` line: on the legacy shape the answer is
--   `incomplete reason=missing-column:users.is_admin …` with the role-only
--   numbers printed as a LOWER BOUND — never a silent, full-looking zero.
--
-- SCOPE: counts and lists only; does not judge whether `users.role`/
-- `users.is_admin` or `user_roles` is "the truth" (that is ADM-13's decision).
-- `is_active` is context, never a WHERE filter.
--
-- VALUES-FREE: only `id`, `role` (small enum), `is_admin`, `is_active`.
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 04-adm13-declared-admins.sql
--   psql "$DATABASE_URL" -v schema=public -f 04-adm13-declared-admins.sql
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Column probe + automatic dispatch (F5) ──────────────────────────────
SELECT table_name, column_name, data_type
  FROM information_schema.columns
 WHERE table_schema = ANY (current_schemas(false))
   AND ((table_name = 'users' AND column_name IN ('id', 'role', 'is_admin', 'is_active'))
     OR (table_name = 'user_roles' AND column_name IN ('user_id', 'role_id')))
 ORDER BY table_name, column_name;

SELECT EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'users' AND column_name = 'is_admin') AS has_is_admin,
       EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'users' AND column_name = 'is_active') AS has_is_active,
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'user_roles') AS has_user_roles
\gset


\if :has_user_roles

\if :has_is_admin
\echo '-- users.is_admin present — full predicate (is_admin = TRUE OR role = admin).'

-- ── Q2. Declared-admin-but-not-in-user_roles — COUNT (full predicate) ──────
-- THE primary ADM-13 number. Depends on rbac/service.ts:22 for the absence test.
SELECT count(*)::int AS declared_admin_not_in_user_roles
  FROM users u
 WHERE (u.is_admin = TRUE OR u.role = 'admin')
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       );

-- ── Q3. Same population — IDS, classified by which declarative field fired ──
\if :has_is_active
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
\else
\echo '-- users.is_active absent — id list without the is_active context column.'
SELECT u.id,
       (u.role = 'admin') AS role_says_admin,
       u.is_admin AS is_admin_flag
  FROM users u
 WHERE (u.is_admin = TRUE OR u.role = 'admin')
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       )
 ORDER BY u.id;
\endif

-- ── Q4 (SUPPLEMENTARY, denominator). user_roles admin rows vs declared ─────
SELECT count(*)::int AS user_roles_admin_rows,
       count(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.id = ur.user_id AND (u.is_admin = TRUE OR u.role = 'admin')
         )
       )::int AS also_declared_admin
  FROM user_roles ur
 WHERE ur.role_id = 'admin';

\else
\echo '-- users.is_admin ABSENT (legacy 054_ shape) — role-only predicate; results are a LOWER BOUND, reported as incomplete.'

-- ── Q2 (legacy shape). Declared-admin-but-not-in-user_roles — COUNT ────────
-- Role-only half of the predicate. This is a LOWER BOUND on the real ADM-13
-- population: on this schema `is_admin` does not exist, so nothing can be said
-- about users who would have carried it. The INVENTORY_RESULT line below says
-- `incomplete` for exactly this reason.
SELECT count(*)::int AS declared_admin_not_in_user_roles_role_only
  FROM users u
 WHERE u.role = 'admin'
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       );

-- ── Q3 (legacy shape). Same population — IDS ───────────────────────────────
\if :has_is_active
SELECT u.id,
       (u.role = 'admin') AS role_says_admin,
       u.is_active
  FROM users u
 WHERE u.role = 'admin'
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       )
 ORDER BY u.id;
\else
SELECT u.id,
       (u.role = 'admin') AS role_says_admin
  FROM users u
 WHERE u.role = 'admin'
   AND NOT EXISTS (
         SELECT 1 FROM user_roles ur
          WHERE ur.user_id = u.id AND ur.role_id = 'admin'
       )
 ORDER BY u.id;
\endif

-- ── Q4 (legacy shape, SUPPLEMENTARY denominator) ───────────────────────────
SELECT count(*)::int AS user_roles_admin_rows,
       count(*) FILTER (
         WHERE EXISTS (
           SELECT 1 FROM users u
            WHERE u.id = ur.user_id AND u.role = 'admin'
         )
       )::int AS also_declared_admin_role_only
  FROM user_roles ur
 WHERE ur.role_id = 'admin';
\endif

\else
\echo '-- user_roles table absent — Q2/Q3/Q4 skipped (see INVENTORY_RESULT below).'
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line ⇒ aborted run (error / statement timeout 57014 /
-- cancellation / truncated output) ⇒ INCOMPLETE, never "zero declared admins".
SELECT 'INVENTORY_RESULT file=04-adm13-declared-admins.sql status=' ||
       CASE WHEN p.missing = '' THEN 'complete predicate=is_admin-or-role'
            ELSE 'incomplete reason=missing-column:' || p.missing ||
                 CASE WHEN p.has_user_roles AND NOT p.has_is_admin
                      THEN ' note=role-only-lower-bound' ELSE '' END
       END AS inventory_result
  FROM (
    SELECT has_user_roles, has_is_admin,
           btrim(
             CASE WHEN NOT has_is_admin THEN 'users.is_admin ' ELSE '' END ||
             CASE WHEN NOT has_is_active THEN 'users.is_active ' ELSE '' END ||
             CASE WHEN NOT has_user_roles THEN 'user_roles ' ELSE '' END
           ) AS missing
      FROM (
        SELECT EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'users' AND column_name = 'is_admin') AS has_is_admin,
               EXISTS (SELECT 1 FROM information_schema.columns
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'users' AND column_name = 'is_active') AS has_is_active,
               EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'user_roles') AS has_user_roles
      ) q
  ) p;
