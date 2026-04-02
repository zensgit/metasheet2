# PLM Workbench Team Views 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 新增 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-views-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-team-views.test.ts tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/plmWorkbenchViewState.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `core-backend` 聚焦单测通过，当前为 `2 files / 11 tests`
- `apps/web` 聚焦单测通过，当前为 `3 files / 11 tests`
- `apps/web test` 当前为 `30 files / 117 tests`
- `apps/web type-check / lint / build`、根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

后端新增/更新覆盖：

1. `workbench` kind 已被接受和归一化
2. `workbench` 团队视图可以保存 `query snapshot`
3. route 层接受 `kind=workbench` 的 save path

前端新增/更新覆盖：

1. 只保留允许的 `PLM workbench` query key
2. 合并 query 时会清空旧 `PLM` key、保留非 `PLM` key
3. client 能把 `workbench` state 规范化成 `{ query: Record<string, string> }`

## Live 运行态验证

已通过：

- `curl http://127.0.0.1:7778/health`
- `GET /api/auth/dev-token`
- `POST /api/plm-workbench/views/team`
- `GET /api/plm-workbench/views/team?kind=workbench`
- `DELETE /api/plm-workbench/views/team/:id`

结果：

- 本轮使用 live backend `http://127.0.0.1:7778`
- 健康检查返回 `200`
- 成功创建默认工作台视角：
  - `PLM Workbench Link View`
- 创建返回 `201`
- `list(kind=workbench)` 返回：
  - `total: 1`
  - `defaultViewId` 正确等于新建视图 ID
- 验证后已清理，当前 `kind=workbench` 列表恢复为：
  - `total: 0`
  - `defaultViewId: null`

产物：

- [plm-workbench-team-view-20260309.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-20260309.json)
- [plm-workbench-team-view-cleanup-20260309.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-cleanup-20260309.json)

## 浏览器 Smoke

证据已归档到：

- [plm-workbench-team-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-views-20260309)

关键文件：

- [page-open-via-default-workbench-view.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-views-20260309/page-open-via-default-workbench-view.png)
- [page-open-via-default-workbench-view.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-views-20260309/page-open-via-default-workbench-view.json)

主路径：

1. 通过 live API 创建默认 `workbench` 团队视角
2. 打开空的 `/plm`
3. 等待首屏完成 auth bootstrap 与 team views refresh
4. 确认页面自动恢复到默认工作台视角
5. 确认 URL 被同步成具体 query
6. 通过 live API 清理测试数据

页面确认结果：

- 当前默认标签为：
  - `当前默认：PLM Workbench Link View`
- 工作台团队视图下拉当前选中：
  - `PLM Workbench Link View · dev-user · 默认`
- 恢复到页面的状态包括：
  - `documentRole = primary`
  - `documentFilter = link-gear`
  - `approvalsFilter = link-eco`
  - `cadReviewState = approved`
  - `cadReviewNote = team-view-note`

最终 URL：

```text
http://127.0.0.1:8899/plm?documentRole=primary&cadReviewNote=team-view-note&cadReviewState=approved&documentFilter=link-gear&approvalsFilter=link-eco
```

## 残留说明

- `/plm` 页面仍会出现既有的 `PLM federation` 噪声：
  - `POST /api/federation/plm/query -> 403`
- 这是现有页面历史行为，不阻断 `workbench team view` 的保存、默认恢复和清理流程
- 本轮浏览器 smoke 不依赖 `Yuantus` 服务在线，只验证 `MetaSheet` 自身的工作台视角恢复链路

## 验证结论

本轮 `PLM workbench team views` 已达到可继续推进的状态：

1. `/plm` 已具备工作台级、后端持久化的 `team view`
2. `workbench` 视图现在支持：
   - `save`
   - `apply`
   - `delete`
   - `set default`
   - `clear default`
3. 保存内容不再局限于单面板 state，而是整页 query snapshot
4. 空 `/plm` 首屏已能自动恢复默认工作台视角
5. live API 与浏览器 smoke 都已闭环
6. 验证后临时 `workbench` 视图已清理，live 环境回到干净状态

