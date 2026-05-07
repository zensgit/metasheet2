# PLM Disabled Import Route Guard Verification - 2026-05-07

## Verification Plan

1. Run the focused PLM disable route unit test.
2. Confirm the new import-route case returns `404 FEATURE_DISABLED`.

## Commands

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-disable-routes.test.ts
```

## Expected Result

- PLM workbench route disabled test passes.
- PLM federation route disabled test passes.
- PLM import route disabled test passes.

## Result

Passed locally on 2026-05-07.

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-disable-routes.test.ts` passed.
- Result: 1 test file passed, 3 tests passed.
- Note: server construction logged existing BPMN workflow DB initialization errors for missing local database `chouhua`; the route assertions still passed and this was not caused by this PLM gate change.
