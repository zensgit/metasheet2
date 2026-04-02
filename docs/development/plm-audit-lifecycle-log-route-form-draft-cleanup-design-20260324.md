# PLM Audit Lifecycle Log-Route Form-Draft Cleanup Design

## Problem

`Clear default`、single lifecycle `Archive / Restore / Delete`、以及 batch lifecycle 都会把页面切到 team-view audit log route。这个 route 没有 durable `teamViewId` owner，但页面之前只依赖 canonical-owner watcher 来处理 `auditTeamViewName` / `auditTeamViewOwnerUserId` 草稿。

结果是 owner-bound 的 rename/save-to-team 草稿会在 log route 上残留，继续占着顶部管理输入框。

## Design

- 保持 `resolvePlmAuditCanonicalTeamViewFormDraftState(...)` 的现有合同不变。
- 新增语义化 helper `resolvePlmAuditLogRouteTakeoverFormDraftState(...)`，复用 takeover draft-cleanup 语义：
  - management-owned drafts 清空
  - create-mode drafts 保留
- 在以下进入 ownerless log route 的入口显式消费这条 cleanup：
  - `clearAuditTeamViewDefault()`
  - `runAuditTeamViewLifecycleAction()` 的 `delete / archive / restore`
  - `runAuditTeamViewBatchAction()`

## Expected Outcome

- lifecycle/default-log route 不再残留旧的 management-owned team-view name / owner drafts。
- create-mode 下的本地草稿仍保留，不影响后续新建 team view。
- 这次变更只补 log-route takeover，不影响 `set-default` followup 或其他仍有 canonical owner 的路径。
