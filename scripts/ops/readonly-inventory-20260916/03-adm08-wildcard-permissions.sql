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
--       `users.permissions` jsonb array (:57-61, where
--       `perms.includes('*:*')` is the literal super-wildcard check, :61).
--     `listUserPermissions()` :74-111 unions `user_permissions` +
--       `role_permissions`-via-`user_roles` (:85-92) with the legacy
--       `users.permissions` array (:94-96).
--   So `*:*` can be granted THREE ways: (a) a `user_permissions` row with
--   `permission_code = '*:*'`, (b) a `role_permissions` row with
--   `permission_code = '*:*'` for a role the user holds via `user_roles`,
--   (c) `'*:*'` present in the legacy `users.permissions` array/text column.
--
-- WHY TWO SHAPES FOR `users.permissions`. Two competing DDLs both guarded by
-- `IF NOT EXISTS` — whichever ran first on a given database wins (same
-- pattern documented for `data_sources` in the CRED-06 design doc):
--   Shape A (current app-code shape, `JSONColumnType<string[]>` per
--   packages/core-backend/src/db/types.ts:758): `permissions jsonb NOT NULL
--   DEFAULT '[]'::jsonb`
--     packages/core-backend/src/db/migrations/zzzz20260119100000_create_users_table.ts:16
--     (table :8-23, `id` :11, `role` :15)
--   Shape B (older raw-SQL shape): `permissions TEXT[] NOT NULL DEFAULT '{}'`
--     packages/core-backend/migrations/054_create_users_table.sql:10
--     (table :4-14, `id` :5, `role` :9)
--
-- role_permissions / user_permissions / user_roles COLUMN NAMES are
-- IDENTICAL across their two competing DDLs (no shape branch needed for
-- these three join tables — verified below):
--   packages/core-backend/migrations/033_create_rbac_core.sql:16-18
--     (role_permissions: role_id, permission_code), :34-36 (user_roles:
--     user_id, role_id), :43-45 (user_permissions: user_id, permission_code)
--   packages/core-backend/src/db/migrations/20250924190000_create_rbac_tables.ts:34-37
--     (user_roles), :54-57 (user_permissions), :74-77 (role_permissions) —
--     same three column-name pairs, just `varchar(255)` instead of `text`.
--
-- VALUES-FREE: every query returns only counts and identifiers (`user_id`,
-- `role_id`) — `*:*` is a permission CODE (an identifier from a fixed,
-- known vocabulary), never a secret value, so returning it as a literal in a
-- WHERE clause / SELECT list is not a values leak.
--
-- RUN WITH: psql "$DATABASE_URL" -f 03-adm08-wildcard-permissions.sql
-- ============================================================================


-- ── Q1. Column-shape probe (RUN THIS FIRST) ─────────────────────────────────
-- Purpose: determine whether `users.permissions` is Shape A (jsonb) or
--   Shape B (text[]) before running Q2/Q3, and confirm the three RBAC join
--   tables exist.
-- Depends on: all migration lines cited in the header comment above.
-- Expected output shape: up to 5 rows of (table_name, column_name, data_type,
--   udt_name). For `permissions`: `jsonb` = Shape A; `ARRAY` with
--   `udt_name = '_text'` = Shape B.
SELECT table_name, column_name, data_type, udt_name
  FROM information_schema.columns
 WHERE (table_name = 'users' AND column_name IN ('id', 'permissions', 'role'))
    OR (table_name = 'role_permissions' AND column_name IN ('role_id', 'permission_code'))
    OR (table_name = 'user_permissions' AND column_name IN ('user_id', 'permission_code'))
    OR (table_name = 'user_roles' AND column_name IN ('user_id', 'role_id'))
 ORDER BY table_name, column_name;


