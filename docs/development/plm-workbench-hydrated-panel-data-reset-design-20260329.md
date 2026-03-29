# PLM Workbench Hydrated Panel Data Reset Design

## Background

`/plm` 的 panel share / deeplink 现在已经能把 route owner、preset owner 和最小 bootstrap context 正确写进 URL，但 `applyQueryState()` 仍只重建 query-owned refs，不会同步清掉上一轮已经加载到内存里的 panel data model。

因为 `PlmProductView` 的各个 panel 始终挂载在同一页里，这会造成一类稳定的 runtime 分叉：

- route 已切到新的 panel / target
- owner hydration 已对齐
- 旧的 `product / bom / documents / approvals / cad / where-used / compare / substitutes` 数据仍留在内存里
- 新 route 如果不是 `all-panels` autoload，就不会主动把这些旧模型重新覆盖

结果就是 panel-scoped deeplink 打开后，页面会混着显示上一轮 route 的数据。

## Goal

把 panel-scoped hydration 补成“像 fresh open 一样”的 runtime contract：

- 对即将 autoload 的 panel，如果 route-owned target 变了，先清旧模型再加载新模型
- 对本轮 route 不会加载的 panel，直接清空旧模型，不再保留 stale data
- 只清 panel data / runtime status，不碰 collaborative owner / preset management state

## Design

新增纯 helper：

- `apps/web/src/views/plm/plmHydratedPanelDataReset.ts`

输入：

- `previousRouteState`
- `nextRouteState`

helper 负责：

1. 归一化 next route 的 panel scope
2. 根据 `autoload + panel + product/item context` 计算哪些 panel 本轮应该真正加载
3. 为每个 panel 构建 route-owned identity key
4. 返回 `clearSearch / clearProduct / clearBom / clearDocuments / clearCad / clearApprovals / clearWhereUsed / clearCompare / clearSubstitutes`

`PlmProductView.vue` 在 `applyQueryState()` 里：

1. 先拍一份上一轮的 route-owned data snapshot
2. 解析新 query refs
3. 调用 helper
4. 按结果清掉对应 panel 的 data model、error/status 和必要 selection
5. 再进入 autoload fetch

## Why This Shape

- 纯 helper 让 route-hydration 规则能被 focused unit test 直接锁住
- 不把大量 branch 继续堆进 `applyQueryState()`，避免回归面继续扩大
- 不使用 `resetAll()` 粗暴清空整个页面，避免把不属于本次 route 切换的 collaborative state 一起误删
