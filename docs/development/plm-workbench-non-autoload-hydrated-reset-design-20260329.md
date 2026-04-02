# PLM Workbench Non-Autoload Hydrated Reset Design

## Background

上一轮把 panel-scoped hydration 的 stale payload reset 抽成了 `plmHydratedPanelDataReset.ts`，但 helper 仍把 `autoload=false` 整体视为“不需要 reset”。

这会留下一个新的 runtime 分叉：

- 外部 route / 浏览器历史把 `cadFileId`、`whereUsedItemId`、`compareLeftId/rightId` 等 route-owned target 改掉
- `applyQueryState()` 会先把这些 query-owned ref 改成新值
- 但由于 `autoload=false`，helper 不会清任何旧 payload
- 视图会进入“新的 route owner + 旧的数据模型”这种混合状态

## Goal

把 `autoload=false` 的 hydration 也补成正确语义：

- 不主动发起新 fetch
- 但如果 route-owned target 已经变了，就必须清掉旧 payload
- 如果 target 没变，只是普通 query 同步，则继续保留当前 payload

## Design

修改：

- `apps/web/src/views/plm/plmHydratedPanelDataReset.ts`

新规则分两段：

### 1. `autoload=true`

沿用上一轮的 panel-aware contract：

- 基于 panel scope + next route key 判定哪些 panel 要 clear

### 2. `autoload=false`

不再直接返回全 `false`，而是改成只比较“底层 fetch identity”：

- `searchQuery/searchItemType/searchLimit`
- `productId/itemNumber/itemType`
- `cadFileId/cadOtherFileId`
- `whereUsedItemId/recursive/maxLevels`
- `compareLeftId/rightId/...`
- `bomLineId`

如果这些底层 key 变了，就 clear 对应 payload；如果没变，则保留当前 payload。

## Why This Shape

- 保留了普通本地 query sync 的稳定性
- 同时修掉了外部 route takeover / browser history 下的 stale payload
- 不会把 `autoload=false` 简化成“全清”或“全不清”这两种过度行为
