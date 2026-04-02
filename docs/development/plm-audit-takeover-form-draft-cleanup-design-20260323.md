# PLM Audit Takeover Form Draft Cleanup Design

## Problem

`auditTeamViewName` / `auditTeamViewNameOwnerId` 同时服务于 `Save to team`、`Rename` 和部分 ownership flows。此前 `scene-context`、`saved-view`、`shared-entry` 这类非管理态 takeover 只清 transient notice/owner，不清 management-owned form draft，于是旧的 rename/save 草稿会穿透到新的来源上下文。

## Design

- 保持现有 canonical management owner 变更合同不变：
  - 仍允许 team-view management 语义内部保留 name draft。
- 新增纯 helper `resolvePlmAuditTakeoverTeamViewFormDraftState(...)`：
  - 如果 `draftTeamViewNameOwnerId` 为空，视为 create-mode draft，原样保留。
  - 如果 `draftTeamViewNameOwnerId` 非空，视为 management-owned draft，在 takeover 时整体清空 `draftTeamViewName`、`draftTeamViewNameOwnerId`、`draftOwnerUserId`。
- 在以下非管理态 takeover 入口统一消费该 helper：
  - `scene-context` route takeovers
  - `saved-view` apply/context quick actions
  - source-aware local saves
  - refresh driven `shared-entry` takeovers

## Expected Outcome

- 旧的 rename/save-to-team 草稿不会再穿透到 `scene`、`saved-view`、`shared-entry` 等来源上下文。
- create-mode team-view draft 继续保留，不影响用户正在新建的草稿。
- team-view management 内部的 canonical-owner 迁移仍沿用现有“保留 name draft、清 owner draft”的合同。
