# PLM Workbench Manual Query Takeover Verification

## 范围

验证 workbench manual-query drift 的基础判断合同，以及 view 集成后的编译稳定性。

## 回归

文件：[plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts)

新增断言：

1. `matches workbench snapshots while ignoring explicit team-view identity`
2. `detects workbench snapshot drift after manual query edits`

覆盖点：

- 比较时忽略显式 `workbenchTeamView` 身份键
- 手动把 `documentFilter` 从 `gear` 改成 `motor` 后，snapshot 会被判定为 drift

## 执行

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web type-check
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`1` 个文件，`7` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：manual-query drift 已具备稳定的纯函数判定，`PlmProductView` 也已接上 route-owner cleanup，不再持续保留陈旧 `workbenchTeamView` identity。
