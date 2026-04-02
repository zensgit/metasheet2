# PLM Audit Refresh Route Takeover Form-Draft Design

## Problem

`refreshAuditTeamViews()` 在普通 `apply-view` 和 `clear-selection` takeover 分支里已经会清 attention、saved-view followup、shared-entry、collaboration draft/followup，但此前不会清理 management-owned team-view form drafts。结果是 refresh 把 canonical owner 切到新的 team view 后，旧的 `Rename / Save to team` 名称草稿仍会残留在输入框里。

## Design

- 扩展 `buildPlmAuditTeamViewRouteTakeoverState(...)`，把 team-view form draft 一并纳入 route takeover 的纯状态转换。
- 复用已有的 `resolvePlmAuditTakeoverTeamViewFormDraftState(...)`：
  - management-owned draft 会被清掉
  - create-mode draft 会被保留
- `PlmAuditView.vue` 的 `applyResolvedTeamViewTakeoverCleanup()` 改为直接消费 route takeover helper 返回的 `formDraft`，让 refresh `apply-view` 和 `clear-selection` 自动获得同样 cleanup。

## Expected Outcome

- refresh 驱动的 canonical target 变化不再携带旧的 team-view rename/save 草稿。
- create-mode draft 继续保留，不影响“新建 team view”流程。
- `scene-context / saved-view / shared-entry` 与 refresh takeover 的 form-draft 合同保持一致。
