# PLM Audit Shared-Entry Refresh Selection Cleanup Verification

## Scope

验证 shared-entry refresh takeover 现在会清掉旧的 batch selection，不再让 shared-entry notice 和 batch lifecycle controls 并存。

## Checks

- shared-entry focused regression
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

- shared-entry refresh takeovers now clear stale batch selection before installing the new share-entry owner
- marker-only `auditEntry=share` query changes inherit the same cleanup because they resolve through `refreshAuditTeamViews()`
- shared-entry notice state remains intact while stale batch lifecycle controls disappear
