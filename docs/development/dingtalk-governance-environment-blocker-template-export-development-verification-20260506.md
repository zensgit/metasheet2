# DingTalk 治理工作台环境阻塞记录模板导出

## 开发目标

- 给当前收尾阶段补一份专门记录环境侧阻塞的模板。
- 把授权组、组织范围、openId 数据缺口、群机器人配置等非代码问题从功能缺陷里单独分离出来。
- 方便交付结论明确区分“代码问题”和“环境阻塞”。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出环境阻塞记录模板` 按钮。
- 新增 `exportGovernanceEnvironmentBlockerTemplate()`，导出内容包含：
  - 适用范围
  - 当前基线
  - 阻塞记录
  - 已采取动作
  - 下一步
  - 关联文档
  - 关键入口
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出环境阻塞记录模板 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键字段。
- 目录治理测试不受影响，`git diff --check` 通过。