-- ── Q2. users.permissions Shape A (jsonb) — count + ids containing `*:*` ────
-- Purpose: legacy super-wildcard grants stored directly on the user row,
--   jsonb-array shape. Mirrors the exact check in rbac/service.ts:61
--   (`perms.includes('*:*')`).
-- Depends on: zzzz20260119100000_create_users_table.ts:11,16.
-- Expected output shape: 1 row `(wildcard_users int)`, then 0..N rows of
--   `(id)`. If `permissions` is Shape B (text[]) this query errors with
--   `operator does not exist: text[] @> jsonb` (or similar) — use Q3 instead.
SELECT count(*)::int AS wildcard_users
  FROM users
 WHERE permissions @> '["*:*"]'::jsonb;

SELECT id
  FROM users
 WHERE permissions @> '["*:*"]'::jsonb
 ORDER BY id;


-- ── Q3. users.permissions Shape B (text[]) — count + ids containing `*:*` ───
-- Purpose: same check as Q2, for the alternate `text[]` column shape.
-- Depends on: 054_create_users_table.sql:5,10.
-- Expected output shape: same as Q2. If `permissions` is Shape A (jsonb)
--   this query errors with `operator does not exist: jsonb = text` (or
--   similar, since `ANY(jsonb)` is not defined) — use Q2 instead.
SELECT count(*)::int AS wildcard_users
  FROM users
 WHERE '*:*' = ANY(permissions);

SELECT id
  FROM users
 WHERE '*:*' = ANY(permissions)
 ORDER BY id;


-- ── Q4. user_permissions — direct `*:*` grant rows ──────────────────────────
-- Purpose: rows where a specific user was directly granted the super-wildcard
--   (not via a role). Mirrors rbac/service.ts:44 (`user_permissions` exact
--   `permission_code` match).
-- Depends on: 033_create_rbac_core.sql:43-45 (or 20250924190000_create_rbac_tables.ts:54-57
--   — identical column names either way).
-- Expected output shape: 1 row `(wildcard_direct_grants int)`, then 0..N
--   rows of `(user_id)`.
SELECT count(*)::int AS wildcard_direct_grants
  FROM user_permissions
 WHERE permission_code = '*:*';

SELECT user_id
  FROM user_permissions
 WHERE permission_code = '*:*'
 ORDER BY user_id;


-- ── Q5. role_permissions — `*:*` granted to a role ──────────────────────────
-- Purpose: which ROLES (not users) carry the super-wildcard. A role-level
--   row does not by itself name a user; Q6 resolves it to affected users via
--   `user_roles`.
-- Depends on: 033_create_rbac_core.sql:16-18.
-- Expected output shape: 1 row `(wildcard_roles int)`, then 0..N rows of
--   `(role_id)`.
SELECT count(*)::int AS wildcard_roles
  FROM role_permissions
 WHERE permission_code = '*:*';

SELECT role_id
  FROM role_permissions
 WHERE permission_code = '*:*'
 ORDER BY role_id;


-- ── Q6. Users who INHERIT `*:*` via a role (the indirect grant path) ───────
-- Purpose: mirrors rbac/service.ts:47-54 (`user_roles` JOIN `role_permissions`
--   exact `permission_code` match) — resolves Q5's role list down to the
--   actual affected users, which is the number ADM-07 needs (a role-level
--   `*:*` can silently fan out to many users via `user_roles`).
-- Depends on: 033_create_rbac_core.sql:16-18,34-36.
-- Expected output shape: 1 row `(wildcard_via_role_users int)`, then 0..N
--   rows of `(user_id, role_id)` — role_id included so the owner can tell
--   WHICH role to fix to clear multiple users at once.
SELECT count(DISTINCT ur.user_id)::int AS wildcard_via_role_users
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
 WHERE rp.permission_code = '*:*';

SELECT DISTINCT ur.user_id, ur.role_id
  FROM user_roles ur
  JOIN role_permissions rp ON rp.role_id = ur.role_id
 WHERE rp.permission_code = '*:*'
 ORDER BY ur.user_id, ur.role_id;
