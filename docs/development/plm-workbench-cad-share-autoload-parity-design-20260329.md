# PLM Workbench CAD Share Autoload Parity Design

## Background

`CAD team view` 的分享链接由 `buildPlmWorkbenchTeamViewShareUrl('cad', ...)` 生成，而产品页在 `applyQueryState()` 中只有在 query 里显式带了 `autoload=true` 时，才会继续触发：

- `loadCadMetadata()`
- `loadCadDiff()`

现状里 CAD share URL 会带：

- `panel=cad`
- `cadTeamView`
- `cadFileId`
- `cadOtherFileId`

但不会带 `autoload=true`。这会导致 fresh open 时虽然 route 已经 hydrate 到 CAD 视图和文件 ID，上层 runtime 却直接在 autoload gate 前返回，CAD 元数据和 diff 都不会加载。

## Goal

让 CAD team-view share URL 和当前产品页 deep-link runtime contract 对齐：只要分享链接里已经携带了可加载 CAD 的 primary `fileId`，就必须一并带上 `autoload=true`。

## Change

在 `apps/web/src/views/plm/plmWorkbenchViewState.ts` 的 `buildPlmWorkbenchTeamViewShareUrl('cad', ...)` 分支中：

- 当 `cadView.state.fileId` 存在时，追加 `autoload=true`

这保持了最小修改面：

- 不改 runtime autoload gate
- 不改 CAD route hydration 逻辑
- 只让 share URL 输出补齐它本来就依赖的加载信号

## Why This Shape

- 这是 source-of-truth contract 修复，问题根因在 share URL builder 漏了 runtime 所需字段
- 与 `buildDeepLinkParams(true)` 的现有设计一致：存在可加载 CAD 主文件时才设置 autoload
- 不会为没有 `fileId` 的空 CAD 视图制造多余加载
