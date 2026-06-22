# 钉钉考勤对标 — refresh 审计 v3（2026-06-21：年假引擎落地后的当前梯子 + 人性化优化维度）

> **执行账本**：`docs/development/attendance-dingtalk-benchmark-target-and-tracker-20260601.md`（tracker，single source of truth）
> **上一轮 refresh**：`docs/research/dingtalk-attendance-benchmark-refresh-v2-20260614.md`（v2「下一梯子」）
> **为什么有这份文**：v2（2026-06-14）的头条候选 **#1 法定/年假额度引擎此后整条 L0→L6 已落地**（#2622 design-lock → #2627–#2853 build，origin/main 110 符号实测）。本文做三件事：① 以 **当前 `origin/main`** 重新实证 #2–#8（**不继承 v2 旧态** —— 避免 #2177 stale 陷阱）；② **深读钉钉手册（36 个考勤内容页全覆盖）**，补 v2 缺的「**人性化操作**」对标维度（owner 本轮特别要的）；③ 按 **文件级并行独立性** 重排梯子 + 推荐下一波，供 owner 拍板。
> **竞品名仅限本研究稿**（`feedback_formal_docs_own_principles_not_brand_names`）。正式 design-lock 只写 MetaSheet 自己口径，不带 钉钉/dingtalk 等字样。**OUT 红线（§4）不变**，且经手册复核确认：手册里的 AI 拍照异常 / 人脸 / 考勤机 / WiFi/蓝牙硬件采集 / 防作弊 都是**我方既定 OUT，不是 gap**。

---

## 0. TL;DR

- **#1 年假/法定假额度引擎 ✅ 已落（L0–L6 staging-proven）**（自 v2 后：L0–L5c build + `/me` 员工自助余额卡 #2850/#2853 + **L6 staging smoke PASS**；grant/accrual/跨年过期/审批扣减/admin 操作 UI 齐全。L6 已闭环（closeout 见 tracker §0.5）——非 pending、非欠账）。
- **当前真实剩余 = 7 候选**，按 **文件级并行独立性** 重排（碰撞图见 §2）：
  - **最安全并行（文件不相交）**：**#3 通知渠道 adapter**（唯一独立文件 + 1 行注册）、**#2 员工自助统一入口**（前端为主 + 1 个隔离 read-route）。
  - **`index.cjs` 内局部、彼此隔离**：**#4 补卡结构化**（`/punch`+`/requests`）、**#7 销假/余额反冲**（与 #1 年假 **同表**，随其家族排期）。
  - **共享热核（必须相互串行）**：**#5 报表分级**、**#6 待审批假期 overlay + 团队日历**、**#8 夜班/跨午夜深化** —— 三者都汇聚到 `resolveEffectiveCalendar` + record-compute 区。
- **推荐第一波（3 链并行）**：`#3 通知渠道（先邮件，最干净）` ∥ `#2 员工自助统一入口（前端为主）` ∥ `#4 补卡结构化（仿 S3 外勤审批 pattern）`。**第二波串行**：`#5 报表分级` → `#6 待审批假期+团队日历`；`#7 销假` 随 #1 家族；**最后** `#8 夜班深水区`（单 arc）。
- **§3 人性化优化** = 手册 8 类 UX 模式 × 我方现状的差距清单，多为可与功能 arc 并行的小切片（owner 可单独挑）。
- 每候选仍 **design-lock → owner 拍板 → build**；owner 选定后锁成新的 **§0.4 目标块**。

---

## 1. 当前态重新实证（2026-06-21 @ `origin/main` — supersedes v2 同行）

