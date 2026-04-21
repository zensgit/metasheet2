# Yjs Migration Exclude And CI Hardening Development

Date: 2026-04-19

## Scope

This work package hardens the follow-up to Yjs rollout `r4` after PR `#918` exposed three CI regressions:

1. the new combined migration provider no longer honored `MIGRATION_EXCLUDE`;
2. the migration-provider unit test used ESM fixture files with a `.js` extension, which broke under CI's CommonJS interpretation path;
3. the plugin test workflow still ran database migrations without the documented exclusion list, so it reintroduced known legacy migration conflicts.

## Problem Summary

After `fix(db): load legacy sql migrations in migrate entrypoint`, three checks failed on PR `#918`:

- `migration-replay`
- `observability-e2e`
- `Plugin System Tests`

The first two failures shared the same root cause:

- `MIGRATION_EXCLUDE` was no longer being applied by `createCoreBackendMigrationProvider()`;
- excluded legacy migrations such as `20250924120000_create_views_view_states.ts` ran again;
- replay environments then hit duplicate or incompatible schema state.

The plugin workflow had an additional problem:

- `packages/core-backend/tests/unit/migration-provider.test.ts` wrote fixture files as `.js` with `export async function up() {}`;
- GitHub Actions executed those fixtures in a CommonJS path and failed with `SyntaxError: Unexpected token 'export'`.

## Code Hardening

Updated:

- `packages/core-backend/src/db/migration-provider.ts`

Changes:

- added optional `excludedNames` to `createCoreBackendMigrationProvider()`;
- restored environment-driven exclusions through `process.env.MIGRATION_EXCLUDE`;
- normalized excluded names by basename and extension so either
  - `056_add_users_must_change_password.sql`
  - `056_add_users_must_change_password`
  can exclude the same migration;
- applied filtering after the combined code + SQL migration map is assembled.

## Test Hardening

Updated:

- `packages/core-backend/tests/unit/migration-provider.test.ts`

Changes:

- switched ESM code fixtures from `.js` to `.mjs`;
- added a regression test that proves exclusion works when names are passed with mixed extensions, matching `MIGRATION_EXCLUDE` style input.

## Workflow Hardening

Updated:

- `.github/workflows/plugin-tests.yml`

Changes:

- added the documented `MIGRATION_EXCLUDE` list to both `Run DB migrations` steps;
- aligned plugin CI with the same migration exclusions already required by replay/observability paths.

## Files Changed

- `.github/workflows/plugin-tests.yml`
- `packages/core-backend/src/db/migration-provider.ts`
- `packages/core-backend/tests/unit/migration-provider.test.ts`
- `docs/development/yjs-migration-exclude-and-ci-hardening-development-20260419.md`
- `docs/development/yjs-migration-exclude-and-ci-hardening-verification-20260419.md`

## Outcome

- The combined migration provider now preserves the intended rollout hardening from `MIGRATION_EXCLUDE`.
- CI test fixtures no longer depend on ambiguous `.js` ESM behavior.
- Plugin workflow migration execution is aligned with the repo's known legacy-migration exclusion policy.
