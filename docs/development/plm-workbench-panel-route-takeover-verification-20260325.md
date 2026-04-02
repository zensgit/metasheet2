# PLM Workbench Panel Route Takeover Verification

## 范围

验证 shared panel-state matcher，以及 documents/cad/approvals route takeover 清理的基础合同。

## 回归

文件：[plmTeamViewStateMatch.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmTeamViewStateMatch.spec.ts)

新增断言：

1. 结构相同但对象键顺序不同的 panel state 仍视为匹配
2. 手动改动 panel query 字段后，state 会被判定为 drift

同时保留上一轮 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmWorkbenchViewState.spec.ts) 对 workbench route-owner drift 的纯函数覆盖。

## 执行

```bash
pnpm --filter @metasheet/web exec vitest run tests/plmTeamViewStateMatch.spec.ts tests/plmWorkbenchViewState.spec.ts
pnpm --filter @metasheet/web type-check
pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts
```

## 结果

- focused：`2` 个文件，`9` 个测试通过
- `type-check`：通过
- 全量：见本轮提交后的整体回归

结论：documents/cad/approvals 三条 panel route owner 已具备和 workbench 同级的 manual takeover 清理能力，不再长期保留陈旧 team-view identity。
