# PLM Audit Source Local Save Takeover Design

## Background

`PLM Audit` 已经把来源驱动的本地保存收口成两条 canonical 入口：

- `shared-entry -> Save as local view / Save current view`
- `scene-context -> Save scene view / Save current view`

这些路径都会安装一个 saved-view local followup，提示用户接下来可以在本地 saved views 区继续操作。

## Problem

在本次修改前，`source-aware local save` 只会安装新的 saved-view followup 和 attention cleanup，但不会清掉已有的 team-view collaboration owner。

这会留下混合状态：

- 新的 local-save followup 已经出现
- 旧的 collaboration draft 或 followup 还留在页面上
- draft 自动装出来的单行 batch selection 也可能继续残留

结果是页面同时存在两套 transient owner，而且它们可能指向不同 team view。

## Decision

把 `source-aware local save` 明确建模成一次 ownership takeover：

- 在安装 saved-view followup 之前，先清 collaboration draft
- 同时清 collaboration followup
- 仅当当前 batch selection 是 draft 自动装出的单行选择时才消费它
- 用户自己后续改过的多选保持不动

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- 新增 `resolvePlmAuditSourceLocalSaveCollaborationState(...)`
- 统一返回 source-local-save takeover 后的 selection / draft / followup 状态
- `saveCurrentLocalViewWithFollowup(...)` 在安装 saved-view followup 前先消费旧的 collaboration owner

## Expected Behavior

- `shared-entry A -> manage B -> Save current view` 最终只剩 saved-view local followup
- `scene-context -> Save current view` 也不会和旧 collaboration notice 并存
- draft-owned 单行选择会跟着旧 owner 一起清掉
- 用户后来改出的多选不会被误清
