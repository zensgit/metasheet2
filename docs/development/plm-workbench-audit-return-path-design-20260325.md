# PLM Workbench Audit Return Path Design

## 背景

[PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue) 的 `openWorkbenchSceneAudit()` 和 `openRecommendedWorkbenchSceneAudit()` 之前直接把：

- `route.fullPath`
- 或 `route.query + sceneFocus`

塞进 `auditReturnTo`。

## 问题

这和 workbench 当前的本地 authoritative state 不一致。

`PLM Workbench` 里大量筛选、排序、panel state 都经过 debounce query sync。只要用户：

1. 刚改了本地筛选
2. 还没等 query flush
3. 立即点击 `查看审计`

`auditReturnTo` 捕获到的就是旧 URL，而不是当前界面状态。跳回 workbench 时，用户刚刚的修改会丢。

## 设计

把 return path 改成基于当前本地 state 构造：

1. 在 [plmWorkbenchViewState.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plm/plmWorkbenchViewState.ts) 新增 `buildPlmWorkbenchRoutePath(...)`
   - 输入当前本地 query snapshot
   - 输出稳定的相对 `/plm?...` path
   - 支持附加 `sceneFocus`
   - 保留 `hash`
2. [PlmProductView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmProductView.vue)
   - `openWorkbenchSceneAudit()` 改成从 `buildDeepLinkParams(true)` 构造 `returnToPlmPath`
   - `openRecommendedWorkbenchSceneAudit()` 同样从本地 state 构造，再叠加 `sceneFocus`

## 结果

- `auditReturnTo` 不再依赖 stale URL
- workbench -> audit -> return 会带回当前本地 workbench 状态
- 推荐场景 audit 入口继续保留 `sceneFocus`，但不再吞掉尚未 flush 的本地筛选
