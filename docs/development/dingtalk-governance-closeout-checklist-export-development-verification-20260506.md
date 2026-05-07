# DingTalk 治理工作台收尾检查单导出

## 开发目标

- 给当前交付阶段补一份真正面向“最后收尾动作”的清单。
- 把 142 联调回填、正式交付判断、归档和对外同步串成最后执行步骤。
- 降低收尾阶段因多人协作而出现的遗漏。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出收尾检查单` 按钮。
- 新增 `exportGovernanceCloseoutChecklist()`，导出内容包含：
  - 收尾目标
  - 必做项
  - 建议执行顺序
  - 输出物
  - 关键入口
  - 当前基线
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出收尾检查单 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键收尾字段。
- 目录治理测试不受影响，`git diff --check` 通过。
