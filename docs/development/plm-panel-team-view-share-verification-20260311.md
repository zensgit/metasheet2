# PLM Panel Team View Share 验证记录

日期: 2026-03-11

## 变更范围

- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 更新 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 使用设计文档 [plm-panel-team-view-share-benchmark-design-20260311.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-share-benchmark-design-20260311.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchViewState.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- focused tests `2 files / 15 tests` 通过
- `apps/web` package 级测试通过，当前为 `30 files / 143 tests`
- `type-check / lint / build` 全部通过
- 根级 `pnpm lint` 通过

## 聚焦覆盖点

本轮重点锁住的是“分享出去的仍然是 panel team view identity”：

1. Documents 分享 URL 会带 `documentTeamView`
2. CAD 分享 URL 会带 `cadTeamView`
3. Approvals 分享 URL 会带 `approvalsTeamView`
4. 分享 URL 还会保留当前 panel 关键状态
5. fresh `/plm` 打开分享 URL 后，会恢复 team view id，而不是只恢复文本字段

## Live API 准备

本轮 live 创建了三条 team view：

1. Documents
   - `c7af9e28-e525-44c7-8a8a-08e46558f4ec`
   - `Share Documents View`
2. CAD
   - `9af3a52e-bd08-46fb-95d9-5ec040286e1f`
   - `Share CAD View`
3. Approvals
   - `3d762c41-7f27-4de6-aae6-12181cbd7e5d`
   - `Share Approvals View`

setup artifact：

- [plm-panel-team-view-share-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-20260311.json)

## Browser Smoke 验证

### Documents 分享

浏览器已真实走通：

1. 通过显式 `documentTeamView` deep link 打开 source 页面
2. 点击：
   - `分享`
3. 捕获复制 URL：

```text
http://127.0.0.1:8899/plm?panel=documents&documentTeamView=c7af9e28-e525-44c7-8a8a-08e46558f4ec&documentRole=primary&documentFilter=share-gear&documentSort=name&documentSortDir=asc&documentColumns=mime%2Crole
```

4. fresh 页面打开该链接后，恢复结果为：
   - `documentTeamView = c7af9e28-e525-44c7-8a8a-08e46558f4ec`
   - `documentRole = primary`
   - `documentFilter = share-gear`
   - `documentSort = name`
   - `documentSortDir = asc`

### CAD 分享

浏览器已真实走通：

1. 通过显式 `cadTeamView` deep link 打开 source 页面
2. 点击：
   - `分享`
3. 捕获复制 URL：

```text
http://127.0.0.1:8899/plm?panel=cad&cadTeamView=9af3a52e-bd08-46fb-95d9-5ec040286e1f&cadFileId=cad-share-main&cadOtherFileId=cad-share-other&cadReviewState=approved&cadReviewNote=share-note
```

4. fresh 页面打开该链接后，恢复结果为：
   - `cadTeamView = 9af3a52e-bd08-46fb-95d9-5ec040286e1f`
   - `cadFileId = cad-share-main`
   - `cadOtherFileId = cad-share-other`
   - `cadReviewState = approved`
   - `cadReviewNote = share-note`

### Approvals 分享

浏览器已真实走通：

1. 通过显式 `approvalsTeamView` deep link 打开 source 页面
2. 点击：
   - `分享`
3. 捕获复制 URL：

```text
http://127.0.0.1:8899/plm?panel=approvals&approvalsTeamView=3d762c41-7f27-4de6-aae6-12181cbd7e5d&approvalsStatus=approved&approvalsFilter=share-eco&approvalComment=share-comment&approvalSort=title&approvalSortDir=asc&approvalColumns=status%2Cproduct
```

4. fresh 页面打开该链接后，恢复结果为：
   - `approvalsTeamView = 3d762c41-7f27-4de6-aae6-12181cbd7e5d`
   - `approvalsStatus = approved`
   - `approvalsFilter = share-eco`
   - `approvalComment = share-comment`
   - `approvalSort = title`
   - `approvalSortDir = asc`

browser artifact：

- [plm-panel-team-view-share-browser-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-browser-20260311.json)
- [page-panel-team-view-share.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-share-20260311/page-panel-team-view-share.png)
- [page-panel-team-view-share.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-share-20260311/page-panel-team-view-share.txt)

## 验证结论

本轮已经确认：

1. `Documents / CAD / Approvals team view` 已具备显式分享入口
2. 分享链接传递的是稳定 team view id，不是匿名 payload
3. 分享链接会保留当前 panel 的关键工作状态
4. fresh `/plm` 打开分享链接后，会恢复 panel team view identity 与面板状态
5. `workbench / local preset / default team view` 不会吞掉显式 panel team view deep link

## Live Cleanup 验证

本轮临时数据已全部清理：

- `c7af9e28-e525-44c7-8a8a-08e46558f4ec`
- `9af3a52e-bd08-46fb-95d9-5ec040286e1f`
- `3d762c41-7f27-4de6-aae6-12181cbd7e5d`

清理后 live 状态：

- `documents = 0`
- `cad = 0`
- `approvals = 0`

cleanup artifact：

- [plm-panel-team-view-share-cleanup-20260311.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-share-cleanup-20260311.json)
