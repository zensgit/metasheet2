# Workflow Hub Restore / Runtime Schema 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 新增 [zzzz20260309103000_create_workflow_designer_support_tables.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts)

## 本轮结果

### 1. Draft lifecycle 已补齐 restore

backend 新增：

- `POST /api/workflow-designer/workflows/:id/restore`

结果：

- archived workflow draft 可以回到 `draft`
- 恢复动作继续复用 `saveBpmnDraft()` 和统一 draft model
- analytics 记录 `restored`

### 2. Duplicate 已支持 Hub 内自定义命名

[WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 现在会先弹出重命名对话框，再调用 `duplicateWorkflowDraft(workflowId, name)`。

结果：

- 用户可以直接给副本命名
- 留空时仍走后端默认 copy naming
- 自定义命名成功后，会直接进入新 draft 的 designer 页面

### 3. Workflow runtime schema 已补齐

浏览器烟测前，真实 backend 日志暴露：

- `relation "workflow_definitions" does not exist`
- `relation "workflow_templates" does not exist`

本轮新增 migration 后，本地 dev 库已补齐：

- `workflow_definitions`
- `workflow_templates`
- `workflow_node_library`
- `workflow_analytics`

结果：

- `/api/workflow-designer/workflows` 不再 `500`
- `/api/workflow-designer/templates` 能在本地 dev 环境稳定返回
- workflow hub 不再依赖“测试里过了，但本地库其实没表”的假状态

### 4. 浏览器烟测已覆盖 rename + restore 的真实交互

本轮 smoke 在独立 Playwright 会话里完成了四步：

1. 注入本地 `workflow` feature override 和 dev JWT
2. 打开 `/workflows`，确认 draft list 和 template catalog 正常加载
3. 在 hub 中对 active draft 执行 `Duplicate`，输入自定义名称 `Smoke Draft Custom Rename`
4. 对 archived draft 执行 `Restore`，确认恢复后状态从 `archived` 变为 `draft`

结果：

- `Duplicate` 会弹出重命名对话框
- 自定义命名完成后跳转到新 draft 的 `/workflows/designer/:id`
- `Restore` 确认后，hub 列表中的该条目恢复为 `draft`，动作按钮重新变为 `Archive`

## 验证命令

已通过：

- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-drafts.test.ts tests/unit/workflow-designer-route-models.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/workflow-designer.ts src/workflow/workflowDesignerRouteModels.ts src/db/migrations/zzzz20260309103000_create_workflow_designer_support_tables.ts`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`

辅助实机检查：

- `curl -s 'http://127.0.0.1:7778/api/auth/dev-token?userId=dev-user&roles=admin'`
- `curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:7778/api/workflow-designer/workflows?...'`
- `curl -s -H "Authorization: Bearer $TOKEN" 'http://127.0.0.1:7778/api/workflow-designer/templates?...'`
- Playwright CLI 独立 session 打开 `http://127.0.0.1:8899/workflows`

结果：

- backend helper 测试 `2 files / 11 tests` 通过
- `apps/web` 当前 `21 files / 78 tests` 通过
- `core-backend build` 通过
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过
- `Yuantus` 健康检查返回 `200`
- browser smoke 中 workflow hub 已显示：
  - active draft 的 `Open / Duplicate / Archive`
  - archived draft 的 `Open / Duplicate / Restore`
  - duplicate-with-rename 后新增 draft
  - restore 后状态回切为 `draft`
- smoke 用到的 `Smoke Draft*` 临时草稿已在验证结束后从本地 dev 库清理

## 关键烟测快照

- 初次修复 schema 后的 hub 快照：
  [page-2026-03-08T23-01-52-698Z.yml](/Users/huazhou/Downloads/Github/metasheet2/.playwright-cli/page-2026-03-08T23-01-52-698Z.yml)
- 带 active / archived draft 的 hub 快照：
  [page-2026-03-08T23-02-31-447Z.yml](/Users/huazhou/Downloads/Github/metasheet2/.playwright-cli/page-2026-03-08T23-02-31-447Z.yml)
- duplicate rename 对话框快照：
  [page-2026-03-08T23-02-43-391Z.yml](/Users/huazhou/Downloads/Github/metasheet2/.playwright-cli/page-2026-03-08T23-02-43-391Z.yml)
- restore 确认对话框快照：
  [page-2026-03-08T23-03-18-809Z.yml](/Users/huazhou/Downloads/Github/metasheet2/.playwright-cli/page-2026-03-08T23-03-18-809Z.yml)
- restore 生效后的 hub 快照：
  [page-2026-03-08T23-03-30-090Z.yml](/Users/huazhou/Downloads/Github/metasheet2/.playwright-cli/page-2026-03-08T23-03-30-090Z.yml)

## 非阻塞提示

- 浏览器烟测里仍会看到一次 `/api/auth/me` `401`
  - 原因是 [featureFlags.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/stores/featureFlags.ts) 仍直接调用 `/api/auth/me`
  - 这不阻断 workflow hub，因为本轮 smoke 已通过 local feature override + dev JWT 打通主路径
  - 但它说明 dev 模式下的 feature bootstrap 仍有一条可继续优化的尾项
- `apps/web` 测试仍会打印一次 `WebSocket server error: Port is already in use`，不影响通过

## 验证结论

这轮证明了五件事：

1. workflow hub lifecycle 已从 `Duplicate / Archive` 扩展到 `Duplicate(with rename) / Archive / Restore`
2. `restore` 没有引入第二套草稿模型，仍然走统一 `workflow_definitions` draft 链
3. workflow hub 的本地 dev 运行前提已正式进入 migration，而不是依赖手工建表
4. 浏览器烟测已经覆盖到真实交互，不再只停留在接口和单测
5. workflow 这条线现在不仅“代码上产品化”，而且“本地运行上产品化”

所以这轮之后，workflow hub 可以从结构治理阶段切到真正的下一层产品增强，而不是继续回头补基础运行条件。 
