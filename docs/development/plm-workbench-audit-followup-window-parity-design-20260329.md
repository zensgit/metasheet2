# PLM Workbench Audit Followup Window Parity Design

## Background

`audit team view set-default` 成功后，页面会进入一条 canonical audit log route，并保留一个 collaboration followup，提示用户“已切换到对应审计日志”。这条 followup 只应在当前 route 仍然精确代表那条默认切换日志上下文时继续保留。

现状里 `shouldKeepPlmAuditTeamViewCollaborationFollowup(...)` 只校验了：

- `page`
- `q`
- `actorId`
- `kind`
- `action`
- `resourceType`
- `from`
- `to`

但没有把 `windowMinutes` 纳入 keep contract。结果是用户只改时间窗口时，route 已经不是原来的默认切换日志上下文，followup 却还会继续显示。

## Goal

把 `set-default` followup 的保留条件收紧到完整的 canonical audit log route，确保任何会改变日志上下文的 route 维度都能正确清掉 followup。

## Change

在 `apps/web/src/views/plmAuditTeamViewCollaboration.ts` 中：

- 扩大 `shouldKeepPlmAuditTeamViewCollaborationFollowup(...)` 的 route state 输入，纳入 `windowMinutes`
- 对 `set-default` followup 额外要求 `routeState.windowMinutes === DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes`

这样 `windowMinutes` 从默认值切到任意其它值时，followup 会像 `page/from/to/actorId` 变化一样被 watcher 正确清掉。

## Why This Shape

- 这是最小改动，直接补在现有 keep contract 上，不引入新的 watcher 分叉
- 使用 `DEFAULT_PLM_AUDIT_ROUTE_STATE.windowMinutes`，避免硬编码默认窗口值
- 语义与现有 `set-default` followup 的其它 canonical route 约束保持一致
