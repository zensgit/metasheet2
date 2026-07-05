# 考勤报表同步 A2 调度触发 design-lock — 2026-07-05

> **Status: RATIFIED（owner-delegated 2026-07-05）**——由
> `attendance-report-sync-hardening-decision-menu-20260705.md`（#3577）的 owner-delegated 决策
> 授权：A 触发模型 = **A2 调度批量**，backend-only v1，不新增 admin UI。本锁把 A2 收敛为可实现规格。
> 依据：2026-07-05 报表同步现状审计（sync 线已 SHIPPED，见 §1）。

## 1. 现状（审计实证——地基已在，本刀只补"自动触发"）

report-records → multitable sync 机器**早已建成**（2026-05-15..19），今天缺的只是**自动触发**：

| 已有 | 锚点 |
|---|---|
| 报表对象 `attendance_report_records` + 孪生 `attendance_report_period_summaries`（catalog 驱动值列 + 双指纹） | `index.cjs:~2265/~2411` |
| 写入器 `syncAttendanceReportRecords[ForUsers]` / `syncAttendanceReportPeriodSummaries[ForUsers]`（queryRecords→双指纹 skip/create/patch，只经 `context.api.multitable`） | `index.cjs:~2718/~2871/~3818` |
| 分页 job 控制面 `plugin_attendance_report_sync_jobs`（`manual_step` run-next-page，`(org_id,idempotency_key)` 部分唯一）+ 路由 | 迁移 `zzzz20260519070000_*`；路由 `~40694-40943` |
| **缺口**：无自动触发；`mode:'enqueue'` job 路径**无 worker**（只 manual_step 手动跑） | 审计 §2 |
| 成熟调度基座 `AttendanceScheduler`（leader-elected/env-gated，已承载 expiry / 未排班提醒 / A2 auto-write / C5 delivery 多 job，composite-registry） | 已 staging-proven |

## 2. 范围（A2 = 挂 AttendanceScheduler 的 report-sync batch job；backend-only）

| # | 内容 | 口径 |
|---|---|---|
| S1 | **latent settings + dormant job** | 新增 `reportSync.scheduledTrigger.{enabled,cadence,maxOrgsPerRun,maxUsersPerRun}`（settings JSON，默认全关，enum-strict zod）；注册 `AttendanceScheduler` job `attendance-report-sync-scheduled`，**默认不跑**（env flag + settings 双门，缺一不跑）；不写任何 report record |
| S2 | **scheduled runner（复用既有写入器）** | job 每 tick：门全开才 claim 一个 run（复用 `plugin_attendance_report_sync_jobs` 的 `mode:'enqueue'` 行 + `(org_id,idempotency_key)` 幂等，**这正是缺的 worker**）→ 逐 org/user **委托既有 `syncAttendanceReportRecordsForUsers`**（不重实现 stats/multitable 写）→ `maxOrgsPerRun`/`maxUsersPerRun` 限流 → run 审计。重复 tick 靠双指纹 + job 幂等键跳过 |
| S3 | **staging smoke** | env+settings 开→seed 陈旧报表事实→tick 自动 sync→双指纹使二次 tick 为 no-op→限流生效→residue=0（backend-only smoke，同 A2 auto-write 档） |

## 3. 硬边界（沿用既有 sync 边界 + A2 auto-write 纪律）

- **零写入语义变更**：只加"何时自动跑"，写入仍走既有 `syncAttendanceReportRecordsForUsers`；边界不变——attendance_* 唯一事实源、只经 `context.api.multitable`、绝不裸写 `meta_*`。
- **composite-registry 纪律**（A2 auto-write 教训）：本 job 独立注册；单 job 失败不跳过 expiry/提醒/delivery/auto-write 其它 job；env flag + settings + （若需）system role-tag scope 全满足才跑。
- **tick-ownership vs RD digest**：二者同挂 `AttendanceScheduler`，各自独立 job、各自 settings 门；本锁不改 digest。
- **无 admin UI**（避免踩 FE 泳道 A 串行冲突）——settings 经既有 `PUT /api/attendance/settings`（记得同步进 zod `settingsSchema`，否则静默 strip——#1829 教训）；运维只读复用既有 job/route。
- **B（孤儿值列）/ C（重复 row_key）不在本刀**——各自独立后续 slice（#3577 决策）。

## 4. 完成口径

- 后端运行时 + 反向测试（门关不跑逐字节不变 / 门开跑 / 限流 / 二次 tick 幂等 / 单 job 失败隔离）+ 1 条 staging smoke（residue=0）。
- 真 DB 用例进既有 attendance integration gate；settings normalizer 与 PUT zod 双改（反 silent-strip）。
- Opus 对抗审阅 0 P1/P2 后合并。**泳道 = backend（off FE lane）**，可与 half-day/bulk-apply FE 串行并行。

## 5. Deferred

- B 孤儿值列清理 · C 重复 row_key 去重（先 diagnostic）· push-on-recompute（A3，事件驱动，比 A2 重）· report-sync admin UI（若日后要，单独 FE 切片）。
