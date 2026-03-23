# PLM Audit Lifecycle Draft Cleanup Design

## Problem

generic lifecycle actions (`archive / restore / delete / clear-default`) 和 batch lifecycle actions 之前没有完整复用 generic collaboration draft completion 合同。尤其当页面已经处于 log/default route、`teamViewId=''` 时，route watcher 可能不会再替这些动作清掉匹配的 collaboration draft。

## Design

- 单个 lifecycle action：
  - `archive / restore / clear-default` 在切换到日志 route 前，显式复用 `resolvePlmAuditCompletedTeamViewCollaborationDraft(...)`
  - 命中当前 draft target 时清掉 draft，并只消费 draft 自动装出来的单行 selection
- batch lifecycle action：
  - 新增 `resolvePlmAuditCompletedTeamViewBatchCollaborationDraft(...)`
  - 只要 `processedTeamViewIds` 命中当前 draft target，就清掉 draft
  - 手动多选保持不变，不把用户 later-edited multi-select 误清

## Expected Outcome

- generic lifecycle actions 和 `share / set-default / clear-default` 一样，都会收掉自身命中的旧 draft
- batch `archive / restore / delete` 不再让旧 draft 或 draft-owned single selection 残留到新的 batch log route
- 手动多选继续保留
