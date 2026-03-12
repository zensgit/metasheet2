# PLM Panel Team View Readonly UI Boundary Verification

日期: 2026-03-11

## 变更文件

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmTeamViewsBlock.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmProductPanel.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmProductPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmDocumentsPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmCadPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmApprovalsPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamViews.spec.ts`

## Focused 验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamViews.spec.ts --watch=false`

结果：

- `16 tests` 全通过
- 新增覆盖：
  - owner transfer 后 `showManagementActions = false`
  - 切到非 owner 视图时清空 `teamViewOwnerUserId`

## Web 门禁

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前为 `30 files / 148 tests`
- `type-check / lint / build` 全绿

## Live Setup

本轮沿用 live setup artifact：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-readonly-ui-boundary-20260311.json`

其中 documents team view:

- `id = c746900a-4ba7-44c7-8505-915ce546225e`
- 初始 owner: `dev-user`
- transfer 后 owner: `plm-transfer-user`
- `canManage = false`

## Browser Smoke

已在 live dev 前端 `8899` 复验显式 deep link：

- `http://127.0.0.1:8899/plm?panel=documents&documentTeamView=c746900a-4ba7-44c7-8505-915ce546225e&approvalsFilter=readonly-eco&cadReviewNote=readonly-note&cadReviewState=approved`

证据：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-readonly-ui-boundary-browser-20260311.json`
- `/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-panel-team-view-readonly-ui-boundary-20260311/page-panel-team-view-readonly-ui-boundary.png`

确认结果：

- 选中视图仍为 `Readonly UI Boundary Source · plm-transfer-user`
- 可见按钮仅剩：
  - `复制深链接`
  - `导出 CSV`
  - `刷新文档`
  - `刷新`
  - `应用`
  - `复制副本`
  - `保存到团队`
- 以下管理动作已从 UI 中移除：
  - `分享`
  - `设为默认`
  - `取消默认`
  - `删除`
  - `归档`
  - `恢复`
  - `重命名`
  - `转移所有者`
- owner transfer 输入框不存在

## Cleanup

临时 live 数据已清理：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-panel-team-view-readonly-ui-boundary-cleanup-20260311.json`

结果：

- `deleted = 1`

## 结论

这轮把 `Documents / CAD / Approvals team view` 的 owner transfer 边界从“禁用管理动作”推进到了“真正的只读 UI 边界”。

显式 deep link 仍然有效，但非 owner 已不再看到管理面和 owner transfer 输入，协作语义与界面语义已一致。
