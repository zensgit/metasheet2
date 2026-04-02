# Workflow Designer Catalog / List Resilience 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 新增 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts)
- 新增 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)

## 本轮结果

### 1. workflow list 已去掉 draft loader 的 N+1

`GET /api/workflow-designer/workflows` 现在不再逐条调用 `designer.loadWorkflowDraft()`。

新实现已经改为：

- 直接读取 `workflow_definitions`
- 使用 `toWorkflowDraftRecord()` 做纯映射
- 基于同一套 draft access 规则完成 list 过滤与 role 计算

这说明 list 已经真正进入“draft row -> draft list item”的单路径，不再额外回查每条 workflow。

### 2. node-types 现在具备 builtin-first 降级能力

`GET /api/workflow-designer/node-types` 已改成：

- builtin node types 永远可用
- `workflow_node_library` 读取失败时只影响 `custom`
- 响应通过 `metadata.customSource` 显式暴露 custom catalog 是否可用

这意味着某个环境即使没落这张旧表，workflow designer 也不会因为 catalog 接口报错而整体失效。

### 3. templates 现在具备 builtin + database 合并策略

`GET /api/workflow-designer/templates` 已改成：

- builtin templates 始终返回
- 数据库模板作为覆盖/增强项合并进结果
- category / featured 过滤在合并结果上执行
- 响应通过 `metadata.databaseSource`、`builtinCount`、`databaseCount` 暴露来源情况

也就是说，模板目录现在不再受 `workflow_templates` 单点可用性约束。

### 4. route 解析逻辑已下沉到 helper module

本轮新增的 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts) 已承接：

- custom node library JSON 解析
- builtin/database templates 合并
- draft list item 组装和过滤

好处是 route 本身已经明显变薄，后续继续做 query 优化或补更多 catalog metadata 时，不需要再把逻辑散落在路由文件里。

## 验证命令

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/workflow-designer-drafts.test.ts tests/unit/workflow-designer-route-models.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/core-backend exec eslint src/routes/workflow-designer.ts src/workflow/workflowDesignerRouteModels.ts`
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:7910/api/v1/health`

结果：

- backend helper 测试 `2 files / 8 tests` 全绿
- `core-backend build` 通过
- 本轮 source-only lint 通过
- `Yuantus` 健康检查返回 `200`

## 新增测试覆盖

[workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts) 覆盖了三类关键语义：

- draft list item 过滤与 role 计算
- builtin/database templates 合并与 featured 过滤
- node library JSON 解析的 defensive fallback

[workflow-designer-drafts.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-drafts.test.ts) 继续覆盖 draft metadata 的：

- share/role/access
- execution append
- stored payload 映射

## 非阻塞提示

- 这轮没有新增 web 端测试或 UI regression，因为改动范围集中在 backend route/model
- `workflow-designer` 仍然还有两个后续深化点：
  - `templates` 的分页/搜索/来源排序策略
  - `workflows list` 的数据库级分页与 query 优化

## 验证结论

这轮证明三件事：

1. `workflow-designer` 的 `list` 已从 “draft loader N+1” 收到直接 draft row 组装
2. `templates / node-types` 已从“旧表硬依赖”收成“builtin 永远可用 + DB 增强可选”
3. 这条线已经从“把旧路由凑通”推进到“catalog 和 list 都具备基础韧性”

所以当前 `workflow-designer` 剩下的已不再是模型不一致问题，而主要是后续的性能和产品化深化问题。 
