# PLM Audit Takeover Selector Alignment Verification

## Scope

验证 `scene-context`、source-aware local save、saved-view apply/context takeovers 现在会把本地 team-view selector 对齐到目标 route owner，而 `Apply` 继续保持 selector-first。

## Checks

- control-target focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts tests/plmAuditTeamViewRouteTakeover.spec.ts tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts tests/plmAuditTeamViewAudit.spec.ts tests/plmAuditTeamViewRouteState.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused regression: `6` files / `79` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- PLM audit regression suite: `48` files / `314` tests passed

## Verified Outcome

- non-apply takeovers now align `auditTeamViewKey` to the target route owner instead of preserving stale local selector state
- `Apply` keeps its selector-first contract because the change only affects takeover paths
- shared-entry refresh takeovers remain unchanged because `applyRouteState(...)` already rewrites selector state there
