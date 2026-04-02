# PLM Workbench Transfer Target Gating Verification

## 范围

验证 team-view transfer gating 已按 target 级别和提交级别拆分：

- 不可转移 target 会禁用 owner input 对应的 target capability
- 可转移 target 在 owner 草稿为空时仍允许编辑，但不会允许提交

## 回归

文件：[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/usePlmTeamViews.spec.ts)

新增/强化断言：

1. locked/archived target 下：
   - `canTransferTargetTeamView === false`
   - `canTransferTeamView === false`
2. transferable target 下：
   - owner 草稿为空时 `canTransferTargetTeamView === true`
   - owner 草稿为空或等于当前 owner 时 `canTransferTeamView === false`
   - owner 草稿为新 owner 时 `canTransferTeamView === true`

## 执行

```bash
pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts
pnpm --filter @metasheet/web type-check
```

## 结果

- focused：`1` 个文件，`42` 个测试通过
- `type-check`：通过

结论：transfer input 已按 target capability 正确 gating，提交按钮和输入框不再混用同一个可用性条件。
