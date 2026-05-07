# DingTalk 治理工作台真人侧验收执行单导出

## 开发目标

- 给 142 真实环境最后一段必须人工参与的验收动作补一份固定执行单。
- 把成功登录样本、缺 openId 样本、公开表单、受保护表单、群机器人五类真人动作按顺序固定下来。
- 降低多人协作时“先测什么、测完怎么回填”的沟通成本。

## 实现说明

- 在 [UserManagementView.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/views/UserManagementView.vue) 新增 `导出真人侧验收执行单` 按钮。
- 新增 `exportGovernanceManualAcceptanceScript()`，导出内容包含：
  - 验收目标
  - 执行角色
  - 样本清单
  - 执行顺序
  - 机器侧参考
  - 结果回填
  - 关联文档
  - 当前建议

## 验证

```bash
pnpm --filter @metasheet/web exec vitest run tests/userManagementView.spec.ts tests/directoryManagementView.spec.ts --watch=false
git diff --check
```

## 预期结果

- 用户治理工作台可直接导出真人侧验收执行单 Markdown。
- `userManagementView.spec.ts` 覆盖新增按钮和关键执行字段。
- 目录治理测试不受影响，`git diff --check` 通过。
