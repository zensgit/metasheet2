# PLM Audit External Lifecycle Log-Route Draft Cleanup Verification

## Scope

验证外部 route pivot / browser navigation 进入 ownerless lifecycle log route 时，现在会触发和本地 lifecycle 按钮相同的 management-owned form-draft cleanup。

## Checks

- team-view audit focused regression
- ownership + collaboration focused regression
- workspace type-check
- PLM audit regression suite

## Commands

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewAudit.spec.ts tests/plmAuditTeamViewOwnership.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## Results

- focused regression: `3` files / `60` tests passed
- `pnpm --filter @metasheet/web type-check`: passed
- PLM audit regression suite: `48` files / `316` tests passed

## Verified Outcome

- external route pivots into ownerless lifecycle/default-log routes now clear management-owned team-view name and owner drafts just like the local lifecycle buttons
- ordinary owner changes still keep name drafts because the new predicate only matches `clear-default`, `archive`, `restore`, and `delete` ownerless log routes
- `set-default` followup ownership is unchanged because it is intentionally excluded from the lifecycle-log predicate
