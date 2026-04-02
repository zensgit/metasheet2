# PLM Team Preset Duplicate / Rename 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [plmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/plm/plmTeamFilterPresets.ts)
- 更新 [plm-workbench.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/src/routes/plm-workbench.ts)
- 更新 [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/services/plm/plmWorkbenchClient.ts)
- 更新 [usePlmTeamFilterPresets.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/usePlmTeamFilterPresets.ts)
- 更新 [plmPanelModels.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmPanelModels.ts)
- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [PlmBomPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmBomPanel.vue)
- 更新 [PlmWhereUsedPanel.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/components/plm/PlmWhereUsedPanel.vue)
- 更新 [plm-team-filter-presets.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-team-filter-presets.test.ts)
- 更新 [plm-workbench-routes.test.ts](/Users/huazhou/Downloads/Github/metasheet2/packages/core-backend/tests/unit/plm-workbench-routes.test.ts)
- 更新 [plmWorkbenchClient.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchClient.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-team-preset-duplicate-rename-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-team-preset-duplicate-rename-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-team-filter-presets.test.ts tests/unit/plm-workbench-routes.test.ts`
- `pnpm --filter @metasheet/web exec vitest run tests/plmWorkbenchClient.spec.ts tests/usePlmTeamFilterPresets.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend build`
- `pnpm lint`

结果：

- backend 聚焦测试通过，当前为 `2 files / 13 tests`
- frontend 聚焦测试通过，当前为 `2 files / 15 tests`
- `apps/web test` 当前为 `30 files / 128 tests`
- `apps/web type-check / lint / build`、`core-backend build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断通过

## 聚焦覆盖点

本轮新增/更新覆盖：

1. duplicate 名称生成不会直接覆盖现有团队预设
2. owner 可以 rename 自己的 team preset
3. duplicate 会生成当前用户拥有的新副本
4. frontend duplicate 后会把 `requestedPresetId` 对齐到新副本
5. frontend rename 后会继续保持当前 `requestedPresetId`

## Live 运行态验证

live backend 初次验证暴露了一个真实运行态问题：

1. `7778` 上的旧 backend 仍停留在未包含本轮 `duplicate / rename` 路由的版本
2. 表现为：
   - `/api/auth/me` 返回旧的 `mode / workflow`
   - `POST /api/plm-workbench/filter-presets/team/:id/duplicate` 返回 `Cannot POST`

处理结果：

1. 已停掉旧的 `7778` 进程
2. 已用最新代码重启 live backend
3. 当前 live runtime 以 `PRODUCT_MODE=plm-workbench`、`WORKFLOW_ENABLED=true` 提供服务

## Live API 验证

live API 已走通：

1. 创建 BOM source preset
2. 创建 Where-Used source preset
3. duplicate 两条 source preset
4. rename 两条 duplicate preset
5. 最终 list 结果与预期名称一致

关键 id：

- BOM source: `9e2f36ad-b08d-43aa-a1b3-80de34b3dbd8`
- Where-Used source: `c35aa4d9-fe94-4017-809b-5371b84f8af3`
- API duplicate BOM: `7d3f38ce-899d-42be-b614-8dd282db4eed`
- API duplicate Where-Used: `e60353e9-2501-4f4f-8e3b-bcb0ad1d08e1`

产物：

- [plm-team-preset-duplicate-rename-api-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-duplicate-rename-api-20260310.json)

## Browser Smoke 验证

浏览器 smoke 已真实走通：

1. 打开显式 source deep link：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=9e2f36ad-b08d-43aa-a1b3-80de34b3dbd8&whereUsedTeamPreset=c35aa4d9-fe94-4017-809b-5371b84f8af3&whereUsedFilter=assy-live&whereUsedFilterField=parent&bomFilter=gear-live&bomFilterField=component
```

2. 在 `BOM` 区块点击 `复制副本`
3. 验证 URL 切到：
   - `bomTeamPreset=43e8bd3e-382e-4de9-b33f-f3ba92662aac`
4. 将副本重命名为：
   - `BOM Browser Copy Renamed`
5. 验证 rename 后 URL 保持同一 BOM preset id
6. 在 `Where-Used` 区块点击 `复制副本`
7. 验证 URL 切到：
   - `whereUsedTeamPreset=2e1349dd-59d6-41da-9c13-c389fd3e53b2`
8. 将副本重命名为：
   - `Where Used Browser Copy Renamed`
9. 验证 rename 后 URL 保持同一 Where-Used preset id

关键结果：

- 最终 URL 为：

```text
http://127.0.0.1:8899/plm?bomTeamPreset=43e8bd3e-382e-4de9-b33f-f3ba92662aac&whereUsedTeamPreset=2e1349dd-59d6-41da-9c13-c389fd3e53b2&whereUsedFilter=assy-live&whereUsedFilterField=parent&bomFilter=gear-live&bomFilterField=component
```

- 当前选中项分别为：
  - `BOM Browser Copy Renamed (Live) · dev-user`
  - `Where Used Browser Copy Renamed (Live) · dev-user`
- `bomFilter` 与 `whereUsedFilter` 在 duplicate / rename 后保持：
  - `gear-live`
  - `assy-live`

产物：

- [plm-team-preset-duplicate-rename-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-duplicate-rename-browser-20260310.json)
- [page-team-preset-duplicate-rename.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-team-preset-duplicate-rename-20260310/page-team-preset-duplicate-rename.png)

## Cleanup 验证

本轮 live 临时团队预设已清理。

清理对象包括：

1. API 创建的 source / duplicate preset
2. 浏览器 smoke 创建的 duplicate preset

清理结果：

- `9e2f36ad-b08d-43aa-a1b3-80de34b3dbd8` 删除成功
- `c35aa4d9-fe94-4017-809b-5371b84f8af3` 删除成功
- `7d3f38ce-899d-42be-b614-8dd282db4eed` 删除成功
- `e60353e9-2501-4f4f-8e3b-bcb0ad1d08e1` 删除成功
- `43e8bd3e-382e-4de9-b33f-f3ba92662aac` 删除成功
- `2e1349dd-59d6-41da-9c13-c389fd3e53b2` 删除成功

产物：

- [plm-team-preset-duplicate-rename-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-team-preset-duplicate-rename-cleanup-20260310.json)

## 验证结论

本轮 `PLM team preset duplicate / rename` 已达到可继续推进的状态：

1. `duplicate` 会生成新的 team preset identity，并立即同步到 URL
2. `rename` 会保留当前 team preset identity，不会打断 deep link
3. `BOM / Where-Used` 团队预设的生命周期语义已和 `PLM workbench team view` 对齐
4. 代码级测试、包级质量门、live API 与浏览器 smoke 全部通过
5. live 临时数据已清理，环境回到干净状态
