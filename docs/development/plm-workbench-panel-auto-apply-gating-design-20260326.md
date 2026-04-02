# PLM Workbench Panel Auto-Apply Gating Design

## Background

默认 `workbenchTeamView` 的 auto-apply 依赖 `hasExplicitPlmWorkbenchAutoApplyQueryState(...)` 来判断当前 route 是否已有显式 workbench 状态。

`panel` 本身已经有 canonical 语义：

- `panel=all` 会被归一化成“无显式 panel scope”
- 非法 `panel` token 也会被归一化成“无显式 panel scope”

## Problem

当前 auto-apply blocker 只做了 `normalizePlmWorkbenchQuerySnapshot(...)`，还没有把 `panel` 按 canonical scope 归一化。

结果是：

- `/plm?panel=all`
- `/plm?panel=unknown`

虽然 hydration 会把它们当成“无显式 panel scope”，默认 `workbenchTeamView` auto-apply 仍然会被这两个 raw query 错误阻断。

## Design

继续沿用 `hasExplicitPlmWorkbenchAutoApplyQueryState(...)`，但把 `panel` 也纳入 canonical normalization：

- 先保留现有 `approvalComment` 剔除逻辑
- 再对 `panel` 调用 `normalizePlmWorkbenchPanelScope(...)`
- 如果结果为空，则从 blocker snapshot 中删掉 `panel`
- 如果结果有效，则写回 canonical 顺序后的 `panel`

## Expected Outcome

- `panel=all` 不再阻断默认 `workbenchTeamView` auto-apply
- 非法 `panel` token 不再阻断默认 `workbenchTeamView` auto-apply
- `panel=approvals,documents` 这类真正的显式 scope 继续阻断 auto-apply
- `panel` 的 blocker 语义和 hydration/share/snapshot 保持一致
