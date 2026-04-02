# PLM Audit Takeover Form Draft Cleanup Verification

## Scope

验证 management-owned team-view form drafts 在 `scene-context`、`saved-view`、`shared-entry` takeovers 中会被清掉，而 create-mode drafts 继续保留。

## Checks

- ownership + takeover focused regressions
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

- management-owned team-view name / owner drafts are cleared when non-management takeovers install scene, saved-view, shared-entry, or source-local-save ownership
- create-mode drafts stay intact because they have no management owner id
- canonical team-view management route changes continue to preserve name drafts under the existing ownership contract
