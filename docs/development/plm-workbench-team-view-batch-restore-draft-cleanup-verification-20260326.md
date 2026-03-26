# PLM Workbench Team View Batch Restore Draft Cleanup Verification

## Coverage

Focused coverage lives in:

- `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts`

This verifies:

- batch restore reapplies the explicit team view id
- stale `teamViewName` and `teamViewOwnerUserId` drafts are cleared after restore

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
