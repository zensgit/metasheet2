# DingTalk 治理工作台 142 验收执行包导出

## 开发目标

- 把 142 验收前已经具备的机器探针、真人侧执行单、上线观察和交付结论收束成一个单文件执行包。
- 让执行人不需要在多份 Markdown 间来回切换，直接按一个文件完成 142 验收推进。
- 把当前机器侧结论提前写进包里，减少重复整理。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出 142 验收执行包` 按钮。
- 新增 `exportGovernance142AcceptancePackage()`，导出内容包含：
  - 包内目录
  - 当前机器侧结论
  - 142 真人侧执行顺序
  - 关键入口
  - 回填要求
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出 142 验收执行包 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键包内字段。
- 目录治理测试不受影响，`git diff --check` 通过。
