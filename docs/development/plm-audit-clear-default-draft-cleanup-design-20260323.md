# PLM Audit Clear-Default Draft Cleanup Design

## Background

`PLM Audit` 的 generic 管理动作里，`Share` 和 `Set default` 已经会在成功后走 collaboration draft completion contract。

但 `Clear default` 之前还是独立编排：

- 更新 team view 列表
- 切到 `clear-default` audit log route
- 不处理当前 collaboration draft

## Problem

如果用户已经通过 recommendation `Manage` 或其他入口建立了 collaboration draft，然后直接点击 generic `Clear default`：

1. 页面切到 `clear-default` log route
2. `buildPlmAuditTeamViewLogState(..., 'clear-default', ...)` 会把 `teamViewId` 清成 `''`
3. 如果当前本来就在 log route，watcher 不一定会再替你清掉旧 draft

结果就是“默认已取消，但旧 collaboration notice 还在”的错位。

## Decision

让 `clear-default` 也并入既有 generic managed-action completion contract：

- 复用 `resolvePlmAuditCompletedTeamViewCollaborationDraft(...)`
- 清匹配 draft
- 只消费 draft 自动装出的单行 selection
- 不误清无关 draft 或用户多选

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `apps/web/tests/plmAuditTeamViewAudit.spec.ts`

## Expected Behavior

- generic `Clear default` 成功后，不再保留旧 collaboration draft
- `clear-default` log route 即使 `teamViewId === ''`，也不会阻止匹配 draft 被清理
- generic managed actions 的 draft completion contract 现在覆盖 `share / set-default / clear-default`
