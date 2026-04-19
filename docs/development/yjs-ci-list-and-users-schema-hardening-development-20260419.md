# Yjs CI List And Users Schema Hardening Development

Date: 2026-04-19

## Scope

This slice hardens two non-Yjs-runtime CI failures that surfaced while closing PR `#918`:

1. `migration-replay` still failed after the replay-only exclusion list was aligned, because the `List migrations` step ran `db:list` without `MIGRATION_EXCLUDE`.
2. `after-sales integration` and one `e2e` job were still inserting into `users.is_active` / `users.is_admin`, even though replay-built databases can still expose the older minimal `users` table shape created by `054_create_users_table.sql`.

## Root Cause

### Migration Replay List Step

`pnpm -F @metasheet/core-backend db:list` invokes `tsx src/db/migrate.ts --list`, which still executes the migration-provider path. Because the step only passed `DATABASE_URL`, it ignored the exclusion list used by the preceding replay step and immediately retriggered `008_plugin_infrastructure.sql`.

### Users Schema Drift In CI Helpers

Two CI helpers assumed a newer `users` schema:

- `packages/core-backend/scripts/seed-rbac.ts`
- `packages/core-backend/tests/integration/after-sales-plugin.install.test.ts`

Both inserted explicit values for `is_active`, `is_admin`, and in one case `permissions` as `jsonb`. Replay/test environments can still expose the older SQL-created `users` table with only:

- `id`
- `email`
- `name`
- `password_hash`
- `role`
- `permissions` as `TEXT[]`
- timestamps

That mismatch caused:

- `column "is_admin" of relation "users" does not exist`
- `column "is_active" of relation "users" does not exist`

## Changes

### Workflow

Updated:

- `.github/workflows/migration-replay.yml`

Changes:

- added the full shared `MIGRATION_EXCLUDE` list to the `List migrations` step so `db:list` and `db:migrate` run with the same exclusion policy.

### CI/Test Helpers

Updated:

- `packages/core-backend/scripts/seed-rbac.ts`
- `packages/core-backend/tests/integration/after-sales-plugin.install.test.ts`

Changes:

- reduced user inserts to the minimal cross-schema column set:
  - `id`
  - `email`
  - `name`
  - `password_hash`
  - `role`
- removed explicit writes to:
  - `is_active`
  - `is_admin`
  - `permissions`
- kept `ON CONFLICT` updates restricted to the same compatible columns.

## Outcome

- `migration-replay` no longer has a separate unexcluded `db:list` path.
- `seed-rbac` and after-sales integration seeding are compatible with both the legacy SQL `users` table and the newer code-created shape.
- The remaining PR `#918` work stays focused on CI hardening around the already-validated Yjs rollout path.
