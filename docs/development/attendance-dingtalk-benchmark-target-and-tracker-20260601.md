# 考勤对标钉钉 — 目标 + 进度追踪（单一真源）

> **版本** 2026-06-01 · 取代过时且未入库的 `docs/research/dingtalk-attendance-optimization-plan-20260514.md`（v1）
> **用途**：唯一的"我们在对标什么、到哪了、还差什么"账本。任何 attendance 开发开工前先读它 + `git log origin/main` 查重，落地后回填 ✅。**防止"开发着开发着就开发歪了"。**
> **基线**：origin/main @ `7e573591b`（#2189，本 PR 对账时的 base；rebase 后更新为最新 hash）。证据为 `file:line`/PR 号。v1 的 schema/API/UI 设计**仅作 archived design reference**，且 **RBAC 一节作废**（见 §5）。
> **档位经产品负责人 2026-06-01 拍板**（自动对班降 SHOULD+灰度门；排班修改窗升 MUST）。

---

## 0. 三视野（北极星）

| 视野 | 范围 | 量级 | 现在做？ |
|---|---|---|---|
| **H1 — scheduler-scope 收尾** | 把已建成的子管理员范围/enforcement 线收干净 | **3–7 人天** | 是，零散收尾（§4） |
| **H2 — 考勤核心成熟度** | **不追全量钉钉**，只补"真实客户会痛"的核心（MUST/SHOULD，§1） | **3–5 周** | **是，最值得做的下一阶段** |
| **H3 — 钉钉级高级** | 调度/换班/多门店/设备围栏/人脸/算薪… | **2–4 月+** | 否，不一口吞（拆 3a 可建 / 3b 不自研，§6 末） |

---

## 0.1 近期开发目标（2026-06-09 锁定）

> 目标名：**考勤 H2 SHOULD 收口**。不是"追平钉钉考勤全量"，而是在 MUST 已闭环后，补齐成熟排班系统最容易被真实客户感知的 SHOULD 能力。继续遵守 §6：每项独立 opt-in，落地后回填本账本；未写入本节的能力不自动开工。

### In scope

| 顺序 | 项 | 当前状态 | 完成口径 |
|---|---|---|---|
| 1 | **一天多班次** | ✅ runtime + admin UI + staging smoke 已闭环 | M0–M5 全部完成：schema replay、slot conflict guard、effective-calendar slots、planned-minutes/shift-compliance 汇总、fixed-apply/auto-shift 兼容、admin UI、staging smoke residue=0 |
| 2 | **排班发布/草稿** | 🟡 runtime + admin UI + smoke harness 已落，pending staging smoke | backend runtime + admin UI + 反向测试 + staging smoke；若触碰 `attendance_shift_assignments` 热表 schema，先与多班次 `slot_index` / `publish_status` / `locked_at` / constraints 做 migration batching 决策 |
| 3 | **临时班次** | ✅ schema + replace runtime + admin UI + staging smoke 已闭环 | backend runtime + admin UI + 反向测试 + staging smoke；不伪装成完整调度/换班系统 |
| 4 | **加班三段引擎** | 🟡 design-lock 已落（`attendance-overtime-segmentation-engine-design-lock-20260609.md`） | 工作日/休息日/节假日三段口径进入规则引擎并有反向测试；不把公式派生当 runtime engine |

### Out of this target

- **自动对班 A2 自动写入**：仍需另起 design-lock + feature flag + staging smoke；不并入本目标主线。
- **C5 外发通知渠道 / 负责人 fan-out**：通知增强，不阻断当前 H2 SHOULD 收口。
- **调度 / 换班 / 小组织 / 多门店**：客户拉动型 OPTIONAL，各自单点开，不纳入本轮目标。
- **算薪、防作弊、AI、人脸/拍照、原生 app、插件市场**：继续按 §1 OUT 红线处理。

### Development budget

- 本目标全量约 **20–30 人天**。
- 只做前三个排班能力约 **15–22 人天**。
- **一天多班次**已完成；下一刀按本目标顺序推进 **排班发布/草稿** 的 staging closeout，开工前继续做 `origin/main` 查重和热表 migration batching 复核。

---

## 1. H2 目标档位（产品负责人 2026-06-01 最终版）

> 验收口径：MUST 项 = **后端运行时强制 + 前端可配 + 反向（权限/校验）测试 + 1 条 staging 联调** 才算 ✅；不是"能展示"算完。

| 档 | 项 | 关键约束 |
|---|---|---|
| **MUST** | **排班合规引擎**（日/周/月工时 cap，**超限阻断保存**） | 钉钉最硬护城河。**MUST 口径 = 排班时阻断保存；warning-only 只算报表/预警红利，不算 MUST ✅**（避免实现方交 warning 充数）。**design-lock #2213（2026-06-02）**：新建 `shiftCompliance`（不并入 comprehensiveHours）/ 全 save 路径事务内投影 / 首版 block / 完成口径 = 日周月三粒度×全路径 |
| | **未排班提醒**（提醒负责人/本人） | ⚠️ **不是小 feature**：2026-06-01 verify 证伪"渠道已有"（attendance 当时无调度器、无事件→通知消费者）。截至 2026-06-05，**attendance scheduler 基座已由 ④ C4 建成并 staging-proven**（镜像 `ApprovalSlaScheduler`，leader-elected/env-gated），⑤ 已作为第二个 job 接入内部提醒记录并 staging-proven；C5 外发渠道、delivery status/retry、负责人 fan-out 后续扩展。**未排班处理策略 → 归 ③ 打卡策略组，不在此单建** |
| | **排班修改窗**（可改 N 天内、超窗锁；钉钉默认 180） | 与合规引擎 + 历史数据可信度强绑；无它则报表不可信。实现量小、治理价值高 |
| | **打卡策略组**（外勤审批 + 内外勤卡合并 + **未排班打卡策略**） | 三项同属 punch policy → 一个"**打卡策略配置基座**"design-lock（greenfield，0 现有字段）；抽屉已在只差配置写入；未排班"阻断/允许打卡"默认 **allow**（不回归） |
| | **加班 ↔ 调休** | 假勤闭环 |
| | **假期过期管理**（expires_at/延长/提醒） | 假勤闭环 |
| **SHOULD** | **自动对班**（**feature-flag 默认关，先 preview/建议态，再灰度自动写入**） | 误判会污染考勤/加班/请假/报表全链 → 不直接自动写，灰度门 |
| | 一天多班次（multi-slot） | 动 `shift_assignments` schema |
| | 排班发布/草稿（draft/pending/published） | 动 `shift_assignments` schema |
| | 临时班次（划线 temp_shift） | |
| | 加班三段（工作日/休/节按日型独立引擎） | 当前仅公式派生，引擎不区分 |
| **OPTIONAL** | 调度 · 换班 · 小组织挂部门 | 多门店/连锁客户真要时单点开（各约 1–2 周，非 H3 的"2–4 月"）|
| 🚫 **OUT** | 算薪引擎（**对接 SaaS 不自研**）· 防作弊/越狱 · AI 拍照 · 原生 app · 插件市场 · 多时区报表（除非海外客户） | 防 scope creep 红线 |

