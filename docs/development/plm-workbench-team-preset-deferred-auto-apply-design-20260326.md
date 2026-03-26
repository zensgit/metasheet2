# PLM Workbench Team Preset Deferred Auto-Apply Design

## 背景

`BOM / Where-Used` 的默认 team preset 会在页面进入空过滤状态时自动接管。

`PlmProductView.vue` 同时支持 deferred hydration patch：同一轮 route 处理里，旧 query key 会先被标记清掉，再在 flush 时统一写回 URL。

## 问题

默认 team preset 的 auto-apply blocker 之前直接读取原始 `route.query`：

- `bomFilterPreset`
- `bomFilter`
- `bomFilterField`
- `whereUsedFilterPreset`
- `whereUsedFilter`
- `whereUsedFilterField`

这会漏掉 deferred patch 已经声明的显式 blocker：

- 同一轮 hydration 已经写入了新的 preset/filter query，但默认 auto-apply 仍把页面当成“无显式 query”
- 默认 preset 会抢先接管，覆盖掉本轮 route 想表达的显式状态

## 设计决策

- 默认 auto-apply blocker 必须读取“effective query”，不是原始 `route.query`
- 这套判定抽成纯 helper，避免 BOM / Where-Used 继续散落 `hasOwnProperty(...)`
- blocker 只关心 query 是否显式声明了 preset/filter/field，不关心值来自原始 route 还是 deferred patch

## 实现

- 在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 新增：
  - `hasExplicitPlmBomTeamPresetAutoApplyQueryState(...)`
  - `hasExplicitPlmWhereUsedTeamPresetAutoApplyQueryState(...)`
- 在 [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 BOM / Where-Used `shouldAutoApplyDefault()` 里，先对 `route.query` 应用 `applyPlmDeferredRouteQueryPatch(...)`，再做 blocker 判定

## 预期结果

- deferred hydration 已声明显式 BOM / Where-Used preset/filter 时，默认 preset 不会越权 auto-apply
- 同一轮 route cleanup 把 blocker 清掉后，默认 preset 仍能正常接管
- 默认 auto-apply 和 deferred hydration 的语义保持一致
