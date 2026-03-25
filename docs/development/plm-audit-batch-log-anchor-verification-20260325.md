# PLM Audit Batch Log Anchor Verification

## 范围

验证批量 `archive / restore / delete` 之后的 batch audit log route 现在只会锚到真实 `processedIds`，不会误回退到 `eligibleIds`。

## 回归

新增/更新：

- [plmAuditTeamViewAudit.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewAudit.spec.ts)

覆盖点：

1. batch log state 继续使用第一个 processed view 作为 audit filter 锚点
2. 当 processed view 已从内存列表消失时，fallback 会退到 `processedIds`
3. fallback 不再从 `eligibleIds` 推断锚点

同时依赖：

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
- [plmAuditTeamViewAudit.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewAudit.ts)

## 执行

```bash
cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench
pnpm --filter @metasheet/web exec vitest run tests/plmAuditTeamViewAudit.spec.ts

pnpm --filter @metasheet/web type-check

cd /Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`1` 个文件，`8` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：batch lifecycle 跳转到 audit logs 时，route 锚点已经和真实 processed target 对齐，不会再让 skipped/eligible view 冒充 batch 处理结果。
