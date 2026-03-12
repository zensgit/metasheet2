# PLM Workbench Team View Rename / Duplicate 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-view-rename-duplicate-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-rename-duplicate-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-team-views.test.ts tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `core-backend` 聚焦单测通过，当前为 `2 files / 14 tests`
- `apps/web` 聚焦单测通过，当前为 `2 files / 12 tests`
- `apps/web test` 当前为 `30 files / 120 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

后端新增/更新覆盖：

1. `duplicate` 命名规则会稳定生成 `（副本） / （副本 2）`
2. owner 可重命名现有团队视图
3. 非 owner 也可以把共享团队视图复制到自己名下

前端新增/更新覆盖：

1. client 会打到新的 `PATCH / duplicate` route
2. `usePlmTeamViews()` 能复制任意可见 workbench 视图
3. 复制后的 owned copy 可以继续重命名

## Live API 验证

已通过：

- `curl http://127.0.0.1:7778/health`
- `GET /api/auth/dev-token`
- `POST /api/plm-workbench/views/team`
- `POST /api/plm-workbench/views/team/:id/duplicate`
- `PATCH /api/plm-workbench/views/team/:id`
- `GET /api/plm-workbench/views/team?kind=workbench`
- `DELETE /api/plm-workbench/views/team/:id`

结果：

1. 成功创建源工作台视图：
   - `PLM Workbench Rename Source`
2. 成功通过 live API 复制：
   - `PLM Workbench API Copy`
3. 成功通过 live API 重命名：
   - `PLM Workbench API Renamed`
4. 验证后临时 workbench 视图已清理
5. 清理后 `kind=workbench` 列表恢复为：
   - `total: 0`

产物：

- [plm-workbench-team-view-rename-duplicate-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-rename-duplicate-20260310.json)
- [plm-workbench-team-view-rename-duplicate-api-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-rename-duplicate-api-20260310.json)
- [plm-workbench-team-view-rename-duplicate-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-rename-duplicate-cleanup-20260310.json)

## 浏览器 Smoke

证据已归档到：

- [plm-workbench-team-view-rename-duplicate-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-rename-duplicate-20260310)

关键文件：

- [page-workbench-rename-duplicate.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-rename-duplicate-20260310/page-workbench-rename-duplicate.json)
- [page-workbench-rename-duplicate.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-rename-duplicate-20260310/page-workbench-rename-duplicate.png)

主路径：

1. 先通过 live API 创建源工作台视图：
   - `PLM Workbench Rename Source`
2. 打开：

```text
http://127.0.0.1:8899/plm?workbenchTeamView=9bc221b3-4f56-45ab-9976-e48eca9dc430
```

3. 在工作台团队视图块输入：
   - `PLM Workbench UI Copy`
4. 点击 `复制副本`
5. 等待下拉框自动切到新副本
6. 再输入：
   - `PLM Workbench UI Renamed`
7. 点击 `重命名`
8. 确认当前选中视图更新为：
   - `PLM Workbench UI Renamed · dev-user`

页面确认结果：

- 当前选中 workbench 团队视图 ID：
  - `8862cd8f-3308-4273-a38a-99bf50c1b19a`
- 当前选中 workbench 团队视图文本：
  - `PLM Workbench UI Renamed · dev-user`
- 复制/重命名过程中，工作台状态保持不变：
  - `documentFilter = rename-source-doc`
  - `approvalsFilter = rename-source-eco`
  - `cadReviewNote = rename-source-note`

最终 URL：

```text
http://127.0.0.1:8899/plm?cadReviewNote=rename-source-note&cadReviewState=approved&documentFilter=rename-source-doc&approvalsFilter=rename-source-eco&workbenchTeamView=9bc221b3-4f56-45ab-9976-e48eca9dc430
```

说明：

- 本轮浏览器 smoke 的核心验证点是：
  - UI 能真实触发 `duplicate / rename`
  - 新副本会自动成为当前选中视图
  - 复制与重命名不会破坏当前 workbench 状态
- URL 仍然保留源 workbench 的显式 deep link，这符合当前实现：本轮只做视图生命周期动作，不在同轮自动切换源链接引用

## 残留说明

- `/plm` 页面仍保留既有的 `PLM federation` 噪声：
  - `POST /api/federation/plm/query -> 403`
- 该噪声不阻断本轮 `rename / duplicate` 的工作台视图链路
- live backend 本轮已重启到当前代码，`7778` 运行态与本轮实现一致

## 验证结论

本轮 `PLM workbench team view rename / duplicate` 已达到可继续推进的状态：

1. `duplicate` 已支持把共享 workbench 视图 fork 成自己的副本
2. `rename` 已支持 owner 在当前入口直接改名
3. 后端 route、前端 client、hook、UI 都已接通
4. live API 与浏览器 smoke 均已闭环
5. 验证后临时 workbench 视图已清理，live 环境回到干净状态
