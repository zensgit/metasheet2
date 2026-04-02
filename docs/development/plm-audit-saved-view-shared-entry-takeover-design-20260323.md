# PLM Audit Saved-View Shared-Entry Takeover Design

## Background

`PLM Audit` 已经把 shared-entry 视为一种 transient route owner：

- URL 上通过 `auditEntry=share` 标记
- 页面本地通过 `auditTeamViewShareEntry` 渲染 notice

前几轮已经把下面几类 takeover 收口到“会消费 shared-entry owner”：

- `Save as local view`
- recommendation/source-aware collaboration actions
- filter navigation / dismiss

## Problem

在本次修改前，saved-view takeover 仍然存在一个残留：

- `Apply saved view`
- saved-view context quick action

这两条路径会：

1. 清 attention
2. 清 collaboration draft / followup
3. 直接 `syncRouteState(...)`

但它们不会主动消费 `auditEntry=share`，也不会清本地 `auditTeamViewShareEntry`。

当 saved-view 恢复出的 canonical route state 与当前 shared-entry route 相同时，会出现：

- `parsePlmAuditRouteState(route.query)` 与 next state 相等
- `syncRouteState(...)` 认为 route 没变
- shared-entry query marker 不被消费
- 旧 shared-entry notice 继续留在页面上

这会让用户明明已经切到 local saved-view 语义，页面却还显示“Opened from a shared audit team view”。

## Decision

把 saved-view takeover 也纳入 shared-entry owner takeover 合同：

- 只要当前存在 active shared-entry owner，saved-view apply/context action 都应视为 takeover
- takeover 时先清本地 `auditTeamViewShareEntry`
- route sync 一律带 `consumeSharedEntry: true`

这样即使 canonical route state 没变化，也会强制 replace 掉 `auditEntry=share`。

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Key changes:

- 新增 `shouldTakeOverPlmAuditSharedEntryOnSavedViewTakeover(...)`
- `applySavedViewTakeover(...)` 现在会清掉 active shared-entry owner
- `Apply saved view` 和 saved-view context quick action 的 `syncRouteState(...)` 统一加上 `consumeSharedEntry: true`
- 补 focused regression，锁住“saved-view takeover 会接管 shared-entry owner”

## Expected Behavior

- shared-entry 下点击 `Apply saved view` 不再留下旧 share notice
- shared-entry 下触发 saved-view context quick action 不再保留 `auditEntry=share`
- 即使 restore 后的 canonical route state 和当前 route 相同，saved-view takeover 仍会显式消费 shared-entry marker
