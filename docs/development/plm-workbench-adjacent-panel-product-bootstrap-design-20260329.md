# PLM Workbench Adjacent Panel Product Bootstrap Design

## Background

`/plm` 的通用 deep link、`where-used` preset share、以及多条 panel share 链已经会把当前 `productId / itemNumber / itemType` 写进 URL。

但 runtime 里的 `shouldAutoloadPlmProductContext(...)` 仍只把 `product / documents / approvals` 视为“需要先 bootstrap 产品上下文”的 panel。结果是：

- `where-used / compare / substitutes` 冷启动 deep link 明明带了产品上下文
- `applyQueryState()` 却不会先走 `loadProduct()`
- 页面顶部的产品区仍然是空的，只有目标 panel 自己被加载

这会让产品上下文在 URL 里变成“写了但不生效”的半残合同。

## Goal

把 `where-used / compare / substitutes` 也拉齐到“产品相邻 panel”的 bootstrap 语义：

- 只要 URL 里已经带了 `productId` 或 `itemNumber`
- 且 panel scope 命中这些产品相邻 panel
- 就先 bootstrap 产品上下文，再进入目标 panel 的具体加载

同时补平 `where-used preset share` 的 URL 合同：

- 即便当前还没有 `whereUsedItemId`
- 只要存在产品上下文，也要带 `autoload=true`

## Design

### 1. 扩展产品 bootstrap panel 集

修改：

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`

`shouldAutoloadPlmProductContext(...)` 现在把这些 panel 都视为产品相邻 panel：

- `product`
- `documents`
- `approvals`
- `where-used`
- `compare`
- `substitutes`

`cad` 继续保持排除，因为它的冷启动主标识仍然是 `cadFileId`，不是产品上下文。

### 2. 补平 where-used preset share 的 autoload 合同

修改：

- `apps/web/src/views/plm/plmFilterPresetUtils.ts`

`buildFilterPresetShareUrl('where-used', ...)` 和 `buildTeamFilterPresetShareUrl('where-used', ...)` 现在都按同一条规则设置 `autoload=true`：

- 有 `whereUsedItemId`
- 或者有 `productId`
- 或者有 `itemNumber`

这样 where-used preset share 在“只有产品上下文、还没选 root item”的场景下，也能 cold-start 到正确的产品页环境。

## Why This Is Correct

- 当前 URL 已经显式携带产品上下文，不 bootstrap 产品就是 runtime 未消费自己的合同
- `where-used / compare / substitutes` 都是产品详情页里的相邻 panel，冷启动时顶部产品摘要为空会造成明显错位
- 这次改动不影响 `cad` 的独立冷启动语义，也不改变 panel 自己的主加载条件
