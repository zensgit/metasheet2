# PLM Team View Deep Links 验证记录

日期: 2026-03-09

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-team-view-deeplinks-benchmark-design-20260309.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-view-deeplinks-benchmark-design-20260309.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- 聚焦单测通过，当前为 `1 file / 4 tests`
- `apps/web test` 当前为 `29 files / 114 tests`
- `apps/web type-check / lint / build`、根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

[usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts) 本轮新增覆盖：

1. 显式 `requestedViewId` 存在时，优先应用该团队视图，而不是默认视图
2. 应用显式团队视图后，会同步触发 `syncRequestedViewId`

这条测试锁住了本轮最关键的行为：

- `query 指定的 team view > 默认 team view`

## 上游健康检查

已通过：

- `curl http://127.0.0.1:7910/api/v1/health`

结果：

- 返回 `200`

## Live API 验证

这轮 live API 用来准备浏览器 smoke 所需的测试数据。

已通过：

- `GET /api/auth/dev-token`
- `POST /api/plm-workbench/views/team`
- `GET /api/plm-workbench/views/team?kind=documents|cad|approvals`
- `DELETE /api/plm-workbench/views/team/:id`

结果：

- 成功创建三条 team views：
  - `Docs Link View`
  - `CAD Link View`
  - `Approvals Link View`
- 每条创建请求都返回 `201`
- 验证后已全部清理，当前三类 team views 列表均为空

创建结果摘要：

```json
{
  "documents": {
    "status": 201,
    "id": "c00960dc-2147-4162-9c2e-2cc76e749433"
  },
  "cad": {
    "status": 201,
    "id": "d7d4e52a-2181-4ec6-937b-1444331a41ba"
  },
  "approvals": {
    "status": 201,
    "id": "e3c1131d-eb9a-4429-8599-df446abdad7a"
  }
}
```

清理后摘要：

```json
{
  "documents": { "total": 0, "defaultViewId": null },
  "cad": { "total": 0, "defaultViewId": null },
  "approvals": { "total": 0, "defaultViewId": null }
}
```

## 浏览器 Smoke

证据已归档到：

- [plm-team-view-deeplinks-20260309](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-view-deeplinks-20260309)

关键文件：

- [page-open-via-team-view-query.yml](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-view-deeplinks-20260309/page-open-via-team-view-query.yml)
- [page-open-via-team-view-query.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-view-deeplinks-20260309/page-open-via-team-view-query.png)

主路径：

1. 通过 live API 创建三条测试 team views
2. 直接打开：
   - `/plm?documentTeamView=<docs-id>&cadTeamView=<cad-id>&approvalsTeamView=<approvals-id>`
3. 等待页面完成 team views refresh 与 query sync
4. 确认 URL 扩展为：
   - `documentTeamView=...`
   - `cadTeamView=...`
   - `approvalsTeamView=...`
   - `documentRole=primary`
   - `documentFilter=link-gear`
   - `approvalsFilter=link-eco`
   - `cadFileId=cad-link-main`
   - `cadOtherFileId=cad-link-other`
   - `cadReviewState=approved`
   - `cadReviewNote=deeplink`
5. 确认页面中三个团队视图下拉分别选中：
   - `Docs Link View · dev-user`
   - `CAD Link View · dev-user`
   - `Approvals Link View · dev-user`
6. 确认字段状态同步到 UI：
   - 文档过滤为 `link-gear`
   - CAD File ID 为 `cad-link-main`
   - CAD 对比 File ID 为 `cad-link-other`
   - CAD 评审备注为 `deeplink`
   - 审批过滤为 `link-eco`
7. 通过 live API 清理测试数据

主结论：

- 显式 team view query 已能驱动三块面板恢复共享视图
- 页面不会只恢复“字段值”，也会恢复“当前选中的团队视图”
- deep-link 路径已同时保留：
  - `team view identity`
  - `resolved field state`

## 残留说明

- 打开 `/plm` 时仍会出现一次既有的 `POST /api/federation/plm/query -> 403`
- 这是当前 `PLM federation` 的历史噪声，不阻断 team view deeplink 的恢复流程

## 验证结论

本轮 `PLM team view deeplinks` 已达到可继续推进的状态：

1. `/plm` 已支持显式 `documentTeamView / cadTeamView / approvalsTeamView` query
2. team view query 会优先于默认恢复生效
3. 页面会在恢复 team view 后补齐具体字段 query，形成可分享的完整 URL
4. 浏览器 smoke 已确认三块面板都能按 team view query 恢复
5. 验证后临时 team views 已清理，当前 live 环境回到干净状态
