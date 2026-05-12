# Legacy SQL Migration Skip Design

## Context

Windows/on-prem K3 WISE deployment exposed a systemic migration mismatch. The
core migration provider loads both modern timestamp migrations from
`packages/core-backend/src/db/migrations` and legacy numeric SQL migrations from
`packages/core-backend/migrations`.

Patching one legacy SQL file at a time is not a stable upgrade path. After
`037_add_gallery_form_support.sql` was guarded, deployment could still fail on
the next legacy core migration whose assumptions no longer match the current
timestamp migration schema.

## Decision

The provider now treats legacy numeric core SQL migrations `032` through `055`
as superseded by the modern timestamp migration stream. By default it keeps
their names visible to Kysely as no-op history markers instead of executing the
legacy SQL bodies.

The default skip list covers:

- approval/RBAC/spreadsheet/file/view core tables;
- config, data source, script sandbox, event bus, audit/cache, snapshot, and
  protection-rule legacy migrations;
- legacy users and attendance import token SQL migrations.

The provider still keeps the SQL migrations currently required by the on-prem
package path:

- `008_plugin_infrastructure.sql`
- `056_add_users_must_change_password.sql`
- `057_create_integration_core_tables.sql`
- `058_integration_runs_running_unique.sql`
- `059_integration_runs_history_index.sql`

`056_add_users_must_change_password.sql` is now guarded for fresh replay order.
If `users` does not exist yet, it no-ops instead of failing. A modern timestamp
bridge migration,
`zzzz20260512100000_add_users_must_change_password.ts`, adds the same column
after the timestamp users migration has created the table.

CI replay exclusions were also updated so
`20250924200000_create_event_bus_tables.ts` runs again. The previous exclusion
only made sense while replay depended on the legacy event-bus SQL path; with
legacy core SQL skipped by default, the modern event-bus migration must be the
source of `event_subscriptions` before the later runtime-schema alignment
migration runs.

## Operator Escape Hatch

For compatibility audits only, the provider accepts:

```bash
MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true
```

or the equivalent programmatic option:

```ts
createCoreBackendMigrationProvider({
  includeSupersededLegacySqlMigrations: true,
})
```

This is not the normal deployment mode. It exists so engineers can replay old
legacy SQL intentionally when diagnosing historical databases.

## Why This Shape

This keeps the package contents stable while changing runtime behavior where
the failure occurs. The package verifier can continue asserting that K3/on-prem
SQL migrations are present in the archive, while the migrator stops applying
legacy core migrations that have already been replaced by timestamp migrations.

Keeping no-op history markers is required for upgraded databases that already
have `032` through `055` in `kysely_migration`. Hiding those names completely
makes Kysely reject the database as a corrupted migration history even though
the runtime schema is healthy.

The approach avoids three bad outcomes:

- no more one-by-one emergency patching of obsolete SQL assumptions;
- no need to delete historical migration files from the repository or package;
- no loss of the recent K3/on-prem SQL migrations required for login and
  integration tables.

## Changed Files

- `packages/core-backend/src/db/migration-provider.ts`
- `packages/core-backend/migrations/056_add_users_must_change_password.sql`
- `packages/core-backend/src/db/migrations/zzzz20260512100000_add_users_must_change_password.ts`
- `packages/core-backend/tests/unit/migration-provider.test.ts`
- `packages/core-backend/tests/unit/users-must-change-password-migration.test.ts`
- `.github/workflows/migration-replay.yml`
- `.github/workflows/observability-e2e.yml`
- `.github/workflows/observability-strict.yml`
- `.github/workflows/plugin-tests.yml`
- `.github/workflows/safety-guard-e2e.yml`
- `packages/core-backend/MIGRATION_EXCLUDE_TRACKING.md`
- `docs/development/migration-legacy-sql-skip-design-20260512.md`
- `docs/development/migration-legacy-sql-skip-verification-20260512.md`

## Deployment Impact

This is a migration-provider policy change. It affects which pending migrations
are visible to `db:migrate` and `db:list`.

Existing databases that already applied any superseded legacy migration are not
rolled back and no longer trip Kysely's missing-provider corruption check. New
or upgraded on-prem databases should now follow the modern timestamp migration
stream plus the on-prem SQL tail (`056` and later); `032` through `055` are
recorded only as no-op superseded markers unless the explicit compatibility
audit flag is enabled.

## GATE Impact

This does not unlock true K3 WISE live push. Customer GATE requirements remain
unchanged. It only removes the current Windows/on-prem deployment blocker so the
K3 setup page and dry-run path can be tested again.
