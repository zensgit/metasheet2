# PLM Workbench Collaborative Local Preset Snapshot Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`

This verifies:

- collaborative workbench query normalization strips local preset ownership keys
- snapshot matching ignores browser-local preset ids
- shared workbench team view URLs serialize concrete filter state without local preset ids

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused workbench state suite passes
- type-check passes
- full PLM frontend suite passes
