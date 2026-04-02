# PLM Workbench Approval History Select Parity Design

## Background

审批 approve/reject 路由写入 `approval_records` 时已经保存了 `id` 和 `actor_name`。

`/api/approvals/:id/history` 读取历史时却没有把这两个字段查出来，导致前端历史表格拿不到稳定 row key，也拿不到可读 actor 名称。

## Problem

- `ApprovalInboxView` 和产品页审批历史都优先显示 `actor_name || actor_id`。
- 当前 history route 只返回 `actor_id`，前端稳定回退成内部 ID。
- 列表行 `:key="record.id"` 实际为 `undefined`，不利于历史刷新后的 DOM diff 稳定性。

## Decision

- 在 `approval-history` route 的 SELECT 中补上 `id` 和 `actor_name`。
- 保持现有分页和排序逻辑不变，不改动响应 envelope。

## Expected Result

- 审批历史 API 返回完整 row identity。
- 前端能优先展示 `actor_name`。
- 历史记录列表的 Vue key 恢复稳定。
