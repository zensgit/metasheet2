-- ============================================================================
-- 03-adm08-wildcard-permissions.sql — ADM-08 read-only inventory
-- ============================================================================
-- Feeds: ADM-07's decision on what to do about the `*:*` super-wildcard
-- permission. This file does not itself decide or change anything — it only
-- counts where `*:*` is currently granted, across every surface
-- `rbac/service.ts` actually consults.
--
-- WHERE `*:*` IS CHECKED (source of truth for which tables/columns matter):
--   packages/core-backend/src/rbac/service.ts
--     `userHasPermission()` :36-72 checks, in order: `user_permissions`
--       (exact `permission_code` match, :44) → `role_permissions` via
--       `user_roles` (exact `permission_code` match, :47-54) → legacy
--       `users.permissions` jsonb array (:57-61, `perms.includes('*:*')`, :61).
--     `listUserPermissions()` :74-111 unions the same three surfaces.
--   So `*:*` can be granted THREE ways: (a) a `user_permissions` row, (b) a
--   `role_permissions` row for a role held via `user_roles`, (c) `'*:*'` in the
--   legacy `users.permissions` array column.
--
-- WHY TWO SHAPES FOR `users.permissions` — two competing DDLs, both guarded by
-- `IF NOT EXISTS`; whichever ran first on a given database wins:
--   Shape A (current app-code shape, `JSONColumnType<string[]>`,
--   packages/core-backend/src/db/types.ts:758): `permissions jsonb NOT NULL
--   DEFAULT '[]'::jsonb`
--     packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:16
--   Shape B (older raw-SQL shape): `permissions TEXT[] NOT NULL DEFAULT '{}'`
--     packages/core-backend/migrations/054_create_users_table.sql:10
--
-- 2026-09-18 REVIEW REPAIR — F5: the two shapes are MUTUALLY EXCLUSIVE and the
--   wrong one raises an operator-error, so the file no longer asks the operator
--   to pick: the Q1 probe feeds `\gset` and `\if` dispatches to the live shape
--   automatically. ON_ERROR_STOP is armed by _preamble.sql (one execution mode:
--   whole file via `psql -f`), and the file ends with an explicit
--   `INVENTORY_RESULT … status=complete|incomplete` line. A missing table or
--   column is reported as `incomplete reason=…`, NEVER as a zero count.
--
-- role_permissions / user_permissions / user_roles column names are IDENTICAL
-- across their two competing DDLs (no shape branch needed):
--   packages/core-backend/migrations/033_create_rbac_core.sql:16-18,34-36,43-45
--   packages/core-backend/src/db/migrations/20250924190000_create_rbac_tables.ts:34-37,54-57,74-77
--
-- VALUES-FREE: only counts and identifiers (`user_id`, `role_id`); `*:*` is a
-- permission CODE from a fixed vocabulary, not a secret.
--
-- RUN WITH (the only supported form):
--   psql "$DATABASE_URL" -f 03-adm08-wildcard-permissions.sql
--   psql "$DATABASE_URL" -v schema=public -f 03-adm08-wildcard-permissions.sql
-- ============================================================================

\ir _preamble.sql


-- ── Q1. Column-shape probe + automatic dispatch (F5) ────────────────────────
-- For `users.permissions`: `jsonb` = Shape A; `ARRAY`/`_text` = Shape B.
SELECT table_name, column_name, data_type, udt_name
  FROM information_schema.columns
 WHERE table_schema = ANY (current_schemas(false))
   AND ((table_name = 'users' AND column_name IN ('id', 'permissions', 'role'))
     OR (table_name = 'role_permissions' AND column_name IN ('role_id', 'permission_code'))
     OR (table_name = 'user_permissions' AND column_name IN ('user_id', 'permission_code'))
     OR (table_name = 'user_roles' AND column_name IN ('user_id', 'role_id')))
 ORDER BY table_name, column_name;

SELECT COALESCE((SELECT udt_name = 'jsonb' FROM information_schema.columns
                  WHERE table_schema = ANY (current_schemas(false))
                    AND table_name = 'users' AND column_name = 'permissions'), false) AS perms_jsonb,
       COALESCE((SELECT udt_name = '_text' FROM information_schema.columns
                  WHERE table_schema = ANY (current_schemas(false))
                    AND table_name = 'users' AND column_name = 'permissions'), false) AS perms_textarray,
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'user_permissions') AS has_user_permissions,
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'role_permissions') AS has_role_permissions,
       EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = ANY (current_schemas(false))
                  AND table_name = 'user_roles') AS has_user_roles
