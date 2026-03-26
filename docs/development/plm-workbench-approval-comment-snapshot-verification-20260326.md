# PLM Workbench Approval Comment Snapshot Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`

This verifies:

- collaborative workbench snapshot normalization strips `approvalComment`
- workbench snapshot matching ignores differing approval comments
- workbench team-view share URLs exclude `approvalComment`

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts tests/usePlmTeamFilterPresets.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused workbench suites pass
- type-check passes
- full PLM frontend suite passes
