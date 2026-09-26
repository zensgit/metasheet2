# 验证：已批准请假销假后重算 live attendance_records（#5982）

> **日期**：2026-09-23  
> **基准**：`main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`  
> **设计**：`docs/development/attendance-approved-leave-cancel-record-recalc-design-20260923.md`  
> **未合并**。未依赖 #6004 / #6005。

## 做了什么

`executeRequestCancel` 在余额 `reverseLeaveBalanceDeduction` 之后，对 `legacy_projection_only` 与 `shadow`（以及未标明 `authoritative` 的姿态）调用 `recalculateLiveAttendanceRecordAfterApprovedLeaveCancel`。

该函数锁定当日 live 行，在行存在、未退役、且 `projection_owner` 为 `legacy_untracked`（无 `current_calculation_id`）时，用取消后仍为 `approved` 的分钟调用 `upsertAttendanceRecord`，**不**传 `statusOverride`。`authoritative` 不进入这条路径。

## 命令

工作区没有安装 pnpm 依赖。用独立的 Vitest 1.6.1 跑了这三个文件（`NODE_ENV=test`，未加载会去解析 `uuid` 的 `tests/setup.ts`）：

- `packages/core-backend/tests/unit/attendance-approved-leave-cancel-record-recalc.test.ts`（9）
- `packages/core-backend/tests/unit/attendance-leave-cancellation-reversal.test.ts`（7，余额反冲未改语义）
- `packages/core-backend/src/attendance/__tests__/w4c3b-approved-leave-cancellation.test.ts`（3，P14 边界未改）

19 passed。另外 `node --check plugins/plugin-attendance/index.cjs` 通过。

等价命令（依赖装好之后）：

```bash
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-approved-leave-cancel-record-recalc.test.ts \
  tests/unit/attendance-leave-cancellation-reversal.test.ts \
  src/attendance/__tests__/w4c3b-approved-leave-cancellation.test.ts
```

## 断言覆盖

- 姿态门：`legacy_projection_only` / `shadow` / 缺省 → 重算；`authoritative` → 不重算。
- `executeRequestCancel` 源码：helper 出现在 `reverseLeaveBalanceDeduction` 之后，且包在 `approvedLeave && shouldRecalculate…(operation.acceptedWritePosture)` 里；该函数体没有 `statusOverride: 'adjusted'`。
- 工作日、无打卡、剩余请假分钟 0：写入 `status='absent'`。
- 同日仍有另一笔批准请假：仍为 `adjusted`。
- 准时完整打卡：`normal`（540 分钟）。迟到打卡：`late`（lateMinutes 20），不再停留在 `adjusted`。
- 非工作日无打卡：`off`。
- 无行不插入；`retired` 不写；`projection_owner='w4'` 不写。
- 带 `manual_result_edit` 的行保留手工状态。

## 本环境没跑的

没有 Postgres，也没有把考勤插件挂进 HTTP。因此没走真实 `POST …/cancel`：没看到 `attendance_current_records` 视图、指针触发器、或 `adjusted_days` 汇总 SQL。单测里的 `trx.query` 是按 SQL 片段路由的假客户端。

P14 的 DB 集成测（`attendance-w4c3b-approved-leave-cancellation.db.test.ts`）未跑。本 PR 没有改 `w4c3b-approved-leave-cancellation.ts`。

## 开放问题

1. 手工改过的日（`manual_result_edit`）在不传 `statusOverride` 时沿用现有 upsert 耐久规则，销假不会改掉手工状态。若产品希望「销掉导致 adjusted 的那张假」也清掉后来的手工改判，需要另开口径。
2. 当天没有 live 行时不补插 `absent`。批准路径本来会插入；缺行只会出现在历史脏数据上。
3. `projection_owner='w4'` 的父行在 shadow 下不改。shadow 的 P14 本来就不写 live；`projection_owner` 只在 authoritative 写入。默认 shadow 可见行仍是批准时 legacy upsert 留下的 `legacy_untracked`，本 PR 会重算。若某组织先 authoritative 再切到 shadow，那张 W4 父行的日状态仍停在上次 authoritative 投影上，直到下一次 W4 写者。
4. 批准时写入的 `attendance_events`（`adjustment` / `source=request`）不删。列表和汇总看的是记录 `status`。
