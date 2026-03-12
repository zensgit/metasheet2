# PLM Collaborative Permissions Team Preset Readonly Verification

日期: 2026-03-11

## 变更文件

- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmCollaborativePermissions.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamViews.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue`
- `/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## Focused 验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/usePlmTeamViews.spec.ts --watch=false`

结果：

- `2 files / 29 tests` 全通过
- 新增覆盖：
  - team preset transfer 后 `showManagementActions = false`
  - team preset transfer 后 `canShareTeamPreset = false`
  - team preset transfer 后 `canTransferTeamPreset = false`
  - 切到非 owner preset 时清空 owner transfer 输入

## Web 门禁

已通过：

- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- `apps/web` 当前为 `30 files / 149 tests`
- `type-check / lint / build` 全绿

## Live Setup

本轮 setup artifact：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-readonly-ui-boundary-20260311.json`

其中成功 transfer 的 BOM team preset：

- `id = 5d5a79fc-96ed-406b-a353-f700f505b95c`
- `owner = plm-transfer-user`
- `kind = bom`

## Browser Smoke

live dev 前端页面：

- `http://127.0.0.1:8899/plm?panel=bom&bomTeamPreset=5d5a79fc-96ed-406b-a353-f700f505b95c&bomFilter=root%2Freadonly-bom&bomFilterField=path`

证据：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-readonly-ui-boundary-browser-20260311.json`
- `/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-readonly-ui-boundary-20260311/page-team-preset-readonly-ui-boundary.png`

确认结果：

- 选中项仍恢复为 `Readonly BOM Preset Source 1047 (只读组) · plm-transfer-user`
- 可见按钮仅剩：
  - `刷新`
  - `应用`
  - `复制副本`
  - `保存到团队`
- 以下管理动作已从 UI 中移除：
  - `分享`
  - `归档`
  - `恢复`
  - `重命名`
  - `设为默认`
  - `取消默认`
  - `删除`
  - `转移所有者`
- owner transfer 输入框不存在

## Cleanup

已清理本轮临时 BOM 团队预设：

- `/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-readonly-ui-boundary-cleanup-20260311.json`

结果：

- 直接清理了 `3` 条临时数据：
  - `64ff673b-97d8-480d-a8de-f3b45156a8c3`
  - `5d5a79fc-96ed-406b-a353-f700f505b95c`
  - `4e3c8218-3208-42f3-a441-6bf9b1035acf`

## 环境说明

本轮 `7910` 上游 PLM 健康端口不可达，但这不影响验证结论，因为本轮验证路径只依赖：

- live backend `7778`
- live frontend/proxy `8899`

## 结论

这轮把 `PLM collaborative permissions` 从 panel team view 扩展到了 `BOM / Where-Used team preset`。

现在 team view 和 team preset 在 owner transfer 之后都进入同一套真正的只读 UI 语义：显式 deep link 仍有效，但非 owner 只保留 `应用 / 复制副本 / 保存到团队` 等使用路径，管理动作和 owner 输入都会退出界面。
