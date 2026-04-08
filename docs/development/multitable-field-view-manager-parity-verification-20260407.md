# Multitable Field/View Manager Parity Verification

## Date
- 2026-04-07

## Commands
```bash
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/multitable-sheet-permissions.api.test.ts
pnpm --filter @metasheet/core-backend build
pnpm lint
pnpm type-check
```

## Results
- `multitable-sheet-permissions.api.test.ts`: passed (`31/31`)
- `pnpm --filter @metasheet/core-backend build`: passed
- `pnpm lint`: passed
- `pnpm type-check`: passed

## Verified Behaviors
- `spreadsheet:read` without global multitable permission can list fields and views.
- `spreadsheet:write` without global multitable permission can:
  - surface `canManageFields/canManageViews` in context
  - list fields/views
  - create/update fields
  - prepare people field presets
  - create/update views
- `spreadsheet:write-own` remains record-scoped and does not gain schema management.
- Sheet delete remains outside this parity slice and is still blocked without the global route-level write permission.
