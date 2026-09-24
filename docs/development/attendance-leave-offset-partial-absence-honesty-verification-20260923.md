# 验证：请假抵扣 partial_unpaid_absence fail-closed（#6009）

> **日期**：2026-09-23
> **设计**：`attendance-leave-offset-partial-absence-honesty-design-20260923.md`
> **基准**：`main` @ `261835ad2dea6331e7880893e781b7f7c3439588`
> **结论**：通过。管理端不能再保存「部分扣（余下计缺勤）」；遗留规则在批准时 422，余额与考勤记录都不动。

## 命令

在本机 Postgres `127.0.0.1:5432/metasheet` 上先跑过 `pnpm --filter @metasheet/core-backend migrate`。

```bash
pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-leave-offset-policy.test.ts --reporter=verbose
```

结果：6 passed。

```bash
cd apps/web && pnpm exec vitest run --watch=false tests/attendance-admin-regressions.spec.ts -t "loads leaveBalanceDeductionPolicy"
```

结果：1 passed（该文件其余 143 条被 `-t` 跳过）。组件挂载后：遗留选项为 disabled、保存不发 PUT、状态条为 error；改成 `block` 后再保存，PUT 体只有 `leaveBalanceDeductionPolicy`，两条规则的 `insufficient` 都是 `block`。

两次集成（各 1 passed，文件里其余用例被 `-t` 跳过），工作目录 `packages/core-backend`，`NODE_ENV=test`，数据库指向本机 `127.0.0.1:5432` 的 metasheet 库（连接串不含在本文）：

```bash
pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/attendance-plugin.test.ts \
  -t "LeaveOffsetPolicy rule-driven deduction" \
  --hookTimeout 180000 --testTimeout 180000

pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/attendance-plugin.test.ts \
  -t "round-trips leaveBalanceDeductionPolicy" \
  --hookTimeout 180000 --testTimeout 180000
```

覆盖：

- PUT `partial_unpaid_absence` → `422 LEAVE_OFFSET_PARTIAL_ABSENCE_NOT_ONLINE`，已存 `block` 规则不变。
- 直接写入遗留规则后：池子 120/申请 200、池子 0/申请 480、池子 200/申请 60，三次批准都是同一个 422；申请保持 `pending`；当日无 `attendance_records` 行；余额不变（包括「够扣」的 200 分钟没有被扣成 140）。
- 改回 `block` 后：不够扣的申请变为 `422 LEAVE_OFFSET_BALANCE_INSUFFICIENT` 且余额仍为 120；够扣的申请 `200`，余额 200→140。
- 设置往返：合法 `block` 规则 PUT/GET 仍成立；局部 PUT `{enabled:false}` 仍保留 rules；未知池与多池仍 400；再 PUT 该模式仍 422 且规则不变。

`node --check plugins/plugin-attendance/index.cjs` 通过。

### 2026-09-24 复核（拒绝函数抽到共享 helper）

批准路径改为调用 `rejectLeaveOffsetPartialAbsence`。错误码、文案、PUT 判断与原先相同，实现改到 `plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs`，以便 #6005 免批路径调用同一份。本环境没有 `DATABASE_URL`，上面两条集成没有重跑。单元与 W7 分类重跑：

```bash
node --check plugins/plugin-attendance/index.cjs
node --check plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-leave-offset-policy.test.ts \
  tests/unit/attendance-w7-w6r5-preservation-guard.test.ts
```

结果：2 files, 19 tests passed。该 helper 文件记入 `ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1`（只在扣减前抛 422，不碰冻结工时上下文）。#6015 原先的 CI（含 `test (18.x)`、`test (20.x)`、coverage）是成功的；这次改动是为了和 #6005 共用拒绝，不是为了修一条失败的检查。

## 对抗（fail-closed）

去掉批准前的 `rejectLeaveOffsetPartialAbsence` 调用后，上面的遗留批准会从 422 变成 200，并且不够扣时余额被部分扣掉、申请变成已批准（`loadApprovedMinutes` 仍按全额分钟投影）。集成测试会红。该函数与 #6005 免批路径是同一份 `plugins/plugin-attendance/lib/leave-offset-partial-absence-guard.cjs`。

去掉 PUT 上的同一判断后，保存该模式会从 422 变成 200。往返测试会红。

只在余额不足时拒绝、余额足够时悄悄改走 `block`：池子 200 / 申请 60 这条会红（现在要求 422 且余额仍是 200）。

测试抓不到的降级：`unpaid` 池配上遗留 `partial_unpaid_absence` 仍会按「不付、不扣余额」批准。该组合没有「少扣余额」这一半；新的 PUT 仍然 422，不能再保存它。见设计文档第 2 节。

## 未在浏览器里走完整管理端

请假抵扣卡的交互是在 Vitest + jsdom 里点保存、改下拉、再保存，并核对 PUT 体。没有另起 `pnpm dev` 用真实浏览器点一遍管理控制台。

## 开放问题

1. 已存的 `partial_unpaid_absence` 不会被迁移改写。管理员必须改成 `block` 再保存，在此之前命中该规则的批准保持 422。免批创建（#6005）必须调用同一个 helper，否则免批仍会部分扣并全额投影。
2. `deductLeaveBalance` 的 `mode='partial'` 仍在引擎里，策略路径不再调用。账4 若要重新打开该模式，必须先定义缺勤分钟的落点，并让 `loadApprovedMinutes` 与之一致。
3. 销假重算（#5982）和折天展示（#5969）本 PR 未改。
