# PLM Workbench Panel Preset Hydration Takeover Design

## 背景

`BOM / Where-Used` 的 team preset owner 也支持通过 route query 显式指定：

- `bomTeamPreset`
- `whereUsedTeamPreset`

`PlmProductView.vue` 在 hydration 时会把这些 query 回灌到 `...TeamPresetQuery`。

## 问题

如果本地 selector 还停在旧 preset `A`，而外部 deep-link / route-to-route navigation 把显式 owner 切成了 `B`：

- hydration 只改 `...TeamPresetQuery`
- `...TeamPresetKey / Name / Group / OwnerUserId` 还保留 `A`
- `usePlmTeamFilterPresets(...)` 会把 `B` 当成 requested owner
- 页面因此进入假的 pending drift，而不是让 canonical route 真正接管

## 设计决策

- 保持 composable 现有“本地 selector pending apply”语义不变
- 只把“route hydration 读到显式 team preset owner，且与本地 selector 不一致”提升成 authoritative takeover
- takeover 时统一清掉：
  - `teamPresetKey`
  - `teamPresetName`
  - `teamPresetGroup`
  - `teamPresetOwnerUserId`
  - `teamPresetSelection`

## 实现

- 新增纯 helper：`resolvePlmHydratedTeamPresetOwnerTakeover(...)`
- `PlmProductView.vue` 在读取 `bomTeamPreset / whereUsedTeamPreset` 时统一调用 `applyHydratedTeamPresetOwnerTakeover(...)`
- 只有显式 route owner 与本地 selector 不一致时才清理

## 预期结果

- deep-link `A -> B` 时，旧 preset selector 不会把 `B` 卡成假的 pending target
- hydration 后 BOM / Where-Used 的 preset owner 会按 canonical route 正常接管
- 本地 pending selector 的普通场景不受影响
