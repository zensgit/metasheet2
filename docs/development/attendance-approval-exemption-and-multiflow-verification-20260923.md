# 验证：请假/加班免批与多条启用流（#5967）

> **日期**：2026-09-23  
> **设计**：`attendance-approval-exemption-and-multiflow-design-20260923.md`  
> **分支**：`cursor/attendance-approval-exemption-c338`  
> **基准**：`main` @ `cd42eaf74`  
> #6004 未合并，本变更不依赖它。

## 验收清单

- [x] 请假类型 `requiresApproval === false`：`attendanceRequestSkipsApproval('leave', …)` 为真。创建路径在该标志下不调用 `upsertAttendanceApprovalInstance`，插入 `status='approved'`、`approval_instance_id` 为空，并写 `metadata.approvalExemption`。
- [x] 加班规则同样：严格 `=== false` 才免批。
- [x] 补卡三种类型没有该列。即使传入 `requiresApproval: false` 的假种/加班对象，`missed_check_in` / `missed_check_out` / `time_correction` 仍不免批，继续走 pending + 审批实例。
- [x] 未带 `approvalFlowId` 且同类型启用流为 0：`resolveGenericApprovalFlow` 返回 `null`，空步骤仍由 `buildAttendanceApprovalAssignments([])` 落到 admin / `attendance:approve`（既有 bridge 测试未改语义）。
- [x] 同类型启用流 >1 且未带 id：`422`，`code = ATTENDANCE_APPROVAL_FLOW_REQUIRED`，不取 `created_at DESC` 的最新一条。
- [x] 显式 id 停用或类型不符：`422`。显式 id 命中启用流：使用该条，即使还有另一条启用流。
- [x] 只传 `flowId` 的 `loadApprovalFlow` 仍能读到停用流（admin GET / outdoor 事后校验）。outdoor / dispatch 的错误码与查询未改。
- [x] 缺省、`true`、字符串 `'false'`、数字 `0` 都不免批。
- [x] 免批请假、规则为 `partial_unpaid_absence`：`applyExemptedLeaveOrOvertimeEffects` 在读余额之前抛 `422 LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`。余额查询、余额 UPDATE、`attendance_events` INSERT 都不发生。池子不足（10/60）和池子足够（500/60）都拒绝。
- [x] 免批请假、`insufficient=block` 且余额不足：`422 LEAVE_OFFSET_BALANCE_INSUFFICIENT`，没有余额写入，也没有考勤投影。
- [x] 免批调休、免批年假（策略已启用）余额不足：分别 `422 COMP_TIME_BALANCE_INSUFFICIENT` / `ANNUAL_LEAVE_BALANCE_INSUFFICIENT`，没有考勤写入。
- [x] 免批加班且归一化后的 `compTimeFromOvertime.enabled === true` 或 `overtimeBankPolicy.enabled === true`：`422 EXEMPT_OVERTIME_CREDIT_PENDING`，没有考勤写入。加班银行存成字符串 `'true'` 时，`parseBoolean` 把它变成 `true`，同样拒绝。调休策略存成字符串 `'true'`、加班银行存成数字 `1` 时不算启用，投影函数继续往后走。两个策略都关时也不走这道门。创建事务在 `INSERT attendance_requests` 之前也调用同一函数。
- [ ] 未在本环境对真实 Postgres 跑 HTTP 创建。上面的余额/入账拒绝由脚本化事务（假 `trx.query`）打到 `applyExemptedLeaveOrOvertimeEffects`，不是 HTTP。

## 命令

工作区没有装好的 pnpm 依赖。用独立的 vitest 1.6.1 跑这两个文件（不加载 `packages/core-backend/vitest.config.ts` 的 setup，那个 setup 会去拉 `uuid`）：

```bash
node --check plugins/plugin-attendance/index.cjs
# vitest 1.6.1, config 只 include 下面两个文件
vitest run --watch=false \
  packages/core-backend/tests/unit/attendance-approval-exemption-5967.test.ts \
  packages/core-backend/tests/unit/attendance-approval-center-bridge.test.ts
```