| # | 候选 | v2（06-14）旧态 | **当前实证（fresh，2026-06-21）** | 文件级并行性 |
|---|---|---|---|---|
| 1 | 年假/法定假额度引擎 | 头条候选（年假仅标签） | **✅ DONE（L0–L6 staging-proven）** — L0–L5c build + `/me` 自助余额卡 + **L6 staging smoke PASS**；grant-lot ledger（`attendance_leave_balances`+events）+ accrual + 跨年 `expires_at` + 审批扣减全落 | —（已闭环） |
| 2 | 员工自助统一工作台 | PARTIAL（「我的余额」缺） | **PARTIAL**（缺口缩小）— 自助余额卡已落（`attendance__grid--selfservice` / `data-selfservice-card="annual-balance"` 消费 `/me`）；但 6 类申请（请假/加班/补卡/外出/调休/换班）仍分散 ≥3 surface：quick-draft 只接 `leave`+`overtime`；`outdoor_punch`(外出) 后端有类型但**无员工表单**；调休仅是 leave 子类型；换班是**并列**独立面（`isShiftSwapRequest` 块），未折叠进申请中心 | **前端为主 + 1 隔离 route**（`/leave-balances/me`）；不动核心 → 文件不相交 |
| 3 | 通知渠道扩展 | seam 已建，仅钉钉 | **PARTIAL** — adapter seam 干净：`interface AttendanceDeliveryChannel { send() }` + name→channel 注册 + env 工厂 `createAttendanceDeliveryChannelsFromEnv`；已有 `DingTalk*` + `DeterministicFake*` 两实现，已 wire 进 `AttendanceScheduler`。**无 email/SMS/WeCom**。⚠ 另有 `NotificationService.ts` 的 `Email/Webhook/Feishu` 实现 **是另一套接口**（approval/breach 用），不可直接复用，需各自实现 `AttendanceDeliveryChannel` | **唯一文件级独立** — 新文件 + `createAttendanceDeliveryChannelsFromEnv` 1 行注册；不碰 index.cjs/records/报表 |
| 4 | 补卡结构化 + 规则强约束 | generic adjusted（无流/约束） | **PARTIAL** — `REQUEST_TYPES` 有 `missed_check_in/missed_check_out/time_correction`（补卡原语），走 generic `/requests`→审批；但 `补卡` 仅作报表字段（`correction_count` = `status==='adjusted'?1:0` 透传），**无专用补卡 event 写入、无 次数/时限/类型 约束**（quota/window grep 0） | **半独立** — 动 `/punch`+`/requests` 局部，与 #5/#6/#8 热区无重叠 |
| 5 | 报表分级口径一等化 | summary.* 透传 | **ABSENT-as-rule** — `severe_late_*`/`absence_late_*` 仍 `source:'system'` + `internalKey:'summary.severeLateCount'` 纯 meta 透传；仅 **basic late** 自算（`lateGraceMinutes→lateThresholdAt→lateMinutes`）；**无** `severeLateThreshold`/`absenceLateThreshold` config，**无**代码给 `severeLateCount` 赋值（字段描述写了「超过严重迟到阈值」但阈值未 wire） | **串行** — 共享 record-compute（~`10250`，与 #8 同区）+ summary-meta plumbing |
| 6 | 待审批假期 overlay + 团队可用性日历 | grep 0 | **ABSENT** — `pendingLeave`/`teamAvailability` 全 0；将注入 `resolveEffectiveCalendar`（`index.cjs:14012`，前端镜像 `effectiveCalendar.ts`）的 `items[]` | **串行** — `resolveEffectiveCalendar` 是热核，#8 compute 也调它 |
| 7 | 销假 / 余额反冲 | grep 0（预留再入点） | **ABSENT（reverse seam 预留）** — `销假`/`reverseLeave` 全 0；ledger 反向种子明确：`deductLeaveBalance`（`15339`）写 `event_type='deduct'`+负 delta，反冲 = 新 `event_type='reverse'`+正 delta 挂回原 `source_id` | **半独立** — 局部 ledger fn + 审批撤销；与 **#1 年假同表** → 随其家族排期 |
| 8 | 夜班/跨午夜深化 | 班次级 overnight ✅；跨午夜 OT 硬拒 | **PARTIAL** — 班次级 overnight **✅ BUILT**（`inferOvernightFlag`/`resolveShiftTiming`/`is_overnight` 列贯穿，shiftEnd 滚到次日）+ records **一日一行 ✅**（`ON CONFLICT (user_id, work_date, org_id)`）；**跨午夜 OT 硬拒**（`OVERTIME_CROSS_MIDNIGHT_UNSUPPORTED` → 422）；**multi-slot 夜班 ABSENT**（班次单 `work_start/end` 对，无分段列） | **串行 / 最热核** — record-compute(`~10250`) + records 模型 + OT 引擎 + 调 `resolveEffectiveCalendar`；碰撞面最大，单 arc |

