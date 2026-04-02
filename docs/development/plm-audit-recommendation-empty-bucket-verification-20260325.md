# PLM Audit Recommendation Empty Bucket Verification

## 范围

验证推荐审计团队视图区在 active filter bucket 为空时，仍然保留 chips 和恢复入口。

## 回归

新增/强化回归：

- [plmAuditTeamViewCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCatalog.spec.ts)

覆盖点：

1. `recent-default` bucket 为 `0` 时，summary chips 仍然保留
2. `shouldShowAuditTeamViewRecommendations(chips)` 在 “active bucket = 0，但其它 bucket 仍有内容” 时返回 `true`

同时依赖：

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plmAuditTeamViewCatalog.spec.ts tests/plmApprovalActionability.spec.ts tests/usePlmAuthStatus.spec.ts

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`3` 个文件，`16` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：推荐区在 `0` 结果 bucket 下不会再整体消失，用户始终保留 chips 和“切回全部推荐”的恢复入口。
