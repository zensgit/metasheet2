# PLM Workbench Team View Archive Restore 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 新增迁移 [zzzz20260310170000_add_archived_to_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260310170000_add_archived_to_plm_workbench_team_views.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新测试：
  - [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
  - [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
  - [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
  - [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-view-archive-restore-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-archive-restore-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-team-views.test.ts tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend targeted tests 当前为 `2 files / 19 tests`
- `apps/web test` 当前为 `30 files / 132 tests`
- backend migrate/build、web `type-check / lint / build` 与根级 `pnpm lint` 均通过

## 单测覆盖点

本轮新增覆盖：

1. `mapPlmWorkbenchTeamViewRow()` 会把 `archived_at` 转成：
   - `isArchived`
   - `archivedAt`
2. `archive route` 会返回：
   - `isArchived: true`
   - `isDefault: false`
3. `restore route` 会返回：
   - `isArchived: false`
4. frontend client 会正确映射 `archive / restore`
5. `usePlmTeamViews` 在当前 `workbench` 视图归档后会：
   - 清空 `requestedViewId`
   - 清空 `teamViewKey`
   - 保留当前 query 状态
6. `restore` 后会重新占住原 `workbenchTeamView` id

## Live Setup

本轮 live smoke 先通过 live API 创建一条显式 `workbench` 团队视图：

- `2592774a-2aba-4a43-91ed-0460c5bf0763`
- `Archive Restore Smoke View`

其 query 状态为：

- `documentRole=archive-secondary`
- `documentFilter=archive-doc`
- `approvalsFilter=archive-eco`
- `cadReviewState=approved`
- `cadReviewNote=archive-note`

产物：

- [plm-workbench-team-view-archive-restore-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-archive-restore-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 打开：

```text
http://127.0.0.1:8899/plm?workbenchTeamView=2592774a-2aba-4a43-91ed-0460c5bf0763
```

2. 页面自动恢复出：
   - `documentRole=archive-secondary`
   - `documentFilter=archive-doc`
   - `approvalsFilter=archive-eco`
   - `cadReviewState=approved`
   - `cadReviewNote=archive-note`
3. 点击当前 `workbench` 团队视图 `归档`
4. 验证归档后 URL 变成：

```text
http://127.0.0.1:8899/plm?documentRole=archive-secondary&cadReviewNote=archive-note&cadReviewState=approved&documentFilter=archive-doc&approvalsFilter=archive-eco
```

5. 再从下拉中选择已归档视图并点击 `恢复`
6. 验证恢复后 URL 变成：

```text
http://127.0.0.1:8899/plm?documentRole=archive-secondary&cadReviewNote=archive-note&cadReviewState=approved&documentFilter=archive-doc&approvalsFilter=archive-eco&workbenchTeamView=2592774a-2aba-4a43-91ed-0460c5bf0763
```

关键结果：

1. `archive` 后 `workbenchTeamView` 已从 URL 中退出
2. 当前 `document / approvals / cad` query 状态继续保留
3. 目录项会显示 `· 已归档`
4. `restore` 后会回到同一个 `workbenchTeamView` id
5. 当前工作台状态没有在 `archive / restore` 过程中丢失

产物：

- [plm-workbench-team-view-archive-restore-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-archive-restore-browser-20260310.json)
- [page-workbench-team-view-archive-restore.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-archive-restore-20260310/page-workbench-team-view-archive-restore.txt)

补充说明：

- `chrome-devtools` 的整页截图在这个超长 `/plm` 页面上超时，因此本轮保留了结构化 browser JSON 和页面 snapshot 文本作为实机证据
- 页面里仍可见既有的 `API error: 403 Forbidden（已回退默认字段）`，这是旧的 compare fallback 噪声，不影响本轮 `archive / restore` 主路径

## Cleanup 验证

本轮临时 `workbench team view` 已通过 live API 删除，环境恢复干净：

- `deleteStatus = 200`
- `message = "PLM team view deleted successfully"`

产物：

- [plm-workbench-team-view-archive-restore-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-archive-restore-cleanup-20260310.json)

## 验证结论

本轮 `PLM workbench team view archive / restore` 已达到可继续推进的状态：

1. 后端已有稳定的 `archive / restore` 路由与数据模型
2. frontend hook / client / UI 已完成接线
3. `archive` 会让 URL identity 正确退场
4. `restore` 会让同一个 view id 正确回到 URL
5. 当前工作台 query 状态在 `archive / restore` 周期中保持不变
6. 代码级测试、包级门禁、live API 与浏览器 smoke 均已通过
