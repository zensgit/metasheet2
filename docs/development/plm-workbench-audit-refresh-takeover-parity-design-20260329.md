# PLM Workbench Audit Refresh Takeover Parity Design

## Background

`refreshAuditTeamViews()` 会重新拉取 audit team-view 列表，并基于当前 route 调用 `resolvePlmAuditRequestedTeamViewRouteState(...)` 解析目标状态。

现状里只要 resolver 返回 `kind === 'apply-view'`，非 shared-entry 路径就会无条件执行 `applyResolvedTeamViewTakeoverCleanup()`。这会清掉：

- collaboration draft
- collaboration followup
- share entry
- saved-view followup attention
- 管理表单 draft

问题在于：当当前 route 本来就是一个仍然有效的 canonical team-view route 时，`resolution.nextState` 和 `requestedState` 实际并没有变化。此时点击 Refresh 不应该被当成 route takeover，更不应该顺手清掉用户正在进行的 audit collaboration UI 状态。

## Goal

让 audit refresh 只在“真的发生 route takeover”时执行 cleanup，而不是在“route 仍有效且未变化”的普通 refresh 上误清本地状态。

## Change

在 `apps/web/src/views/plmAuditTeamViewRouteState.ts` 中新增纯 helper：

- `shouldApplyPlmAuditRequestedTeamViewTakeoverCleanup(...)`

规则：

- shared-entry takeover 继续始终 cleanup
- 否则仅当 `nextState !== requestedState` 时才 cleanup

然后在 `apps/web/src/views/PlmAuditView.vue` 的 `refreshAuditTeamViews()` 里改为使用这份 helper，而不再对所有 `apply-view` 结果一律执行 `applyResolvedTeamViewTakeoverCleanup()`。

## Why This Shape

- 把“refresh 是否代表真正 takeover”从组件里抽成纯 contract，易测、易复用
- 不影响 shared-entry 的既有 takeover 语义
- 保留 default auto-apply refresh 的 cleanup 行为，因为这类场景的 `nextState` 确实与 `requestedState` 不同
