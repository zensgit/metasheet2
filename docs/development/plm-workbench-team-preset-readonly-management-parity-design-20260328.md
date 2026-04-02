# PLM Workbench Team Preset Readonly Management Parity Design

## Context

`team view` 和 `team preset` 在 readonly target 上的管理动作反馈还存在一组不对称：

- `team view` 的 `delete / archive / restore / set-default / clear-default`
  会优先返回 `仅创建者可...`
- `team preset` 的同组 handler 还会统一落到 `当前...不可...`

这会让 `team preset` 的 denied reason 比 `team view` 更粗糙，也和按钮隐藏后的直接 handler 调用语义不一致。

## Problem

对 readonly `team preset` 来说，真正的阻塞原因是：

- 当前用户不是 owner

而不是：

- 动作本身在 owner 上也不可执行

如果继续返回泛化的 `当前...不可...`，会掩盖权限归因，并且和已经对齐过的 `share / rename / transfer` 语义不一致。

## Design

把 `team preset` 这组管理 handler 对齐到 `team view`：

- `deleteTeamPreset()`
- `archiveTeamPreset()`
- `setTeamPresetDefault()`
- `clearTeamPresetDefault()`
- `restoreTeamPreset()`

统一规则：

1. 先判 pending-management blocker
2. 再判 owner/manageability
3. 只有 owner target 才继续判 archived / granular actionability

其中 `restore` 是唯一例外：

- local owner drift 场景下允许 restore 继续执行
- 所以 restore 的 owner 判断必须回到 selected preset 自身权限
- 不能复用 `selectedManagementTarget`

另外把 archived `clear default` 文案也收口到和 `team view` 一致的 restore-first 语义。

## Scope

- `apps/web/src/views/plm/usePlmTeamFilterPresets.ts`
- `apps/web/tests/usePlmTeamFilterPresets.spec.ts`

## Expected Outcome

readonly `team preset` 的管理动作现在会和 `team view` 一样，优先返回准确的 owner denial，不再用泛化的“当前不可…”掩盖权限原因，同时不破坏已有的 local-owner-drift restore 特例。
