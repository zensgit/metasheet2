# PLM Local Filter Preset Deep Links 验证记录

日期: 2026-03-10

## 变更范围

- 更新 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/PlmProductView.vue)
- 更新 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/src/views/plm/plmWorkbenchViewState.ts)
- 更新 [plmWorkbenchViewState.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/plmWorkbenchViewState.spec.ts)
- 更新 [usePlmTeamFilterPresets.spec.ts](/Users/huazhou/Downloads/Github/metasheet2/apps/web/tests/usePlmTeamFilterPresets.spec.ts)
- 使用本轮设计文档 [plm-local-filter-preset-deeplinks-benchmark-design-20260310.md](/Users/huazhou/Downloads/Github/metasheet2/docs/development/plm-local-filter-preset-deeplinks-benchmark-design-20260310.md)

## 代码级验证

已通过：

- `pnpm --filter @metasheet/web exec vitest run tests/usePlmTeamFilterPresets.spec.ts tests/plmWorkbenchViewState.spec.ts --watch=false`
- `pnpm --filter @metasheet/web test`
- `pnpm --filter @metasheet/web type-check`
- `pnpm --filter @metasheet/web lint`
- `pnpm --filter @metasheet/web build`
- `pnpm lint`

结果：

- 聚焦测试通过，当前为 `2 files / 7 tests`
- `apps/web test` 当前为 `30 files / 123 tests`
- `apps/web type-check / lint / build` 与根级 `pnpm lint` 均通过

说明：

- 前端测试仍会打印一次 `WebSocket server error: Port is already in use`
- 该提示没有阻断测试通过

## 单测覆盖点

本轮新增/更新覆盖：

1. `plmWorkbenchViewState` 会保留 `bomFilterPreset / whereUsedFilterPreset`
2. 显式 local preset query 会进入 workbench deep link snapshot
3. 显式 local preset 与 team preset 的优先级链路不会丢失 query identity

## Live / Browser Smoke

### Live setup

本轮沿用了 live backend 的 team preset 能力，先制造冲突环境，再验证显式 local preset 的优先级：

1. 创建一条 `BOM default team preset`
2. 创建一条 `Where-Used default team preset`
3. 分别设为默认

setup 产物：

- [plm-local-filter-preset-deeplinks-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-filter-preset-deeplinks-20260310.json)

其中记录了这两条默认 team preset 的 live id：

1. `bomDefault = 7ee1d83e-3551-47de-81ef-527387227223`
2. `whereUsedDefault = 754451e2-b4e8-4ec5-a0b6-040ce462509b`

### 浏览器主路径

主路径 A：在默认团队 preset 已存在的页面上创建 local preset

1. 打开带默认 team preset 的 `/plm`
2. `BOM` 输入：
   - `field = component`
   - `value = local-bom-gear-20260310`
   - `preset name = Codex Local BOM Link 20260310`
3. 点击保存
4. `Where-Used` 输入：
   - `field = parent_number`
   - `value = LOCAL-PARENT-20260310`
   - `preset name = Codex Local Where Link 20260310`
5. 点击保存

页面确认结果：

1. URL 从团队 preset identity 切换到 local preset identity：

```text
http://127.0.0.1:8899/plm?whereUsedFilter=LOCAL-PARENT-20260310&whereUsedFilterField=parent_number&bomFilter=local-bom-gear-20260310&bomFilterField=component&bomFilterPreset=bom:1773106575960:nd1rzq&whereUsedFilterPreset=where-used:1773106589660:3no2k7
```

2. `bomTeamPreset` 已从 URL 清掉
3. `whereUsedTeamPreset` 已从 URL 清掉

主路径 B：用显式 local preset deep link 打开一条全新 `/plm`

1. 直接打开上面的显式 URL
2. 不再依赖已有页面内存状态

页面确认结果：

1. `BOM` 恢复为：
   - `field = component`
   - `value = local-bom-gear-20260310`
   - `preset id = bom:1773106575960:nd1rzq`
   - `team preset id = ''`
2. `Where-Used` 恢复为：
   - `field = parent_number`
   - `value = LOCAL-PARENT-20260310`
   - `preset id = where-used:1773106589660:3no2k7`
   - `team preset id = ''`

这说明显式 local preset 没有被 live 默认 team preset 覆盖。

浏览器产物：

- [plm-local-filter-preset-deeplinks-browser-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-filter-preset-deeplinks-browser-20260310.json)
- [plm-local-filter-preset-deeplinks-20260310](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-deeplinks-20260310)
- [page-explicit-local-preset-deeplink.json](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-deeplinks-20260310/page-explicit-local-preset-deeplink.json)
- [page-explicit-local-preset-deeplink.png](/Users/huazhou/Downloads/Github/metasheet2/output/playwright/plm-local-filter-preset-deeplinks-20260310/page-explicit-local-preset-deeplink.png)

## Cleanup

本轮 cleanup 已完成两部分：

1. live backend 中临时创建的 `BOM / Where-Used default team preset`
2. 浏览器本地的 `plm_bom_filter_presets / plm_where_used_filter_presets`

cleanup 产物：

- [plm-local-filter-preset-deeplink-cleanup-20260310.json](/Users/huazhou/Downloads/Github/metasheet2/artifacts/plm-local-filter-preset-deeplink-cleanup-20260310.json)

清理后 live 列表恢复为：

1. `bom total = 0`
2. `whereUsed total = 0`

## 验证结论

本轮 `PLM local filter preset deep links` 已达到可继续推进的状态：

1. `/plm` 已支持：
   - `bomFilterPreset=<local-key>`
   - `whereUsedFilterPreset=<local-key>`
2. 显式 local preset 会覆盖默认 team preset
3. 同面板 local preset identity 与 team preset identity 已保持互斥
4. stale local preset 具备 query 自清理能力
5. 前端门禁、live setup、浏览器 smoke、cleanup 已闭环
