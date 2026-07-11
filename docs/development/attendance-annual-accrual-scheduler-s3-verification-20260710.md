# 考勤年假计提 scheduler job（S3）验证报告 — 2026-07-10

> 余下开发总目标池（#3925 计划）之 **S3**。PR **#4008** MERGED `e837c508f`（2026-07-10）。
> 缺陷定性：引擎+run provenance 齐全，但唯一入口是手工路由——管理员开了年假政策后若无人手工触发，
> 全员计提永不发生。本刀补 scheduler 自动触发。design-lock：`attendance-annual-accrual-scheduler-s3-design-lock-20260710.md`。

## 1. 交付（G1-G8 逐门）

- **G1 Seam**：插件 activate() 自注册 `attendance-annual-leave-accrual` job（`context.services.attendanceScheduler.registerJob`），
  精确镜像 attendance-report-sync-scheduled；run() in-process 调引擎，零 HTTP 自调零跨包 import。
- **G2**：引擎 `triggered_by` 硬编码 'manual' → 参数化；scheduler 传 'scheduler'（CHECK 约束早已预留）；manual 路由逐字节不变。
- **G3 double-gate**：env `ATTENDANCE_ANNUAL_LEAVE_ACCRUAL_SCHEDULED_ENABLED`（默认 off，入 .env.example）
  + settings `annualLeavePolicy.scheduledTrigger.enabled`（四层同步：DEFAULT/normalizer/mergeSettings/zod，防 silent-strip）
  + 引擎既有门；缺任一 = byte-exact no-op。
- **G4**：org fan-out 复用共享 resolver + maxOrgsPerRun=50 节流，per-org try/catch。
- **G5 月度 due-gate**：period=org-local 当前年（getZonedParts，非 UTC 年），当月已有 real run → 零写入 skip；
  否则跑（asOf=org-local 今日）。≤12 runs/org/year；lot source_key 保 per-user-per-year exactly-once；
  月度重跑唯一作用 = 吃进年中入职新员工；dryRun 遗留不挡 due。
- **G6**：run header triggered_by='scheduler'；emitEvent 同 manual。
- **G7 FE**：年假管理卡 scheduledTrigger 单开关（`data-annual-policy="scheduled-trigger"`）+ 双语提示；
  spec 入 attendance-web-guard（run-list + 双 path-filter）。
- **G8**：单测 43 + 集成 4（并入 attendance-plugin.test.ts，CI 白名单 plugin-tests.yml:478）。

## 2. 对抗审阅（opus，refute-first）

审阅 MD：`/tmp/pr4008-s3-review-claude-20260710.md`（head `56faba9fe`）。判定 **APPROVE：0 P1 · 0 P2**。

- 攻击面逐一核过：时区跨年数学正确；exactly-once 由 DB 唯一索引 `uq_attendance_leave_balances_org_source_key` 兜底；
  双门 byte-exact no-op 实证；manual 路由逐字节不变；OUT 边界全守。
- 审阅者独立复验 mutation cut1（due-gate → always-due）：集成+单测双红——**同时证明集成测试真执行非 skip 假绿**
  （本仓招牌雷区，已排除）；并自加一刀 FE save-wire mutation → spec 红（有牙）。
- 实跑：新鲜迁移库全量集成 **158/158** · 单测 43/43 · FE 1/1 · 双 typecheck exit 0。
- **P3-1（合并前已修 `4cf82c60b`）**：org fan-out cap 注释谎称「所有 due org 跨 tick 都会覆盖」——共享 resolver
  是确定性 first-50 无轮转、due-gate 在 resolver 之后 → >50 org 时尾部 scheduler 永不可达（manual 路由可用）。
  修为如实陈述（注释级，行为不变，锁准许的 G4 镜像行为；fairness 轮转 = 同 report-sync A2 一样的 deferred rung）。
- NIT-1（术语）：G5「org-local」实为全局 annualLeavePolicy.timezone（年假政策本就单一全局设置，语义自洽）。

## 3. 实现过程记录（模型接力）

Sonnet 首刀（3 commits：runtime/单测/集成测试 + G7 FE + .env.example 全在内）→ 额度墙 → Opus 接棒
核验而非重做（正确判断前任已完成度）、补 design-lock 落盘、全量复跑、mutation 三刀（due-gate/triggeredBy/env-gate
全红/绿闭环）、开 PR。WIP 推送纪律使切换零丢失。

## 4. 账本归属

tracker 年假线：计提引擎 ✅（L0-L6 既有）+ **定时触发 ✅（本刀）**。剩余相关：>50 org fairness 轮转 = deferred rung
（需求出现再立项）；per-org timezone 语义 = 年假政策全局设置的既有形状，非本刀缺口。
