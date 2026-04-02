# PLM Workbench Stale Route Owner Refresh Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts`

This verifies:

- refresh clears `requestedViewId` when the same id survives but loses applyability
- the local selector remains on the pending target
- management actions are no longer hidden behind stale pending state

## Commands

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Expected Result

- focused team view suite passes
- type-check passes
- full PLM frontend suite passes