---

## 2. 可并行梯子（重排 + 候选间碰撞图）

**碰撞图（不只是「都动 index.cjs」，而是候选*之间*的真实重叠）：**
- **文件不相交 / 最安全并行**：**#3**（自有 `AttendanceNotificationDeliveryWorker.ts`）、**#2**（Vue + 1 隔离 read-route）。
- **`index.cjs` 内局部、彼此隔离**：**#4**（`/punch`+`/requests`）、**#7**（ledger `deductLeaveBalance@15339`；与 #1 年假**同表** → 序列在其家族内）。
- **共享热核，必须相互串行**：**#5**（record-compute `~10250` + summary-meta）、**#6**（`resolveEffectiveCalendar@14012`）、**#8**（record-compute + records 模型 + OT 引擎 + 调 resolver）。#5/#6/#8 都汇聚到 resolver + record-compute 区。

| 档 | 候选 | 价值 | 粗估 | 泳道 |
|---|---|---|---|---|
| **A 首选** | **#3 通知渠道（邮件先行）** | 🟡 中（可靠性/覆盖面） | ~1 周/渠道 | 文件独立 |
| **A 首选** | **#2 员工自助统一入口** | 🟢 高（C 端体感最直接） | ~1–1.5 周 | 前端为主，文件不相交 |
| **B** | **#4 补卡结构化** | 🟡 中（员工高频缺卡） | ~2–2.5 周 | 半独立 |
| **C 串行** | **#5 报表分级** | 🟡 中（报表可信度=护城河） | ~1.5–2 周 | 串行（踩 computed-only/wire-vs-fixture 雷区）|
| **C 串行** | **#6 待审批假期 + 团队日历** | 🟡 中（排班/请假协同） | ~1.5–2.5 周 | 串行（动热核 resolver）|
| **B/家族** | **#7 销假/余额反冲** | 🟡 中（假勤生命周期完整性） | ~1.5–2 周 | 随 #1 年假家族 |
| **D 单 arc** | **#8 夜班/跨午夜深水区** | 🟢 高（三班倒/制造/医疗刚需） | ~3–5 周 | 串行，最热核，单 arc |

**推荐第一波（3 链并行，沿用已验证的 worktree + rebase/baseline-first 并行工作模式）**：`#3 邮件渠道` ∥ `#2 统一入口` ∥ `#4 补卡结构化`。三者 feature/merge 面独立（#3 文件全独立；#2 前端为主；#4 局部 index.cjs，与 #3/#2 不相交）。

---

## 3. 人性化操作优化空间（手册对标 — owner 本轮特别要的维度）

手册的价值不只在「有没有功能」，更在「**操作有多顺手**」。下面 8 类是手册反复出现的 UX 模式 × 我方现状差距，**多为可独立小切片**，可与上面的功能 arc 并行挑做（每项仍 design-lock）：

