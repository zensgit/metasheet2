# PLM Audit Refresh Clear-Selection Takeover Design

## Background

`refreshAuditTeamViews()` 不只会把请求 route 解析成 canonical team view，也会在请求的 `teamViewId` 不再可用时进入 `clear-selection`：

- view 被删除
- view 被归档，因此不再允许继续作为 active audit team view
- route 上遗留了一个已失效的 `teamViewId`

## Problem

在本次修改前，`resolution.kind === 'clear-selection'` 分支只会本地：

- `applyRouteState(...)`
- 必要时 `syncRouteState(...)`

但不会先做 takeover cleanup。

这意味着如果当前页面还挂着：

- stale management focus
- stale saved-view followup / focus
- stale shared-entry owner
- stale collaboration ownership

那么 refresh 虽然把 canonical route 的 `teamViewId` 清掉了，这些 transient UI 仍可能留在页面上。

## Decision

让 `clear-selection` 和 `apply-view` 的 generic refresh route coercion 共用同一套 route-takeover cleanup：

- 清 transient attention
- 清 local saved-view notice / focus
- 清 shared-entry owner
- 清 collaboration owner
- 只保留用户主动维护的多选

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewRouteTakeover.spec.ts`

## Expected Behavior

- refresh 清掉失效 `teamViewId` 前，会先清 stale transient ownership
- “已归档 / 已失效的 view 被清空选择” 不会再留下错误高亮或 notice
- refresh route coercion 的 `apply-view` 与 `clear-selection` 现在共享同一套 generic takeover contract
