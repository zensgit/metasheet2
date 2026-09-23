# 请假/加班免批与多条启用流（#5967）

> **文档性质：本 PR 的实现设计**  
> **日期**：2026-09-23  
> **基准**：`main` @ `cd42eaf74`  
> **不依赖** #6004（未合并；#5986 / #5990 不在本 PR）

## 结论

| 项 | 选择 |
|---|---|
| `requiresApproval === false` | 创建时 **不** 写 `approval_instances` / `approval_assignments`，`attendance_requests.status = 'approved'`，`approval_instance_id` 为空 |
| 状态名 | 用已有 `approved`，不用新值 `auto_approved`。`attendance_requests_status_check` 只允许 `pending` / `approved` / `rejected` / `cancelled`。新状态对 `loadApprovedMinutes`、日历覆盖、重复单判断都不可见 |
| 免批标记 | `metadata.approvalExemption = { version: 1, reason: 'requires_approval_false', source: 'leave_type' \| 'overtime_rule' }`，并写 `metadata.resolution`（`source: 'requires_approval_false'`） |
| 多条启用流 | **提交时 fail-closed**，对齐 outdoor / dispatch 的「多于一条」：未带 `approvalFlowId` 且该 `request_type` 启用流 **>1** → `422 ATTENDANCE_APPROVAL_FLOW_REQUIRED`。不静默 `ORDER BY created_at DESC LIMIT 1` |
| 零条启用流 | **保持** leave / OT / makeup 的 admin / `attendance:approve` 队列回落（`buildAttendanceApprovalAssignments([])`）。这是与 outdoor「0 条也 422」的有意差别：缺流回落已被 `attendance-approval-center-bridge.test.ts` 锁住，且 issue 允许在 `requiresApproval` 为真时保留 |
| 显式 `approvalFlowId` | 必须 `is_active` 且 `request_type` 匹配，否则同一 422。命中则使用该条，即使同类型还有别的启用流 |
| 保存第二条流 | **不** 在 POST/PUT 审批流时 409。唯一约束仍是 `(org_id, request_type, name)`。歧义在提交时拒绝 |

`requiresApproval` 只有严格 `=== false` 才免批。缺省、`null`、`true` 都走审批。映射层 `?? true` 不变。

## 免批范围

- **请假类型**、**加班规则**：列 `requires_approval` 已存在。创建路径读它。
- **补卡**（`missed_check_in` / `missed_check_out` / `time_correction`）：没有同类开关。`makeupPunchPolicy` 只有额度、窗口、原因、附件。补卡 **继续一律建 pending + 审批实例**。多流规则与请假/加班相同（0 条回落，>1 条 422，显式 id 校验）。
- 免批只作用于 **新建**。已是 pending 的单再编辑，不改成免批、不拆掉已有实例。
- 免批创建 **不** 选流：多条启用流不挡住免批提交；员工若带了 `approvalFlowId` 也忽略。之后把开关改回「需要审批」时，提交再按上面的多流规则拒绝。

## `loadApprovalFlow(flowId)`

- 同时传入 `flowId` 和 `requestType`：`is_active = true` 且 `request_type` 匹配，否则 `null`。通用申请走这条。
- **只** 传 `flowId`：查询保持原样（含停用流）。`GET /api/attendance/approval-flows/:id` 和 outdoor 的事后校验依赖它。outdoor / `schedule_dispatch` 的错误码与 0/多条判断不改。
- 无 `flowId` 的 `LIMIT 1` **不** 改。换班仍经 `loadActiveApprovalFlowForRequestType` 走这条；本 issue 的成功标准是请假流，不改换班、不改 S7 动态审批人解析。

通用申请在需要审批且未带 id 时，自己 `LIMIT 2` 计数，不调用那条 `LIMIT 1`。

## 免批写入同一事务

1. `deriveAttendanceApprovalOrgStampV1` 盖 `attendance_requests.org_id`（与审批实例写入同一套组织派生），但不插入实例。
2. 插入 `status='approved'`，`resolved_by` = 申请人，`resolved_at` = now。
3. 请假：与终审相同的余额扣减——`comp_time` 始终扣；年假、leave-offset 仅在对应策略 `enabled === true` 时扣。余额不足则整单回滚。
4. 请假/加班：`loadApprovedMinutes` + `upsertAttendanceRecord`，并写一条 `adjustment` / `source='request'` 事件。`referenceSegments` 用本事务边界已经解析好的位，不在行锁之后再解析。
5. 计算快照仍走创建追加。生命周期事件仍是单条 `attendance.requested`（outbox 种类是闭集）。

## 非目标

- 不改 #5961 outdoor `requireApproval` 保存守卫，不改 `OUTDOOR_APPROVAL_FLOW_REQUIRED` / `SCHEDULE_DISPATCH_APPROVAL_FLOW_REQUIRED`。
- 不改 S7 动态审批人解析与 authoring gate。
- 不把「缺流」改成硬拒绝。
- 不改员工四卡、总览、ACL O3。
- **加班转调休 / 加班银行入账仍只在人工终审。** `compTimeFromOvertime` 与 `overtimeBankPolicy` 默认关。免批加班会把分钟写进当日记录，但不会发调休批次。见验证文档的开放问题。

## 验收

见 `attendance-approval-exemption-and-multiflow-verification-20260923.md`。
