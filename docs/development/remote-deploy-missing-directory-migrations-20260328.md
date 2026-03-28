# Remote Deploy Missing Directory Migrations

## Problem

`Build and Push Docker Images` on `main` now reaches the remote `migrate` stage, but the deploy fails with:

`previously executed migration zzzz20260323120000_create_user_external_identities is missing`

This is not a remote shell problem. The production database already recorded a directory migration chain that is absent from the current tracked repository state, so Kysely aborts before running any new migrations.

## Design

Use the smallest deploy-unblock that preserves migration history semantics:

1. Restore the already-executed directory migration files to tracked source control under their original names.
2. Restore the full contiguous executed chain that follows the first missing migration, not just the first file, so Kysely does not fail again on the next missing entry.
3. Do not pull in the larger untracked directory runtime feature surface. This PR only restores migration source files required for migration history parity.

## Scope

Restore these tracked migrations:

- `zzzz20260323120000_create_user_external_identities.ts`
- `zzzz20260323133000_harden_user_external_identities.ts`
- `zzzz20260324143000_create_user_external_auth_grants.ts`
- `zzzz20260324150000_create_directory_sync_tables.ts`
- `zzzz20260325100000_add_mobile_to_users_table.ts`
- `zzzz20260327110000_create_directory_template_center_and_alerts.ts`

## Why This Shape

- Restoring same-name real schema migrations matches the remote database history and satisfies Kysely's missing-migration guard.
- The files are idempotent and safe on fresh databases because they already use `ifNotExists`, helper guards, or additive DDL.
- A noop placeholder would unblock history checks but would silently break fresh-database installs and later migrations that depend on these tables.
