# On-Prem Migration Gap Guard Development - 2026-05-14

## Summary

This slice adds a regression guard for the Windows/on-prem upgrade failure
reported from the K3 WISE deployment path.

The failed deployment was not a K3 adapter issue. It was a migration bridge
gap: packages built from the newer codebase still carried legacy numeric SQL
migrations, while the target database had already followed the timestamp-based
schema path. Replaying legacy migrations such as
`037_add_gallery_form_support` and `038_config_and_secrets` against that
database can fail on missing historical columns like `form_id` or `category`.

Current runtime behavior already no-ops superseded legacy SQL migrations by
default through `migration-provider.ts`. This work makes that contract harder
to regress by testing the two issue-facing migrations directly and by making
the on-prem package verifier assert the packaged provider still carries the
skip-list entries.

## Files Changed

- `packages/core-backend/tests/unit/migration-provider.test.ts`
  - Adds `038_config_and_secrets` to the superseded legacy SQL fixture.
  - Asserts `037_add_gallery_form_support` and `038_config_and_secrets`
    resolve as no-op markers by default.
  - Keeps the explicit audit opt-in path intact, so
    `includeSupersededLegacySqlMigrations: true` can still expose real SQL
    migrations for compatibility inspection.
- `scripts/ops/multitable-onprem-package-verify.sh`
  - Extends `verify_migration_bridge_contract()` to require
    `037_add_gallery_form_support` and `038_config_and_secrets` in the
    packaged migration provider skip list.
  - Verifies this development and verification note are present in the
    packaged zip.
- `scripts/ops/multitable-onprem-package-build.sh`
  - Includes this development and verification note in the Windows/on-prem
    release package.
- `docs/development/onprem-migration-gap-guard-verification-20260514.md`
  - Records the focused validation and deployment impact.

## Runtime Contract

Normal on-prem upgrades must not set:

```bash
MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL=true
```

With the default setting, superseded legacy SQL migrations stay visible to the
Kysely migration provider as marker names, but their `up()` functions do
nothing. That lets existing migration history remain understandable without
replaying legacy SQL against a newer schema.

The opt-in flag remains reserved for explicit compatibility audits. It is not a
normal deployment switch and should not be used to repair production upgrade
failures.

## Deployment Impact

- No database migration.
- No backend API change.
- No frontend change.
- No K3 WebAPI, SQL Server, Submit, or Audit behavior change.
- Package verification now fails earlier if the migration bridge guard is
  accidentally removed from the packaged backend.

## Issue Linkage

This guard addresses the class of deployment failures where a Windows/on-prem
package tries to replay legacy numeric SQL migrations against a database that
already contains the equivalent timestamp migration path. The specific cases
covered here are the `037` gallery/form migration and the `038`
config/secrets migration, matching the observed schema-gap pattern from issue
`#651`.
