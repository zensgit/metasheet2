# DingTalk 治理工作台当前验收就绪快照导出

## 开发目标

- 在真人侧验收开始前，提供一页“当前是否已经准备好开测”的快照。
- 把代码侧完成度、机器探针覆盖度、真人侧剩余动作和现场检查项集中到一份 Markdown。
- 减少开测前来回确认“现在到底还差什么”的沟通成本。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出当前验收就绪快照` 按钮。
- 新增 `exportGovernanceAcceptanceReadinessSnapshot()`，导出内容包含：
  - 当前就绪判断
  - 当前基线
  - 已准备好的执行物
  - 现场开测前检查
  - 下一步顺序
  - 关键入口
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出当前验收就绪快照 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键就绪字段。
- 目录治理测试不受影响，`git diff --check` 通过。
