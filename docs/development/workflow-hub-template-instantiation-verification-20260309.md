# Workflow Hub / Template Instantiation 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)

## 本轮结果

### 1. WorkflowHub 已切到真实 draft/template 入口

[WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 现在不再依赖旧的 definitions-only 列表，而是直接消费：

- `listWorkflowDrafts()`
- `listWorkflowTemplates()`

并提供：

- 搜索
- 状态/来源过滤
- 排序
- 分页翻页
- `Use template` 入口

### 2. 模板实例化链路已打通

backend 新增：

- `GET /api/workflow-designer/templates/:id`
- `POST /api/workflow-designer/templates/:id/instantiate`

前端新增：

- `loadWorkflowTemplate()`
- `instantiateWorkflowTemplate()`

这意味着模板现在不再只是目录项，而是可以直接生成新 draft workflow。

### 3. WorkflowDesigner 已支持模板对话框与 route-query 实例化

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 本轮新增：

- 模板按钮
- 模板对话框
- 模板目录分页/过滤
- 模板详情预览
- 一键使用模板

同时，当 designer 在没有 `workflowId` 时收到 `templateId` query，也会自动完成实例化并加载新 draft。

### 4. 模板实例化走的是 backend 主保存链

本轮没有在前端自己做 visual template -> BPMN 转换，而是让 backend 继续复用现有 `saveWorkflow()`。

这保证了：

- 模板实例化后的 draft 仍然落在统一的 draft model 中
- 后续保存、部署、分享、执行记录语义不分叉

## 验证命令

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-drafts.test.ts tests/unit/workflow-designer-route-models.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/workflow-designer.ts src/workflow/workflowDesignerRouteModels.ts`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`

结果：

- backend helper 测试 `2 files / 10 tests` 通过
- `apps/web` 当前 `20 files / 72 tests` 通过
- `core-backend build` 通过
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过
- `Yuantus` 健康检查返回 `200`

## 非阻塞提示

- `apps/web` 测试仍会打印一次 `WebSocket server error: Port is already in use`，但不影响通过
- backend unit test 仍会打印一次 Vite CJS deprecation 提示，但不阻断验证
- 本轮没有新增 Playwright/UI regression，当前验证以 `unit + type-check + lint + build` 为主

## 验证结论

这轮证明了三件事：

1. workflow 这条线已经不再缺入口，`hub -> template -> designer` 已形成闭环
2. 模板实例化不会绕开 draft model，而是继续走统一 backend 保存链
3. 后续如果继续做 workflow 产品化，可以直接进入列表页深化、模板运营或 UI 回归，而不是再补结构性缺口

所以这轮之后，`workflow-designer` 已经从“接口和能力都准备好了”推进到“产品入口可以真实使用”的阶段。 
