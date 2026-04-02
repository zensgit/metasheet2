# Workflow Designer Pagination / Catalog 验证记录

日期: 2026-03-08

## 变更范围

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)

## 本轮结果

### 1. templates 已具备分页 / 搜索 / 来源过滤 / 排序

`GET /api/workflow-designer/templates` 现在支持：

- `search`
- `source`
- `sortBy`
- `sortOrder`
- `limit`
- `offset`

并且保持 `data` 数组兼容，同时在 `metadata` 中返回：

- `total`
- `limit`
- `offset`
- `returned`
- `builtinCount`
- `databaseCount`
- `databaseSource`

### 2. workflows list 已具备分页与排序

`GET /api/workflow-designer/workflows` 现在支持：

- `sortBy`
- `sortOrder`
- `limit`
- `offset`

同样保持 `data` 数组兼容，并在 `metadata` 中返回分页与筛选信息。

### 3. 前端 persistence 已补齐 typed list helper

[workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts) 现在新增：

- `listWorkflowTemplates()`
- `listWorkflowDrafts()`

同时统一了：

- query string 构造
- list envelope 解包
- pagination metadata 归一化
- list item typed normalize

### 4. 纯函数测试已覆盖分页/来源过滤/排序

[workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts) 现在覆盖：

- draft list item 过滤与 role 计算
- templates builtin/database 合并
- `source` 过滤
- `limit/offset` 分页
- node library defensive parse

### 5. 前端 helper 测试已覆盖 pagination normalize

[workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts) 现在新增覆盖：

- template list pagination normalize
- workflow list pagination normalize

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

- backend helper 测试 `2 files / 9 tests` 通过
- `apps/web` 当前 `20 files / 70 tests` 通过
- `core-backend build` 通过
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过
- `Yuantus` 健康检查返回 `200`

## 非阻塞提示

- `apps/web` 测试仍会打印一次 `WebSocket server error: Port is already in use`，但不影响通过
- backend unit test 仍会打印一次 Vite CJS deprecation 提示，但不阻断验证
- 本轮没有新增 UI regression，因为改动集中在 catalog/list API 与 persistence helper

## 验证结论

这轮证明了三件事：

1. `workflow-designer` 的 templates/list 已经具备真正可用的产品级列表语义
2. 前端已经有对应的 typed helper，可直接支撑后续列表页或模板页
3. 这条线现在剩下的主要不是结构性缺口，而是后续是否要继续做 UI 和更深的 query 优化

所以这轮之后，`workflow-designer` 已经从“模型统一完成”推进到“可以承接下一层产品入口开发”。 
