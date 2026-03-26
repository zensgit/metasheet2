# PLM Workbench Approvals Auto-Apply Gating Design

## Background

`approvals` 面板的默认团队视角会在当前 route 没有显式 approvals state 时自动接管。

同时，`approvalComment` 已经被收口为本地审批动作草稿：

- 不进入 approvals team view state
- 不进入 collaborative snapshot
- 不参与 approvals route-owner 匹配

## Problem

当前 `approvals` 默认 auto-apply gate 仍把 `approvalComment` 当成显式 query blocker。

复现：

1. 配置一个默认 `approvalsTeamView`。
2. 打开 `/plm?approvalComment=draft-note`，不带 `approvalsTeamView`，也不带其他 approvals query。
3. 页面 hydration 完成后，默认 approvals team view 不会 auto-apply。

这与 `approvalComment` 的本地草稿语义不一致。

## Design

新增 shared helper `hasExplicitPlmApprovalsAutoApplyQueryState(...)`：

- 基于 `normalizePlmWorkbenchQuerySnapshot(...)` 读取 approvals 相关 query
- 显式剔除 `approvalComment`
- 仅保留真正属于 approvals team view state 的 blocker：
  - `approvalsTeamView`
  - `approvalsStatus`
  - `approvalsFilter`
  - `approvalSort`
  - `approvalSortDir`
  - `approvalColumns`

然后把 `PlmProductView.vue` 里 approvals 面板的 `shouldAutoApplyDefault` 改为使用这条 helper。

## Expected Outcome

- `approvalComment` 单独存在时，不再阻断默认 `approvalsTeamView`
- 真正的 approvals route state 仍继续阻断默认 auto-apply
- approvals 面板和 workbench 主面板在 `approvalComment` 本地化语义上保持一致
