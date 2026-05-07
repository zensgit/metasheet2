# DingTalk 治理工作台试运行值班说明导出

## 开发目标

- 把“可试交付但尚在 142 联调验收中”的阶段性操作沉淀成页面可导出的 Markdown。
- 让值班、测试和运维可以直接从治理工作台取到试运行说明，而不是临时口头同步。
- 保持交付清单、142 验收清单、试运行说明三类文档导出风格一致。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 治理工作台新增 `导出试运行值班说明` 按钮。
- 新增 `exportGovernanceTrialRunbook()`，导出内容覆盖：
  - 适用阶段
  - 值班前准备
  - 值班入口
  - 值班检查项
  - 异常上报
  - 当日收口
  - 当前基线
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出试运行值班说明 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮与导出内容。
- 目录治理测试不受影响，`git diff --check` 通过。
