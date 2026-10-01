# 已批准请假销假后重算 live attendance_records（#5982）

> **文档性质：本 PR 的实现设计**  
> **日期**：2026-09-23  
> **基准**：`main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`  
> **不依赖**未合并的 #6004 / #6005。  
> **本 PR**：设计 + 实现 + 验证；**draft，不合并**。

## 0. 结论

| 姿态 | 销假后 live `attendance_records` |
|---|---|
| `legacy_projection_only`（默认，W4 未设） | **本 PR 重算**。批准时 `upsertAttendanceRecord` + `statusOverride:'adjusted'` 留下的日状态，按取消后仍为 `approved` 的请假/加班分钟和打卡，走与批准相同的 `computeMetrics`（**不**再钉 `adjusted`）。 |
| `shadow` | 同上。P14 只追加 calculation / shadow_diff，不改 live 行；员工与汇总读的是 `attendance_current_records`（`visibility_state='active'` 的 live 行）。 |
| `authoritative` | **不改**。P14 `w4c3b-approved-leave-cancellation.ts` 在 `mode==='authoritative'` 时已 `UPDATE attendance_records`。再用 legacy `computeMetrics` 覆盖会和指针守卫 / W4 投影打架。 |

余额反冲 `reverseLeaveBalanceDeduction`、待审取消、外勤批准、四卡、ACL O3 不在本改动里。不新增申请状态枚举。

## 1. 已核对的缺口

`executeRequestCancel`（`plugins/plugin-attendance/index.cjs`）：

- `approvedLeave` = `status==='approved' && request_type==='leave'`。
- `acceptedWritePosture === 'legacy_projection_only'` 时跳过 `appendApprovedLeaveCancellationCalculation`。
- 然后只跑 `reverseLeaveBalanceDeduction`。函数内没有 `loadApprovedMinutes` / `upsertAttendanceRecord`。

批准最终通过（同文件 `executeRequestDecisionInTransaction`，`requestType==='leave'`）会 `loadApprovedMinutes` 后 `upsertAttendanceRecord`，工作日 `statusOverride:'adjusted'`。无打卡且 `leaveMinutes>0` 时 `computeMetrics` 本身也返回 `adjusted`。

`GET` 列表对 `attendance_current_records.status` 原样返回，却用 `loadApprovedMinutesRange` 重算 `meta.leave_minutes`。销假后分钟已是 0，日状态仍可是 `adjusted`。`loadAttendanceSummary` 的 `adjusted_days` 按记录 `status` 计数，一并偏高。

`attendance_current_records` 是 `SELECT * FROM attendance_records WHERE visibility_state = 'active'`。改 live 行的 `status` 与分钟字段，列表和汇总一起收敛。

## 2. 做法

在请求已写成 `cancelled`、余额 reverse 之后（同一事务），当 `approvedLeave` 且姿态 **不是** `authoritative`：

1. `SELECT … FOR UPDATE` 当日记录。
2. 没有行、行已 `retired`、或行不是 legacy 投影（`projection_owner` 不是 `legacy_untracked`，或已有 `current_calculation_id`）→ **不写**。缺行时不插入新的缺勤行。retired / W4 归属行若硬写，要么无可见收益，要么触发 `W4C0_POINTER` 把整笔销假（含反冲）回滚。
3. 否则 `loadDefaultRule` + `resolveWorkContext` + `loadApprovedMinutes`（此时本单已是 `cancelled`，分钟只含其余仍批准的请假/加班）+ `upsertAttendanceRecord`。`mode:'merge'`，**不传** `statusOverride`。`computeMetrics` 决定状态：
   - 工作日、无打卡、剩余请假分钟 = 0 → `absent`
   - 工作日、无打卡、仍有批准请假分钟 → `adjusted`
   - 有完整打卡 → `normal` / `late` / `early_leave` / `late_early`；仅当既不迟到也不早退且仍有请假或加班分钟时才是 `adjusted`
   - 非工作日、无打卡 → `off`
4. 已有 `manual_result_edit` 且本次不传 `statusOverride` 时，沿用现有 upsert 耐久语义：保留手工状态。这不是请假钉死的 `adjusted`。

`authoritative` 仍只走已有 P14。`shadow` / `legacy_projection_only` 才走上面的 live 重算。P14 的 `review_required` 仍在改请求状态之前抛出，重算不会跑到。

## 3. 非目标

- 不改 P14 投影算法，不把 authoritative 再写一遍 legacy upsert。
- 不删批准时写入的 `attendance_events`（`adjustment` / `source=request`）。可见合同以记录 `status` 为准。
- 不开放已批准加班 / 补卡的取消（design-lock：非 pending 且非 approved leave → 400）。
- 不改年假 480/540 口径（#5969）。
