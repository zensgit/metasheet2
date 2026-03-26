# PLM Workbench Effective Hydration Blockers Design

## 背景

`PlmProductView.vue` 在 route hydration 期间会把 query 修正动作 defer 到最后一轮 apply 之后再 flush。这样避免了 watcher 递归，但会留下一个时序缺口：

1. refresh / stale-owner cleanup 期间，本地已经决定要清掉 `documentTeamView / cadTeamView / approvalsTeamView / workbenchTeamView`
2. 这条 patch 已进入 deferred queue
3. 但 `shouldAutoApplyDefault()` 仍然读取原始 `route.query`
4. 结果默认 target 被旧 query blocker 错误挡住，拿不到同一轮的 takeover 机会

这个问题在 invalid owner deep-link 下尤其明显：stale owner 会被本地清掉，但默认 view/preset 不会立刻 reapply。

## 设计目标

1. auto-apply blocker 必须基于 “route.query + deferred patch” 的有效状态判断。
2. 不改变现有 deferred flush 时序。
3. 文档、CAD、审批、workbench 主面板统一使用同一套 effective hydration 语义。

## 方案

### 1. 给 hydration patch helper 增加 effective query overlay

在 `plmRouteHydrationPatch.ts` 新增：

- `applyPlmDeferredRouteQueryPatch(current, patch)`

合同：

- `undefined` / `''` => 从 effective query 中移除该 key
- 其它值 => 覆盖当前 query 值

### 2. blocker 改读 effective hydration query

`PlmProductView.vue` 中：

- `hasExplicitQueryKey(...)`
- `hasExplicitWorkbenchQueryState()`
- approvals 的 `hasExplicitPlmApprovalsAutoApplyQueryState(...)`

全部改成基于 `applyPlmDeferredRouteQueryPatch(route.query, deferredRouteQueryPatch)` 计算。

这样 documents/cad/workbench/approvals 的默认 auto-apply 都会看到“本轮 hydration 结束后真正会落到 URL 上的 query 状态”。

## 结果

修复后，stale owner cleanup 与默认 auto-apply 会在同一轮 hydration 中对齐：

- 旧 owner 被 defer 清掉
- blocker 同时感知这个清理
- 默认 target 可以在同一轮 refresh 中直接接管

不会再因为读取原始 `route.query` 而被旧 owner 假拦截。