\gset


\if :perms_jsonb
\echo '-- users.permissions is jsonb (Shape A) — running Q2.'
-- ── Q2. users.permissions Shape A (jsonb) — count + ids containing `*:*` ────
-- Mirrors rbac/service.ts:61 (`perms.includes('*:*')`).
-- Expected: 1 row `(wildcard_users int)`, then EXACTLY that many `(id)` rows.
SELECT count(*)::int AS wildcard_users
  FROM users
 WHERE permissions @> '["*:*"]'::jsonb;

SELECT id
  FROM users
 WHERE permissions @> '["*:*"]'::jsonb
 ORDER BY id;
\endif

\if :perms_textarray
\echo '-- users.permissions is text[] (Shape B) — running Q3.'
-- ── Q3. users.permissions Shape B (text[]) — count + ids containing `*:*` ───
SELECT count(*)::int AS wildcard_users
  FROM users
 WHERE '*:*' = ANY(permissions);

SELECT id
  FROM users
 WHERE '*:*' = ANY(permissions)
 ORDER BY id;
\endif


\if :has_user_permissions
-- ── Q4. user_permissions — direct `*:*` grant rows ──────────────────────────
-- Mirrors rbac/service.ts:44. Expected: 1 count row, then that many user_ids.
SELECT count(*)::int AS wildcard_direct_grants
  FROM user_permissions
 WHERE permission_code = '*:*';

SELECT user_id
  FROM user_permissions
 WHERE permission_code = '*:*'
 ORDER BY user_id;
\else
\echo '-- user_permissions table absent — Q4 skipped.'
\endif


\if :has_role_permissions
-- ── Q5. role_permissions — `*:*` granted to a role ──────────────────────────
SELECT count(*)::int AS wildcard_roles
  FROM role_permissions
 WHERE permission_code = '*:*';

SELECT role_id
  FROM role_permissions
 WHERE permission_code = '*:*'
 ORDER BY role_id;
\endif


\if :has_role_permissions
\if :has_user_roles
-- ── Q6. Users who INHERIT `*:*` via a role (the indirect grant path) ───────
-- Mirrors rbac/service.ts:47-54 — resolves Q5's role list down to users.
SELECT count(DISTINCT ur.user_id)::int AS wildcard_via_role_users
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
 WHERE rp.permission_code = '*:*';

SELECT DISTINCT ur.user_id, ur.role_id
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
 WHERE rp.permission_code = '*:*'
 ORDER BY ur.user_id, ur.role_id;
\else
\echo '-- user_roles table absent — Q6 skipped.'
\endif
\endif


-- ── COMPLETENESS RESULT (must be the LAST statement in this file) ──────────
-- No `INVENTORY_RESULT` line ⇒ aborted run (error / statement timeout 57014 /
-- cancellation / truncated output) ⇒ INCOMPLETE, never "zero wildcards".
SELECT 'INVENTORY_RESULT file=03-adm08-wildcard-permissions.sql status=' ||
       CASE WHEN p.missing = '' THEN 'complete shape=' ||
                 CASE WHEN p.perms_jsonb THEN 'A(jsonb)' ELSE 'B(text[])' END
            ELSE 'incomplete reason=missing:' || p.missing END AS inventory_result
  FROM (
    SELECT perms_jsonb,
           btrim(
             CASE WHEN NOT (perms_jsonb OR perms_textarray) THEN 'users.permissions ' ELSE '' END ||
             CASE WHEN NOT has_user_permissions THEN 'user_permissions ' ELSE '' END ||
             CASE WHEN NOT has_role_permissions THEN 'role_permissions ' ELSE '' END ||
             CASE WHEN NOT has_user_roles THEN 'user_roles ' ELSE '' END
           ) AS missing
      FROM (
        SELECT COALESCE((SELECT udt_name = 'jsonb' FROM information_schema.columns
                          WHERE table_schema = ANY (current_schemas(false))
                            AND table_name = 'users' AND column_name = 'permissions'), false) AS perms_jsonb,
               COALESCE((SELECT udt_name = '_text' FROM information_schema.columns
                          WHERE table_schema = ANY (current_schemas(false))
                            AND table_name = 'users' AND column_name = 'permissions'), false) AS perms_textarray,
               EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'user_permissions') AS has_user_permissions,
               EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'role_permissions') AS has_role_permissions,
               EXISTS (SELECT 1 FROM information_schema.tables
                        WHERE table_schema = ANY (current_schemas(false))
                          AND table_name = 'user_roles') AS has_user_roles
      ) q
  ) p;
