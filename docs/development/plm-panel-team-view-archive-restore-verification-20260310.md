# PLM Panel Team View Archive Restore 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 使用设计文档 [plm-panel-team-view-archive-restore-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-archive-restore-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- targeted test 当前为 `1 file / 9 tests`
- `apps/web test` 当前为 `30 files / 134 tests`
- web `type-check / lint / build` 与根级 `pnpm lint` 均通过

## 验证点

本轮实际收口的是前端接线与行为一致性：

1. `Documents / CAD / Approvals` team view 现在都能显示：
   - `归档`
   - `恢复`
2. 归档视图时：
   - 当前面板 `Apply` 会禁用
   - 当前 URL 只退出对应的 query key
3. 恢复视图时：
   - 同一个 team view id 会回到 URL
4. 当前面板状态保持不变

## Live Setup

本轮 live smoke 通过 live API 创建三条面板团队视图：

- Documents:
  - `41a7fde5-7728-46e0-8dba-0e8beda0d436`
- CAD:
  - `8f66dc5c-c096-45b9-9c90-99812408be01`
- Approvals:
  - `37ae9a24-80af-4862-a377-e105bf342e68`

对应面板状态：

- Documents:
  - `documentRole=primary`
  - `documentFilter=doc-archive-live`
  - `documentSort=name`
  - `documentSortDir=asc`
- CAD:
  - `cadFileId=cad-archive-live`
  - `cadOtherFileId=cad-archive-other`
  - `cadReviewState=approved`
  - `cadReviewNote=cad-archive-note`
- Approvals:
  - `approvalsFilter=approvals-archive-live`
  - `approvalComment=archive-comment`
  - `approvalSort=title`
  - `approvalSortDir=asc`

setup 产物：

- [plm-panel-team-view-archive-restore-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-archive-restore-20260310.json)

补充说明：

- 这轮 `7910` 上游 PLM 健康端口当时不可达
- 但本轮验证路径只依赖 `8899` 前端代理与 `7778` live backend 的 team view 路由，不依赖联邦 PLM 数据本体

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 打开：

```text
http://127.0.0.1:8899/plm?documentTeamView=41a7fde5-7728-46e0-8dba-0e8beda0d436&cadTeamView=8f66dc5c-c096-45b9-9c90-99812408be01&approvalsTeamView=37ae9a24-80af-4862-a377-e105bf342e68
```

2. 页面自动恢复出：
   - `documentRole=primary`
   - `documentFilter=doc-archive-live`
   - `cadFileId=cad-archive-live`
   - `cadOtherFileId=cad-archive-other`
   - `cadReviewState=approved`
   - `cadReviewNote=cad-archive-note`
   - `approvalsFilter=approvals-archive-live`
   - `approvalComment=archive-comment`
3. 在三个面板分别点击：
   - `文档 -> 归档`
   - `CAD -> 归档`
   - `审批 -> 归档`
4. 验证归档后 URL 变成：

```text
http://127.0.0.1:8899/plm?documentRole=primary&documentFilter=doc-archive-live&documentSort=name&documentSortDir=asc&approvalsFilter=approvals-archive-live&approvalComment=archive-comment&approvalSort=title&approvalSortDir=asc&cadFileId=cad-archive-live&cadOtherFileId=cad-archive-other&cadReviewState=approved&cadReviewNote=cad-archive-note
```

5. 再从三个面板的下拉中选中已归档 team view，并分别点击：
   - `恢复`
6. 验证恢复后 URL 变成：

```text
http://127.0.0.1:8899/plm?documentRole=primary&documentFilter=doc-archive-live&documentSort=name&documentSortDir=asc&approvalsFilter=approvals-archive-live&approvalComment=archive-comment&approvalSort=title&approvalSortDir=asc&cadFileId=cad-archive-live&cadOtherFileId=cad-archive-other&cadReviewState=approved&cadReviewNote=cad-archive-note&documentTeamView=41a7fde5-7728-46e0-8dba-0e8beda0d436&cadTeamView=8f66dc5c-c096-45b9-9c90-99812408be01&approvalsTeamView=37ae9a24-80af-4862-a377-e105bf342e68
```

关键结果：

1. `archive` 只退出对应面板的显式 identity
2. 归档过程中 `document / cad / approvals` 当前状态保持不变
3. 目录项会显示：
   - `· 已归档`
4. 归档项不能继续 `apply`
5. `restore` 后同一个 id 会重新回到 URL

产物：

- [plm-panel-team-view-archive-restore-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-archive-restore-browser-20260310.json)
- [page-panel-team-view-archive-restore.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-archive-restore-20260310/page-panel-team-view-archive-restore.png)
- [page-panel-team-view-archive-restore.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-archive-restore-20260310/page-panel-team-view-archive-restore.txt)

补充说明：

- 页面中仍可见既有的 `API error: 403 Forbidden（已回退默认字段）` compare fallback 噪声，不影响本轮 `Documents / CAD / Approvals team view archive / restore` 主路径

## Cleanup 验证

本轮临时 team view 已通过 live API 删除，环境恢复干净：

- documents total = `0`
- cad total = `0`
- approvals total = `0`

cleanup 产物：

- [plm-panel-team-view-archive-restore-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-archive-restore-cleanup-20260310.json)

## 验证结论

本轮 `PLM panel team view archive / restore` 已达到可继续推进的状态：

1. 后端 generic team view `archive / restore` 已可复用
2. `Documents / CAD / Approvals` 前端面板已完成接线
3. `archive` 会让对应 query identity 正确退场
4. `restore` 会让同一个 view id 正确回到 URL
5. 当前面板状态在整个周期内保持不变
6. 代码级门禁、live API、浏览器 smoke 与 cleanup 均已通过
