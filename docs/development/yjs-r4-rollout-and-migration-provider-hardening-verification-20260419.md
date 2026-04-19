# Yjs r4 Rollout And Migration Provider Hardening Verification

Date: 2026-04-19

## Local Build And Test Verification

Executed from the clean worktree:

```bash
pnpm install --frozen-lockfile
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/yjs-cleanup.test.ts --watch=false
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/migration-provider.test.ts tests/unit/migrations.rollback.test.ts tests/unit/db.test.ts --watch=false
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
pnpm exec node --input-type=module -e "import path from 'node:path'; import { pathToFileURL } from 'node:url'; const moduleUrl = pathToFileURL(path.resolve('packages/core-backend/dist/src/db/migration-provider.js')).href; const { createCoreBackendMigrationProvider } = await import(moduleUrl); const runtimeDir = path.resolve('packages/core-backend/dist/src/db'); const provider = createCoreBackendMigrationProvider({ runtimeDir }); const migrations = await provider.getMigrations(); console.log(JSON.stringify({ hasMustChangePassword: Boolean(migrations['056_add_users_must_change_password']), hasYjsTables: Boolean(migrations['zzzz20260501100000_create_yjs_state_tables']), total: Object.keys(migrations).length }, null, 2));"
```

Results:

- `tests/unit/yjs-cleanup.test.ts`: `5 passed`
- `tests/unit/migration-provider.test.ts` + `tests/unit/migrations.rollback.test.ts` + `tests/unit/db.test.ts`: `20 passed`
- backend build: passed
- web build: passed
- built provider runtime check:
  - `hasMustChangePassword: true`
  - `hasYjsTables: true`
  - `total: 134`

## GHCR Publish Verification

Images published successfully:

- `ghcr.io/zensgit/metasheet2-backend:20260419-yjs-rollout-r4`
- `ghcr.io/zensgit/metasheet2-web:20260419-yjs-rollout-r4`

Manifest verification:

- backend index digest: `sha256:fb6ee54572e9f360bfa4fb871d9fdb96b01ced38cbbd2722f44ce64a22756c80`
- backend amd64 digest: `sha256:ed4e2d69cb8de656d5d8146f40538a9360669e80d8235329902d7f1054c8a441`
- web index digest: `sha256:07d9acaff67416cb33c3a0b1a36f254bd85c561ffa9ec32d07ea31ea5e9c5f18`
- web amd64 digest: `sha256:f5b64d429b4bc6e0b2b676647319d6255ecc81a97742cde26050c39586557d8d`

## Remote Deployment Verification

Remote target:

- host: `mainuser@142.171.239.56`
- project: `/home/mainuser/metasheet2`
- deployed tag: `20260419-yjs-rollout-r4`

Deployment evidence:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/deploy.stdout.txt`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/deploy.stderr.txt`

Observed:

- `.env` updated to `IMAGE_TAG=20260419-yjs-rollout-r4`
- backend/web images pulled and recreated successfully
- normal migration entrypoint exited `0`

## Remote Schema Fix Verification

Manual patch evidence:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/manual-schema-fix.stdout.txt`

Recorded result:

```json
[
  {
    "column_name": "must_change_password",
    "data_type": "boolean",
    "is_nullable": "NO",
    "column_default": "false"
  }
]
```

## Remote Rollout Validation Verification

Executed on remote after the schema fix:

- `check-yjs-rollout-status.mjs`
- `check-yjs-retention-health.mjs`
- `capture-yjs-rollout-report.mjs`
- `run-yjs-rollout-gate.mjs`

Evidence:

- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/status.json`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/retention.json`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/report/yjs-rollout-report-2026-04-19T02-58-34-616Z.json`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/report/yjs-rollout-report-2026-04-19T02-58-34-616Z.md`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/reports/yjs-rollout-report-2026-04-19T02-58-38-313Z.json`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/reports/yjs-rollout-report-2026-04-19T02-58-38-313Z.md`
- `output/yjs-rollout/remote-yjs-rollout-r4-20260419-104604/gate/yjs-internal-rollout-signoff.md`

Key results:

- runtime status: `HEALTHY`
- `enabled: true`
- `initialized: true`
- `activeDocCount: 0`
- `pendingWriteCount: 0`
- `flushFailureCount: 0`
- retention status: `HEALTHY`
- `statesCount: 0`
- `updatesCount: 0`
- `orphanStatesCount: 0`
- `orphanUpdatesCount: 0`
- report failures: none
- gate failures: none

## Conclusion

- The automated Yjs rollout baseline on `r4` is healthy after deployment.
- The environment is ready for the next step: `30-60` minutes of human collaborative trial.
- A real migration-loader defect was confirmed and is now covered by code and tests, but the already-running remote environment still required the one-time manual schema patch documented above.
