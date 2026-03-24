# PLM Audit Takeover Selector Alignment Design

## Problem

`Apply` 仍然是 selector-first 语义：只要本地 `auditTeamViewKey` 还指向某个 team view，顶部 `Apply` 就会优先应用它。但 `scene-context`、source-aware local save、saved-view apply/context 这类 takeover 之前只清 notice、draft、followup、focus，不会同步清本地 selector。于是页面已经进入新的来源上下文，`Apply` 仍可能指向旧的本地下拉选择。

## Design

- 保持 `Apply` 的 selector-first 合同不变。
- 新增纯 helper `resolvePlmAuditTakeoverTeamViewSelectorId(...)`，约束非-apply takeover 的 selector 一律对齐到目标 route owner。
- 在以下入口统一消费该 helper：
  - `applySceneContextTakeoverCleanup()`
  - `saveCurrentLocalViewWithFollowup()`
  - `applySavedViewTakeover()`，由 `applySavedView()` 和 saved-view context quick actions 传入目标 `teamViewId`
- 不改 refresh shared-entry 分支，因为它已经显式 `applyRouteState(...)`，会同步覆盖 selector。

## Expected Outcome

- source-aware local saves 不再留下旧的 local selector。
- saved-view apply / context actions 即使 route sync 最终 no-op，也会先把 selector 对齐到目标 route owner。
- `Apply team view` 本身仍保持 selector-first，不回归现有交互。
