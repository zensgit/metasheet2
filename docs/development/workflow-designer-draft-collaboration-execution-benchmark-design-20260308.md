# Workflow Designer Draft Collaboration / Execution 对标设计

日期: 2026-03-08

## 目标

上一轮已经把 `workflow-designer` 当前前端直接依赖的 `create / get / update / deploy / validate` 收成了 `BPMN draft API`。但这条线仍然留下了三块旧 designer 表系能力：

- `GET /api/workflow-designer/workflows`
- `POST /api/workflow-designer/workflows/:id/share`
- `POST /api/workflow-designer/workflows/:id/test`
- `GET /api/workflow-designer/workflows/:id/executions`

它们还停留在旧的：

- `workflow_designer_definitions`
- `workflow_collaboration`
- `workflow_execution_history`

这意味着 draft API 只完成了一半。  
所以本轮目标是把这几条路由也迁到统一的 `workflow_definitions.definition` draft metadata 上。

## 对标判断

当前真正的问题不是“页面没拆完”，而是：

1. `save / load / deploy` 走的是新 draft 链
2. `list / share / executions` 走的是旧 designer 表系
3. 结果是同一个 `WorkflowDesigner` 功能面实际上有两套存储模型

如果继续保持这种状态，会有三类风险：

- 保存成功的 draft 在列表里不可见
- share 权限和真实 draft 数据脱节
- test / executions 历史落不到当前 draft 上

## 设计决策

### 1. 把 collaboration / execution 收到 draft metadata

本轮不引入新表，也不强行修复整套旧 designer schema，而是把这两类状态先收到 `workflow_definitions.definition` 的 metadata 中：

- `shares`
- `executions`

新增/扩展的核心文件是 [workflowDesignerDrafts.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerDrafts.ts)。

它现在负责：

- 解析 `shares / executions`
- 计算 `owner / editor / viewer` 角色
- 判断 `access / edit / deploy / share` 权限
- 统一 share upsert 和 execution append 语义

### 2. list 改成围绕 workflow_definitions 组装

`GET /api/workflow-designer/workflows` 不再查 `workflow_designer_definitions`。

新的策略是：

- 从 `workflow_definitions` 读取记录
- 解析为 draft record
- 按 owner 或 shared access 过滤
- 再做 `category / status / search` 过滤

这一步的关键不是性能最优，而是先让“列表看到的就是当前真实 draft”。

### 3. share 写回 draft metadata

`POST /api/workflow-designer/workflows/:id/share` 现在不再依赖 `workflow_collaboration`。

新的策略是：

- owner 或具备 `canShare` 的 shared user 可发起 share
- share 信息写回 draft metadata
- 以后 `list / get / edit / deploy` 都从同一份 share metadata 判断权限

这样可以把 share 从“旁路状态”收回到“draft 主状态”。

### 4. test / executions 改成 draft metadata 路径

`POST /:id/test` 和 `GET /:id/executions` 这轮也不再依赖 `workflow_execution_history`。

新的策略是：

- test 直接生成一条 lightweight execution record
- record 写回 draft metadata
- executions 从 draft metadata 读取并排序返回

本轮不追求真实 engine execution 追踪，只解决“当前 designer 有测试动作，但没有自洽执行记录模型”的问题。

### 5. analytics 改成 best-effort

这轮顺手把 route 里的 `workflow_analytics` 写入改成了 best-effort。

原因很现实：

- analytics 不是主业务路径
- 某些环境里即使 analytics 表未落库，也不应该把保存/部署/share 主流程拖死

## 超越目标

这轮真正想超越的不是“把几个旧 query 改掉”，而是让 `workflow-designer` 开始有完整 draft 主模型：

1. draft 内容
2. draft deploy
3. draft share
4. draft execution history
5. draft list visibility

也就是说，这一轮之后，`WorkflowDesigner` 不再只是“草稿能存”，而是开始拥有自己的完整协作与执行侧边状态。

## 本轮不做

- 不迁移 `templates / node-types`
- 不把 workflow execution history 升级成完整独立事件流或审计表
- 不优化 list 的 N+1 draft 组装成本
- 不引入新的 workflow collaboration 表设计

本轮目标很明确：先让 `workflow-designer` 的剩余核心路由也站到同一个 draft model 上。 
