# PLM Audit Canonical Owner And Return Access Verification

## Verified Changes

- generic team-view controls 现在会在 `route.teamViewId` 为空但 collaboration followup 仍然 active 时，继续锁到 followup 所有的 canonical team view。
- `Apply filters`、`Reset filters`、分页不再把未 `Apply` 的 Team views 下拉选择写回 canonical route。
- `shared-entry` dismiss / takeover 只消费 `auditEntry=share`，不会顺手提交本地筛选或 selector 草稿。
- `returnToPlmPath` 在 scene banner 消失后仍然通过顶部 CTA 保持可访问。

## Focused Validation

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check
```

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewControlTarget.spec.ts tests/plmAuditReturnToScene.spec.ts tests/plmAuditTeamViewShareEntry.spec.ts tests/plmAuditTeamViewCollaboration.spec.ts
```

Actual result:

- `type-check` passed
- focused Vitest run passed with `4` files and `53` tests

## Full Regression

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

Actual result:

- full PLM frontend regression passed
- `45` files and `276` tests passed

## Residual Risk

- 这轮没有引入 Vue component test harness，页面级 return CTA 仍然主要靠纯 helper 回归和全量类型/单测链守住。
- 若后续继续扩展 canonical owner 语义，优先沿 `plmAuditTeamViewControlTarget.ts` 统一，而不是在 `PlmAuditView.vue` 里新增局部分支。
