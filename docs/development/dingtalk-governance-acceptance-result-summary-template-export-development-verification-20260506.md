# DingTalk 治理工作台验收结果汇总模板导出

## 开发目标

- 给 142 真人侧验收结束后的结果整理补一页统一汇总模板。
- 把样本结果、机器探针、风险阻塞和最终结论汇总到一份 Markdown。
- 方便直接转给交付负责人或作为最终归档首页。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出验收结果汇总模板` 按钮。
- 新增 `exportGovernanceAcceptanceResultSummaryTemplate()`，导出内容包含：
  - 汇总目标
  - 当前基线
  - 样本结果汇总
  - 机器探针结论
  - 风险与阻塞
  - 最终结论
  - 关联文档
  - 关键入口
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出验收结果汇总模板 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键汇总字段。
- 目录治理测试不受影响，`git diff --check` 通过。
