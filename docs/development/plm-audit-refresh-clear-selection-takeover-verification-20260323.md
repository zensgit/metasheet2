# PLM Audit Refresh Clear-Selection Takeover Verification

## Scope

验证 `refreshAuditTeamViews()` 在清掉失效 `teamViewId` 时，现在会像其他 takeovers 一样回收 stale transient ownership。

## Checks

- refresh clear-selection takeover focused regression
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

- refresh-driven `clear-selection` now clears stale attention / notice / ownership before local route apply
- stale shared-entry and saved-view local notice no longer survive when an archived or unavailable team view is cleared
- user multi-select remains intact because only draft-owned single-row selection is consumed
