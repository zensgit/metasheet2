# PLM Team Preset Archive / Restore 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 新增迁移 [zzzz20260310183000_add_archived_to_plm_filter_team_presets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/db/migrations/zzzz20260310183000_add_archived_to_plm_filter_team_presets.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新测试：
  - [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
  - [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
  - [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
  - [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-preset-archive-restore-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-archive-restore-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/core-backend migrate`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- backend targeted tests 当前为 `2 files / 17 tests`
- web targeted tests 当前为 `2 files / 19 tests`
- `apps/web test` 当前为 `30 files / 134 tests`
- backend `migrate / build`、web `type-check / lint / build` 与根级 `pnpm lint` 均通过

## 单测覆盖点

本轮新增覆盖：

1. `mapPlmTeamFilterPresetRow()` 会把 `archived_at` 转成：
   - `isArchived`
   - `archivedAt`
2. `archive route` 会返回：
   - `isArchived: true`
   - `isDefault: false`
3. `restore route` 会返回：
   - `isArchived: false`
4. frontend client 会正确映射 team preset 的：
   - `archive`
   - `restore`
5. `usePlmTeamFilterPresets` 在当前 preset 归档后会：
   - 清空当前 `requestedPresetId`
   - 清空 `teamPresetKey`
   - 清空 `teamPresetName / teamPresetGroup`
   - 保留当前 `bomFilter / whereUsedFilter`
6. `restore` 后会把同一个 preset id 重新写回 URL identity

## Live Setup

本轮 live smoke 先通过 live API 创建两条显式团队预设：

- BOM:
  - `6de4abef-6f21-489f-b6aa-46b89e682185`
  - `Archive Restore BOM 1773136066176`
- Where-Used:
  - `fc55970f-fde6-4c8a-911c-032452b658ed`
  - `Archive Restore Where 1773136066176`

过滤状态：

- `bomFilter=root/archive-live`
- `bomFilterField=path`
- `whereUsedFilter=assy-restore-live`
- `whereUsedFilterField=parent`

产物：

- [plm-team-preset-archive-restore-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-archive-restore-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 打开：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=6de4abef-6f21-489f-b6aa-46b89e682185&whereUsedTeamPreset=fc55970f-fde6-4c8a-911c-032452b658ed&whereUsedFilter=assy-restore-live&whereUsedFilterField=parent&bomFilter=root/archive-live&bomFilterField=path
```

2. 页面自动恢复出：
   - `bomFilter=root/archive-live`
   - `whereUsedFilter=assy-restore-live`
3. 先点击 BOM 团队预设 `归档`
4. 验证 URL 变成：

```text
http://127.0.0.1:8899/plm?whereUsedTeamPreset=fc55970f-fde6-4c8a-911c-032452b658ed&whereUsedFilter=assy-restore-live&whereUsedFilterField=parent&bomFilter=root/archive-live&bomFilterField=path
```

5. 再点击 Where-Used 团队预设 `归档`
6. 验证 URL 变成：

```text
http://127.0.0.1:8899/plm?whereUsedFilter=assy-restore-live&whereUsedFilterField=parent&bomFilter=root/archive-live&bomFilterField=path
```

7. 从下拉中选择已归档 BOM 预设并点击 `恢复`
8. 验证 URL 变成：

```text
http://127.0.0.1:8899/plm?whereUsedFilter=assy-restore-live&whereUsedFilterField=parent&bomFilter=root/archive-live&bomFilterField=path&bomTeamPreset=6de4abef-6f21-489f-b6aa-46b89e682185
```

9. 再从下拉中选择已归档 Where-Used 预设并点击 `恢复`
10. 验证 URL 变成：

```text
http://127.0.0.1:8899/plm?whereUsedFilter=assy-restore-live&whereUsedFilterField=parent&bomFilter=root/archive-live&bomFilterField=path&bomTeamPreset=6de4abef-6f21-489f-b6aa-46b89e682185&whereUsedTeamPreset=fc55970f-fde6-4c8a-911c-032452b658ed
```

关键结果：

1. `archive` 后对应面板的 team preset id 会从 URL 退出
2. 当前 `bomFilter / whereUsedFilter` 会保留
3. 已归档项会在下拉中显示：
   - `· 已归档`
4. 归档项不能继续应用，但可以恢复
5. `restore` 后同一个 preset id 会重新回到 URL

产物：

- [plm-team-preset-archive-restore-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-archive-restore-browser-20260310.json)
- [page-team-preset-archive-restore.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-archive-restore-20260310/page-team-preset-archive-restore.png)
- [page-team-preset-archive-restore.txt](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-archive-restore-20260310/page-team-preset-archive-restore.txt)

补充说明：

- 页面中仍可见既有的 `API error: 403 Forbidden（已回退默认字段）` compare fallback 噪声，不影响本轮 `team preset archive / restore` 主路径
- live browser smoke 在 backend 重启到最新 `7778` 进程后完成闭环

## Cleanup 验证

本轮临时团队预设已通过 live API 删除，环境恢复干净：

- BOM:
  - `total = 0`
  - `activeTotal = 0`
  - `archivedTotal = 0`
- Where-Used:
  - `total = 0`
  - `activeTotal = 0`
  - `archivedTotal = 0`

产物：

- [plm-team-preset-archive-restore-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-archive-restore-cleanup-20260310.json)

## 验证结论

本轮 `PLM team preset archive / restore` 已达到可继续推进的状态：

1. 后端已有稳定的 team preset `archive / restore` 路由与归档字段
2. frontend hook / client / panel UI 已完成接线
3. `archive` 会让对应 `team preset` identity 正确退场
4. `restore` 会让同一个 preset id 正确回到 URL
5. 当前 `BOM / Where-Used` 过滤状态在整个 `archive / restore` 周期中保持不变
6. 代码级测试、包级门禁、live API、浏览器 smoke 与 cleanup 均已通过
