# PLM Workbench Authoritative Route Hydration Design

## 背景

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 之前只在 `onMounted()` 时调用一次 `applyQueryState()`。

这意味着：

1. 页面挂载后，同一路由下的外部 query 变化不会重新回灌本地 state
2. `applyQueryState()` 还是 sparse patch 语义
3. query 缺失的键不会把本地 ref 复原到默认值

结果是浏览器 `Back / Forward`、in-app deep link、同一路由 `router.replace()` 都可能让 URL 和界面状态分叉。

## 问题

典型表现包括：

- URL 已经移除了 `approvalsFilter`，审批面板仍然保留旧筛选
- URL 已经切走 `documentTeamView / cadTeamView / approvalsTeamView`，本地 selector 仍指向旧 owner
- 外部 route 重入时，本地待同步的 debounce patch 还可能把旧 query 再写回去

## 设计

把 query hydration 收成 authoritative route owner：

1. `PlmProductView.vue`
   - 新增 `isApplyingRouteQueryState` guard
   - `applyQueryState()` 改成完整 authoritative 赋值：
     - 先把 query-backed refs 复原到默认值
     - 再按当前 `route.query` 显式覆盖
   - 新增 `watch(() => route.fullPath, ...)`
     - 同一路由 query 变化时重新应用 `applyQueryState()`

2. [usePlmDeepLinkState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/usePlmDeepLinkState.ts)
   - 新增 `cancelScheduledQuerySync()`
   - route watcher 在 hydration 前先清理待发送的 debounce patch，避免旧 query 回写

3. 本地 query 同步
   - `scheduleQuerySync(...)` 改成 hydration-aware wrapper
   - route hydration 期间不再让本地 watcher 把 canonical route 反向写脏

## 结果

- `PlmProductView` 不再只在挂载时吃一次 query
- query 缺键会真实把本地 state 复原到默认值，而不是留下 stale ref
- 外部 route pivot 和本地 debounce query sync 不再互相打架
