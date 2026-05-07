# DingTalk 治理工作台最终交付包导出

## 开发目标

- 给当前 DingTalk 收尾阶段补一份最终 handoff 文件。
- 把 142 验收执行包、正式交付结论、对外同步、上线观察和归档索引收束成单文件入口。
- 让交付负责人只看一份导出物就能知道最后该怎么推进。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出最终交付包` 按钮。
- 新增 `exportGovernanceFinalHandoffPackage()`，导出内容包含：
  - 包内目录
  - 当前交付判断
  - 最终执行顺序
  - 关键入口
  - 最终回填要求
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出最终交付包 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键 handoff 字段。
- 目录治理测试不受影响，`git diff --check` 通过。
