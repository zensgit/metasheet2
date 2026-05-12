# On-Prem Migration Bridge Package Verify Design

## Purpose

After issue `#651`, the Windows/on-prem package must not only contain SQL
files. It must contain the migration runtime policy that makes those files safe
to run on upgraded databases.

The previous package verification checked that `056` through `059` were present
inside the archive, but it did not prove that the package also included:

- the rebuilt migration provider with the superseded legacy SQL skip policy;
- the timestamp bridge that adds `users.must_change_password` after the modern
  `users` table exists;
- the guarded `056` SQL that no-ops when `users` has not been created yet.

Without those checks, a future package could pass verify while still carrying
the same class of migration failure seen on the entity machine.

## Change

`scripts/ops/multitable-onprem-package-verify.sh` now requires two additional
runtime files:

```text
packages/core-backend/dist/src/db/migration-provider.js
packages/core-backend/dist/src/db/migrations/zzzz20260512100000_add_users_must_change_password.js
```

It also validates the content contract:

- `migration-provider.js` contains the superseded legacy SQL opt-in
  `MIGRATION_INCLUDE_SUPERSEDED_LEGACY_SQL`;
- `migration-provider.js` contains a known skipped legacy migration name,
  `032_create_approval_records`;
- `056_add_users_must_change_password.sql` contains the `to_regclass` guard for
  absent `users` tables;
- the timestamp bridge migration contains `must_change_password`.

## Why Content Checks

Path checks alone only prove that a file with the right name exists. The
operator risk here is subtler: an archive built from the wrong SHA could include
the old `migration-provider.js` and still pass if the verifier only checked
generic runtime paths.

The content checks are intentionally small and stable. They avoid parsing
compiled JavaScript while still proving the package includes the specific
runtime migration policy needed by the K3 WISE on-prem deployment.

## Non-Goals

- No new database migration.
- No changes to K3 WISE adapter, setup page, or pipeline behavior.
- No change to package layout beyond stronger verification.
- No automatic deployment to the Windows/entity machine.

## Deployment Impact

Future Windows/on-prem package builds fail earlier if they omit the migration
bridge. This is a packaging quality gate only; it does not change runtime
behavior once the package is installed.