---

## 2. 现状对账（done vs remaining）

> ✅ 已落 · 🟡 部分 · ⬜ 未开始 · 🚫 不做。证据为当前 main 实测。

| 项 | 档 | 状态 | 证据 / 备注 |
|---|---|---|---|
| 管理范围 RBAC + 运行时 enforcement | （H1 已成） | ✅ | `scheduler_scopes`（subject×action×6-target）+ enforcement E1–E5（#2134→#2140/#2142/.../#2162-2164/#2175）；**异构于 v1 模型**，见 §5 |
| 主/子负责人 | （已成） | ✅ | group owner roster/panel/scope（#2099–2103） |
| 综合工时（报表侧） | （已成，OUT 之外的红利） | ✅ | #1801 等（113 hits，`enforcement:'warn'`） |
| 固定班 preview/apply + provenance + managed controls · 周矩阵展示 · 打卡只读抽屉 · HR 字段/onboarding/work-time drawer · FormulaEngine（仅差 4–5 函数） | （红利） | ✅ | 并行 session 两天内落地 |
| 排班合规引擎（超出禁止保存） | MUST | ✅ | **完成 2026-06-03**：design-lock #2213 → S0 latent settings #2214 → S1 daily cap #2218 → S2 weekly/monthly explicit scheduled-load cap #2221；staging 联调 PASS 13/13（`/tmp/staging-shift-compliance-smoke-20260603.mjs` against `0fd25d3ed`）。日/周/月三粒度 × shift/rotation/fixed-apply 全 save 路径均运行时 block；`warn` 仍为惰性预留 |
| 未排班提醒（复用 attendance scheduler 基座） | MUST | ✅ | **完成 2026-06-05**：design-lock `attendance-unscheduled-reminder-design-lock-20260604.md` → #2294（merge `32f3aa196`）作为 `AttendanceScheduler` **第二个 job**（非新调度器）落地——`UnscheduledReminderService` set-based scan（**镜像 + 真值 parity-locked 对 `isUserScheduledForDate`**，fixed/free 不误报由 applicability guard 继承）→ `attendance_unscheduled_reminder_dispatch` claim（`ON CONFLICT DO NOTHING` = at-most-once 去重）→ `AttendanceNotifier` seam（默认 0 渠道 = 不外发）。staging deploy `32f3aa196497d2cf81846d36520257be5c793adc` + migration `zzzz20260604120000_create_attendance_unscheduled_reminder_dispatch` + `ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED=true` smoke PASS：scheduled_shift 无 assignment 用户写 exactly one dispatch；有 assignment 用户 0；fixed_shift 用户 0；repeat tick 不重复；cleanup residue=0。**C5 外发渠道/负责人 fan-out 仍 deferred**（v1=内部 dispatch 记录 + 本人语义，不等同外部发送成功）。处理策略已移入 ③ |
| 排班修改窗 | MUST | ✅ | #2197（squash `2d4808fe`，2026-06-02）：org-level `shiftEditPolicy` 入 attendance settings JSON（默认 `unrestricted`，无 DDL）+ shift/rotation assignment POST/PUT/DELETE 6 写路由显式 422 `SHIFT_EDIT_WINDOW_EXCEEDED`；PUT/DELETE 同看 existing start date + next start date 防历史绕窗；unit + CI real-DB attendance integration 绿 |
| 外勤审批 | MUST | ✅ | **完成 2026-06-05**：S3 design-lock #2304（`attendance-outdoor-approval-s3-design-lock-20260605.md`）→ backend runtime #2308（squash `bbf2b5a64`）→ staging smoke **PASS** on deploy `61b13a95b941a680fb4315a2cf92d3fa056f5ac2`（该 main build 包含 #2308）。**本项 ✅ 口径** = 后端运行时 + 反向测试 + staging 联调（runtime capability 闭环已可用）；S3-2 admin config card **已落 #2322**（admin-UX follow-up，不阻断本 capability ✅）。migration `zzzz20260605120000_add_outdoor_punch_request_type` 已应用；`outdoor_punch` 仅 `/punch` 路由创建，generic `/requests` create/update 显式 422 `OUTDOOR_PUNCH_VIA_PUNCH_ONLY`（OpenAPI `/requests` input enum 不含 outdoor_punch，无 dist 变更）；PUT settings 暴露 `punchPolicy.outdoor.{requireApproval,requireNote,approvalFlowId}`（`requirePhoto` 仍 latent）；`requireApproval=true` + 围栏外/`meta.outdoor` → pending `outdoor_punch` request（不写 `attendance_events`/`attendance_records`）；final approve 写 exactly one `source='outdoor_approval'` 真打卡 event + record（无 generic adjustment；metadata 缺失则 422 不伪造）；reject 不写；dup key 含 `eventType`；空 `approvalFlowId` 要求唯一 active outdoor flow；note 缺失 422；默认关闭零回归。CI real-DB outdoor 路由级 9/9（全 attendance 套件 99/99 无回归）；staging smoke stamp `s3-outdoor-1780649522285`：pending no event/record、approve exactly one event+record、reject no event/record、settings restored、cleanup residue=0。**仍 deferred**：移动端外勤体验、S2 内外勤合并、C5 外发渠道、requirePhoto/照片存证、dist-sdk SDK 类型（S3-2 admin card 已 #2322 落） |
| 内外勤卡合并 | MUST | ✅ | **runtime + admin UI + S2-3 staging smoke 已完成**（非 design-only）：S2-0 reserved source #2329（`outdoor_approval` 列为 reserved source，只 S3 approve writer 可写，`/punch` 伪造 422 `PUNCH_SOURCE_RESERVED` → 分类器可信）→ S2-1 backend #2333（PUT settings 暴露 `punchPolicy.merge.{internalWinsOnIn,externalWinsOnOut}` 两键 + `applyAttendanceInOutMergePolicy` 事件感知窄触发重算）→ record-only 保护 fix #2336（对应 key 开启时 import/override 的 `first_in_at`/`last_out_at` 不被普通 punch 冲掉，默认 key 关仍走现有 append；真 DB §5.11/§5.12 first+last 对称反向矩阵）→ S2-2 admin card #2344（`7542d3679`，`AttendanceView.vue` 两 checkbox，PUT 仅 `{punchPolicy:{merge}}`，默认 false 零回归，文案不越界承诺 record-only 永不覆盖）。锁定口径不变：分类器 = `source='outdoor_approval'`（S2-0 已加固为可信）；上班卡 `internalWinsOnIn`、下班卡 `externalWinsOnOut` 分别定；派生层不回写 `attendance_events`，只经 `computeMetrics` 重算 records。完成口径 = 事件组合反向矩阵（✅ 真 DB tests #2333/#2336）+ staging smoke（✅ S2-3 PASS `s2-merge-mq2kc9sy`）。**已 ✅（staging-proven）** |
| 加班↔调休 | MUST | ✅ | C0–C3 staging-validated + C4-1(#2270 inert) + **C4-2 #2274**（`4b3108737`：expiry scheduler + `expiresInDays` grant 写 `expires_at` + notifier scaffold，**无 DDL**）。CI real-DB attendance step 真跑且绿（`④ C4` 用例在 `attendance-plugin.test.ts` 88-test 文件 + `attendance-expiry-service.test.ts`）。**staging C4 smoke PASS 2026-06-04**：staging deploy `8701c46e00c68ed19c226e7206f5456866f6b8ba` on `https://23.254.236.11/`，scheduler env `ATTENDANCE_SCHEDULER_ENABLED=true` / interval `5000ms`，30d grant 精确 720h，后台 scheduler 过期 aged lot 一次且 repeat tick 幂等，NULL-expiry lot 保持 active，cleanup residue=0（见 runbook `attendance-comp-leave-c4-2-staging-smoke-runbook-20260604.md`） |
| 假期过期管理 | MUST | ✅ | C4 子链已 staging-validated：`expires_at` 写入 + 过期 state-flow + env-gated `AttendanceScheduler` 调度基座均已证实；C5 通知/提醒仍按 #2230 作为后续扩展，不影响 C4 完成口径 |
| 自动对班 | SHOULD | ✅ | **A0/A1 preview→admin-apply 已 staging-proven**：design-lock `attendance-auto-shift-matching-preview-design-lock-20260609.md` → A0 backend preview #2403 + A0 admin review UI #2405 → A1 admin selected apply #2406（squash `b4a1ca693`）→ staging smoke **PASS** `A1_AUTO_SHIFT_STAGING_SMOKE_PASS deploy=b4a1ca69323d767e7d838882751b365f18b4116f prefix=autoshift-a1-smoke-mq64a66m residue={"users":0,"events":0,"records":0,"assignments":0,"groups":0,"shifts":0}`。owner 口径不变：feature-flag 默认关；A0 只读 preview/建议态，不写 `attendance_shift_assignments`；A1 仅 admin 选择后应用且复用排班写入锁、排班修改窗、排班合规引擎与 provenance；A2 自动写入另起 design-lock。只匹配 scheduled_shift 组内“未排班但有打卡”的 user/day，不覆盖人工/导入/固定/轮班排班 |
| 一天多班次 | SHOULD | ✅ | design-lock `attendance-multi-shift-day-design-lock-20260609.md` 已锁；runtime + admin UI + staging smoke 已闭环：M1 slot schema/conflict guard #2426；M2 effective-calendar slots + planned-minutes/shift-compliance/comprehensive-hours projection #2427；M3 fixed-schedule/auto-shift single-slot producer compatibility #2428；M4 admin settings/card + slot editor #2429；M5 smoke harness #2445 + cleanup/env runbook hardening #2446；staging smoke PASS 2026-06-10（deploy `46b218503c965370fc58db02141220787cb1cf79`，stamp `multi-shift-m5-mq7x1wqk`，log `/tmp/staging-multi-shift-m5-smoke-20260610T101849Z.log`，45/45，residue=0）。v1 默认关闭，最多 3 个 direct slots；同 slot overlap 拒绝，不同 slot 只有 shift 时间窗不重叠才可共存；rotation 与 direct multi-slot v1 互斥；records 仍一日一行 |
| 排班发布/草稿 | SHOULD | 🟡 | design-lock `attendance-schedule-publishing-design-lock-20260609.md` 已锁；**runtime + admin UI + smoke harness 已落 main**：P0 lifecycle foundation #2430 → P1 draft CRUD/list filters #2432 → P2 publish transition #2433 → P3 producer compatibility tests #2434 → P4 admin UI #2435 → P4 staging smoke prep #2436。draft/pending 不进入 effective-calendar、`isUserScheduledForDate`、shiftCompliance planned-load、提醒或报表；publish 事务内复用 per-user lock、scope permission、`shiftEditPolicy`、published-conflict guard 与 `shiftCompliance`；fixed-apply 与 auto-shift A1 默认保持 immediate published 并保留 provenance。**仍 pending staging smoke，未翻 ✅** |
| 临时班次 | SHOULD | ✅ | design-lock `attendance-temporary-shift-design-lock-20260609.md` 已锁；T0 temp metadata schema #2437 → replace-only backend runtime #2439 → T5 admin UI #2441（`5edaf08b`）→ T6 runtime closeout #2443（`46b2185`）→ staging smoke PASS `temp-shift-t6-mq7vn6uc`。v1 范围仍为 one-day replace-only temporary overlay：draft create only、direct immediate-active 拒绝、publish revalidate、effective-calendar/planned-minutes overlay 不双算、published temp cancel soft-deactivate restores base、fixed-schedule rebuild preserves exact temp overlay、admin UI 只对已发布常规分配创建替班草稿；rotation replacement / add mode / immediate-active interim 仍稳定拒绝。完成口径（backend runtime + admin UI + 反向测试 + staging smoke）已满足 |
| 加班三段引擎 | SHOULD | 🟡 | design-lock `attendance-overtime-segmentation-engine-design-lock-20260609.md` 已锁：day-type 以 effective-calendar 为真源，request approval / records / summary / report / comp-time 必须消费同一 segmentation snapshot；本 PR 仅设计，不含 runtime/schema/frontend/OpenAPI |
| 调度 / 换班 / 小组织 | OPTIONAL | ⬜ | 0 |

**余下量（2026-06-09 复核）**：MUST 已闭环；近期目标改为 **H2 SHOULD 收口 ≈ 20–30 人天**（只做前三个排班能力约 **15–22 人天**）。详见 §0.1。

---

## 3. H2 执行排序（产品负责人 2026-06-01）

① **排班修改窗**（✅ #2197 已落；纯 write-time 校验，不碰 scheduler/notifier 新基座；治理价值高）
② **打卡策略组**（design-lock #2203）：S0 基座 ✅#2204 · S1 未排班打卡 ✅#2209 · **子序 S1→S3→S2** · **S3 外勤审批 ✅**（#2304 design → #2308 runtime → #2319 staging closeout → #2322 admin card）· **S2 内外勤合并 ✅**（S2-0 #2329 → S2-1 #2333 → record-only fix #2336 → S2-2 admin card #2344 → S2-3 staging PASS `s2-merge-mq2kc9sy`）
③ **排班合规引擎**（✅ #2213/#2214/#2218/#2221 + staging 2026-06-03）：`shiftCompliance` 日/周/月 cap 已按 **explicit scheduled load** 口径在全部 save 路径运行时阻断；staging smoke 13/13 通过，③ 正式关闭
④ **加班调休 + 假期过期**（假勤闭环；假期过期提醒在此**首建** scheduler/notifier 基座）— **design-lock 已落**（`attendance-comp-leave-expiry-design-lock-20260603.md`，本 PR；owner 决策 2026-06-03 锁定）：余额=**grant-lot ledger**（`attendance_leave_balances`，非 mutable aggregate）+ **必需审计流水 `attendance_leave_balance_events`**（不可只改 remaining）· 入账=OT approve **transition** 幂等（**`source_key` NOT NULL + `UNIQUE(org,source_key)` 兜底**，不锁可空 source_id）· 撤销**首版不自动反冲但不静默错账** · 调度=**首建 `AttendanceScheduler`**（镜像 `ApprovalSlaScheduler`，leader-elected，⑤ 复用）。子链 C0 staging-align（**硬前置**）→C1 ledger DDL→C2 入账→C3 扣减→C4 过期+调度→C5 提醒+notifier，实现 PR 拆开。**比 ③ 重一档（有 DDL）。**
⑤ **未排班提醒**（✅ #2294 + staging 2026-06-05；复用 ④ C4 已建成的 scheduler 基座；C5 外发渠道/负责人 fan-out 后续扩展）
⑥ **自动对班**（✅ A0/A1 staging-proven 2026-06-09；灰度门，feature-flag 默认关 → A0 只读 preview → A1 admin apply；A2 自动写另起锁）
⑦ **一天多班次**（✅ 2026-06-10 staging-proven：schema-first，默认关闭 → slot_index migration → conflict/effective-calendar/planned-minutes → UI → staging）
⑧ **H2 SHOULD 收口目标**（2026-06-09 owner 锁定；见 §0.1）：一天多班次 → 排班发布/草稿 → 临时班次 → 加班三段引擎；不纳入 A2/C5/OPTIONAL/OUT

> **回填（2026-06-01 pre-flight 发现）**：原排序把"未排班提醒"列首，依据"渠道已有/最便宜"——**verify 证伪**（attendance 无调度器、无事件→通知消费者）。故改：**排班修改窗为首刀**（真·最便宜 + 治理高）；未排班提醒降级为后续"scheduler+notifier 基座"基础设施刀（2–3pd，与假期过期提醒共建）；未排班处理策略归 ③ 打卡策略组。

> **回填（2026-06-02 决定）**：打卡策略组 S0 ✅#2204 + S1 ✅#2209 后**暂停**。pre-flight 证 **S2 内外勤合并依赖 S3 外勤**（当前模型无内/外勤打卡区分——geofence 只在围栏外拒绝、不分类保留；打卡 → first-in/last-out）→ #2203 子序改为 **S1→S3→S2**（S2 可并入 S3 后半段）。S3 外勤=重刀（外勤动作/审批流/报表口径/移动现场），**暂缓**；**下一主线转 ③ 排班合规引擎**（钉钉硬招牌、无此依赖、直接服务"排班保存时禁止越界"）。

> **回填（2026-06-02 合规引擎 design-lock）**：③ 排班合规引擎 design-lock 落地（`attendance-shift-compliance-engine-design-lock-20260602.md`，#2213）。owner 决策锁定：(1) 新建 `shiftCompliance`（日/周/月 maxMinutes + enforcement warn|block，**不并入** comprehensiveHours——save-time/planned/日周月 vs report/actual/月季年）；(2) 强制 = **全部** save 路径（shift POST/PUT `29445/29538` + rotation POST/PUT `21452` + fixed-apply `27818/9193`，DELETE 不拦）；(3) **首版只 block**，warn 预留惰性。**keystone**：投影**复用** `loadAttendanceComprehensivePlannedMinutesByUser`（`13163`，经 effective-calendar resolver，与 comprehensiveHours **同一套** planned-minutes 算法 → 零漂移），**事务内写后投影 → 超限 throw → rollback → 422**（PUT 排除自身自动成立）。切片 **S0 latent config → S1 daily → S2 weekly+monthly**（各 gated + 真 DB route-level 反向 integration）。**完成口径（partial-MUST bar）：③ 仅在 daily∧weekly∧monthly × 全路径 + 反向 integration + staging 全满足才 ✅；daily-only 的 S1 是切片不是"引擎完成"**（防 P2 式 warning/切片充数）。

> **回填（2026-06-03 合规引擎 closeout）**：S0 ✅ #2214（`shiftCompliance` latent settings）· S1 ✅ #2218（daily cap，全部 save 路径）· S2 ✅ #2221（weekly/monthly cap，owner 决策 A：只统计 explicit scheduled load，排除默认兜底工作制 baseline）。staging 部署到 `0fd25d3ed` 后运行 `/tmp/staging-shift-compliance-smoke-20260603.mjs`：**PASS 13/13**。覆盖：(1) `shiftCompliance` PUT→GET round-trip；(2) weekly cap 2400 + 单个显式 540 分钟排班 → 201，证明默认 Mon–Fri baseline 不计入；(3) daily/weekly/monthly 超 cap → `422 SHIFT_COMPLIANCE_CAP_EXCEEDED` 且无 assignment 持久化；(4) fixed-schedule apply 批量路径超 cap → 422 且无 managed row。联调中发现 staging schema drift 并做最小 alignment：`attendance_groups.attendance_type` + `attendance_shift_assignments.producer_*`；这是 staging 环境补齐，不改变 ③ 完成口径，但后续应补正式 migration/ops 记录避免其它环境复现。

> **回填（2026-06-04 C4 closeout）**：④ C4-2 #2274（`4b3108737`）已部署 staging build `8701c46e00c68ed19c226e7206f5456866f6b8ba`（`https://23.254.236.11/`），并以 `ATTENDANCE_SCHEDULER_ENABLED=true` / `ATTENDANCE_SCHEDULER_INTERVAL_MS=5000` 运行后台 scheduler。C4 staging smoke **PASS**：`compTimeFromOvertime.expiresInDays=30` 的 OT grant 写出 `expires_at - granted_at = interval '720 hours'`；`expiresInDays=null` 的 control lot 保持 `expires_at=NULL`；SQL aging 后由**部署态后台 scheduler**把 aged lot 过期为 `status=expired, remaining=0` 并写 exactly one `-120:comp_time_expiry` event；repeat tick 不重复；cleanup residue=0 且 settings restored。至此 ④ 的 C0/C1/C2/C3/C4 全部完成；C5 通知/提醒仍为后续扩展。

> **回填（2026-06-05 ⑤ closeout）**：⑤ 未排班提醒 #2294（merge `32f3aa196`）已部署 staging build `32f3aa196497d2cf81846d36520257be5c793adc`（`https://23.254.236.11/`），先运行 migration `zzzz20260604120000_create_attendance_unscheduled_reminder_dispatch`，再以 `ATTENDANCE_SCHEDULER_ENABLED=true` / `ATTENDANCE_SCHEDULER_INTERVAL_MS=5000` / `ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED=true` 启动后台 scheduler。staging smoke **PASS**：seed `scheduled_shift` 无 assignment 用户 `u-unscheduled-ur1780630401`（target `2026-06-06`）→ 写出 exactly one `attendance_unscheduled_reminder_dispatch`；同 org 的 covered scheduled_shift 用户与 fixed_shift 用户均 0；repeat tick 后仍 exactly one；cleanup 删除 dispatch/assignment/members/shift/groups 后 residue `0|0|0`。因此 ⑤ 从 🟡 翻 ✅。注意：本 ✅ 的完成口径是**内部提醒记录 + notifier seam**；C5 外部渠道、delivery status/retry、负责人 fan-out 仍为后续扩展，不能把 `dispatched_at` 解读为外部送达成功。

> **回填（2026-06-05 S3 外勤审批恢复）**：② 打卡策略组在 S1 后暂停的 blocker 已明确：S2 内外勤合并必须等 S3 先建立“外勤打卡”事实类型。S3 delta design-lock（`attendance-outdoor-approval-s3-design-lock-20260605.md`）锁定 v1：`outdoor_punch` request type；`punchPolicy.outdoor.requireApproval=true` 时外勤 punch 先入 pending request，不写 `attendance_events`/`attendance_records`；final approve 才写 exactly one 有效 punch event + record；reject/cancel 不计入；同日 outdoor check_in/check_out duplicate key 必须包含 `eventType`，避免互相挡卡。实现随后在 #2308 落地并完成 staging gate；见下一条 closeout 回填。

> **回填（2026-06-05 S3 staging closeout）**：S3 backend runtime #2308（`bbf2b5a64`）已随 main build `61b13a95b941a680fb4315a2cf92d3fa056f5ac2` 部署到 `https://23.254.236.11/`（该 deploy 的 main 祖先链包含 #2308）。staging smoke **PASS**（stamp `s3-outdoor-1780649522285`）：确认 `zzzz20260605120000_add_outdoor_punch_request_type` migration 已应用；创建临时 smoke 用户 + outdoor approval flow；开启 `punchPolicy.outdoor.requireApproval=true/requireNote=true` + geoFence；围栏外 punch 返回 pending request 且 `attendance_events`/`attendance_records` 均 0；final approve 写 exactly one `source='outdoor_approval'` check-in event 并更新 record、无 generic `adjustment`；reject path 不写 event/record；settings restored；cleanup residue=0。至此外勤审批 runtime + staging gate 完成；S3-2 前端配置卡、移动端外勤体验、S2 内外勤合并、C5 外发渠道、`requirePhoto`/照片存证、dist-sdk SDK 类型仍为后续 deferred。

> **回填（2026-06-05 S2 内外勤合并 design-lock）**：S3 外勤事实类型（`source='outdoor_approval'` event）就位后，S2 的可合并对象成立 → 补 delta design-lock `attendance-inout-merge-s2-design-lock-20260605.md`（**仅设计，implementation 🔒，不翻 ✅**）。owner 决策锁定：(1) 内/外勤分类器 = `attendance_events.source === 'outdoor_approval'`（**但当前可被 `/punch` 伪造 → 须先经 S2-0 加固为 reserved source（只有 S3 approve writer 可写）才可信**；`meta.outdoor` 因 requireApproval 关时被忽略，不能单独判）；(2) **上班卡由 `internalWinsOnIn`、下班卡由 `externalWinsOnOut` 分别**定，语义 = "wins-when-present-else-fallback"，胜出桶内仍 earliest-in/latest-out，两键独立；(3) **默认两键 false ≡ 现状 first-in/last-out**，且无外勤事件日恒为 no-op → 双重零回归；(4) **S2 是派生层口径——绝不回写 `attendance_events`**，只把 effective in/out 喂既有 `computeMetrics` 重算 records，summary/report 读 records 路径不变（已 verified export 亦读 `attendance_records`）；(5) pending/reject/cancel 外勤无 event/record 故永不参与；(6) `internalWinsOnIn`/`externalWinsOnOut` 各有 payroll-adjacent 工时取舍，owner 开启前须确认。完成口径 = 真实事件组合反向矩阵（内/外 × in/out × 两键）+ staging smoke。子链 **S2-0 source 加固（reserved `outdoor_approval`，硬前置）→** S2-1 backend（暴露两键 + 事件感知 + record-only 保护 + 窄触发重算）→ S2-2 frontend card → S2-3 反向测试 + staging，全 🔒、各自 opt-in。

> **回填（2026-06-06 S2 runtime + admin UI build-out）**：S2 子链已逐环 opt-in 落 main：**S2-0** reserved source #2329（`outdoor_approval` 列为 reserved，`/punch` 等非 approve 写入伪造该 source → 422 `PUNCH_SOURCE_RESERVED` + 反向测试；分类器自此可信）→ **S2-1** backend #2333（暴露 `punchPolicy.merge.{internalWinsOnIn,externalWinsOnOut}` 两键 + `applyAttendanceInOutMergePolicy` 事件感知重算，不回写 events）→ **record-only 保护 fix #2336**（修 #2333 把保护误锁在 `outdoorIns>0` 窄触发内的缺陷——design-lock §2.4 / §5.11-§5.12 要求 import/override record-only `first_in_at`/`last_out_at` 在对应 key 开启时即使当天无外勤事件也不被普通 punch 冲掉；#2333 原实现在无外勤日不保护、review 阶段我曾误判 APPROVE，主源 + 真 DB §5.11/§5.12 repo 复现后 fix-forward，owner 决策 A=只在 key 开启时保护、key 关仍走现有 append；first+last 对称用例覆盖）→ **S2-2** admin card #2344（`7542d3679`，`AttendanceView.vue` 两 checkbox + PUT 仅 `{punchPolicy:{merge}}`，per-sub-key preserve 保 outdoor/unscheduled sibling，文案诚实不承诺 record-only 永不覆盖）。**至此 S2 runtime + admin UI + staging smoke 全部闭环（✅）**——事件组合反向矩阵已由 #2333/#2336 真 DB 测试覆盖；staging gate 已于 2026-06-06 通过。

> **回填（2026-06-06 S2 staging closeout）**：S2-3 内外勤卡合并 staging smoke **PASS**（deploy `66cd91582275301c538421a1e4c1f3190a415ef8`，stamp `s2-merge-mq2kc9sy`，log `/home/mainuser/s2-3-smoke-s2merge-1780763046-2208155.log`）：部署前从 `32f3aa196` 升级 staging 到 #2352 main，并应用 pending migrations `zzzz20260605120000_add_outdoor_punch_request_type` + `zzzz20260605130000_add_condition_branch_automation_action`（migration count 180）；production dev-token 404，smoke 使用 synthetic `s2merge-*` subject + 临时 `users`/`user_roles` hydration，trap 清理身份记录。两键开启后同日内勤+approved 外勤两卡：`first_in_at=09:05`（internalWinsOnIn）/ `last_out_at=18:30`（externalWinsOnOut）/ `work_minutes=565`（≤565，未合并窗口为 610）；4 条 `attendance_events` 未被 rewrite；`GET /records` 与 `GET /summary` 跟随 record；settings restored；attendance residue `0,0,0`，synthetic identity/flow residue 0。至此 S2（S2-0 #2329 → S2-1 #2333 → fix #2336 → S2-2 #2344 → S2-3 staging）闭环 ✅。

> **回填（2026-06-09 自动对班 design-lock）**：H2 MUST 全部完成后，下一条 SHOULD 先锁 **自动对班 preview**（`attendance-auto-shift-matching-preview-design-lock-20260609.md`）。设计把风险拆为 A0/A1/A2：A0 只读 preview/建议态（从真实 punch 证据给出候选 shift、score/confidence/reasons，**不写库**）；A1 admin 选择应用才写 `attendance_shift_assignments`，并必须复用排班写入锁、排班修改窗、排班合规引擎与 provenance；A2 自动写入默认不允许，需另起 design-lock + feature flag + staging smoke。硬红线：只处理 `scheduled_shift` 组内 `isUserScheduledForDate=false` 的 user/day；固定/自由工时不适用；不覆盖已有 manual/import/fixed/rotation assignment；不做 multi-slot/overnight；不把固定班组 preview/apply 误当自动对班。状态从 ⬜ → 🟡，不翻 ✅。

> **回填（2026-06-09 自动对班 A0/A1 build-out）**：A0 backend preview 已落 #2403（runtime flag + org setting 双门；`preview`/`apply` 模式均可预览；只读，不写 assignment），A0 admin review UI 已落 #2405（`AttendanceView.vue` 建议/跳过表 + filter form；无 apply）。A1 已落 #2406（squash `b4a1ca693`）：settings schema 接受 `mode='apply'`（`auto` 仍拒绝，A2 另锁）；新增 `POST /api/attendance/auto-shift-matching/apply`，只接受 admin 选中的 preview suggestion + evidence eventIds，事务内重跑 eligibility/matching，复用 per-user assignment lock、scheduler-scope dispatch guard、排班修改窗、shift-compliance cap，写 `attendance_shift_assignments` 并 stamped `producer_type='auto_shift_match'` / deterministic `producer_key=userId:workDate` / `producer_run_id`；已有 auto/manual/import/fixed/rotation assignment 跳过，不覆盖；stale punch evidence 跳过；重放同一 suggestion 幂等 `already_applied`。A1 UI 增加模式选择 + suggestion checkbox + apply selected 按钮，POST 仅 `/auto-shift-matching/apply`，不直接写 `/assignments`。A2 自动写入仍 deferred。

> **回填（2026-06-09 自动对班 A1 staging closeout）**：staging 已部署 #2406 build `b4a1ca69323d767e7d838882751b365f18b4116f`（`https://23.254.236.11/`，backend env `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true`）。A1 smoke **PASS**：临时 synthetic admin 通过真实 `AuthService` token 走线上 API；PUT `autoShiftMatching.enabled=true/mode='apply'` round-trip；seed `scheduled_shift` group + real punch events 后 `POST /auto-shift-matching/preview` 返回建议且 `attendance_shift_assignments` 仍 0；选中 suggestion 调 `POST /auto-shift-matching/apply` 写 exactly one assignment，provenance 为 `producer_type='auto_shift_match'` + deterministic `producer_key=userId:workDate` + `producer_run_id`；重复 apply 返回 `already_applied` 且无重复；已有 manual assignment 的 user/day 返回 `already_scheduled` 且不覆盖；settings restored；cleanup residue `{"users":0,"events":0,"records":0,"assignments":0,"groups":0,"shifts":0}`，全局 `autoshift-a1-smoke-*` 前缀 residue 亦为 0。stamp：`A1_AUTO_SHIFT_STAGING_SMOKE_PASS deploy=b4a1ca69323d767e7d838882751b365f18b4116f prefix=autoshift-a1-smoke-mq64a66m`。至此自动对班 A0/A1（preview → admin selected apply）闭环 ✅；A2 自动写入仍需另起 design-lock，不属于当前 ✅ 口径。

> **回填（2026-06-09 一天多班次 design-lock）**：下一条 SHOULD 「一天多班次」先落设计锁 `attendance-multi-shift-day-design-lock-20260609.md`，不直接写 runtime。pre-flight 发现当前表没有 user/day DB unique，单班限制主要来自 `findAttendanceScheduleAssignmentConflict`、`loadShiftAssignment LIMIT 1`、effective-calendar/planned-minutes 等 single-effective 口径；因此不能只允许多行写入。v1 锁定：默认关闭；新增 `attendance_shift_assignments.slot_index`（API `slotIndex`，0-2，legacy 默认 0）；同 slot date-range overlap 禁止，不同 slot 仅在 shift 时间窗不重叠时可共存；rotation 与 direct multi-slot v1 互斥；planned minutes / shift-compliance cap 必须汇总 slots；`attendance_records` 仍一日一行，实际出勤 first/last 与 payroll-grade multi-segment 计算不在本线；fixed-schedule apply 与 auto-shift A1 保持 slot 0 兼容。完成口径：schema replay + conflict/effective-calendar/planned-minutes + admin UI + staging smoke 全满足才从 🟡 翻 ✅。

> **回填（2026-06-10 一天多班次 M1-M5 prep）**：一天多班次已从 design-only 推进到 runtime + admin UI，但尚未 staging-proven，故保持 🟡：M1 #2426（squash `1e7454bd2`：`attendance_shift_assignments.slot_index` schema/mapping，assignment POST/PUT 接受 `slotIndex`，默认 off coercion to slot 0，同 slot conflict、不同时段 slot coexist、rotation 互斥、list read 回传 slot）→ M2 #2427（squash `69c571c27`：`multiShiftDay.enabled=true` 时 effective-calendar 返回 direct `effective.slots[]`，`plannedMinutes` 汇总 slots，comprehensive-hours planned preview 与 shift-compliance 投影复用同一路径；修过 per-slot working-days gating）→ M3 #2428（squash `e3219b176`：fixed-schedule apply/rebuild 只写/管理 slot 0 且不 clobber 兼容非零 slot；auto-shift A1 保持 single-slot，已有任一 direct/rotation assignment 覆盖 user/day 时 skip `already_scheduled`）→ M4 #2429（squash `41e626498`：真实 `AttendanceView.vue` 新增 `multiShiftDay` settings card，assignment editor 仅 enabled 时显示/发送 `slotIndex`，table slot chips，文案说明 records 仍是一日一行）。M5 smoke harness 本 PR：`scripts/ops/staging-attendance-multi-shift-m5-smoke.mjs` + runbook `attendance-multi-shift-m5-staging-runbook-20260610.md`，覆盖 direct slot0+slot1、conflict guard、effective-calendar slots、planned preview 汇总、fixed rebuild preserve non-zero slot、auto-shift already_scheduled compatibility、settings restore + residue=0。**仍 pending owner-driven staging run；未翻 ✅。**

> **回填（2026-06-10 一天多班次 M5 staging closeout）**：一天多班次 staging smoke **PASS**（deploy `46b218503c965370fc58db02141220787cb1cf79`，stamp `multi-shift-m5-mq7x1wqk`，log `/tmp/staging-multi-shift-m5-smoke-20260610T101849Z.log`）：direct slot0+slot1 coexist when shift windows do not overlap；same-slot and overlapping-window conflicts reject；effective-calendar exposes ordered `effective.slots[]` and total planned minutes；comprehensive planned preview sums slots；fixed-schedule apply/rebuild preserves the exact existing non-zero direct slot and effective-calendar still reports both slots；auto-shift A1 apply branch（staging env `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED=true` 后重启，同 deploy image）skips existing non-zero slot user/day；settings restored；cleanup residue=0（assignments/shifts/groups/events/records）。首轮 run 暴露两个 staging/runbook 问题并已修正：staging env 缺 auto-shift runtime flag 导致 `AUTO_SHIFT_MATCHING_APPLY_DISABLED`，以及 smoke cleanup 对 UUID producer 列做 `LIKE` 导致 cleanup fail；#2446 已把 cleanup 限定到 synthetic user assignments 并补 runbook env 前置说明。至此一天多班次（M1 #2426 → M2 #2427 → M3 #2428 → M4 #2429 → M5 #2445/#2446 staging）闭环 ✅。

> **回填（2026-06-09 排班发布/草稿 design-lock）**：下一条 SHOULD 「排班发布/草稿」落设计锁 `attendance-schedule-publishing-design-lock-20260609.md`，不直接写 runtime/schema/UI/OpenAPI。v1 锁定：API 生命周期 `draft` / `pending` / `published`，DB 建议用显式 `publish_status`（不是泛化 `status`）；legacy/current assignment writes 默认 `published`，确保零回归；draft/pending 对 effective-calendar、planned-minutes/shiftCompliance、`isUserScheduledForDate`、未排班提醒、报表均不可见；publish 才是生效写入点，事务内按稳定 user 顺序拿 per-user lock，复用 scheduler-scope permission、`shiftEditPolicy`、published conflict guard 与 `shiftCompliance`，成功后写 `published_at/published_by/locked_at`；published rows v1 不允许普通 PUT 静默改写，修正/重开另起设计；fixed-apply 与 auto-shift A1 默认仍 immediate published，并保留 `producer_type` / `producer_key` / `producer_run_id` provenance。状态从 ⬜ → 🟡，完成口径需 schema replay、状态过滤、draft CRUD、publish preflight/transition、fixed/auto 兼容、admin UI、staging smoke 全满足才 ✅。

> **回填（2026-06-10 排班发布/草稿 build-out）**：排班发布/草稿 runtime 链已逐片落 main，但尚未 staging-proven，故保持 🟡：P0 lifecycle foundation #2430（`publish_status`/publish metadata/locked rows foundation）→ P1 draft CRUD/list filters #2432 → P2 publish transition #2433 → P3 producer compatibility tests #2434（fixed-apply / auto-shift A1 immediate published 兼容）→ P4 admin UI #2435 → P4 staging smoke prep #2436（runbook/script）。本链已具备 backend runtime + admin UI + 反向测试 + staging harness；**剩余唯一完成门 = staging smoke PASS + residue=0 后再翻 ✅**。

> **回填（2026-06-09 加班三段引擎 design-lock）**：下一条 SHOULD 「加班三段引擎」先落设计锁 `attendance-overtime-segmentation-engine-design-lock-20260609.md`，不直接写 runtime。pre-flight 确认当前 `workday_overtime_duration` / `restday_overtime_duration` 主要从 `attendance_records.is_workday` + total overtime 派生，`holiday_overtime_duration` 依赖未被 runtime approval engine 统一产出的 metadata；`attendance_overtime_rules` 也只有通用 min/rounding/max。v1 锁定：O1/O2 只用 org settings JSON、不做 schema/table；day type 只从 effective-calendar 真源解析（makeup workday=workday；非工作日且有 holiday layer=holiday；无 holiday row 的公司/组额外休息日=restday）；跨日加班 v1 稳定拒绝 `OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED`，不 warning 接受；per-day-type comp-time rate 保持 latent，v1 仍按 total 1:1 入账；overtime request metadata 必须保存 versioned segmentation snapshot；request approval、records、summary、report fields、period/report sync、comp-time grant 都消费同一 engine output；公式字段只能作为 projection，不能作为 runtime truth。完成口径：helper/request/record/summary/report/comp-time 反向测试 + staging smoke residue=0 全满足才从 🟡 翻 ✅。

> **回填（2026-06-09 临时班次 design-lock）**：下一条 SHOULD 「临时班次」先落设计锁 `attendance-temporary-shift-design-lock-20260609.md`，不直接写 runtime/schema/UI。v1 锁定：临时班次是 replace-only one-off assignment overlay，不是每天新建 `attendance_shifts` catalog row；复用 `attendance_shift_assignments` 并加 temp metadata，`start_date=end_date=workDate`；支持 replace 语义覆盖当天 direct/fixed/auto effective schedule；rotation replacement 在 v1 稳定拒绝 `TEMP_SHIFT_ROTATION_REPLACEMENT_UNSUPPORTED`，直到另起 rotation override design 证明 resolver precedence；add mode 在 v1 稳定拒绝 `TEMP_SHIFT_ADD_MODE_DEFERRED`，等一天多班次 M0-M5 staging-proven 后另起 follow-up 用 slot/non-overlap guard；temp runtime 必须等 assignment publish/draft status，不允许 immediate-active interim（除非 owner 以后另开 interim design）；fixed-apply/rebuild/clear 与 auto-shift A1 必须 preserve/skip temp row，不覆盖。完成口径仍是 backend runtime + admin UI + 反向测试 + staging smoke 全满足才从 🟡 翻 ✅。

> **回填（2026-06-10 临时班次 T0/T1 build-out）**：临时班次已从 design-only 推进到 schema + replace runtime，但未完成 UI/staging，故保持 🟡：T0 #2437（`attendance_shift_assignments` temp metadata schema、DB CHECK、read mapping/OpenAPI/frontend read shape）→ T1 replace runtime #2439（squash `743d5ba75`）：仅 schedule draft route 可创建 one-day `assignmentKind='temporary'`/`temporaryMode='replace'` rows；direct `/api/attendance/assignments` immediate-active temp 422；open-ended/multiday/add-mode/rotation replacement/temp edit 均稳定 422；draft create + publish 均重验 replacement assignment（same org/user/slot/date coverage/published/non-temporary/active）；conflict helper 只放行被替换 published base row，不放过其它 draft/pending/published conflict；effective-calendar/planned-minutes resolver overlay 防 base+temp 双算，默认单班 temp day 也暴露 `effective.slots[].assignmentKind='temporary'` + `replaces.assignmentId`。CI real-DB attendance integration 119/119 通过；**剩余：admin UI + staging smoke 后才 ✅**。

> **回填（2026-06-10 临时班次 T5/T6 prep）**：T5 admin UI 已落 #2441（squash `5edaf08b`）：真实 `AttendanceView.vue` Assignments 面板新增「Temporary shift replacement」卡，替换目标 select 只列 active+published+regular assignment；保存只走 `/api/attendance/schedule-drafts/assignments`，payload 精确包含 `assignmentKind='temporary'` / `temporaryMode='replace'` / `temporaryReplacesKind='shift'` / `temporaryReplacesAssignmentId` / `slotIndex` / 单日 start=end / reason；不触发 immediate `/api/attendance/assignments` POST 或 comprehensive-hours preview；`workDate` 受 replacement assignment start/end 前端 min/max + 保存前校验，越界不 POST；table 显示 temporary marker。attendance-web-guard 101/101 绿，Huygens review APPROVE。T6 smoke harness 已准备：`scripts/ops/staging-attendance-temporary-shift-t6-smoke.mjs` + runbook `attendance-temporary-shift-t6-staging-runbook-20260610.md`，覆盖 draft invisible → publish temp overlay → single-shift `effective.slots` metadata + replacement planned minutes → cancel restore base → fixed-schedule rebuild preserves temp overlay → cleanup residue=0。**仍 pending owner-driven staging run；未翻 ✅。**

> **回填（2026-06-10 临时班次 T6 staging closeout）**：T6 staging 首跑在 #2441 build `5edaf08b` 上真实暴露运行态缺口（published temp DELETE 被 `SCHEDULE_PUBLISH_LOCKED` 拦住、fixed-schedule rebuild 把 temp overlay 当 blocking conflict、单班普通 base day 的 effective-calendar 响应无 `effective.slots` 导致脚本误判）。修复 #2443（squash `46b218503c965370fc58db02141220787cb1cf79`）：published temporary row 允许 DELETE 语义走 soft-deactivate/cancel（非 temp locked row 仍保持 422）、fixed-schedule rebuild 只跳过"准确替换本次 fixed base row"的 temp overlay（防 stale/unrelated temp 被误跳过）、T6 smoke 读取 normal base/draft/cancel 时以 `effective.source='shift'` + no temporary slot 判定而不是假设单班 always exposes slots。CI real-DB attendance integration 119/119 通过，Copernicus re-review APPROVE。staging 手动构建/部署 `46b218503c965370fc58db02141220787cb1cf79`（backend/web image tag 同 SHA；GHCR merge image 未及时发布，故在 staging 主机用该 SHA source snapshot 本地 build 后 `SKIP_PULL=1` deploy），migration clean；T6 smoke **PASS**：`=== PASS — 41 passed, 0 failed === stamp temp-shift-t6-mq7vn6uc`，log `/tmp/staging-temporary-shift-t6-smoke-20260610T093922Z.log`。覆盖：draft temp invisible before publish；publish 后 replacement shift 生效 + `effective.slots[].assignmentKind='temporary'` + `replaces.assignmentId`；planned minutes 使用 replacement shift；cancel 后 base schedule restored；fixed-schedule rebuild preserves temp overlay；settings restored；cleanup residue `assignments 0, shifts 0, groups 0, events 0, records 0, requests 0`。至此临时班次（T0 #2437 → runtime #2439 → admin UI #2441 → runtime closeout #2443 → T6 staging）闭环 ✅。

> **⚠️ schema 成组迁移，别一刀一迁。** 首刀"排班修改窗"已按 #2197 路线**无 DDL 落地**：policy 先进 org-level attendance settings JSON（`shiftEditPolicy`），write-time 按受影响日期判窗。后续若要把排班合规（`shift_constraints`）、发布（`publish_status`）、多班次（`slot_index`）、或持久锁窗（`locked_at`）落到 `attendance_shift_assignments`/`rule_sets`，这些 schema 变更再打一个协调 migration，再分层叠 service/UI（v1 阶段2 已是此意）。

---

## 4. H1 — scheduler-scope 收尾清单（3–7 人天）

| 项 | 量 | 备注（含审计 `/tmp/attendance-scheduler-scope-enforcement-audit-20260601.md` 收紧） |
|---|---|---|
| scoped 非管理员真实 UX smoke | **0.5–1.5 天** | 必须 seed "**有 scope、无中央 `attendance:import`/`approve`**" 的子管理员——证明 scope 分支**可达、非死代码**（`fullImport`/`canAccessOtherUsers` 会短路）；并核 provisioning 不会给同一人同时发中央权限+scope（否则 scope 在 import/approve 上被静默忽略） |
| dept/roles/roleTags 真 picker | **0–4 天** | **roles/roleTags 当前无可枚举源**（开放词汇）→ 大概率停在 chips、性价比低、可不做；departments 若有部门树才值得做 |
| async import/batches/rollback/templates/integrations 开放给 scoped actor | design-lock **0.5–1 天**；接线另 **3–6 天** | 当前是 `withAttendanceImportPermission`（中央权限）专属、自洽两层模型。**倾向 design-lock 拍板后 DEFER 接线**（YAGNI，除非客户明确要） |

---

## 5. ⚠️ 已发生的偏离（记录，否则再歪一次）

v1 阶段1 旗舰 = `attendance_admin_scopes`（scope_type + permission_set）。**实际并行 session 建的是完全不同的 `attendance_scheduler_scopes`（subject×action×6-target）+ 一整套运行时 enforcement。**
- **能力已交付且更完整**（v1 只设计 scope CRUD，实际还做了 11 路由的运行时 403）——**不回退、不按 v1 的 `attendance_admin_scopes` 重做**。
- v1 §三整节作废；后续"管理范围"以 `scheduler_scopes` + `assertAttendanceSchedulerScopeAllowed`（`index.cjs:~15269`）为准。
- 其余阶段 schema 可参考 v1，但**落地前必 `git log origin/main` 查重**（本轮已撞 2 次：T4 pickers、整条 enforcement）。

---

## 6. 防漂移规则（这份文档存在的意义）

1. **唯一真源**：本表是"对标到哪了"的唯一账本。每个 attendance PR 合并后回填对应行 ✅ + PR 号。
2. **开工前查重**：`git fetch origin main && git log origin/main --oneline -15` + grep 该项特征 symbol/路由，确认没被并行抢做（**讨论计划 ≠ 占坑**）。
3. **每项独立 opt-in**：MUST/SHOULD/OPTIONAL 各项是独立 PR 链，不自动串下一刀。
4. **OUT 红线**：§1 的 🚫 项不碰。
5. **验收口径**：MUST 项"能配置且运行时生效 + 反向测试 + staging 联调"才 ✅。
6. **H3 拆两类**：**3a 可选可建**（调度/换班/小组织/多门店——客户真要时单点开，各约 1–2 周）vs **3b 不自研红线**（算薪→SaaS · 防作弊→原生 app · 人脸/AI→视觉资源 · 设备/WiFi/地理围栏→原生/硬件）。别把"能做的大"和"不该自研"混报"2–4 月"。
