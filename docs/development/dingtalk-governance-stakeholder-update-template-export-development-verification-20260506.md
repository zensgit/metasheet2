# DingTalk 治理工作台对外同步模板导出

## 开发目标

- 给交付末期补一份可直接发给测试、运维、业务和项目负责人的同步模板。
- 把交付结论、当前基线、阻塞项和附件文档整理成统一口径。
- 减少收尾阶段重复整理“今天到底完成了什么、还差什么”的沟通成本。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出对外同步模板` 按钮。
- 新增 `exportGovernanceStakeholderUpdateTemplate()`，导出内容包含：
  - 同步对象
  - 今日结论
  - 关键状态
  - 已完成事项
  - 风险与阻塞
  - 附件与文档
  - 关键入口
  - 建议下一步
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出对外同步模板 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键同步字段。
- 目录治理测试不受影响，`git diff --check` 通过。
