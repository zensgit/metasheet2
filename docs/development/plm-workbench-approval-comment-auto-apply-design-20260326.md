# PLM Workbench Approval Comment Auto-Apply Design

## Background

`workbench` 主面板的默认团队视角会在没有显式 query state 时自动接管。当前 gating 由 `PlmProductView.vue` 的 `hasExplicitWorkbenchQueryState()` 控制。

同时，`approvalComment` 只是本地审批动作草稿：

- 它会从 collaborative workbench snapshot 里被剥掉；
- 它不会进入保存、分享和 route-owner 匹配。

## Problem

当前 gate 仍把 `approvalComment` 视为显式 workbench query state。

复现：

1. 配置一个默认 `workbenchTeamView`。
2. 打开 `/plm?approvalComment=draft-note`，不带 `workbenchTeamView`，也不带其他 workbench collaborative query。
3. 页面 hydration 完成本地 `approvalComment` 草稿恢复。
4. 默认团队视角不会 auto-apply。

这和 collaborative snapshot 的既有合同矛盾：`approvalComment` 是本地草稿，不应该阻断默认协作视角的接管。

## Design

把 auto-apply blocker 收口成独立 helper：

- 新增 `hasExplicitPlmWorkbenchAutoApplyQueryState(value)`。
- 它基于 `normalizePlmWorkbenchQuerySnapshot(...)` 判断显式 state。
- 仅剔除 `approvalComment`，其余 query key 继续保持原 blocker 语义。

然后 `PlmProductView.vue` 的 `hasExplicitWorkbenchQueryState()` 改为直接调用这条 helper。

## Expected Outcome

- 只有 `approvalComment` 时，默认 `workbenchTeamView` 可以 auto-apply。
- 只要存在真正的显式 workbench query state，例如 `workbenchTeamView`、`approvalsFilter`、`productId`，auto-apply 仍然被阻断。
- `approvalComment` 继续保持本地草稿属性，不进入 collaborative owner 合同。
