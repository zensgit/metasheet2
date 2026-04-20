# DingTalk Notify Deploy Development - 2026-04-19

## Summary

Deployed the DingTalk notification features from `#919` and `#920` to the remote host, then fixed a migration-provider gap that blocked production migrations from recognizing SQL files under `packages/core-backend/src/db/migrations`.

## Problem Found During Deploy

The remote database already contained later schema state, but `kysely_migration` was missing a block of historical entries. After ledger backfill, `migrate.js` still failed because:

- `20250925_create_view_tables.sql`
- `20250926_create_audit_tables.sql`

were present in the image source tree at `/app/packages/core-backend/src/db/migrations`, but the runtime migration provider only searched:

- `dist/src/db/migrations`
- `dist/migrations`
- `packages/core-backend/migrations`

That made Kysely treat the existing ledger rows as corrupted.

## Code Changes

Updated `packages/core-backend/src/db/migration-provider.ts` to treat `../../../src/db/migrations` as a SQL-only candidate folder when running from `dist/src/db`.

Key constraint:

- the source-tree folder is added only for raw `.sql` discovery
- it is not passed through `FileMigrationProvider`, so runtime does not try to import source `.ts` migrations

Updated `packages/core-backend/tests/unit/migration-provider.test.ts` to cover the dist-runtime case where:

- code migrations come from `dist/src/db/migrations`
- SQL migrations come from `src/db/migrations`
- legacy SQL migrations come from `packages/core-backend/migrations`

## Remote Deployment Work

1. Confirmed the remote host was already running the merged DingTalk notify mainline image from `453d16341...`.
2. Compared local migration stems to remote `kysely_migration`.
3. Backfilled 33 historical replay-debt migration names into `kysely_migration` without replaying old SQL.
4. Built and pushed amd64 images from hotfix commit `8060c596970b59b0e2b6360297af1332b63db7f6`:
   - `ghcr.io/zensgit/metasheet2-backend:8060c596970b59b0e2b6360297af1332b63db7f6`
   - `ghcr.io/zensgit/metasheet2-web:8060c596970b59b0e2b6360297af1332b63db7f6`
5. Updated remote `.env`:
   - `IMAGE_TAG=8060c596970b59b0e2b6360297af1332b63db7f6`
   - removed stale host-side `MIGRATION_EXCLUDE`
6. Recreated `backend` and `web`.
7. Ran `node packages/core-backend/dist/src/db/migrate.js`.
8. Verified the five DingTalk notification migrations executed successfully.

## Scope Deployed

This deploy includes:

- DingTalk group destination CRUD
- `send_dingtalk_group_message`
- DingTalk group delivery history
- `send_dingtalk_person_message`
- person recipient picker / delivery history support
- migration-provider hotfix for source SQL migrations during dist runtime

## Notes

- The remote repo checkout on the host is still on the previously merged main commit `453d16341...`.
- The running containers are now on hotfix image tag `8060c596970b59b0e2b6360297af1332b63db7f6`.
- A follow-up PR is required so `main` matches the deployed runtime again.
