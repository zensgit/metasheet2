# Yjs r4 Rollout And Migration Provider Hardening Development

Date: 2026-04-19

## Scope

This work package covered two linked concerns:

1. publish and validate a fresh Yjs rollout image from the latest `main`;
2. harden the backend migration entrypoint after the remote rollout exposed that SQL migrations in `packages/core-backend/migrations/` were not being loaded by `migrate.js`.

## Release And Deployment Work

- Built and pushed fresh amd64 images from latest `main`:
  - `ghcr.io/zensgit/metasheet2-backend:20260419-yjs-rollout-r4`
  - `ghcr.io/zensgit/metasheet2-web:20260419-yjs-rollout-r4`
- Verified pushed manifests after publish:
  - backend index digest: `sha256:fb6ee54572e9f360bfa4fb871d9fdb96b01ced38cbbd2722f44ce64a22756c80`
  - backend amd64 digest: `sha256:ed4e2d69cb8de656d5d8146f40538a9360669e80d8235329902d7f1054c8a441`
  - web index digest: `sha256:07d9acaff67416cb33c3a0b1a36f254bd85c561ffa9ec32d07ea31ea5e9c5f18`
  - web amd64 digest: `sha256:f5b64d429b4bc6e0b2b676647319d6255ecc81a97742cde26050c39586557d8d`
- Updated remote host `142.171.239.56` to `IMAGE_TAG=20260419-yjs-rollout-r4`.
- Recreated backend/web containers with `docker compose -f docker-compose.app.yml pull` and `up -d`.
- Ran the normal migration entrypoint:
  - `docker compose -f docker-compose.app.yml exec -T backend node packages/core-backend/dist/src/db/migrate.js`

## Remote Issue Found

The remote deploy exposed a real production gap:

- `migrate.js` exited successfully;
- the deployed schema still lacked `users.must_change_password`;
- auth verification then failed because runtime queries selected that column.

Root cause:

- the migration runner only loaded migrations from `packages/core-backend/src/db/migrations`;
- it did not load legacy SQL migrations under `packages/core-backend/migrations`;
- `056_add_users_must_change_password.sql` therefore never ran through the normal entrypoint.

To finish remote validation without blocking the rollout, the missing column was added manually on the remote database:

```sql
ALTER TABLE users
ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
```

The verification artifact for that manual schema fix was captured locally under:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/manual-schema-fix.stdout.txt`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/manual-schema-fix.stderr.txt`

## Code Hardening

Added a new migration provider helper:

- `packages/core-backend/src/db/migration-provider.ts`

The helper now:

- loads code migrations from the current runtime `migrations` folder;
- loads SQL migrations from the same folder when present;
- loads legacy SQL migrations from package-level `migrations/`;
- supports both source-style runtime paths and built `dist/src/db` runtime paths;
- fails fast on duplicate migration names.

Updated:

- `packages/core-backend/src/db/migrate.ts`

So the normal backend migration entrypoint now uses the combined provider instead of only `FileMigrationProvider` against `src/db/migrations`.

## Files Changed

- `packages/core-backend/src/db/migration-provider.ts`
- `packages/core-backend/src/db/migrate.ts`
- `packages/core-backend/tests/unit/migration-provider.test.ts`
- `docs/development/yjs-r4-rollout-and-migration-provider-hardening-development-20260419.md`
- `docs/development/yjs-r4-rollout-and-migration-provider-hardening-verification-20260419.md`

## Operational Artifacts

Local rollout evidence was captured under:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/`

Key generated files:

- `status.json`
- `retention.json`
- `report/yjs-rollout-report-2026-04-19T02-58-34-616Z.{json,md}`
- `gate/reports/yjs-rollout-report-2026-04-19T02-58-38-313Z.{json,md}`
- `gate/yjs-internal-rollout-signoff.md`

## Outcome

- Yjs `r4` automation baseline is healthy on the remote host.
- The rollout also identified and now patches a real migration-loader gap that would otherwise recur on the next environment that relies on `packages/core-backend/migrations/*.sql`.
