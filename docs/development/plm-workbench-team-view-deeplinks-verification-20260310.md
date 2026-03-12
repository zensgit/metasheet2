# PLM Workbench Team View Deep Links 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 使用本轮设计文档 [plm-workbench-team-view-deeplinks-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-workbench-team-view-deeplinks-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web test` 当前为 `30 files / 118 tests`
- `apps/web type-check / lint / build` 通过
- 根级 `pnpm lint` 通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. `workbenchTeamView` 已进入 `PLM workbench` 允许 query key 集合
2. `mergePlmWorkbenchRouteQuery()` 会在保留非 `PLM` query 的同时合入 `workbenchTeamView`
3. `usePlmTeamViews()` 在应用 `workbench` 视图时，会先同步 requested id，再应用视图状态

## Live API 验证

已通过：

- `curl http://127.0.0.1:7778/health`
- `GET /api/auth/dev-token`
- `POST /api/plm-workbench/views/team`
- `GET /api/plm-workbench/views/team?kind=workbench`
- `DELETE /api/plm-workbench/views/team/:id`

本轮 live 数据设计为两条冲突视图：

1. 显式视图：
   - `PLM Workbench Explicit Link View`
   - 非默认
   - 状态：
     - `documentRole = secondary`
     - `documentFilter = explicit-link-doc`
     - `approvalsFilter = explicit-link-eco`
     - `approvalsStatus = pending`
     - `cadReviewState = rejected`
     - `cadReviewNote = explicit-link-note`
2. 冲突默认视图：
   - `PLM Workbench Default Override View`
   - 默认
   - 状态：
     - `documentRole = primary`
     - `documentFilter = default-override-doc`
     - `approvalsFilter = default-override-eco`
     - `cadReviewState = approved`
     - `cadReviewNote = default-override-note`

结果：

- 显式视图创建成功
- 冲突默认视图创建成功
- `list(kind=workbench)` 返回：
  - `total >= 2`
  - `defaultViewId` 指向默认视图
- 验证后两条临时视图均已删除
- 清理后 `kind=workbench` 列表恢复为：
  - `total: 0`
  - `defaultViewId: null`

产物：

- [plm-workbench-team-view-deeplink-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-deeplink-20260310.json)
- [plm-workbench-team-view-deeplink-precedence-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-deeplink-precedence-20260310.json)
- [plm-workbench-team-view-deeplink-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-workbench-team-view-deeplink-cleanup-20260310.json)

## 浏览器 Smoke

证据已归档到：

- [plm-workbench-team-view-deeplinks-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-deeplinks-20260310)

关键文件：

- [page-open-via-explicit-workbench-view.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-deeplinks-20260310/page-open-via-explicit-workbench-view.png)
- [page-open-via-explicit-workbench-view.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-workbench-team-view-deeplinks-20260310/page-open-via-explicit-workbench-view.json)

主路径：

1. 通过 live API 创建一条显式 `workbench` 团队视图
2. 再创建一条冲突的默认 `workbench` 团队视图
3. 打开：

```text
http://127.0.0.1:8899/plm?workbenchTeamView=1ed0bc0f-c7bd-46ec-9ff6-9f312b08efe6
```

4. 等待 auth bootstrap 与 team views refresh 完成
5. 确认页面选中显式视图，而不是默认视图
6. 确认 URL 被展开成显式视图对应的具体状态
7. 清理两条临时视图

页面确认结果：

- 当前选中的工作台团队视图为：
  - `PLM Workbench Explicit Link View · dev-user`
- 页面同时展示的默认标签为：
  - `当前默认：PLM Workbench Default Override View`
- 这说明：
  - 默认视图存在
  - 但显式 `workbenchTeamView` 仍然优先生效
- 页面恢复到的状态为：
  - `documentRole = secondary`
  - `documentFilter = explicit-link-doc`
  - `approvalsFilter = explicit-link-eco`
  - `cadReviewState = rejected`
  - `cadReviewNote = explicit-link-note`

最终 URL：

```text
http://127.0.0.1:8899/plm?documentRole=secondary&cadReviewNote=explicit-link-note&cadReviewState=rejected&documentFilter=explicit-link-doc&approvalsFilter=explicit-link-eco&workbenchTeamView=1ed0bc0f-c7bd-46ec-9ff6-9f312b08efe6
```

## 残留说明

- `/plm` 页面仍保留既有的 `PLM federation` 噪声：
  - `POST /api/federation/plm/query -> 403`
- 该噪声不阻断本轮 `workbenchTeamView` 显式恢复链路
- 本轮没有新增后端 schema 变化；验证重点在前端 query 协议与 live 运行态行为

## 验证结论

本轮 `PLM workbench team view deeplinks` 已达到可继续推进的状态：

1. `/plm` 已正式支持 `workbenchTeamView=<id>` 显式引用
2. `copyDeepLink / buildDeepLinkUrl` 现在会保留当前 `workbench` 视图身份
3. 页面恢复后，会同时带回显式视图对应的具体字段状态
4. 当默认工作台视图存在时，显式 `workbenchTeamView` 仍优先生效
5. 代码级验证、live API 与浏览器 smoke 都已闭环
6. 验证后临时 `workbench` 视图已清理，live 环境回到干净状态
