# PLM Audit Kind Selector Contract Verification

## 范围

验证 `PLM Audit` 的 Kind selector 现在会把 `audit` 作为一等选项暴露出来，和 route/state 合同一致。

## 回归

新增：

- [plmAuditFilterOptions.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditFilterOptions.spec.ts)

覆盖点：

1. `PLM_AUDIT_KIND_OPTIONS` 包含 `audit`
2. `PlmAuditView.vue` 消费共享 options，不再手写缺项的列表

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditFilterOptions.spec.ts tests/plmAuditTeamViewAudit.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：见本轮提交后的回归结果
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：Kind selector 已经能够正确表达 `audit` 这一合法 route/state 值，不再出现日志态可恢复、但 UI 不可表示的分叉。
