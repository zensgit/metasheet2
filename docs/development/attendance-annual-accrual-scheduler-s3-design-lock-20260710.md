# 考勤年假计提 scheduler job（S3）design-lock — 2026-07-10

> Status: **RATIFIED**（余下开发总目标池 #3925 之 S3；autonomous 主循环 ratify，基于 2026-07-10 代码侦察报告）
> 缺陷定性：引擎+run provenance 齐全（zzzz20260615170000 migration），但唯一入口是手工路由
> `POST /api/attendance/annual-leave-accrual/run`（plugins/plugin-attendance/index.cjs ~:42027）——
> 管理员开了年假政策后，若无人手工触发，全员计提永不发生。本刀补 scheduler 自动触发。
>
> 行号锚点说明：本文档所引用的 `~:NNNNN` 行号锚点（`~:42027`、`~:42294`、`~:17647`、`~:17668`、`~:21914`、
> `~:12588`、`~:13421`、`~:3568`、`~:11548`/`~:11599`）均经核实，精确对应 **ratify 时（origin/main 基线，
> 本刀实现之前）** 的实际代码位置。本刀实现在这些锚点之前插入了新代码（scheduler 函数群、settings 三层字段等），
> 实现落地后的最终行号相应下移 ~200 行；此处保留 ratify 时的原始锚点作为侦察记录，不做事后行号回填。

## 设计裁决（G1-G8 = 审阅逐门表）

- **G1 Seam**：插件 `activate()` 自注册 `attendance-annual-leave-accrual` job，走 `context.services.attendanceScheduler.registerJob`，精确镜像 `attendance-report-sync-scheduled`（index.cjs ~:42294）。`run()` in-process 调 `runAnnualLeaveAccrual`。禁 HTTP 自调、禁 core-backend import 插件。unregister 走既有 per-plugin 跟踪。
- **G2 triggered_by 参数化（必改）**：引擎 ~:17668 硬编码 `'manual'` → 参数化 `triggeredBy: 'manual'|'scheduler'`；scheduler 路径传 `'scheduler'`（CHECK 约束 + 集成测试已允许）。manual 路由行为逐字节不变。
- **G3 double-gate（镜像 report-sync）**：① env `ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED`（默认 off，进 .env.example）② settings `annualLeavePolicy.scheduledTrigger.enabled`（默认 false；zod+normalizer+mergeSettings 三层同步防 silent-strip）③ 引擎既有门不动（annualLeavePolicy.enabled + timezone 存在且合法 IANA）。缺任一 = byte-exact no-op（不写任何行、不 log noise）。
- **G4 org fan-out**：同型复用 resolveAttendanceReportSyncScheduledTriggerOrgIds（SELECT DISTINCT org_id FROM attendance_rules ORDER BY org_id）+ maxOrgsPerRun 节流；per-org try/catch，一 org 失败不断其余。
- **G5 due 判定 + 防审计膨胀（核心裁决）**：月度 due-gate——对每个通过 G3 的 org：period = org-local 当前年（getZonedParts(now, tz).year，勿用 UTC 年，防 12-31/1-1 边界），若该 org 已存在 real（非 dryRun）run（period_key='annual:'+year）且其 created_at 落在当前 org-local 月内 → skip（零写入）；否则跑一次，asOf = org-local 今日（与 manual 默认语义一致）。效果：≤12 runs/org/年；lot source_key 保 per-user-per-年 exactly-once；月度重跑的唯一作用 = 吃进年中入职新员工。dryRun 遗留 run 不挡 due。
- **G6 权限/审计**：scheduler 路径不走 withPermission（系统触发）；run header triggered_by='scheduler'；成功 emitEvent('attendance.annual_leave_accrual.run', ...) 同 manual；log 记 granted/skipped/alreadyGranted 计数。
- **G7 FE 最小配置面**：annualLeavePolicy 管理卡加 scheduledTrigger.enabled 单开关 + 一句说明文案；遵守考勤 label 规范。
- **G8 测试**：单测（no-DB，镜像 attendance-scheduler.test.ts）：due 判定纯函数（月内已有 real run→skip / 新月→due / dryRun 不挡 / org-tz 年与月边界）+ job 注册形状。集成（attendance-plugin.test.ts，CI 白名单已含）：scheduler 跑落库 triggered_by='scheduler'；同 period scheduler+manual 不双发（第二次全 alreadyGranted、lot 不增）；flag 关 = 零写入；settings zod round-trip（scheduledTrigger 不被 strip）。mutation 自证：拆 due-gate → 月内重复 run 断言红；拆 triggeredBy 参数 → 'scheduler' 断言红；拆 env gate → no-op 断言红。

