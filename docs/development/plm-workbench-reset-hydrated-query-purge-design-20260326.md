# PLM Workbench Reset Hydrated Query Purge Design

## 背景

`PlmProductView.vue` 的 `resetAll()` 不仅要清页面内存状态，还要把会被 `applyQueryState()` 再 hydration 回来的 route query 一起删掉。

之前虽然已经补过 canonical team-view owner query 的 purge，但还有一组 panel query 仍然漏掉：

- `documentSort`
- `documentSortDir`
- `documentColumns`
- `cadReviewState`
- `cadReviewNote`
- `approvalComment`
- `approvalSort`
- `approvalSortDir`
- `approvalColumns`

这些字段在 `resetAll()` 里已经被本地重置为默认值，但 URL 没清时，`route.fullPath` watcher 仍会通过 `applyQueryState()` 把它们重新 hydration 回来。

## 设计目标

1. `resetAll()` 必须 authoritative 地清掉所有会被 panel hydration 回灌的非默认 query。
2. 这组 key 需要集中定义，不再散落在 `resetAll()` 的裸 patch 里。

## 方案

### 1. 新增 hydrated panel reset helper

在 `plmWorkbenchViewState.ts` 中新增：

- `buildPlmWorkbenchResetHydratedPanelQueryPatch()`

它统一返回 reset 时需要 purge 的 panel query patch，并复用已有的：

- `buildPlmWorkbenchResetOwnerQueryPatch()`

形成完整 reset-hydration 清理集。

### 2. resetAll 直接复用 helper

`PlmProductView.vue` 的 `resetAll()` 在 `syncQueryParams(...)` patch 中展开该 helper，使 URL 和本地 reset 语义一致。

## 影响

修复后，`resetAll()` 不会再留下 stale sort / columns / review / approval comment query；页面 reset 后也不会被 route watcher 再次污染。
