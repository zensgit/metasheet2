# PLM Audit External Scene-Context Takeover Verification

## Scope

验证外部 route 进入或切换 scene-context 时，现在会触发和本地 scene banner 一样的 takeover cleanup，并在需要时消费 stale `auditEntry=share` marker。

## Checks

- scene-context focused regression
- shared-entry / collaboration focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditSceneContext.spec.ts tests/plmAuditSceneContextTakeover.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused regression: `4` files / `74` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- PLM audit regression suite: `48` files / `318` tests passed

## Verified Outcome

- external route transitions into scene-context now trigger the same takeover cleanup as local scene banner actions
- stale collaboration draft / followup, saved-view attention, and management-owned form drafts no longer survive browser-driven scene-context pivots
- when an active shared-entry owner is cleared by the external scene takeover, the watcher now consumes the stale `auditEntry=share` marker so refresh cannot resurrect the old notice
