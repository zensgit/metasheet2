# PLM Team Scene Recommendation Filter Verification

## Summary

This slice adds recommendation filtering to the workbench team scene catalog without changing backend APIs.

## Focused Validation

Command:

```bash
TMPDIR=/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/.tmp \
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/plmWorkbenchSceneCatalog.spec.ts \
  tests/usePlmProductPanel.spec.ts
```

Result:

- passed
- `2 files / 8 tests`

Coverage points:

- recommendation filtering works after owner filtering
- top-6 truncation still applies
- panel contract exposes recommendation filter options

## Full Web Validation

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

- `pnpm --filter @metasheet/web test` passed with `34 files / 180 tests`
- Vitest still prints `WebSocket server error: Port is already in use`, but the suite completes successfully

## Not Run

- no real `PLM UI regression`
- no backend-focused validation, because this slice is frontend-only
