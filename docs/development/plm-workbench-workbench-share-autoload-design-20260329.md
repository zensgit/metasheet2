# PLM Workbench Workbench Share Autoload Design

## Background

`buildDeepLinkParams(true)` 已经把本地 workbench 场景的 cold-start 语义收成了一条清晰合同：

- 只要当前 snapshot 里存在真实 fetch target
- 就会带 `autoload=true`

覆盖的 target 包括：

- `searchQuery`
- `productId / itemNumber` 命中的产品相邻 panel
- `cadFileId`
- `whereUsedItemId`
- `compareLeftId + compareRightId`
- `bomLineId`

但 `buildPlmWorkbenchTeamViewShareUrl('workbench', ...)` 之前只是把保存下来的 `state.query` 原样序列化。这样会留下一个 share/runtime 分叉：

- 当前保存逻辑会把 `autoload` 存进新 team view
- 但历史 team view、外部注入的 SDK payload、或旧 snapshot 里可能根本没有 `autoload`
- 分享这些 workbench team view 时，fresh open 只会 hydrate query，不会真正 bootstrap 数据

## Goal

让 `workbench` team view share URL 和本地 deep link 合同重新对齐：

- 不依赖持久化 state 里“恰好已经存了 autoload”
- 而是从 normalized snapshot 重新推导一次是否需要 `autoload=true`

## Design

修改：

- `apps/web/src/views/plm/plmWorkbenchViewState.ts`

新增 helper：

- `shouldAutoloadPlmWorkbenchSnapshot(snapshot)`

判定规则直接复用现有 cold-start 合同：

- `searchQuery` 存在
- 或 `shouldAutoloadPlmProductContext(...)` 返回 `true`
- 或 `cadFileId` 存在
- 或 `whereUsedItemId` 存在
- 或 `compareLeftId + compareRightId` 同时存在
- 或 `bomLineId` 存在

然后在 `buildPlmWorkbenchTeamViewShareUrl('workbench', ...)` 里：

- 先序列化 normalized query
- 再按上述规则补 `autoload=true`

## Why This Is Correct

- 新旧 team view snapshot 都能得到同一份冷启动合同
- 不改变没有任何 fetch target 的轻量 share URL
- 语义与 `buildDeepLinkParams(true)` 保持一致，而不是维护第二份弱化版 share 逻辑
