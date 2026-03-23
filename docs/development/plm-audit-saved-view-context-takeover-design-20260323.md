# PLM Audit Saved-View Context Takeover Design

## Background

`PLM Audit` 里的 local saved view 已经支持两类 takeover：

- `Apply saved view`
- saved-view context quick action
  - `Show owner activity`
  - `Restore scene filter`
  - `Reapply scene`

前一轮已经把 `Apply saved view` 接到统一的 saved-view takeover cleanup。

## Problem

在本次修改前，saved-view context quick action 仍保留独立页面编排：

- 清 attention focus
- 清 saved-view followup/focus
- 直接 `syncRouteState(buildSavedViewContextState(...))`

它不会像 `Apply saved view` 一样先清 collaboration draft / followup。

这会在下面这类路径里留下真实残留：

1. recommendation `Manage audit team views` 先创建 collaboration draft
2. draft 自动装出单行 selection
3. 用户转到 saved views，对一个 scene-context saved view 点击 quick action
4. 如果这次 route pivot 不改 canonical `teamViewId`，watcher 不会帮忙清 draft

结果页面会同时保留：

- saved-view context route
- 旧 collaboration draft notice
- draft 自动装出来的单行 selection

## Decision

把 saved-view context quick action 也并入现有的 saved-view takeover 合同：

- 清 draft
- 清 followup
- 只消费 draft 自动装出来的单行 selection
- 不误清用户后来改过的多选

`Apply saved view` 和 saved-view context quick action 共用同一个页面 helper，不再维持两套 takeover 语义。

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- 在页面层新增 `applySavedViewTakeover(...)`
- `applySavedView(...)` 改为复用这套 helper
- `runSavedViewContextAction(...)` 也改为复用这套 helper
- focused regression 补一条 “draft only + single selection” 的 saved-view takeover 用例，锁住 context-action 这类 route-no-op 路径

## Expected Behavior

- saved-view context quick action 不再留下旧 collaboration draft
- 如果 draft 自动装出了单行 selection，这个 selection 会一起清掉
- saved-view apply 和 context-action 现在共享同一套 takeover cleanup 合同
