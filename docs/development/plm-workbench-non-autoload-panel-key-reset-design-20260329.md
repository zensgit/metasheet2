# PLM Workbench Non-Autoload Panel Key Reset Design

## Background

上一轮已经把 `autoload=false` 的 hydration 从“完全不清理”补成了“route-owned target 变化时清理 stale payload”。

但 helper 里仍然只对这几类 key 做了 non-autoload 对比：

- search key
- product context key
- cad key
- where-used key
- compare key
- substitutes key

这会留下同一产品上下文下的 panel-owned drift：

- `bomDepth / bomEffectiveAt` 变化时，`clearBom` 仍是 `false`
- `documentRole` 变化时，`clearDocuments` 仍是 `false`
- `approvalsStatus` 变化时，`clearApprovals` 仍是 `false`

结果就是 URL 已经切到新的 route-owned panel state，但页面继续挂着上一轮的 BOM / documents / approvals payload。

## Goal

把 non-autoload reset 拉齐到和 autoload path 同一份 panel identity 语义：

- `clearProduct` 继续只由产品上下文决定
- `clearBom` 基于 `buildBomKey(...)`
- `clearDocuments` 基于 `buildDocumentsKey(...)`
- `clearApprovals` 基于 `buildApprovalsKey(...)`

这样非 autoload 的外部 route takeover / 浏览器历史回退在同一产品上下文下也不会留下 stale panel payload。

## Design

修改：

- `apps/web/src/views/plm/plmHydratedPanelDataReset.ts`

在 `!nextRouteState.autoload` 分支中新增对比：

- `previousBomKey / nextBomKey`
- `previousDocumentsKey / nextDocumentsKey`
- `previousApprovalsKey / nextApprovalsKey`

并把返回值改成：

- `clearBom: previousBomKey !== nextBomKey`
- `clearDocuments: previousDocumentsKey !== nextDocumentsKey`
- `clearApprovals: previousApprovalsKey !== nextApprovalsKey`

`clearProduct` 仍保持：

- `previousProductContextKey !== nextProductContextKey`

因为 product header/context 本身不该被 `bomDepth`、`documentRole`、`approvalsStatus` 这种 panel-owned 参数触发清理。

## Why This Is Correct

- BOM、documents、approvals 本来就已经有各自的 key builder，说明 runtime contract 早已承认它们不是单纯的“产品上下文别名”
- 这次只是把 non-autoload path 补齐到同一份 identity，而不是引入新语义
- 不会误扩大清理范围到本地 UI-only 参数；仅影响真正的 route-owned fetch identity
