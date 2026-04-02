# PLM Team Scene Recommendation Verification

## Summary

This slice was verified at three levels:

- focused backend route/helper coverage
- focused frontend client/helper/panel coverage
- full `apps/web` package validation

## Focused Backend

Command:

```bash
TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp \
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/plm-workbench-team-views.test.ts \
  tests/unit/plm-workbench-routes.test.ts
```

Result:

- passed
- `2 files / 35 tests`

Coverage points:

- row mapper exposes `lastDefaultSetAt`
- list route hydrates default-set timestamps
- set-default response preserves timestamp
- clear-default response preserves latest set timestamp
- save-with-default response preserves timestamp

## Focused Frontend

Command:

```bash
TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp \
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/plmWorkbenchSceneCatalog.spec.ts \
  tests/plmWorkbenchClient.spec.ts \
  tests/usePlmProductPanel.spec.ts
```

Result:

- passed
- `3 files / 25 tests`

Coverage points:

- owner filter options are stable
- recommendation ranking prefers:
  - current default
  - recent default-set scenes
  - recent updates
- panel contract exposes enriched scene items
- client mapping preserves `lastDefaultSetAt`

## Full Web Package Validation

Commands:

```bash
TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp pnpm --filter @metasheet/web test
pnpm --filter @metasheet/web type-check
pnpm --filter @metasheet/web lint
pnpm --filter @metasheet/web build
```

Result:

- all passed

Notes:

- `pnpm --filter @metasheet/web test` passed with `34 files / 179 tests`
- Vitest still prints `WebSocket server error: Port is already in use`, but the suite passes

## Not Run

- No real `PLM UI regression` was run in this slice
- No backend integration/e2e validation was run because the change is limited to team-view response enrichment and frontend recommendation rendering

## Outcome

The workbench team scene catalog now has a stable recommendation signal, explicit card-level default-set timing, and a testable ranking policy without widening the PLM backend schema.
