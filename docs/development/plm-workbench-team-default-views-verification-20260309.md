# PLM Workbench Team Default Views 验证记录

日期: 2026-03-09

## 变更范围

- 新增 [plmWorkbenchTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmWorkbenchTeamViews.ts)
- 新增迁移 [zzzz20260309143000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts)
- 兼容 no-op 迁移 [zzzz20260309150000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309150000_create_plm_workbench_team_views.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plm-workbench-team-views.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-team-views.test.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 新增 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 新增 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-default-views-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-default-views-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-team-views.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `core-backend` 聚焦单测通过，当前为 `2 files / 6 tests`
- `apps/web` 聚焦测试通过，当前为 `2 files / 5 tests`
- `apps/web test` 当前为 `29 files / 111 tests`
- `apps/web type-check / lint / build`、`core-backend build`、根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 数据库迁移验证

已通过：

- `pnpm --filter @metasheet/core-backend migrate`

结果：

- 主迁移 [zzzz20260309143000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309143000_create_plm_workbench_team_views.ts) 已成功执行
- 兼容迁移 [zzzz20260309150000_create_plm_workbench_team_views.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260309150000_create_plm_workbench_team_views.ts) 当前为 no-op，用于兼容并行开发期间本地数据库已经记录过的旧 timestamp

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## Live Runtime 对齐

这轮验证继续沿用当前 live backend：

- `7778` 运行的是本轮代码版本
- 启动剖面为 `PRODUCT_MODE=plm-workbench`
- `WORKFLOW_ENABLED=true`

说明：

- [package.json](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/package.json) 中 `dev:core` 不是 watch 模式
- 因此本轮新增 route 只有在重启 live backend 后，`8899 -> 7778` 代理链才会真实反映新行为
- 当前验证阶段使用的 live backend 已经是重启后的新进程

## Live API 验证

已通过：

- `GET /api/auth/dev-token`
- `GET /api/auth/me`
- `POST /api/plm-workbench/views/team`
- `POST /api/plm-workbench/views/team/:id/default`
- `GET /api/plm-workbench/views/team?kind=documents|cad|approvals`
- `DELETE /api/plm-workbench/views/team/:id/default`
- `DELETE /api/plm-workbench/views/team/:id`

结果：

- `auth/me` 返回 `200`
- `features.mode = plm-workbench`
- 三类 team views 都已走通 `save -> set default -> list -> clear default -> delete`

真实 spot-check 返回如下：

```json
{
  "cases": [
    {
      "kind": "documents",
      "saveStatus": 201,
      "setDefaultStatus": 200,
      "listStatus": 200,
      "defaultViewId": "95c2591e-80bf-4f9b-bbbe-cad437c92171",
      "listIsDefault": true,
      "clearDefaultStatus": 200,
      "deleteStatus": 200
    },
    {
      "kind": "cad",
      "saveStatus": 201,
      "setDefaultStatus": 200,
      "listStatus": 200,
      "defaultViewId": "6849ef55-e6cd-436d-affd-f38fc3e80190",
      "listIsDefault": true,
      "clearDefaultStatus": 200,
      "deleteStatus": 200
    },
    {
      "kind": "approvals",
      "saveStatus": 201,
      "setDefaultStatus": 200,
      "listStatus": 200,
      "defaultViewId": "76c98242-d112-42fa-9147-b00053fe47cc",
      "listIsDefault": true,
      "clearDefaultStatus": 200,
      "deleteStatus": 200
    }
  ]
}
```

补充清理验证：

```json
{
  "documents": { "total": 0, "defaultViewId": null },
  "cad": { "total": 0, "defaultViewId": null },
  "approvals": { "total": 0, "defaultViewId": null }
}
```

## 浏览器 Smoke

证据已归档到：

- [plm-workbench-team-default-views-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-default-views-20260309)

关键文件：

- [page-documents-default-set.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-default-views-20260309/page-documents-default-set.yml)
- [page-cad-approvals-default-set.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-default-views-20260309/page-cad-approvals-default-set.yml)
- [page-restore.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-default-views-20260309/page-restore.yml)
- [page-restore.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-default-views-20260309/page-restore.png)

主路径：

1. 在 live `/plm` 页面为 `Documents` 保存 `Docs Default View`
2. 选中该视图并设为默认
3. 在同一会话中为 `CAD` 保存 `Cad Default View`
4. 将 `Cad Default View` 设为默认
5. 为 `Approvals` 保存 `Approvals Default View`
6. 将 `Approvals Default View` 设为默认
7. 新开干净浏览器会话，直接打开空的 `http://127.0.0.1:8899/plm`
8. 确认地址栏自动恢复为：
   - `?documentRole=primary`
   - `&documentFilter=gear`
   - `&approvalsFilter=eco`
   - `&cadFileId=cad-main-01`
   - `&cadOtherFileId=cad-other-02`
   - `&cadReviewState=approved`
   - `&cadReviewNote=team+default`
9. 确认页面中出现：
   - `Docs Default View · dev-user · 默认`
   - `Cad Default View · dev-user · 默认`
   - `Approvals Default View · dev-user · 默认`
10. 通过 live API 清理三类 team views，并确认列表恢复为空

主结论：

- `Documents / CAD / Approvals` 的团队视图保存与默认设置均已在浏览器实机走通
- 空的 `/plm` 会自动恢复三类默认视角，而不是只恢复单面板
- 文档、CAD、审批的默认项都能在 UI 中显示 `· 默认` 和 `当前默认：...`

## 已发现并修正的问题

这轮浏览器 smoke 抓到一个真实问题：

- `Documents` 初次 smoke 只保存了 team view，但没有真正将其设为默认
- 新会话恢复时只带回了 `CAD / Approvals`，没有带回 `Documents`

处理结果：

- 已回到 live UI 重新选中 `Docs Default View`
- 再次执行 `设为默认`
- 随后重新打开空 `/plm`，地址栏已正确恢复 `documentRole=primary&documentFilter=gear`

这说明：

- 默认恢复逻辑本身没有问题
- 问题在于首轮 smoke 没有把文档视图真正落成默认项
- 修正后，三类视图的默认恢复已经完整闭环

## 残留说明

- 打开 `/plm` 时仍会出现一次既有的 `POST /api/federation/plm/query -> 403`
- 这是当前 `PLM federation` 的历史噪声，不阻断 team views 的保存、默认恢复和清理流程

## 验证结论

本轮 `PLM workbench team views` 已达到可继续推进的状态：

1. 后端资源、唯一默认约束和 owner 权限已生效
2. 前端三块面板都已接入统一 team views 生命周期
3. live API 已走通三类视图的完整 CRUD + default 流程
4. 浏览器 smoke 已证明空 `/plm` 能自动恢复 `Documents / CAD / Approvals` 的默认团队视角
5. 验证后临时数据已清理，当前 live 环境回到干净状态
