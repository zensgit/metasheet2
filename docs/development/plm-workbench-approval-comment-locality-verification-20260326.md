# PLM Workbench Approval Comment Locality Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchClient.spec.ts`
- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts`

This verifies:

- approvals team-view share URLs no longer include `approvalComment`
- approvals team-view payload normalization drops legacy `comment`
- approvals team-view save/apply flows only persist canonical approvals filter/sort/column state

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused approvals/workbench suites pass
- type-check passes
- full PLM frontend suite passes
