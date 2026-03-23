# PLM Audit Generic Management Draft Cleanup Design

## Background

`PLM Audit` 的 collaboration draft 主要由 source-aware 入口创建：

- recommendation handoff
- saved-view promotion handoff
- scene-context handoff

当用户通过 notice 上的 `Share` 或 `Set default` 完成动作时，现有逻辑已经会把 draft 清掉，并在需要时切到 followup。

## Problem

页面同时还暴露了一组 generic team-view management controls。

在本次修改前，如果 collaboration draft 已经锁定在某个 canonical team view 上，用户改用 generic `Share` 或 generic `Set default` 完成同一个目标视图的动作时：

- 动作会成功执行
- 旧的 collaboration draft 不会被清掉
- draft 自动装出来的单行 selection 也可能继续残留

结果就是动作已经完成，但 notice 还像没完成一样挂在页面上。

## Decision

把 generic management completion 也纳入 collaboration draft completion 合同：

- 如果动作目标就是当前 draft target，并且这次动作不是 source-aware followup takeover，则清 draft
- 清 draft 时继续沿用现有规则：只消费 draft-owned 单行 selection，保留用户后续改出的多选
- source-aware share/default 仍走 followup replacement 语义，不退回 generic cleanup

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`

Key changes:

- 新增 `resolvePlmAuditCompletedTeamViewCollaborationDraft(...)`
- 统一处理两类 completion：
  - source-aware followup replacement
  - generic managed action completion
- `shareAuditTeamViewEntry(...)` 和 `setAuditTeamViewDefaultEntry(...)` 都复用同一 helper

## Expected Behavior

- recommendation draft 仍可通过 notice 按钮正常转成 followup
- recommendation draft 也可以通过 generic `Share` / `Set default` 完成，并在完成后消失
- draft-owned 单行 selection 会一起清掉
- unrelated draft 或 source-aware replacement 不会被 generic cleanup 误伤
