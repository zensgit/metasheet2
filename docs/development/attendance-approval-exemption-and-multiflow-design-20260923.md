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
3. 请假：与终审相同的余额扣减——`comp_time` 始终扣；年假、leave-offset 仅在对应策略 `enabled === true` 时扣。余额不足则整单回滚，不写当日考勤。
4. 请假抵扣若规则仍是 `partial_unpaid_absence`：在扣减和投影之前调用 `rejectLeaveOffsetPartialAbsence`（`plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs`）。这是与 #6015 终审路径共用的**唯一**拒绝函数，错误码 `422 LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`。不再传 `deductLeaveBalance({ mode: 'partial' })`，因此不会少扣余额再把全额请假分钟写入考勤。池子够不够扣都拒绝。
5. 请假/加班：通过上面的门之后才 `loadApprovedMinutes` + `upsertAttendanceRecord`，并写一条 `adjustment` / `source='request'` 事件。`referenceSegments` 用本事务边界已经解析好的位，不在行锁之后再解析。
6. 计算快照仍走创建追加。生命周期事件仍是单条 `attendance.requested`（outbox 种类是闭集）。
7. **临时门禁（owner 未决）**：免批加班在插入 `attendance_requests` 之前，以及 `applyExemptedLeaveOrOvertimeEffects` 投影之前，读取 `getSettings` 已经归一化的对象。`compTimeFromOvertime.enabled` 只有布尔 `true` 算启用（现有 normalizer 把非布尔退回默认 `false`）。`overtimeBankPolicy.enabled` 走现有 `parseBoolean`，所以字符串 `'true'` / `'1'` / `'yes'` 会变成布尔 `true` 并被拒绝；数字 `1` 不是字符串，`parseBoolean` 退回 `false`，不拒绝。守卫函数本身只判断 `=== true`，不再解析字符串。命中则抛 `422 EXEMPT_OVERTIME_CREDIT_PENDING`，不创建「已批准但未入账」的记录。两个策略都未启用时，免批加班仍按原设计直接 `approved` 并把分钟写入当日记录，不发调休批次。

## 非目标

- 不改 #5961 outdoor `requireApproval` 保存守卫，不改 `OUTDOOR_APPROVAL_FLOW_REQUIRED` / `SCHEDULE_DISPATCH_APPROVAL_FLOW_REQUIRED`。
- 不改 S7 动态审批人解析与 authoring gate。
- 不把「缺流」改成硬拒绝。
- 不改员工四卡、总览、ACL O3。
- **加班转调休 / 加班银行入账仍只在人工终审。** 两个策略默认关。策略未启用时，免批加班会把分钟写进当日记录，但不会发调休批次。**策略一旦启用，免批加班提交被 `422 EXEMPT_OVERTIME_CREDIT_PENDING` 拒绝**（临时门禁，等 owner 决定免批加班是否入账）。见验证文档。

## 验收

见 `attendance-approval-exemption-and-multiflow-verification-20260923.md`。
