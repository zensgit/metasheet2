# PLM Audit Scene Route Takeover Attention Design

## Background

`PLM Audit` 的 scene banner / scene token route pivots 这一轮已经接入了 collaboration takeover cleanup：

- `Clear context`
- `Show owner activity`
- `Restore scene filter`

这样可以回收旧的 collaboration draft / followup。

## Problem

这些 scene route pivots 之前仍然没有接入 saved-view / transient attention cleanup。

结果是：

1. 用户先通过 `scene-context` 保存本地视图
2. 页面出现 local saved-view followup / saved-view focus
3. 用户继续点 scene banner 的 owner / restore / clear
4. route 已经切到新的 scene-owned state，但旧 saved-view followup / focus 还留在页面上

这和前面已经收口的 saved-view takeovers、filter-navigation、route pivots 语义不一致。

## Decision

把 scene route takeovers 也统一并入一个纯 helper：

- 清 route-pivot attention
- 清 local saved-view followup / focus
- 清 collaboration draft / followup
- 只消费 draft 自动装出的单行 selection，不误伤用户主动维护的多选

## Implementation

Files:

- `apps/web/src/views/plmAuditSceneContextTakeover.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSceneContextTakeover.spec.ts`

Key changes:

- 新增 `buildPlmAuditSceneContextTakeoverState(...)`
- scene banner 的三个 route action 在 `syncRouteState(...)` 前统一走这套 helper
- helper 复用现有的 route-pivot attention contract 和 collaboration takeover contract，不新增第四套状态语义

## Expected Behavior

- scene route pivots 会和 saved-view/context takeovers 一样清掉 stale saved-view notice / focus
- scene route pivots 不再留下旧 collaboration owner
- 用户自己维护的多选不会被 scene takeover 误清
