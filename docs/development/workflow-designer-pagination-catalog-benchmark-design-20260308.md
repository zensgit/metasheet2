# Workflow Designer Pagination / Catalog 产品化对标设计

日期: 2026-03-08

## 目标

上一轮已经把 `workflow-designer` 的底层模型统一到 `BPMN draft model`，并把：

- `create / get / update / deploy / validate`
- `list / share / test / executions`
- `templates / node-types` 的旧表硬依赖

基本收口完成。

本轮不再继续做模型统一，而是往产品化再推进一层：

1. `templates` 要具备真正可用的分页、搜索、来源过滤和排序
2. `workflows list` 要具备真正可用的分页和排序，而不是仅返回全量数组
3. 前端 persistence 要有对应的 typed list helper，后面接列表页或模板页时不再重复造 query/metadata 逻辑

## 对标判断

当前真正要对标的不是“页面长什么样”，而是 workflow designer catalog API 是否已经具备最基本的产品能力。

如果还停在上一轮状态，会有四个问题：

1. 模板目录只能一次性读全量结果
2. workflow 列表虽然正确，但没有明确分页语义
3. 前端如果后续补模板页/列表页，还得再手工拼 query string 和 metadata 解析
4. `templates` 虽然已经有 builtin fallback，但还没有来源过滤和稳定排序，产品上仍然偏“能用”而不是“可运营”

所以本轮目标是把它推进到“可以支撑真正列表页”的级别。

## 设计决策

### 1. templates 增加服务端分页 / 搜索 / 来源过滤 / 排序

`GET /api/workflow-designer/templates` 现在支持：

- `category`
- `featured`
- `search`
- `source=all|builtin|database`
- `sortBy=usage_count|name|updated_at`
- `sortOrder=asc|desc`
- `limit`
- `offset`

同时保持旧兼容：

- `data` 仍然是数组
- 新增 `metadata.total/limit/offset/returned`

这样现有消费者不会被打断，后续列表页也能直接接。

### 2. workflows list 增加分页和排序

`GET /api/workflow-designer/workflows` 现在支持：

- `category`
- `status`
- `search`
- `sortBy=updated_at|created_at|name`
- `sortOrder=asc|desc`
- `limit`
- `offset`

这一步的意义不是只“多几个 query 参数”，而是把 designer list 正式从“内部工具型接口”推进成“产品列表接口”。

### 3. catalog/list 保持数组兼容，分页信息进 metadata

本轮刻意没有把响应改成：

- `data.items`
- `data.pagination`

而是保持：

- `data: []`
- `metadata: {...}`

原因很现实：

- 当前前端还没正式消费这两条接口
- 保守兼容比追求更漂亮的 envelope 更重要

### 4. 前端 persistence 预先补齐 typed helper

本轮顺手把前端 persistence 补上了：

- `listWorkflowTemplates()`
- `listWorkflowDrafts()`

位置在 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)。

这样后续如果补：

- workflow 列表页
- template picker
- 模板搜索
- 最近编辑列表

就不需要重新发明一层 query / pagination / normalize 逻辑。

### 5. helper 继续承接 route 产品规则

本轮没有把分页/过滤逻辑散回 route，而是继续留在 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts) 里。

这样这条线现在已经形成三层：

1. route: 接收 query / 返回响应
2. routeModels helper: 目录与列表规则
3. draft helper: 权限与 metadata 解析

这比继续把规则散在 route 文件里更适合后续扩功能。

## 超越目标

这轮真正想超越的，不是“把接口做复杂一点”，而是让 `workflow-designer` 从“模型统一完成”真正推进到“产品入口可扩展”。

超越点有三个：

1. `catalog API` 从 fallback 可用，推进到真正具备运营语义
2. `workflow list API` 从正确可用，推进到真正具备分页语义
3. 前端从只有单条 draft load/save helper，推进到已经有 catalog/list 级 typed helper

也就是说，这轮结束后，`workflow-designer` 不只是底层统一了，而且已经开始具备“接列表页/模板页”的产品化基础。

## 本轮不做

- 不直接做 workflow 列表页 UI
- 不直接做 template picker UI
- 不引入数据库级全文搜索
- 不引入缓存、索引或 query planner 级优化
- 不做模板运营后台

本轮只做一件事：

把 `workflow-designer` 的 templates/list 接口推进到一个真正适合被产品层消费的状态。 
