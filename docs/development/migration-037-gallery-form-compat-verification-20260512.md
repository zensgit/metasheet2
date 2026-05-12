# Migration 037 Gallery/Form Compatibility Verification

## Scope

Verify the fix for the on-prem migration failure where
`037_add_gallery_form_support.sql` referenced `form_responses.form_id` on a
database whose `form_responses` table had already been created by the
timestamp-based view migrations.

## Static Regression Tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/gallery-form-sql-migration.test.ts --reporter=dot
```

Result:

```text
Test Files  1 passed (1)
Tests       4 passed (4)
```

The test asserts:

- `view_configs` optional indexes and demo seed rows are guarded by column
  existence.
- `idx_form_responses_form_id` is only created after a
  `form_responses.form_id` column-existence guard.
- other `form_responses` legacy indexes are guarded by their target columns.
- `idx_view_states_user` is only created after a `view_states.user_id` guard.
- `update_view_states_updated_at` is only created after a
  `view_states.updated_at` column-existence guard.
- Optional comments on `view_states.state_data` and
  `form_responses.response_data` are column-guarded.

## Related Migration Unit Tests

Command:

```bash
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/plugin-infrastructure-sql-migration.test.ts \
  tests/unit/gallery-form-sql-migration.test.ts \
  tests/unit/migration-provider.test.ts \
  --reporter=dot
```

Result:

```text
Test Files  3 passed (3)
Tests       12 passed (12)
```

This keeps the new 037 guard coverage adjacent to the existing SQL migration
guard tests and confirms the migration provider still loads SQL migrations from
the package paths.

## Real Postgres Rehearsal

Local Postgres was available on `localhost:5432`. I created a throwaway
database, recreated the timestamp-based `view_states` and `form_responses`
shape, applied 037, then dropped the throwaway database.

Setup shape:

```text
form_responses(id, view_id, data, submitted_by, ip_address, user_agent, submitted_at, status)
view_states(id, view_id, user_id, state, last_accessed, updated_at)
```

Command:

```bash
psql -h localhost -p 5432 -d "$db" -v ON_ERROR_STOP=1 \
  -f packages/core-backend/migrations/037_add_gallery_form_support.sql
```

Result:

```text
view_configs=1
form_id_column=0
form_id_index=0
submitted_by_index=1
view_state_trigger=1
view_config_seeds=2
```

Conclusion: 037 now succeeds against the mixed-history shape that previously
failed. The migration does not add `form_id` to a timestamp-shaped table; it
simply skips the incompatible index and continues creating compatible indexes
and triggers.

## Narrow view_configs Rehearsal

I created a throwaway database with a deliberately narrow `view_configs(id)`
table, applied 037, then dropped the database.

Result:

```text
seed_shape_guard_columns=0
seed_rows=0
```

Conclusion: if a deployment already has a non-037 `view_configs` table shape,
037 now skips the gallery/form demo seed rows instead of referencing missing
`name/type/description/config_data/created_by` columns.

## Fresh-schema Rehearsal

I also applied 037 twice to an empty throwaway database to verify the original
fresh-install path and idempotency still work.

Result:

```text
view_configs=1
form_id_column=1
form_id_index=1
response_data_column=1
view_configs_seed_rows=2
```

Conclusion: fresh installs still get the original 037 table shape and seed
records, and re-running the migration remains safe.

## Manual Rehearsal Plan for On-prem or CI

When a Postgres instance is available, reproduce the old schema and apply 037:

1. Create `form_responses` in timestamp migration shape:

   ```text
   id, view_id, data, submitted_by, ip_address, user_agent, submitted_at, status
   ```

2. Apply:

   ```bash
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/core-backend/migrations/037_add_gallery_form_support.sql
   ```

3. Expected result:

   ```text
   migration succeeds
   form_responses.form_id remains absent if it was absent before
   idx_form_responses_form_id remains absent when form_id is absent
   idx_form_responses_submitted_by exists when submitted_by exists
   ```

## Diff Hygiene

Command:

```bash
pnpm --filter @metasheet/core-backend exec tsc --noEmit
```

Result:

```text
passed
```

Note: the first `tsc --noEmit` attempt failed because this worktree was missing
the `nodemailer` dependency link declared in `packages/core-backend/package.json`
and `pnpm-lock.yaml`. Running `pnpm install --ignore-scripts` restored the
workspace link; dependency symlink dirt under `plugins/` and `tools/` was then
reverted before commit.

Command:

```bash
git diff --check
```

Result:

```text
no whitespace errors
```

## Build Check

Command:

```bash
pnpm --filter @metasheet/core-backend build
```

Result:

```text
src/services/NotificationService.ts(7,24): error TS2307:
Cannot find module 'nodemailer' or its corresponding type declarations.
```

Local diagnosis:

```text
node_modules/nodemailer: not present
packages/core-backend/node_modules/nodemailer: not present
```

Conclusion: the local checkout is missing the `nodemailer` dependency install.
This blocks a local build in this workspace but is unrelated to the migration SQL
change. The targeted Vitest suites and real Postgres migration rehearsals above
are the relevant gates for this fix.

## Deployment Readiness

This change is ready for PR/CI. After merge, a new Windows on-prem package
should be generated before retrying the customer/entity-machine deployment.
