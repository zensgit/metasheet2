# Yjs Internal Rollout Execution

Date: 2026-04-16

## Goal

Run the first limited internal rollout with two operator-visible checks:

1. runtime health from `GET /api/admin/yjs/status`
2. storage/retention health from PostgreSQL

Optional packet export:

```bash
node scripts/ops/export-yjs-rollout-packet.mjs
```

## Runtime Check

```bash
YJS_BASE_URL=http://localhost:3000 \
YJS_ADMIN_TOKEN=$ADMIN_TOKEN \
node scripts/ops/check-yjs-rollout-status.mjs
```

Expected:

- `enabled: true`
- `initialized: true`
- `flushFailureCount: 0`
- `pendingWriteCount` low and stable

## Retention Check

```bash
YJS_DATABASE_URL=$DATABASE_URL \
node scripts/ops/check-yjs-retention-health.mjs
```

Expected:

- `orphanStatesCount = 0`
- `orphanUpdatesCount = 0`
- `updatesCount` below the rollout threshold

## Recommended Sequence

1. Enable `ENABLE_YJS_COLLAB=true`
2. Restart the target service
3. Run `check-yjs-rollout-status.mjs`
4. Have pilot users open the selected test sheets
5. Run `check-yjs-rollout-status.mjs` again after live editing begins
6. Run `check-yjs-retention-health.mjs`
7. Optionally capture a rollout report artifact:

```bash
YJS_BASE_URL=http://localhost:3000 \
YJS_ADMIN_TOKEN=$ADMIN_TOKEN \
YJS_DATABASE_URL=$DATABASE_URL \
node scripts/ops/capture-yjs-rollout-report.mjs
```

8. If both checks stay healthy, keep the pilot enabled

## Abort Conditions

- runtime status reports `initialized: false`
- `flushFailureCount` keeps increasing
- `orphanStatesCount` or `orphanUpdatesCount` is non-zero
- `updatesCount` grows past the agreed pilot threshold

## Rollback

1. Set `ENABLE_YJS_COLLAB=false`
2. Restart the service
3. Re-run `check-yjs-rollout-status.mjs`
4. Keep DB data intact unless there is a separate cleanup decision
