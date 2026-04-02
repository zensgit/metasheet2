# PLM Workbench Route Hydration Deferred Patch Design

## 背景

`PlmProductView.vue` 在 route hydration 期间会设置：

- `isApplyingRouteQueryState = true`
- `pendingRouteQueryHydration = true`

这能避免 watcher 递归，但也带来一个副作用：

- refresh / auto-apply / stale-owner cleanup 期间调用 `scheduleQuerySync(...)`
- `scheduleQuerySync(...)` 在 hydration 中直接 return
- 本地 state 虽然被修正了，URL query 却没有被 authoritative 回写

典型症状：

1. URL 上还挂着 stale `workbenchTeamView` / `documentTeamView` / `cadTeamView` / `approvalsTeamView`。
2. refresh 或 hydration 把本地 owner 清掉，甚至接管到 default target。
3. 因为 query patch 被吞掉，地址栏仍保留旧 owner。
4. 后续 reload / share / back-forward 又把旧 owner 带回来。

## 设计目标

1. hydration 期间的 query patch 不能丢。
2. 不能在 hydration 中立即 `syncQueryParams(...)`，否则会重新打断当前 apply pass。
3. 多次 patch 要按最后写入值合并，最终只 flush 一次 canonical patch。

## 方案

### 1. 引入 deferred patch helper

新增 `plmRouteHydrationPatch.ts`，提供两个纯 helper：

- `mergePlmDeferredRouteQueryPatch(current, patch)`
- `resolvePlmDeferredRouteQueryPatch(current, hasPendingHydration)`

合同：

- hydration 中收到 patch：合并进 deferred patch
- 还有 pending hydration pass：继续保留
- 最后一轮 hydration 结束：统一产出 `flushPatch`

### 2. scheduleQuerySync 在 hydration 中先缓存

`PlmProductView.vue` 的 `scheduleQuerySync(...)` 改成：

- 正常态：照旧 `scheduleBaseQuerySync(patch)`
- hydration 中：写入 `deferredRouteQueryPatch`

### 3. 在最后一轮 applyQueryState 后 flush

`applyQueryState()` 结束阶段增加：

- `resolvePlmDeferredRouteQueryPatch(...)`
- 若还有 `pendingRouteQueryHydration`，递归处理下一轮
- 最后一轮结束后再 `syncQueryParams(flushPatch)`

这样 stale owner cleanup / default takeover 期间产生的 query patch 不会丢，又不会在 hydration 中抢跑。

## 结果

修复后，route hydration 会满足这条 authoritative 合同：

- 本地 state 修正什么
- URL 就在最终 hydration pass 结束后写回什么

不会再出现“本地 owner 已纠正，地址栏仍保留旧 owner”的分叉状态。
