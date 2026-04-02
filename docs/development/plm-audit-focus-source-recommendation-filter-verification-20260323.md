# PLM Audit Focus-Source Recommendation Filter Verification

## Scope

验证 collaboration `focus-source` 在来源不是 recommendation 时，会正确清掉旧的 recommendation filter，而不是把旧筛选芯片残留在页面上。

## Checks

- collaboration helper focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- `pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewCollaboration.spec.ts`
  - `1` file / `40` tests passed
- `pnpm --filter @metasheet/web type-check`
  - passed
- `pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`
  - `46` files / `298` tests passed

## Verified Outcome

- non-recommendation source-focus intents return `recommendationFilter: ''`
- recommendation source-focus intents still return the expected recommendation filter
- `focus-source` now clears stale recommendation filters when returning to saved views, scene context, or team-view controls
