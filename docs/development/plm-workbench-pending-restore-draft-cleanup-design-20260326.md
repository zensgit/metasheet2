# PLM Workbench Pending Restore Draft Cleanup Design

## Date
- 2026-03-26

## Problem
- `team views` 和 `team filter presets` 的 batch `restore` 已经支持一种重要语义：
  - 如果当前 canonical route owner 仍然是 `A`
  - 本地 selector 只是 pending 到已归档的 `B`
  - 批量恢复 `B` 时，不应把 canonical owner 从 `A` 劫持到 `B`
- 但当前实现只保住了 route owner，没有同步清理 `B` 挂着的本地 management drafts。
- 结果是 `teamViewName / teamViewOwnerUserId`，以及 `teamPresetName / teamPresetGroup / teamPresetOwnerUserId` 会在 batch `restore` 后继续残留，即使这次 lifecycle action 已经处理完同一个 pending target。

## Design
- 保持既有的 canonical owner 语义完全不变：
  - 如果 `requestedViewId/requestedPresetId` 仍然指向未处理的 active owner，就不改 route owner。
- 只补 pending restored target 的 draft cleanup：
  - 当 `selectedIdBeforeAction` 被 `processedIds` 命中时，无论 restore 是否会调用 `applyView/applyPresetToTarget`，都清掉该 target 的本地 management drafts。
- 这条 cleanup 只在 `selectedIdBeforeAction` 实际被 restore 处理时触发：
  - 不影响 create-mode drafts
  - 不影响未命中的 selector target
  - 不影响 canonical owner 保留逻辑

## Intended Result
- batch `restore` 之后，pending local selector target 不会继续保留 stale rename / transfer / group drafts。
- `team views` 与 `team presets` 的 lifecycle cleanup 语义保持对称。

## Touched Files
- `apps/web/src/views/plm/usePlmTeamViews.ts`
- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/tests/usePlmTeamViews.spec.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`
