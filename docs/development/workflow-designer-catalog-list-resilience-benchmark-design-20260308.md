# Workflow Designer Catalog / List Resilience 对标设计

日期: 2026-03-08

## 目标

上一轮已经把 `workflow-designer` 的：

- `create / get / update / deploy / validate`
- `list / share / test / executions`

基本收到了同一条 `BPMN draft model` 上。

但还剩两类结构性尾项：

1. `GET /api/workflow-designer/workflows` 仍然通过 `loadWorkflowDraft()` 逐条回查，存在明显的 `N+1`
2. `GET /api/workflow-designer/node-types` 和 `GET /api/workflow-designer/templates` 仍然把旧表当成硬依赖

这会造成两个现实问题：

- 在 `workflow_node_library / workflow_templates` 不完整的环境里，catalog API 直接退化成 `500`
- 列表虽然已经切到 draft model，但查询路径还停留在“正确性优先、性能欠账明显”的状态

所以本轮目标很明确：

- 去掉 `workflows list` 的 `N+1`
- 把 `node-types / templates` 改成“内建 catalog 永远可用，数据库扩展是增强项”
- 顺手把这套规则沉淀成可单测的 helper module

## 对标判断

当前真正需要对标的不是“多做几个路由”，而是设计器域是否已经具备最低限度的环境韧性。

如果继续沿用旧方案，会有三类问题：

1. 列表性能随着 workflow 数量线性放大
2. 某些环境只缺一张旧表，整个 designer catalog 就不可用
3. route 中混杂大量 JSON 解析和 fallback 逻辑，后续很难继续治理

所以这轮的判断是：

- `draft model` 已经足够承担 list 主路径
- `node library / template library` 应该是可选增强，而不是强依赖前提
- “内建能力 + 数据库增强”的双层 catalog，才更符合当前仓库的真实成熟度

## 设计决策

### 1. list 直接基于 workflow_definitions 行组装

`GET /api/workflow-designer/workflows` 不再逐条调用 `designer.loadWorkflowDraft()`。

新的策略是：

- 直接读取 `workflow_definitions`
- 通过 `toWorkflowDraftRecord()` 做纯映射
- 在内存中完成 `access / category / status / search` 过滤
- 直接返回 draft list item

这样做的收益是：

- 去掉 `N+1`
- 列表逻辑和 draft 权限逻辑仍然保持同一模型
- 后续如果要分页或 query 优化，也只需要继续沿这一条路径做

### 2. node-types 改成 builtin-first

`GET /api/workflow-designer/node-types` 现在的主路径是：

- 永远返回 `designer.getNodeTypes()` 的 builtin catalog
- 尝试从 `workflow_node_library` 读取 custom 节点
- 如果读取失败，仅把 custom 降级为空，并通过 metadata 显式标记 `customSource: unavailable`

这意味着：

- 即使数据库里没有旧 node library 表，前端设计器仍然可用
- custom 节点库从“硬依赖”变成了“增强项”

### 3. templates 改成 builtin + database merge

`GET /api/workflow-designer/templates` 现在改成双层模板目录：

- builtin templates 来自 [WorkflowDesigner.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/WorkflowDesigner.ts)
- database templates 来自 `workflow_templates`
- 合并时按 `id` 去重，数据库记录可覆盖同 ID 的 builtin 记录
- `featured / category` 过滤作用在合并结果上

这个设计比“数据库挂了就 500”更合理，因为：

- builtin 模板本来就是当前系统最稳定、最可控的模板来源
- 数据库模板更适合作为定制化增强，不该成为唯一可用来源

### 4. 解析与过滤规则下沉成 helper module

本轮新增了 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)。

它负责：

- custom node library JSON 解析
- builtin/database template 映射与合并
- draft list item 组装与过滤

这样 route 只负责：

- 取数据
- 调 helper
- 返回响应

后续如果继续补分页、缓存或 schema 规范，改动范围会更集中。

## 超越目标

这轮真正想超越的，不只是“把三条尾项收一收”，而是把 `workflow-designer` 往“弱环境也能稳定工作”的方向推进。

超越点有三个：

1. `catalog` 从“依赖旧表才能可用”提升到“内建目录永远可用”
2. `list` 从“正确但 N+1”提升到“仍然基于 draft model，但查询链干净一层”
3. route 规则从“散落在控制器里”提升到“有明确 helper model 和单测”

也就是说，这轮结束后，`workflow-designer` 不只是更统一了，而且更抗环境漂移了。

## 本轮不做

- 不重建 `workflow_templates / workflow_node_library` 的完整新 schema
- 不做 list 的数据库级全文搜索或分页优化
- 不引入缓存层
- 不把 builtin template catalog 做成可配置 marketplace

本轮目标只聚焦一件事：

让 `workflow-designer` 的 catalog 和 list 从“还能跑”提升到“在当前代码阶段更合理、更稳”。 
