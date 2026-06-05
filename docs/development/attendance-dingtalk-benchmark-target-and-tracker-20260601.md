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
| 外勤审批 | MUST | ⬜ | 0 |
| 内外勤卡合并 | MUST | ⬜ | 0（打卡抽屉只读） |
| 加班↔调休 | MUST | ✅ | C0–C3 staging-validated + C4-1(#2270 inert) + **C4-2 #2274**（`4b3108737`：expiry scheduler + `expiresInDays` grant 写 `expires_at` + notifier scaffold，**无 DDL**）。CI real-DB attendance step 真跑且绿（`④ C4` 用例在 `attendance-plugin.test.ts` 88-test 文件 + `attendance-expiry-service.test.ts`）。**staging C4 smoke PASS 2026-06-04**：staging deploy `8701c46e00c68ed19c226e7206f5456866f6b8ba` on `https://23.254.236.11/`，scheduler env `ATTENDANCE_SCHEDULER_ENABLED=true` / interval `5000ms`，30d grant 精确 720h，后台 scheduler 过期 aged lot 一次且 repeat tick 幂等，NULL-expiry lot 保持 active，cleanup residue=0（见 runbook `attendance-comp-leave-c4-2-staging-smoke-runbook-20260604.md`） |
| 假期过期管理 | MUST | ✅ | C4 子链已 staging-validated：`expires_at` 写入 + 过期 state-flow + env-gated `AttendanceScheduler` 调度基座均已证实；C5 通知/提醒仍按 #2230 作为后续扩展，不影响 C4 完成口径 |
| 自动对班 | SHOULD | ⬜ | 0 |
| 一天多班次 | SHOULD | ⬜ | 0 |
| 排班发布/草稿 | SHOULD | ⬜ | 0 |
| 临时班次 | SHOULD | ⬜ | 0 |
| 加班三段引擎 | SHOULD | ⬜ | 公式派生，引擎不区分日型 |
| 调度 / 换班 / 小组织 | OPTIONAL | ⬜ | 0 |

**余下量**：H2 全量（MUST+SHOULD）≈ 3–5 周；**只做 MUST ≈ 2.5–3.5 周**。

---

## 3. H2 执行排序（产品负责人 2026-06-01）

① **排班修改窗**（✅ #2197 已落；纯 write-time 校验，不碰 scheduler/notifier 新基座；治理价值高）
② **打卡策略组**（design-lock #2203）：S0 基座 ✅#2204 · S1 未排班打卡 ✅#2209 · **子序修正 → S1→S3→S2**（S2 内外勤合并依赖 S3 先建"外勤打卡"事实类型）· **S3 外勤 + S2 产品 2026-06-02 暂缓**（外勤=重刀/移动现场）→ 组在 S1 后暂停
③ **排班合规引擎**（✅ #2213/#2214/#2218/#2221 + staging 2026-06-03）：`shiftCompliance` 日/周/月 cap 已按 **explicit scheduled load** 口径在全部 save 路径运行时阻断；staging smoke 13/13 通过，③ 正式关闭
④ **加班调休 + 假期过期**（假勤闭环；假期过期提醒在此**首建** scheduler/notifier 基座）— **design-lock 已落**（`attendance-comp-leave-expiry-design-lock-20260603.md`，本 PR；owner 决策 2026-06-03 锁定）：余额=**grant-lot ledger**（`attendance_leave_balances`，非 mutable aggregate）+ **必需审计流水 `attendance_leave_balance_events`**（不可只改 remaining）· 入账=OT approve **transition** 幂等（**`source_key` NOT NULL + `UNIQUE(org,source_key)` 兜底**，不锁可空 source_id）· 撤销**首版不自动反冲但不静默错账** · 调度=**首建 `AttendanceScheduler`**（镜像 `ApprovalSlaScheduler`，leader-elected，⑤ 复用）。子链 C0 staging-align（**硬前置**）→C1 ledger DDL→C2 入账→C3 扣减→C4 过期+调度→C5 提醒+notifier，实现 PR 拆开。**比 ③ 重一档（有 DDL）。**
⑤ **未排班提醒**（✅ #2294 + staging 2026-06-05；复用 ④ C4 已建成的 scheduler 基座；C5 外发渠道/负责人 fan-out 后续扩展）
⑥ **自动对班**（灰度门，feature-flag 默认关 → preview → 自动写）

> **回填（2026-06-01 pre-flight 发现）**：原排序把"未排班提醒"列首，依据"渠道已有/最便宜"——**verify 证伪**（attendance 无调度器、无事件→通知消费者）。故改：**排班修改窗为首刀**（真·最便宜 + 治理高）；未排班提醒降级为后续"scheduler+notifier 基座"基础设施刀（2–3pd，与假期过期提醒共建）；未排班处理策略归 ③ 打卡策略组。

> **回填（2026-06-02 决定）**：打卡策略组 S0 ✅#2204 + S1 ✅#2209 后**暂停**。pre-flight 证 **S2 内外勤合并依赖 S3 外勤**（当前模型无内/外勤打卡区分——geofence 只在围栏外拒绝、不分类保留；打卡 → first-in/last-out）→ #2203 子序改为 **S1→S3→S2**（S2 可并入 S3 后半段）。S3 外勤=重刀（外勤动作/审批流/报表口径/移动现场），**暂缓**；**下一主线转 ③ 排班合规引擎**（钉钉硬招牌、无此依赖、直接服务"排班保存时禁止越界"）。

> **回填（2026-06-02 合规引擎 design-lock）**：③ 排班合规引擎 design-lock 落地（`attendance-shift-compliance-engine-design-lock-20260602.md`，#2213）。owner 决策锁定：(1) 新建 `shiftCompliance`（日/周/月 maxMinutes + enforcement warn|block，**不并入** comprehensiveHours——save-time/planned/日周月 vs report/actual/月季年）；(2) 强制 = **全部** save 路径（shift POST/PUT `29445/29538` + rotation POST/PUT `21452` + fixed-apply `27818/9193`，DELETE 不拦）；(3) **首版只 block**，warn 预留惰性。**keystone**：投影**复用** `loadAttendanceComprehensivePlannedMinutesByUser`（`13163`，经 effective-calendar resolver，与 comprehensiveHours **同一套** planned-minutes 算法 → 零漂移），**事务内写后投影 → 超限 throw → rollback → 422**（PUT 排除自身自动成立）。切片 **S0 latent config → S1 daily → S2 weekly+monthly**（各 gated + 真 DB route-level 反向 integration）。**完成口径（partial-MUST bar）：③ 仅在 daily∧weekly∧monthly × 全路径 + 反向 integration + staging 全满足才 ✅；daily-only 的 S1 是切片不是"引擎完成"**（防 P2 式 warning/切片充数）。

> **回填（2026-06-03 合规引擎 closeout）**：S0 ✅ #2214（`shiftCompliance` latent settings）· S1 ✅ #2218（daily cap，全部 save 路径）· S2 ✅ #2221（weekly/monthly cap，owner 决策 A：只统计 explicit scheduled load，排除默认兜底工作制 baseline）。staging 部署到 `0fd25d3ed` 后运行 `/tmp/staging-shift-compliance-smoke-20260603.mjs`：**PASS 13/13**。覆盖：(1) `shiftCompliance` PUT→GET round-trip；(2) weekly cap 2400 + 单个显式 540 分钟排班 → 201，证明默认 Mon–Fri baseline 不计入；(3) daily/weekly/monthly 超 cap → `422 SHIFT_COMPLIANCE_CAP_EXCEEDED` 且无 assignment 持久化；(4) fixed-schedule apply 批量路径超 cap → 422 且无 managed row。联调中发现 staging schema drift 并做最小 alignment：`attendance_groups.attendance_type` + `attendance_shift_assignments.producer_*`；这是 staging 环境补齐，不改变 ③ 完成口径，但后续应补正式 migration/ops 记录避免其它环境复现。

> **回填（2026-06-04 C4 closeout）**：④ C4-2 #2274（`4b3108737`）已部署 staging build `8701c46e00c68ed19c226e7206f5456866f6b8ba`（`https://23.254.236.11/`），并以 `ATTENDANCE_SCHEDULER_ENABLED=true` / `ATTENDANCE_SCHEDULER_INTERVAL_MS=5000` 运行后台 scheduler。C4 staging smoke **PASS**：`compTimeFromOvertime.expiresInDays=30` 的 OT grant 写出 `expires_at - granted_at = interval '720 hours'`；`expiresInDays=null` 的 control lot 保持 `expires_at=NULL`；SQL aging 后由**部署态后台 scheduler**把 aged lot 过期为 `status=expired, remaining=0` 并写 exactly one `-120:comp_time_expiry` event；repeat tick 不重复；cleanup residue=0 且 settings restored。至此 ④ 的 C0/C1/C2/C3/C4 全部完成；C5 通知/提醒仍为后续扩展。

> **回填（2026-06-05 ⑤ closeout）**：⑤ 未排班提醒 #2294（merge `32f3aa196`）已部署 staging build `32f3aa196497d2cf81846d36520257be5c793adc`（`https://23.254.236.11/`），先运行 migration `zzzz20260604120000_create_attendance_unscheduled_reminder_dispatch`，再以 `ATTENDANCE_SCHEDULER_ENABLED=true` / `ATTENDANCE_SCHEDULER_INTERVAL_MS=5000` / `ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED=true` 启动后台 scheduler。staging smoke **PASS**：seed `scheduled_shift` 无 assignment 用户 `u-unscheduled-ur1780630401`（target `2026-06-06`）→ 写出 exactly one `attendance_unscheduled_reminder_dispatch`；同 org 的 covered scheduled_shift 用户与 fixed_shift 用户均 0；repeat tick 后仍 exactly one；cleanup 删除 dispatch/assignment/members/shift/groups 后 residue `0|0|0`。因此 ⑤ 从 🟡 翻 ✅。注意：本 ✅ 的完成口径是**内部提醒记录 + notifier seam**；C5 外部渠道、delivery status/retry、负责人 fan-out 仍为后续扩展，不能把 `dispatched_at` 解读为外部送达成功。

> **⚠️ schema 成组迁移，别一刀一迁。** 首刀"排班修改窗"已按 #2197 路线**无 DDL 落地**：policy 先进 org-level attendance settings JSON（`shiftEditPolicy`），write-time 按受影响日期判窗。后续若要把排班合规（`shift_constraints`）、发布（`status`）、多班次（`slot`）、或持久锁窗（`locked_at`）落到 `attendance_shift_assignments`/`rule_sets`，这些 schema 变更再打一个协调 migration，再分层叠 service/UI（v1 阶段2 已是此意）。

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
