# PLM Team Preset Owner Transfer 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-preset-owner-transfer-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-owner-transfer-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmWorkbenchClient.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

结果：

- backend route focused test 通过，新增覆盖 `team preset transfer success / missing target owner`
- `usePlmTeamFilterPresets / plmWorkbenchClient` focused tests 通过
- `apps/web` 当前为 `30 files / 138 tests`
- `apps/web type-check / lint / build`、`core-backend build` 与根级 `pnpm lint` 全部通过

## 聚焦覆盖点

本轮验证的重点是 `owner transfer` 与 deep link identity 没有互相打架：

1. `BOM / Where-Used team preset` 转移后仍保留原 id
2. URL 不会跳走
3. 当前列表项 owner 会立即切换
4. 当前用户会立即失去管理权限
5. 目标 owner 不存在时会被拒绝

## Live API 准备

本轮 live 准备做了三件事：

1. 创建激活用户：
   - `plm-preset-transfer-user`
2. 创建 source `bom team preset`：
   - `e940479d-b025-47f7-9e44-9a8d679e9916`
   - `Transfer BOM Team Preset Source`
3. 创建 source `where-used team preset`：
   - `bbaff28d-dfbe-4264-901d-6ec83c49c637`
   - `Transfer Where-Used Team Preset Source`

准备完成后，页面入口为：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=e940479d-b025-47f7-9e44-9a8d679e9916&whereUsedTeamPreset=bbaff28d-dfbe-4264-901d-6ec83c49c637
```

产物：

- [plm-team-preset-owner-transfer-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-owner-transfer-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 直接打开显式 `bomTeamPreset + whereUsedTeamPreset` deep link
2. 页面初始选中：
   - `Transfer BOM Team Preset Source (owner-transfer) · dev-user`
   - `Transfer Where-Used Team Preset Source (owner-transfer) · dev-user`
3. 在 BOM 的 `目标用户 ID` 输入：
   - `plm-preset-transfer-user`
4. 点击：
   - `转移所有者`
5. 页面提示：
   - `已将BOM团队预设转移给：plm-preset-transfer-user`
6. BOM 选中项切换为：
   - `Transfer BOM Team Preset Source (owner-transfer) · plm-preset-transfer-user`
7. 在 Where-Used 的 `目标用户 ID` 输入：
   - `plm-preset-transfer-user`
8. 点击：
   - `转移所有者`
9. 页面提示：
   - `已将Where-Used团队预设转移给：plm-preset-transfer-user`
10. Where-Used 选中项切换为：
   - `Transfer Where-Used Team Preset Source (owner-transfer) · plm-preset-transfer-user`
11. 最终 URL 保持为：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=e940479d-b025-47f7-9e44-9a8d679e9916&whereUsedTeamPreset=bbaff28d-dfbe-4264-901d-6ec83c49c637&whereUsedFilter=transfer-where-used&whereUsedFilterField=component&bomFilter=transfer-bom&bomFilterField=partNumber
```

12. 当前用户管理按钮已收口：
   - `归档` disabled
   - `设为默认` disabled
   - `删除` disabled
   - `转移所有者` disabled

关键结果：

1. 两条 preset 的 owner 已变化
2. 两条 preset 的 identity 未变化
3. URL 未变化
4. 当前用户权限已变化

产物：

- [plm-team-preset-owner-transfer-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-owner-transfer-browser-20260310.json)
- [page-team-preset-owner-transfer.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-owner-transfer-20260310/page-team-preset-owner-transfer.png)
- [page-team-preset-owner-transfer.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-owner-transfer-20260310/page-team-preset-owner-transfer.txt)

## 数据库状态确认

浏览器 smoke 完成后数据库实况为：

1. `e940479d-b025-47f7-9e44-9a8d679e9916`
   - `owner_user_id = plm-preset-transfer-user`
   - `kind = bom`
2. `bbaff28d-dfbe-4264-901d-6ec83c49c637`
   - `owner_user_id = plm-preset-transfer-user`
   - `kind = where-used`

这说明：

1. 页面选中项 owner
2. URL identity
3. 数据库 owner

三者已经保持一致。

## Live Cleanup 验证

本轮 live 临时数据已全部清理：

1. 删除 team preset：
   - `e940479d-b025-47f7-9e44-9a8d679e9916`
   - `bbaff28d-dfbe-4264-901d-6ec83c49c637`
2. 删除测试用户：
   - `plm-preset-transfer-user`

清理后数据库状态：

- `remainingPresetCount.count = 0`
- `remainingUserCount.count = 0`

产物：

- [plm-team-preset-owner-transfer-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-owner-transfer-cleanup-20260310.json)

## 验证结论

本轮 `PLM BOM / Where-Used team preset owner transfer` 已达到可继续扩展的状态：

1. `BOM / Where-Used team preset` 已具备统一的 owner transfer 接线
2. transfer 后会保持当前 preset id，不打断 deep link
3. transfer 后列表项 owner、URL identity、数据库 owner 已保持一致
4. 当前用户会立即失去管理权限，不会继续误操作刚转出的对象
5. 代码级测试、包级质量门、live 浏览器 smoke 全部通过
6. live 临时数据已清理，环境恢复干净
