# PLM Workbench Sparse Column Route Ownership Verification

## 范围

验证 `documents / approvals` panel route-owner 在 sparse `columns` 状态下不会误判 drift。

## 回归

文件：[plmTeamViewStateMatch.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmTeamViewStateMatch.spec.ts)

新增断言：

1. `mergePlmTeamViewBooleanMapDefaults(...)` 会把 sparse boolean map 正确展开到默认列配置上

同时依赖已有回归：

- [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 全量 `plm*.spec.ts + usePlm*.spec.ts`

## 执行

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmTeamViewStateMatch.spec.ts tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web type-check
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`10` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：`documents / approvals` 的 sparse `columns` 已不会再触发错误的 route-owner cleanup，只有真实列变更才会清理显式 ownership。
