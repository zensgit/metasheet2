# PLM Audit Lifecycle Draft Cleanup Verification

## Scope

验证 single/batch lifecycle actions 现在会清掉命中的 collaboration draft，同时保留用户手动多选。

## Checks

- collaboration + lifecycle focused regressions
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewRouteTakeover.spec.ts tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewAudit.spec.ts tests/plmAuditTeamViewRouteState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused regression: `5` files / `70` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- PLM audit regression suite: `48` files / `313` tests passed

## Verified Outcome

- single lifecycle actions now clear matching generic collaboration drafts before they pivot to audit-log routes
- batch lifecycle actions clear matching drafts when `processedTeamViewIds` include the draft target
- user multi-select stays intact because only draft-owned single-row selection is consumed
