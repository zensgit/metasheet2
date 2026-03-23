# PLM Audit Saved-View Apply Takeover Design

## Background

`PLM Audit` 里 local saved view 已经是一个独立的 transient owner：

- `Save current view`
- `Save scene view`
- `Apply saved view`

其中 source-aware local save 已经会在接管前清掉旧的 collaboration draft / followup。

## Problem

在本次修改前，`Apply saved view` 只做了两件事：

- 清理 saved-view attention
- 清理 collaboration followup

但它不会清 collaboration draft。

这会在下面这类路径里留下真实残留：

1. recommendation / team-view management 先创建 collaboration draft
2. 当前 canonical route 仍然保持原样
3. 用户点击一个 local saved view 的 `Apply`

如果这个 saved-view snapshot 和当前 canonical route 一样，`syncRouteState(...)` 会直接 no-op，route watcher 也不会帮忙清 draft。结果页面会同时保留：

- 新的 saved-view focus
- 旧的 collaboration draft notice
- draft 自动装出来的单行 selection

## Decision

把 “saved-view takeover” 统一成同一套 collaboration 清理合同：

- 清掉 draft
- 清掉 followup
- 只消费 draft 自动装出来的单行 selection
- 不误清用户后续改过的多选

`Save current view` 和 `Apply saved view` 都复用这套 helper，不再各自手写。

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- `resolvePlmAuditSourceLocalSaveCollaborationState(...)` 提升并重命名为
  `resolvePlmAuditSavedViewTakeoverCollaborationState(...)`
- `saveCurrentLocalViewWithFollowup(...)` 继续使用这套 helper
- `applySavedView(...)` 现在也在 route sync 前先应用同一套 takeover cleanup

## Expected Behavior

- `Apply saved view` 不再留下旧 collaboration draft
- 如果 draft 曾自动装出单行 selection，这个 selection 会一起清掉
- route 不变化时，saved-view apply 也能正确完成 takeover，不依赖 watcher 自愈
