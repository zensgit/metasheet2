# DingTalk 治理工作台正式交付结论导出

## 开发目标

- 在治理工作台补齐最后一份面向交付负责人的结论文档。
- 把交付清单、142 联调验收、试运行值班和完整联调包收束到一个 go/no-go 模板。
- 降低“口头判断可否交付”的不确定性，让最终结论可归档、可转发、可追责。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出正式交付结论` 按钮。
- 新增 `exportGovernanceDeliveryDecision()`，导出内容包含：
  - 结论类型
  - 依据文档
  - 当前基线
  - 关键链路结论
  - 环境侧结论
  - 风险与阻塞
  - 建议动作
  - 关键入口
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出正式交付结论 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键字段。
- 目录治理测试不受影响，`git diff --check` 通过。