结果：2 files, 10 tests passed（新增 7，bridge 3）。

仓库内等价命令（依赖装好之后）：

```bash
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-approval-exemption-5967.test.ts \
  tests/unit/attendance-approval-center-bridge.test.ts
```

### 2026-09-24 复核（与 #6015 共用拒绝、免批加班临时门禁、DML 声明）

```bash
node --check plugins/plugin-attendance/index.cjs
node --check plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-approval-exemption-5967.test.ts \
  tests/unit/attendance-approval-exemption-balance-5967.test.ts \
  tests/unit/attendance-approval-center-bridge.test.ts \
  tests/unit/attendance-w7-w6r5-preservation-guard.test.ts
node --test scripts/ops/attendance-w4c0-dml-inventory-collector.test.mjs
```

结果：vitest 4 files, 33 tests passed（含免批余额负例与加班入账门禁）。DML collector 60 passed。先前 CI `test (18.x)` / `test (20.x)` 失败是真实的：免批路径新增的 `attendance_events` INSERT 被符号启发式归到未声明站点，不是基础设施抖动。P13 现按符号 `applyExemptedLeaveOrOvertimeEffects` 声明该站点。本环境没有 `DATABASE_URL`，未重跑 HTTP/集成。

## 共享 default 组织的兼容

`attendance-plugin.test.ts` 里三条销假用例在同文件已经插入两条启用请假流之后还要 `POST` 请假且期望 201。它们现在在存在启用请假流时带上一条 `approvalFlowId`，避免被新的多流 422 挡住。余额断言不变。没带 id 的提交在启用流多于一条时会 422，这是本修复的合同。

## 变异

- 把 `requiresApproval === false` 放宽成 `!== true` 或 `!requiresApproval`：缺省 / `'false'` / `0` 用例变红。
- 把多流查询改回 `LIMIT 1` 并返回最新一条：「两条启用流」用例期望 422，变红。
- 去掉 `flowId + requestType` 的 `is_active` / `request_type` 条件：停用流或错类型用例不再 422，变红。
- 让只传 `flowId` 也过滤 `is_active`：停用流仍可读的用例变红（会误伤 admin GET 与 outdoor）。

抓不到的降级：创建事务里「免批仍插入 approval_instances」要靠 HTTP/DB 才能看见；本环境没跑那一层。选择函数被创建路径调用，但插入语句本身没有单测打到数据库。

## 与 #6015 的共用拒绝

`rejectLeaveOffsetPartialAbsence` 在 `plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs`。本 PR 的免批扣减和 #6015 的人工终审都调用它，错误码和文案只有这一份。文件被标进 `ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1`：它只在提交/批准前抛 422，不构建冻结工时上下文。

免批路径新的 `attendance_events` INSERT 记在 W4C-0 债务条目 P13（申请终态处理），符号 `applyExemptedLeaveOrOvertimeEffects`。这修的是 CI `attendance-w4c0-dml-inventory-collector` 把该 INSERT 标成未声明站点。

## 开放问题

1. **Owner 未决，临时门禁已加上。** 免批加班不发调休批次，也不走加班银行。`getSettings` 归一化之后，`compTimeFromOvertime.enabled === true` 或 `overtimeBankPolicy.enabled === true` 时，提交直接 `422 EXEMPT_OVERTIME_CREDIT_PENDING`，不留下已批准未入账的单。加班银行的字符串 `'true'` 会被既有 `parseBoolean` 收成 `true` 并拒绝；数字 `1` 不会。Owner 决定「免批也入账」或「免批明确不入账且允许提交」之后，再撤或改这道门。两个策略都关时行为与原先设计相同。
2. 已经 pending 的单，事后把假种/加班规则改成免批，编辑不会拆实例、不会改成 approved。
3. 换班在未带 `approvalFlowId` 时仍是最新一条启用流（`loadApprovalFlow` 的 `LIMIT 1`）。本 PR 不改换班、不改 S7。
4. 免批请假若余额不足（调休、或已启用的年假/冲抵 `block`），事务在投影前失败。`partial_unpaid_absence` 不论余额够不够都是 `LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`。
