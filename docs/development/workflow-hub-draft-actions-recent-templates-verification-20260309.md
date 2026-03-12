# Workflow Hub Draft Actions / Recent Templates 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [workflow-designer.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/workflow-designer.ts)
- 更新 [workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts)
- 更新 [workflow-designer-route-models.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/workflow-designer-route-models.test.ts)
- 更新 [workflowDesignerPersistence.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerPersistence.ts)
- 新增 [workflowDesignerRecentTemplates.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRecentTemplates.ts)
- 更新 [workflowDesignerPersistence.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerPersistence.spec.ts)
- 新增 [workflowDesignerRecentTemplates.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/workflowDesignerRecentTemplates.spec.ts)
- 更新 [WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue)
- 更新 [WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue)
- 更新 [workflow-designer.yml](/Users/huazhou/Downloads/Github/metasheet2/packages/openapi/src/paths/workflow-designer.yml)
- 更新 [apps/web/package.json](/Users/huazhou/Downloads/Github/metasheet2/apps/web/package.json)

## 本轮结果

### 1. Workflow draft 已具备复制与归档动作

backend 新增：

- `POST /api/workflow-designer/workflows/:id/duplicate`
- `POST /api/workflow-designer/workflows/:id/archive`

结果：

- `duplicate` 会生成新的 personal draft
- `archive` 会把 workflow draft 状态切到 `archived`
- 两条动作都继续复用 draft model，而不是分叉到单独表系

### 2. Duplicate name 已具备稳定递增规则

[workflowDesignerRouteModels.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/workflow/workflowDesignerRouteModels.ts) 新增 duplicate name helper，并有单测覆盖：

- `审批流程` -> `审批流程 Copy`
- `审批流程 Copy` -> `审批流程 Copy 2`
- `审批流程 Copy 2` -> `审批流程 Copy 3`

这避免了 workflow hub 在连续复制下产生不稳定命名。

### 3. WorkflowHub 已从“入口页”升级到“操作页”

[WorkflowHubView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowHubView.vue) 本轮新增：

- `Duplicate` 按钮
- `Archive` 按钮
- `Recent Templates` 区块

结果：

- workflow draft 不再只能 `Open`
- 最近模板可以直接 `Use again`
- hub 已从单纯目录页向工作台推进

### 4. WorkflowDesigner 已接入 recent templates

[WorkflowDesigner.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/WorkflowDesigner.vue) 的模板对话框新增“最近使用”区块。

结果：

- 模板应用成功后会进入本地 recent list
- 再次打开模板选择器时不必重新搜完整目录
- recent templates 现在是 `hub + designer` 双入口共享

### 5. Recent templates 已形成独立状态模块

[workflowDesignerRecentTemplates.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/workflowDesignerRecentTemplates.ts) 已把这类能力从页面中抽出，覆盖：

- 本地读取
- 防御性解析
- 去重
- 按最近使用时间排序
- 上限裁剪

这意味着后续如果要做：

- recent templates widget
- pin/favorite templates
- server-side recent profile

都可以继续沿用这个状态边界，而不需要回头再拆页面。

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

- backend helper 测试 `2 files / 11 tests` 通过
- `apps/web` 当前 `21 files / 77 tests` 通过
- `core-backend build` 通过
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过
- `Yuantus` 健康检查返回 `200`

## 非阻塞提示

- `apps/web` 测试仍会打印一次 `WebSocket server error: Port is already in use`，但不影响通过
- backend helper test 仍会打印一次 Vite CJS deprecation 提示，但不阻断验证
- 本轮没有新增 Playwright/UI regression；验证仍以 `unit + type-check + lint + build` 为主

## 验证结论

这轮证明了四件事：

1. workflow hub 已不只是浏览页，而开始具备 draft lifecycle action
2. recent templates 已经不是一个抽象概念，而是同时落在 hub 和 designer 两个高频入口
3. duplicate / archive 没有绕开 draft model，仍然走统一 workflow-designer 主路径
4. 这条线接下来可以进入更细的产品化动作，例如 `restore archive / duplicate with rename / batch actions / UI regression`

所以这轮之后，workflow 线的重点已经从“把入口补齐”转成“把日常使用动作补齐”。 
