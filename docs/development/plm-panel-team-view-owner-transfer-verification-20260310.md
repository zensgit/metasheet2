# PLM Panel Team View Owner Transfer 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamViews.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts)
- 更新 [PlmTeamViewsBlock.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmProductPanel.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmProductPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue)
- 更新 [PlmDocumentsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue)
- 更新 [PlmCadPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue)
- 更新 [PlmApprovalsPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [usePlmTeamViews.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 使用本轮设计文档 [plm-panel-team-view-owner-transfer-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-panel-team-view-owner-transfer-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend route focused test 通过，新增覆盖 `transfer success / missing target owner`
- `usePlmTeamViews / plmWorkbenchClient` focused tests 通过
- `apps/web` 当前为 `30 files / 136 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 全部通过

## 聚焦覆盖点

本轮验证的重点是 `owner transfer` 与 deep link identity 没有互相打架：

1. panel team view 转移后仍保留原 id
2. URL 不会跳走
3. 当前列表项 owner 会立即切换
4. 当前用户会立即失去管理权限
5. 目标 owner 不存在时会被拒绝

## Live API 准备

本轮 live 准备做了两件事：

1. 创建激活用户：
   - `plm-transfer-user`
2. 创建 source team view：
   - kind: `documents`
   - id: `0e798b6f-7372-42c2-b341-3fd3ecc7e8a8`
   - name: `Transfer Panel View Source`
   - owner: `dev-user`

转移完成后数据库实况为：

- `owner_user_id = plm-transfer-user`
- `kind = documents`
- `name = Transfer Panel View Source`
- `state.filter = transfer-doc`
- `state.role = primary`

产物：

- [plm-panel-team-view-owner-transfer-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-owner-transfer-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 直接打开：

```text
http://127.0.0.1:8899/plm?documentTeamView=0e798b6f-7372-42c2-b341-3fd3ecc7e8a8&documentRole=primary&documentFilter=transfer-doc
```

2. 页面初始选中：
   - `Transfer Panel View Source · dev-user`
3. 在 `文档目标用户 ID` 输入：
   - `plm-transfer-user`
4. 点击：
   - `转移所有者`
5. 页面提示：
   - `已将文档团队视角转移给：plm-transfer-user`
6. 页面选中项切换为：
   - `Transfer Panel View Source · plm-transfer-user`
7. URL 保持为：

```text
http://127.0.0.1:8899/plm?documentTeamView=0e798b6f-7372-42c2-b341-3fd3ecc7e8a8&documentRole=primary&documentFilter=transfer-doc
```

8. 当前用户管理按钮已收口：
   - `设为默认` disabled
   - `删除` disabled
   - `归档` disabled
   - `转移所有者` disabled

关键结果：

1. owner 已变化
2. identity 未变化
3. URL 未变化
4. 当前用户权限已变化

产物：

- [plm-panel-team-view-owner-transfer-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-owner-transfer-browser-20260310.json)
- [page-panel-team-view-owner-transfer.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-owner-transfer-20260310/page-panel-team-view-owner-transfer.png)
- [page-panel-team-view-owner-transfer.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-owner-transfer-20260310/page-panel-team-view-owner-transfer.txt)

## Live Cleanup 验证

本轮 live 临时数据已全部清理：

1. 删除 team view：
   - `0e798b6f-7372-42c2-b341-3fd3ecc7e8a8`
2. 删除测试用户：
   - `plm-transfer-user`

清理后数据库状态：

- `remainingView.count = 0`
- `remainingUser.count = 0`

产物：

- [plm-panel-team-view-owner-transfer-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-owner-transfer-cleanup-20260310.json)

## 验证结论

本轮 `PLM panel team view owner transfer` 已达到可继续扩展的状态：

1. `Documents / CAD / Approvals team view` 已具备统一的 owner transfer 接线
2. transfer 后会保持当前 team view id，不打断 deep link
3. transfer 后列表项 owner、URL identity、数据库 owner 已保持一致
4. 当前用户会立即失去管理权限，不会继续误操作刚转出的对象
5. 代码级测试、包级质量门、live 浏览器 smoke 全部通过
6. live 临时数据已清理，环境恢复干净
