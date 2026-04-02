# PLM Workbench Local Preset Destructive Action Ownership Design

## Background

`BOM` 和 `Where-Used` 面板里的本地过滤预设，会通过 `runPlmLocalPresetOwnershipAction(...)` 在团队预设动作成功后消费本地 owner。

上一轮已经把 `save/apply/duplicate/rename/transfer/set-default/promote` 这类真正会把当前过滤状态切到团队预设的动作改成按真实成功结果再 takeover。本轮继续检查后发现，`archive`、batch `archive`、batch `delete` 这类 destructive action 并不会把当前过滤状态切到团队预设，但页面 wrapper 仍然把 truthy result 当成 takeover 成功。

## Problem

复现路径：

1. 当前 `bomFilterPreset` 或 `whereUsedFilterPreset` 由本地 preset route owner 持有。
2. 用户在团队预设下拉里选中另一个团队预设，但没有执行 `Apply`。
3. 用户执行 single `Archive`、batch `Archive` 或 batch `Delete`。
4. 底层 action 成功返回 truthy result，wrapper 提前清掉本地 preset owner。

结果是当前过滤状态仍然是本地 preset 的状态，但 route 已丢失本地 owner。后续 refresh、share、reload 都无法再 authoritative 地 round-trip 回真正拥有当前过滤状态的本地 preset。

## Design

把 “是否清本地 owner” 收口成显式动作语义：

- 新增 `shouldClearLocalPresetOwnerAfterTeamPresetAction(action, result)`。
- `archive`、`batch-archive`、`batch-delete` 明确返回 `false`。
- 仍会 takeover 当前状态的动作保持 `Boolean(result)` 语义，例如 `apply`、`save`、`duplicate`、`rename`、`transfer`、`set-default`、`restore`、`promote`、`promote-default`。

页面 wrapper 对齐到这套 helper：

- `archiveBomTeamPreset`
- `archiveBomTeamPresetSelection`
- `deleteBomTeamPresetSelection`
- `archiveWhereUsedTeamPreset`
- `archiveWhereUsedTeamPresetSelection`
- `deleteWhereUsedTeamPresetSelection`

这样 destructive action 只更新团队预设列表和 selection，不会错误消费仍然有效的本地 preset owner。

## Expected Outcome

- destructive team preset action 成功后，本地 preset owner 继续保留；
- restore/promote/apply 这类真正 takeover 当前过滤状态的动作，仍会清理本地 owner；
- BOM 和 Where-Used 两条面板语义完全一致。
