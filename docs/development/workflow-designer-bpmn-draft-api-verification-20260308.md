# Workflow Designer BPMN Draft API 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts)
- 新增 [workflowDesignerDrafts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerDrafts.ts)
- 新增 [workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts)

## 本轮结果

### 1. workflow-designer 已支持 BPMN draft save/load

当前 `workflow-designer` 的 `POST / GET / PUT /workflows` 路径已经支持 `bpmnXml` payload：

- create: 支持直接保存 BPMN XML 草稿
- get: 返回 `bpmnXml`
- update: 支持直接更新 BPMN XML 草稿

这一轮后，前端 `WorkflowDesigner` 不再依赖“route 偶然返回了兼容字段”才能工作。

### 2. saveWorkflow 的 ID 落库问题已修正

[WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts) 之前 `saveWorkflow()` 返回逻辑生成的 `workflowId`，但 insert 并没有真正写入该 `id`。

这轮已经修正为：

- insert 时显式写入 `id`
- conflict update 也以该 `id` 为主键

这意味着前端第一次保存后拿到的 draft ID，现在和数据库记录是一致的。

### 3. designer deploy route 已具备 BPMN draft 路径

`POST /api/workflow-designer/workflows/:id/deploy` 现在不再只是假设 visual-definition deploy 存在，而是：

- 若草稿里存在 `bpmnXml`
- 就直接调用 BPMN workflow engine 完成部署

也就是说，保存后的 BPMN draft 现在已经拥有自己的 designer deploy 路径。

### 4. 前端 deploy 已重新优先走 saved draft

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 当前行为已改为：

- 有未保存改动时先保存
- 保存后若拿到 `workflowId`，优先调用 `workflow-designer/:id/deploy`
- 仅在没有草稿 ID 的情况下，才退回 raw `BPMN XML` deploy

这意味着前后端行为已经开始围绕 `designer draft` 收敛，而不是继续各走各路。

### 5. backend helper 已有聚焦测试

[workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts) 已覆盖：

- `bpmn-only` 存储结构构建
- 存储 JSON 解析
- DB row -> draft record 映射

这虽然还不是 route 级 supertest，但已经把本轮新增的 storage/model 关键边界锁住了。

## 验证命令

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-drafts.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

补充检查：

- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`
- 结果: `200`

## 结果摘要

本轮验证的重点有三类：

### 1. 后端 helper 与编译链

- 新增 backend helper 测试通过
- `core-backend` 编译通过

### 2. 前端设计器行为链

- `apps/web` 测试通过，当前 `20 files / 68 tests`
- `apps/web` 构建通过

### 3. 工作区质量门

- `pnpm lint` 通过

## 非阻塞提示

这轮仍保留的结构问题是范围性而不是阻断性：

- `workflow-designer` 旧表系相关的 `list / share / executions` 路由仍未统一到新的 `workflow_definitions` draft 链
- visual-definition 与 BPMN-editor 的底层模型仍未完全统一
- 本轮没有新增专门的 WorkflowDesigner E2E/UI regression 报告

也就是说，本轮解决的是“当前前端实际依赖的 API 自洽问题”，不是“designer 全部后端模型统一问题”。

## 验证结论

这轮改动证明四件事：

1. `workflow-designer` 已经具备真实可用的 `BPMN draft save/load/update` 能力
2. `designer deploy` 已经具备 `BPMN draft` 路径
3. 前端 `WorkflowDesigner` 已开始回收至 saved-draft-first 的部署模型
4. 本轮改动已经通过 backend test/build、frontend test/build 和 workspace lint 门禁

所以这条线现在已经从“前端兼容后端漂移”推进到“后端 draft API 初步自洽”。下一步如果继续，最值钱的就是把 `list/share/executions` 也从旧 designer 表系迁到同一条 draft model 上。 
