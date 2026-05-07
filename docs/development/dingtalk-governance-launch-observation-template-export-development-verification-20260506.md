# DingTalk 治理工作台上线观察记录模板导出

## 开发目标

- 给试运行和正式放量后的观察窗口补一份统一记录模板。
- 让登录、目录同步、公共表单、群机器人四类关键链路在观察期内有可回填的事实记录。
- 让交付结论不仅停留在“当天验收通过”，还能覆盖上线后的稳定性观察。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出上线观察记录模板` 按钮。
- 新增 `exportGovernanceLaunchObservationTemplate()`，导出内容包含：
  - 观察窗口
  - 关键指标
  - 观察项
  - 异常记录
  - 结论
  - 关联文档
  - 关键入口
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出上线观察记录模板 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键观察字段。
- 目录治理测试不受影响，`git diff --check` 通过。
