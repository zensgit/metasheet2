# PLM Audit Refresh Apply-View Takeover Design

## Background

`refreshAuditTeamViews()` 会把当前 `/plm/audit` route 解析成 canonical team-view route。

典型场景包括：

- route 里已经有 `teamViewId`，refresh 后把它补齐成完整 team-view state
- 没有显式筛选时，refresh 自动解析到默认 team view

## Problem

在本次修改前，`resolution.kind === 'apply-view'` 这条本地 route coercion 只会：

- `applyRouteState(...)`
- 必要时 `syncRouteState(...)`

但不会先清 takeover residue。

结果是 refresh 把页面 silently 解析到另一个 canonical team view 后，旧的：

- management focus
- recommendation/saved-view source focus
- local saved-view followup
- shared-entry owner
- collaboration draft / followup

仍可能留在页面上，形成“实际 team view 已切换，视觉锚点还指着旧来源”的错位。

## Decision

给 refresh 的 `apply-view` 非 shared-entry 分支补一套纯 helper takeover：

- 清 route-pivot attention
- 清 local saved-view followup / focus
- 清 stale shared-entry owner
- 清 collaboration owner
- 只消费 draft 自动装出的单行 selection，不误清用户多选

`requestedSharedEntry` 的特判继续保留它自己的 takeover 语义，不改现有 shared-entry 流。

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewRouteTakeover.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewRouteTakeover.spec.ts`

## Expected Behavior

- refresh 把 route 解析到 canonical team view 时，不会再留下旧 notice / focus
- shared-entry 特判仍保留自己的 owner handoff 行为
- 非 shared-entry 的 refresh apply-view 会像其他 takeovers 一样回收 transient ownership
