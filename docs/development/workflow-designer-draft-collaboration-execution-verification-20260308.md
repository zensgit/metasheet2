# Workflow Designer Draft Collaboration / Execution 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts)
- 更新 [workflowDesignerDrafts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerDrafts.ts)
- 更新 [workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)

## 本轮结果

### 1. workflow list 已切到 draft model

`GET /api/workflow-designer/workflows` 现在不再依赖 `workflow_designer_definitions`。

它已经改为：

- 从 `workflow_definitions` 读取
- 解析 draft metadata
- 根据 owner/shared access 过滤
- 返回基于 draft record 的 `role / status / category / updated_at`

这意味着列表视图和真实 draft 数据终于在同一条链上。

### 2. share 已写回 draft metadata

`POST /api/workflow-designer/workflows/:id/share` 现在已经改成：

- 基于 draft record 判断 `canShare`
- 把 share 信息写回 `workflow_definitions.definition.shares`

也就是说，share 不再依赖旧 `workflow_collaboration` 表才能生效。

### 3. test / executions 已切到 draft metadata

`POST /:id/test` 和 `GET /:id/executions` 现在都围绕 draft metadata 工作：

- test 追加 execution record
- executions 读取并排序 execution records

这一轮之后，designer 的测试动作终于有可读取的执行结果来源，而不是继续依赖旧 execution 表系。

### 4. 旧 visual-definition 记录已有 BPMN fallback

为了避免历史 visual-definition 记录因为缺少 `bpmn` 字段而在新 draft 链中失效，本轮在 [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts) 中补了 fallback：

- 如果 draft record 没有显式 `bpmnXml`
- 但存在 `visual`
- 就会在加载 draft 时动态生成 BPMN XML

这让迁移对旧记录更平滑。

### 5. analytics 已降为 best-effort

route 中 `workflow_analytics` 写入现在不会再阻断主流程。

即使某个环境没有落 analytics 表：

- create
- get
- update
- deploy
- share

这些主路径也不会因为 analytics 失败而整体失败。

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

## 测试结果

backend draft helper 测试当前为：

- `1 file / 5 tests` 通过

覆盖点包括：

- `bpmn-only` 存储结构
- 存储 JSON 解析
- draft row 映射
- share/role/access 语义
- execution append 语义

frontend 包级测试仍保持：

- `20 files / 68 tests` 通过

## 非阻塞提示

这轮仍保留的旧 designer 体系范围有两块：

- `node-types`
- `templates`

它们还没有迁到新的 draft model，也不属于当前前端 `BPMN editor` 的直接阻断路径。

另外，`workflow list` 当前实现是以 draft loader 逐条组装，属于正确性优先而不是性能优先；后续如果要扩到大规模列表，需要再做 query 级优化。

## 验证结论

这轮改动证明三件事：

1. `workflow-designer` 的剩余核心路由已经基本并入同一条 `draft model`
2. `share / test / executions / list` 不再依赖旧 designer 表系才能工作
3. `WorkflowDesigner` 已从“能保存草稿”推进到“草稿、协作、执行记录都开始围绕同一模型工作”

所以这条线现在离“完整自洽的 designer domain”只剩两类尾项：

- 旧 `templates / node-types` 的处理
- draft list/query 的性能优化 