## OUT（本刀不做）

- 不加 (org_id, period_key) partial unique migration（lot source_key 已防双发；run 门取 app 级即可）。
- cadence 不可配（v1 固定月度 due）。
- 不动 manual 路由的任何语义（含其 asOf 默认、权限门）。
- 不做补计提/回溯 backfill UI。

## 实现落地记录（本刀完成，2026-07-10）

分支 `claude/attendance-s3-annual-accrual-scheduler-20260710`。逐门对照见 PR body。关键实现锚点（本刀落地后的实际位置，plugins/plugin-attendance/index.cjs）：

- `isAnnualLeaveAccrualScheduledTriggerRuntimeEnabled()` — G3 env 半闸。
- `ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_TRIGGER_MAX_ORGS_PER_RUN`（固定常量 50，非 org 可配 —— G7 范围只锁一个开关，不含节流参数）。
- `resolveAnnualLeaveAccrualScheduledTriggerPeriod(now, timezone)` — G5 纯函数，org-local 年/periodKey/asOf workDate。
- `isAnnualLeaveAccrualScheduledTriggerDue(now, timezone, lastRealRunCreatedAt)` — G5 纯 due-gate。
- `loadAnnualLeaveAccrualLatestRealRunCreatedAt(db, orgId, periodKey)` — G5 DB 半闸（WHERE dry_run = false）。
- `runAnnualLeaveAccrualScheduledTriggerForOrg(trx, orgId, now, logger, emitEvent)` — per-org worker（G3③ + G5 + G6）。
- `runAnnualLeaveAccrualScheduledTriggerOnce(db, logger, options)` — 顶层 job entrypoint（G3①② + G4）。
- `runAnnualLeaveAccrual(trx, { orgId, period, asOf, dryRun, triggeredBy })` — G2 参数化（默认 'manual'，scheduler 路径显式传 'scheduler'）。
- `activate()` 内 `annualLeaveAccrualSchedulerUnregister` 注册/`deactivate()` 清理 — G1。
- `DEFAULT_SETTINGS.annualLeavePolicy.scheduledTrigger` + `normalizeAnnualLeavePolicySetting` + `mergeSettings` annualLeavePolicy 分支 + zod `annualLeavePolicy.scheduledTrigger` — G3② 三层同步。
- `.env.example` 新增 `ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED`（注释块，默认关）。
- `apps/web/src/views/AttendanceView.vue` 年假策略卡新增 `scheduledTrigger.enabled` 单开关（`data-annual-policy="scheduled-trigger"`）— G7。

测试：
- `packages/core-backend/tests/unit/attendance-annual-leave-accrual-scheduled-trigger.test.ts`（纯函数，无 DB）。
- `packages/core-backend/tests/unit/attendance-scheduler.test.ts`（新增一条 job 隔离回归）。
- `packages/core-backend/tests/integration/attendance-plugin.test.ts` 新 describe 块（真 DB，双闸/due-gate/不双发/PUT round-trip）。
- `apps/web/tests/attendance-admin-regressions.spec.ts` 新增一条前端开关回归（既有 guarded spec 文件，未新增 workflow 接线）。

无新依赖；未修改 package.json / pnpm-lock.yaml。