1. **自动兜底 > 手动切换**。手册：超出围栏时打卡按钮**自己变成「外勤打卡」**；新增/删除班次**默认自动加入对班**。我方差距：审查我方打卡/排班入口是否需要用户**手动选模式** → 改为状态驱动自动兜底。
2. **一键主动操作 + 多渠道**。手册：对今日未打卡者**一键「提醒打卡」**，可选 定时DING/悄悄话/应用内/短信/电话。我方现状：⑤未排班提醒 + C5 投递已有，但**渠道仅钉钉**（= #3）且缺「管理员一键催办今日异常」的聚合动作 → 小切片：未打卡聚合 + 一键多渠道催办（依赖 #3）。
3. **规则对员工透明**。手册：打卡首页 **「查看规则」** 直接展示本人补卡/考勤组/负责人规则；报表可自助订阅。我方差距：补卡/打卡策略规则是否对**员工端可见**？→ 小切片：员工端「我的考勤规则」只读卡。
4. **变更必通知，绝不静默**。手册：开关申请入口、OT/异常改数、对班结果**都推工作通知**。我方差距：admin 改员工异常数据 / 改规则后**是否通知被影响员工**？→ 对齐「变更必通知」不变量（与我方既有 send_notification/投递面接）。
5. **安全默认 + 数据保护**。手册：默认 300m、默认 调休/年假带薪、**重发余额前「备份假期余额」**、覆盖式导入**先导出再改**警告、不可逆操作**显式提示**。我方差距：年假 grant 重算/导入是否有**备份+不可逆提示**？（#1 家族可补）→ 小切片：余额重算前快照 + 覆盖导入二次确认。
6. **批量 + Excel 往返**。手册：Excel 排班、批量地点/WiFi 导入、批量改余额、批量处理异常（部分 PC-only）。我方现状：import workflow 已富；差距 = **批量处理异常考勤** + 批量改余额的统一往返体验审查。
7. **隐私 / 信任**。手册：人脸照不存、隐藏详细地址（只到区县）、改数前后**留底照片+备注**、子管理员**严格数据隔离**。我方差距：审查我方 admin 改数审计是否**留前后值**（我方有 audit logs，需确认粒度）+ 子管理员范围隔离的 UX 暴露。
8. **精确可信定义**。手册：移动端团队视图把 **打卡人数/应到/应到但未打卡** 明确列出排除项（请假/休息/未排班/全天外出），消除「这个数字为什么不对」。我方差距：我方报表/团队视图的口径定义是否**对用户显式可见**？→ 小切片：口径 tooltip / 字段说明（与 #5 报表分级天然同源，可一起做）。

> 注：**§3 的小切片不替代 §2 功能 arc**；它们是「让已有功能更顺手」的优化，价值在 C 端/运营体感。owner 可单独挑，或附在相关 arc 里一起做（如 #8 顺手做 §3.8 口径可见、#3 顺手做 §3.2 一键催办）。

---

## 4. 红线 / 非目标（不变 + 手册复核确认）

🚫 **不自研**（手册里这些页 = 我方 OUT，**不是 gap**，不要因「手册有」就重开）：
- **AI 考勤拍照异常识别**（大模型图像理解判黑屏/天花板/安全帽…）→ 视觉/AI，OUT。
- **人脸识别打卡 / 拍照打卡** 采集层 → 硬件/原生，OUT。
- **考勤机 / WiFi / 蓝牙智点** 硬件采集 → 硬件，OUT。
- **防作弊**（7 天虚拟定位记录/越狱检测）→ 原生 app，OUT。
- **算薪引擎** → 对接 SaaS，不自研。
- **原生 app push / 插件市场 / 对外公开 API / 多时区报表**（除非海外客户）→ OUT。

手册的「7 种打卡方式」我方只对标**规则/审批/归属/统计层**，**采集层不自研**。

---

## 5. 治理 / 下一步

1. **owner 拍板下一波 arc**（推荐 §0 第一波 3 链：#3 ∥ #2 ∥ #4）；选定后锁成 **§0.4 目标块**（沿用 In/Out/预算/完成口径格式）。
2. 我按选定 arc 出对应 **design-lock**（`docs/development/`，**MetaSheet 自己口径，不带竞品名**）。
3. **并行护栏**（沿用治理）：每链开工前 `git fetch origin main && git log origin/main` 查重 + grep 特征 symbol；worktree 隔离；每项独立 opt-in；**MUST 口径 = 运行时强制 + 反向测试 + staging 联调**。
4. 每链 staging-proven 后回填 tracker ✅。

> 本文为研究稿；不改任何代码。下一步等 owner 选 arc。
