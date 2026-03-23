# PLM Audit Clear-Default Draft Cleanup Verification

## Scope

验证 generic `Clear default` 现在会像其他 managed actions 一样清掉匹配 collaboration draft。

## Checks

- collaboration + clear-default focused regressions
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditSceneContextTakeover.spec.ts tests/plmAuditTeamViewRouteTakeover.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewAudit.spec.ts tests/plmAuditTeamViewRouteState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused regression: `7` files / `89` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- PLM audit regression suite: `48` files / `312` tests passed

## Verified Outcome

- generic `clear-default` now clears matching collaboration drafts through the same managed-action completion contract as other generic actions
- `clear-default` log routes still clear drafts even though `teamViewId` is reduced to `''`
- refresh `clear-selection` and `apply-view` takeovers continue to clear stale transient ownership without regressing user multi-select
