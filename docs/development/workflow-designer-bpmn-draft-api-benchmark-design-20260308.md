# Workflow Designer BPMN Draft API 对标设计

日期: 2026-03-08

## 目标

上一轮已经把 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 从页面内联 `runtime / persistence / validation` 中拆出两层，但真正的结构问题仍在后端：

- 前端当前编辑器主模型是 `BPMN XML`
- `workflow-designer` 路由仍以 visual-definition 思路设计
- `workflow-designer` 路由读写链路本身也不自洽

所以本轮目标不是继续在前端堆兼容，而是把 `workflow-designer` 的 `create / get / update / deploy / validate` 这条链至少收成“面向 BPMN draft 可运行”的后端 API。

## 对标判断

当前仓库里存在三层明显漂移：

1. [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 编辑的是 `BPMN XML`
2. [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts) 保存的主模型是 `visual + converted BPMN`
3. [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts) 之前一部分逻辑在读 `workflow_designer_definitions`，而 `designer.saveWorkflow()` 实际写的是 `workflow_definitions`

这会带来两个直接问题：

- 前端 `save / load` 只能依赖兼容假设
- 即使前端 persistence 已拆，后端 route 仍然不是一个真实可用的 `BPMN draft API`

## 设计决策

### 1. 补一个明确的 draft storage helper

新增 [workflowDesignerDrafts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerDrafts.ts)。

它负责：

- 统一存储结构 `visual / bpmn / metadata`
- 解析 `workflow_definitions.definition`
- 把数据库行映射成 `WorkflowDraftRecord`

这一步的意义在于，先把“怎么存 BPMN draft”从 route 和 service 里抽出来，避免这轮继续出现重复 JSON 解析和隐式 shape 假设。

### 2. 让 WorkflowDesigner service 真正支持 BPMN draft

[WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts) 本轮补了两件关键事：

- 修正 `saveWorkflow()`：真正写入 `id`，不再返回一个没有落库的逻辑 ID
- 新增 `saveBpmnDraft()` 和 `loadWorkflowDraft()`：让 service 能直接处理 `BPMN XML` draft

同时保留现有 visual-definition 路径，不强行在这一轮把所有旧能力推倒重来。

### 3. 收口当前前端实际使用的五个端点

[workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts) 本轮只收口当前前端真正依赖的路径：

- `POST /api/workflow-designer/workflows`
- `GET /api/workflow-designer/workflows/:id`
- `PUT /api/workflow-designer/workflows/:id`
- `POST /api/workflow-designer/workflows/:id/validate`
- `POST /api/workflow-designer/workflows/:id/deploy`

设计原则是：

- `bpmnXml` payload 走新的 BPMN draft path
- `nodes / edges` payload 继续兼容旧 visual path
- route 内部优先走 `workflow_definitions` 这条当前真正落库的链路

### 4. deploy 路由变成真实可用

这轮不只做 draft save/load，还把 designer deploy 打通了。

当前设计是：

- 如果草稿里有 `bpmnXml`
- `POST /api/workflow-designer/workflows/:id/deploy` 就直接调用 BPMN workflow engine 部署

这意味着：

- 前端不再只能绕过 designer route 直接打 `/api/workflow/deploy`
- 保存后的 designer 草稿已经拥有自己的 deploy 路径

### 5. 前端 deploy 重新优先走 saved draft

[workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts) 和 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 也同步调整：

- 有未保存改动时，先保存 draft
- 保存成功后，优先走 `workflow-designer/:id/deploy`
- 只有拿不到 draft ID 时，才回退到 raw `BPMN XML` deploy

这样页面行为就和这轮补好的后端 draft API 对齐了。

## 超越目标

这轮真正想超越的不是“再兼容一次后端响应”，而是把问题往后端真正推回去：

1. 不只是让前端 load/save 少写几行
2. 而是让 backend route 自己能处理 `BPMN XML draft`
3. 不只是让 deploy 暂时可用
4. 而是让 saved draft 自己拥有 deploy 路径
5. 不只是补一个 helper
6. 而是把当前前端实际使用的 route 先打成自洽 API

## 本轮不做

- 不在这轮统一 `workflow_designer_definitions / workflow_collaboration / workflow_execution_history` 整套旧 designer 表系
- 不重写 list/share/executions 这组旧 route
- 不把所有 visual-definition 逻辑迁成 BPMN editor 语义
- 不引入新的 workflow SDK

本轮目标很明确：先把当前前端真实依赖的 `BPMN draft API` 打通，再谈 designer 全量模型统一。 
