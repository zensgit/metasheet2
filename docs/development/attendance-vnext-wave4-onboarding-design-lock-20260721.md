# 考勤 vNext Wave 4 · 首次启用向导（onboarding）design-lock — 2026-07-21

> **Status: PROPOSED — docs-only，不授权任何 runtime。** owner 2026-07-21 裁决原文授权范围 =
> 「只读侦察 + docs-only design-lock，暂不授权 runtime」。本锁不改任何代码、不建端点、不动 flag；
> runtime 切片只有在 owner RATIFY 本锁之后按 §9 切片序逐一开工。Wave 5（explainability）保持
> DATA-CONTRACT-GATED，且按同一裁决**不与 Wave 4 runtime 并开**。
> 上位文档：`attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`
> （RATIFIED；§4.5/§4.6/§6.2/§7-Wave4/§9/§13-3/§15），OD-VX3/OD-VX4 已按推荐值 ratify。
> 基线 = `origin/main` `6feff1b2b`（Wave 0-3 已收档，3/3 波次验证 MD 在 main）。
>
> **Amendment round-1（2026-07-21，owner 审阅 = CHANGES REQUESTED，0 P1 / 4 P2 + 五条追加门禁；
> 措辞取自 owner 审阅原文）**：P2-1 步骤① memberCount 真源改 `user_orgs`（原考勤组成员数与步骤②
> 循环依赖）→ §3①/§4.2；P2-2 步骤④ `attendance.settings` 为部署级单键（`index.cjs:135`
> SETTINGS_KEY 无 org 维度，保存写入完整 normalized defaults）——「key 存在」会跨组织假绿 →
> 重定义为「平台级打卡策略已显式确认」+ `scope=deployment` 显式标记，无法证明人工确认 ⇒
> `manual_review_required`，绝不 `ready`（§3④/§4.2）；P2-3 步骤⑥历史 delivery 行非配置真源 →
> 新增 core-backend 只读 runtime readiness port（`workerEnabled/defaultChannelAvailable/
> availableChannelCount/orgRecipientBindingReady`，仅布尔/计数；port 缺失 ⇒ `unknown`，禁由
> delivery 存在性推断）（§4.5）；P2-4 恢复合同与「无向导态」矛盾 → OD-W4-7 重写为四点恢复合同
> （已保存=readiness 重算恢复 / 未保存不承诺+离开提示 / 模板选择只存 ID 且 key 含 userId+orgId /
> 「未完成」提示来自 readiness 非访问史）。追加门禁五条入 §9。owner 核心判断维持：core-backend
> 聚合 + user_orgs 门方向正确；①④⑥真源修正后 OD-W4-1..7 方可提交 ratify。
>
> **Amendment round-2（2026-07-21，owner 复审 + OD-W4-1..7 全套裁决，措辞取自 owner 原文）**：
> ④再收紧为 values-free posture 枚举 `default / customized / unknown`（scope=deployment，default 显示
> 「待确认」绝不伪装组织已配置）+ OD-W4-4 新增并裁定 (c)「后端内部语义检查、前端仅收 values-free
> posture」；模板预填补**覆盖确认 + 原表单快照 + 取消完整恢复**合同（OD-W4-3 附加条件）；③补
> `rotationRuleCount/hasRotationRules`（排班制信号闭合，原料 `attendance_rotation_rules`
> `index.cjs:14192`）；每步「计划生效时间」入响应结构为 posture；⑦更名 **preview-ready + 人工
> canonical activation checklist**（绝不暗示已启用）；模板时区禁硬编码（取组织显式时区，取不到要求
> 用户选择）。OD 裁决全录 §8；两非阻断项（聚合单 CTE 或短 TTL org-scoped cache；§10 编号 1..7）
> 已吸收。owner：修订完成并再次核对后方建议 PROPOSED → RATIFIED。

---

## 0. Owner 四条红线（一等公民，覆盖本锁一切条款）

owner 2026-07-21 裁决原文，逐条落为 v1 硬边界；每个 runtime 切片的完成门必须含对应负向断言。
**裁决出处锚定（预审 P3-1）**：该裁决于 2026-07-21 在 owner 工作会话（「考勤开通-260717」）中作出，
本节为其首次入仓转写——仓内此前无该裁决记录（章程 owner record 为 2026-07-20）。**owner 审阅本锁时
请首先核对本节四条红线与授权范围（只读侦察 + docs-only 锁、Wave 5 不并开、operator 项不计完成度）
对裁决原意的转写无失真、无扩权**；确认即构成该裁决的 durable 记录。

| # | 红线 | 本锁的落地形态 |
|---|---|---|
| R1 | **只读 readiness** | readiness 聚合是纯读、values-free 计数面（§4）；聚合端点无任何写路径；mutation 目标：给聚合加写语句 ⇒ 契约测试红 |
| R2 | **canonical form 深链** | 向导从不内嵌复制表单；每步「去配置」= query 形深链跳转到既有 canonical form（§6）；禁止 hash 形（W3 验证 MD 实证 raw-hash 冷加载不恢复区块，既有缺口） |
| R3 | **无副作用 preview** | 模板 = FE 常量预填 + 既有表单保存路径（§5）；向导自身零提交端点；「预览影响范围」只读推演，负向测试断言 preview 期间零 POST/PUT/DELETE |
| R4 | **禁自动开 S7、通知 worker、外发或生产 flag** | §5.4 枚举受禁 flag/开关全清单（env 层 + settings 层）；向导对 `PUT /api/attendance/settings` **整体禁写**（该端点保存即触发重排程与事件——`plugins/plugin-attendance/index.cjs:43053-43058`，任何整包写都可能翻动 enabled 类开关） |

章程同源条款：§4.5 L211「向导不能替用户静默开启 feature flag、通知真实外部人员或修改生产配置」、
§7-Wave4 L350-355（首版禁止清单）、§13-3「不自动改 operator flag」。

## 1. Grounded problem statement（现状，全部对 `6feff1b2b` 实证）

1. **七步无聚合真源。** 全仓唯一 attendance readiness 读端点是 S7-5 的
   `GET /api/attendance-admin/directory-readiness`（`packages/core-backend/src/routes/attendance-admin.ts:392-412`）,
   只覆盖「目录联通」一个维度。组/班次/节假日/规则集/审批流/设置的完备度今天需 5-6 次独立 list
   调用拼装（各端点 `COUNT(*)::int … WHERE org_id=$1` 原料已齐：`index.cjs:37718/39710/32305/30924/41833`）。
   章程 §7-Wave4 L343 明令「不得假设七步都已有统一状态端点」——实证：确实没有。
2. **`AttendanceSetupReadiness.vue` 尚不存在**（章程 §6.2 预留名）；仓内两个貌似相关的抽取组件
   `AttendanceProvisioningSection.vue` / `AttendanceSettingsSection.vue` **未被任何 src import**（死代码，
   运行时对应区块是 `AttendanceView.vue` 内联版本）——本锁不以它们为接缝。
3. **入口接缝已就绪。** 管理中心默认首屏 = 任务首页（`AttendanceView.vue:14389-14396`）；新增 admin
   section 只需注册 `ATTENDANCE_ADMIN_SECTION_IDS`（`useAttendanceAdminRail.ts:12-46`）+ nav items/groups
   （`:168-274`），注册后自动获得 `?section=` 深链、rail、快速跳转。章程 §3.4 L147:「实施入口不得与
   员工日常页面混在同一首屏」——admin 侧入口满足。
4. **「只预填不提交」的机制先例已在。** 同宿主预填→跳转：`prefillRequestFromAnomaly`
   （`AttendanceView.vue:1000`）、`prefillRequestFromRecordTimeline`（`:16051`）直接写 reactive 表单再走
   原保存路径；深链只承载 section id（`AttendanceExperienceView.vue:146-149`），不支持带参——因此模板
   预填必须与表单同宿主完成（§5.2），而非发明新 route 参数。
5. **org 隔离双姿态并存（本锁最大安全决策，OD-W4-1）。** S7-5 端点在 core-backend router，带
   `user_orgs` 成员门（`attendance-admin.ts:367-379`）+ router 级 `rbacGuard('attendance','admin')`（`:386`）；
   而 plugin 配置端点的 org 隔离靠 `getOrgId(req)` 完全信任客户端传入（`index.cjs:6215-6224`），
   `attendance:admin` 是全局权限——A org 受托管理员传 `orgId=B` 即可读 B org 配置计数。
6. **权限失败信号不可复用全局 flag。** `adminForbidden` 是 last-writer-wins（约 90 处成功路径重置，
   W3 审阅实证）；章程 L358 要求「缺配置与权限不足明确区分」⇒ readiness 面必须 per-surface 信号（§4.3）。
7. **对标事实边界。** tracker 中不存在钉钉「首次启用/快速配置」行为的权威记载（全树 grep 实证）；
   仓内可引的只有章程 §2.1 L82 一行判定（「首次配置与管理导航…明显落后，本轮主战场」）。本锁**不**
   凭记忆补写对手细节（§1.2 L47-48 + OD-VX4 双重禁止）。

## 2. Scope

**IN（v1，全部 RATIFY 后方可开工）**：七步 readiness 聚合读端点（R1）；`AttendanceSetupReadiness.vue`
+ 纯逻辑模块 `attendanceSetupReadiness.ts`（判别矩阵完整，分支不埋 template——章程 L267-268）；
四模板 FE 常量 + 预填跳转（R3）；向导入口（admin section + 任务首页 action）；§4.6 页内 values-free 帮助。

**OUT（显式）**：一键跨资源提交、任何「万能保存」后端端点（章程 L354-355）；向导写
`/api/attendance/settings`（R4）；S7/通知/外发/生产 flag 的任何自动变更（R4）；移动端 UA 专项
（沿 Wave 1 已知项口径）；对手行为细节对照（§1-7）；Wave 5 explainability（独立 DATA-CONTRACT 门）。

## 3. 七步合同（章程 §4.5 L202-208 逐字继承）与信号派生矩阵

七步 = ①同步或创建组织人员 → ②创建考勤组并选择人员 → ③选择班制与班次模板 → ④配置允许的打卡方式
→ ⑤关联审批流程 → ⑥配置通知渠道与接收范围 → ⑦预览影响范围并启用。
每步必须显示：完成状态、缺失项、影响人数、计划生效时间、预览入口、修复动作（L210）。

| 步 | 完成信号（values-free 计数/布尔） | 现有原料（file:line） | 修复动作深链（§6，query 形） |
|---|---|---|---|
| ① | `directoryLinked`（S7-5 原样复用）+ `orgActiveMemberCount>0`（**真源 = `user_orgs` 该 org 的 active 成员数**，P2-1：绝不用考勤组成员数——那与步骤②循环依赖） | `attendance-admin.ts:336-360`；`user_orgs` 表（S7-5 门已查同表 `:367-379`） | `attendance-admin-user-access` |
| ② | `groupCount>0 && groupsWithMembers>0` | `index.cjs:37718`（含 member_count 子查询） | `attendance-admin-groups` |
| ③ | `shiftCount>0`；排班制组存在时另需 `hasRotationRules`（`rotationRuleCount>0`，round-2 闭合项） | `index.cjs:39710`；`attendance_rotation_rules`（`index.cjs:14192`） | `attendance-admin-shifts` |
| ④ | `punchPolicyPosture ∈ {default, customized, unknown}`（**values-free posture，`scope=deployment`**——`attendance.settings` 为部署级单键（`index.cjs:135`），保存写入完整 normalized defaults，key 存在≠本组织配置过；posture 由**后端内部语义检查**得出（OD-W4-4=(c)：与 normalized defaults 比对，前端只收枚举）；`default` 显示「待确认」**绝不伪装已配置**，`unknown` fail-closed） | `system_configs key='attendance.settings'`（`index.cjs:135,291-295,13733-13760`） | `attendance-admin-settings` |
| ⑤ | `approvalFlowCount>0`（含 active 判定） | `index.cjs:30924` | `attendance-admin-approval-flows` |
| ⑥ | 经 §4.5 runtime readiness port：`workerEnabled` + `defaultChannelAvailable` + `availableChannelCount` + `orgRecipientBindingReady`（P2-3：历史 delivery 行**不是**配置真源，settings 亦不注册渠道；port 缺失 ⇒ `unknown`） | `AttendanceNotificationDeliveryWorker.ts:370+`（渠道逐个 env-gated、worker 按名路由） | `attendance-admin-notification-deliveries` |
| ⑦ | 前六步全绿 ⇒ `previewReady`；步名 = **「预览影响范围（preview-ready）」**——向导只做只读预览 + 展示**人工 canonical activation checklist**（逐项列出真人要去哪些 canonical 面完成启用），**绝不暗示已启用**（round-2）；影响人数=①②计数派生 | 聚合派生 | （无——预览在向导内，只读） |

判别值域（纯模块判别矩阵的行）：`ready / missing / forbidden / unknown / manual_review_required / db_not_ready`，
且每信号携带 `scope: 'org' | 'deployment'`（全局信号显式标 `deployment`，追加门禁 2）——
`forbidden` 为 per-surface（§4.3），`unknown` fail-closed 显示为「未知，去核查」，绝不显示为已完成
（章程 L232 未知态红线）；`manual_review_required` 显示为「需人工确认」并给出确认入口；`db_not_ready`
对应各端点统一 503 `DB_NOT_READY` 档（`index.cjs:37752` 等）。
**「计划生效时间」逐步来源规则（追加门禁 4 + round-2 结构闭合）**：生效时间入响应结构为逐步 posture
`effectiveTime: {source: <权威来源标识>, posture: 'known'|'undeterminable'}`——有权威来源（如排班生效日、
节假日同步窗口）才 `known`；否则 `undeterminable` 显示「无法确定」，**不得省略、不得猜测**；各步来源在
W4-0 判别矩阵逐行登记。

## 4. Readiness 聚合契约（R1）

**4.1 端点（OD-W4-1 推荐 =(a)）**：`GET /api/attendance-admin/setup-readiness?orgId=…`，落
core-backend `attendance-admin.ts` router——继承 router 级 `rbacGuard('attendance','admin')` + S7-5 同款
`user_orgs` org-membership 门 + 平台 admin 直通（`:367-379` 先例逐字复用）。**不选** plugin 路由：
那将继承「信任客户端 orgId」缺口（§1-5），对一个汇总全 org 配置面的端点不可接受。
**4.2 响应形状（values-free by construction）**：仅布尔与非负整数计数，每信号带 `scope` 标记
`{directoryLinked, orgActiveMemberCount, groupCount, groupsWithMembers, shiftCount, rotationRuleCount,
hasRotationRules, approvalFlowCount, punchPolicyPosture(default|customized|unknown, scope=deployment),
notify:{workerEnabled, defaultChannelAvailable, availableChannelCount, orgRecipientBindingReady},
perStep.effectiveTime:{source, posture(known|undeterminable)}}` ——聚合实现采用**单条 CTE 或短 TTL
org-scoped cache**（owner 非阻断项）——
契约测试断言 SQL 文本不含任何标识列（S7-5 单测先例：`attendance-admin-directory-readiness-s7-5.test.ts:82-191`）,
且响应键集合恒等锁定。错误档：400 `ORG_ID_REQUIRED` / 401 / 403 / 503 `DB_NOT_READY` / 500 泛化文案。
**4.3 权限信号**：端点级 403 = 整面 `forbidden`；不复用 `adminForbidden` 全局 flag（§1-6）。FE 纯模块
将 403 映射为对应步 `forbidden`，与 `missing` 显示语义分离（L358）。
**4.4 读放大**：单次聚合替代 5-6 次 list 调用；GET 不限流（`attendance-production.ts:461-497` 现状），
IP allowlist 对 `/api/attendance-admin/*` 的既有覆盖自动适用。
**4.5 通知 runtime readiness port（P2-3，W4-0 新增，core-backend 只读）**：真实可用性真源 = worker
是否开启 + 默认 channel 是否已注册 + 各 provider env/credential readiness
（`AttendanceNotificationDeliveryWorker.ts:370+` `createAttendanceDeliveryChannelsFromEnv`：渠道逐个
env-gated、default-off、worker 按 `row.channel` 名路由）。port 只回
`{workerEnabled, defaultChannelAvailable, availableChannelCount, orgRecipientBindingReady}` 布尔/计数——
**不回传 env 名、渠道名或凭据**；port 缺失/异常 ⇒ 步骤⑥ = `unknown`，**禁止**由 delivery 行存在性
推断成功。契约测试断言：port 实现零 env 值外泄 + 缺 port 时聚合端点仍 200 且 notify 块为 unknown 档。

## 5. 模板与预填契约（R3/R4）

**5.1 四模板 = FE 常量**（OD-W4-3 推荐）：办公室固定班 / 门店排班 / 工厂多班次 / 销售外勤（OD-VX3
已裁），落 `attendanceSetupTemplates.ts` 纯常量模块——BE 零新增（现有 rule-templates/role-templates
均非其载体，实证 `engine/template-library.cjs:288`；「只预填不提交」使 FE 常量即真源充分）。
**5.2 预填机制（round-2 收紧：模板不得污染共享表单）**：向导与表单同宿主（AttendanceView），模板
选择 = 写既有 reactive 表单（`shiftForm:15251` / `ruleSetForm:15484` / `attendanceGroupForm:15493` /
`holidayForm:15329`）+ `selectAdminSection(目标)` 跳转（`:14593-14601`）——先例
`prefillRequestFromAnomaly` 同型。**强制合同（OD-W4-3 附加条件，owner round-2）**：
①应用模板**前**显示受影响字段清单并确认覆盖（表单已有未保存内容时尤其）；②应用前保存原表单
**快照**，「取消」完整恢复快照；③只承诺恢复**已保存**的资源，未保存预填不承诺刷新后存活；
④模板**时区禁硬编码**——取组织显式时区，取不到则要求用户在预填确认时选择（仍过
`resolveExplicitTimeZoneOrThrow`）。保存仍走各表单既有保存路径与校验（group name 必填等，
`index.cjs:37804-37856`）。**预填值域约束**：模板字段必须满足各表 NOT NULL/枚举（`attendance_type ∈
fixed_shift/scheduled_shift/free_time` 等，migrations 实证）——锁附录 A 列四模板逐字段预填集
（时区列为「组织时区/用户选择」占位，非常量）。
**5.3 preview 无副作用**：⑦步 = 只读预览（聚合读 + 派生展示）+ **人工 canonical activation
checklist**（列出真人逐项去 canonical 面完成的启用动作），UI 文案与状态**绝不暗示「已启用」**
（round-2）；完成门负向测试断言 preview 全程零写请求 + 文案不含「已启用/enabled」类完成时态。
**5.4 受禁开关全清单（R4 执行面）**：env 层（API 不可改，列举以供断言）：`ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`、
`ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED`、`ATTENDANCE_SCHEDULER_ENABLED`、
`ATTENDANCE_AUTO_SHIFT_*`、`ATTENDANCE_REPORT_*` 等（`AttendanceScheduler.ts:311-400`、
`index.cjs:14749-14768` 清单）；settings 层 enabled 键（`autoAbsence/holidaySync.auto/compTimeFromOvertime/
multiShiftDay/annualLeavePolicy/attendanceResultEditPolicy`）——向导对 settings **整体禁写**（§0-R4），
「④打卡方式」的修复动作=深链到 settings 表单由人保存，向导只读存在性。

## 6. 入口与导航合同（R2）

**6.1 注册形态（OD-W4-2 推荐 =(a)+(c)）**：新增 admin section `attendance-admin-setup`（canonical 注册，
自动获得 `?section=attendance-admin-setup` 深链/rail/快速跳转）+ 任务首页 **`people-groups`（人员与
考勤组）组**新增首位 action「启用准备」（button 型 sectionId action，`adminTaskHomeGroups:14452` 内
加一项——**不加第 5 组**，避免 4 列栅格改动 `AttendanceAdminTaskHome.vue:175-179`；任务首页实有四组
= daily-operations / people-groups / work-time-policies / reporting-payroll，归组位置 owner 可在
ratify 时调整）。不做首次进入自动拦截（现状无 first-run 逻辑，
强拦截违背「不与日常混首屏」的克制姿态）。任务首页 action 上的轻量「未完成」提示**来自 readiness
派生（前六步存在非 ready 步 ⇒ 提示），不来自「是否访问过」的本地信号**（P2-4 第 4 点，OD-W4-2(c) 修订）。
**6.2 深链纪律**：向导内七步「去配置/修复」全部 = `selectAdminSection` 或 `?section=` query 深链
（W3 实证契约形态）；禁 hash 形；禁新增 route 参数。中途退出即自然落在 canonical form，无需「恢复」
状态机——向导本身无持久向导态（readiness 是重进即重算的派生，非流程状态）。
**6.3 帮助（OD-VX4 已裁）**：每步页内上下文帮助四类内容（章程 §4.6 L216-225），values-free 红线
逐字继承；不复制外部手册。

## 7. 组件与文件形状

- `apps/web/src/views/attendance/attendanceSetupReadiness.ts`（新，纯模块）：聚合响应 → 七步
  判别矩阵（`ready/missing/forbidden/unknown/db_not_ready` 全值域），零 DOM/零 fetch；
  单测覆盖判别矩阵全行 + mutation 目标（任一判别分支取反 ⇒ 对应腿红）。
- `apps/web/src/views/attendance/AttendanceSetupReadiness.vue`（新，§6.2 预留名）：纯展示
  props（`tr` + steps 数组）+ emit（`select-section`/`open-template`）——AttendanceAdminTaskHome 同型
  （props/emit 先例 `AttendanceAdminTaskHome.vue:105-112`）；tokens.css `--ms-*`（新组件零硬编码 hex，
  不以存量 hex 债为先例）。
- 父层 AttendanceView：readiness 加载/聚合调用/模板预填写入/section 注册（§6.2「留父层」条款）。
- `packages/core-backend/src/routes/attendance-admin.ts`：`setup-readiness` 端点 + 契约单测
  （S7-5 测试同型：状态码矩阵 + SQL values-free 断言 + 响应键集合锁定）。
- guard 接线（§8.1.4）：新 spec 进 run-list 显式 pattern + 双 path filter + 收集证明 + 同命令 mutation。

## 8. Open Decisions（OD-W4）——**owner 2026-07-21 round-2 已全部裁决（DECIDED）**

| OD | 裁决 |
|---|---|
| OD-W4-1 | **(a)** core-backend + `user_orgs` 门；授权检查**先于任何聚合 SQL**；双组织伪造 orgId 真库测试 |
| OD-W4-2 | **(a)**；拒绝 localStorage 首访提示——「未完成」徽标由 readiness 派生 |
| OD-W4-3 | **(a)** + 附加条件：动态时区、覆盖确认、取消快照恢复合同（§5.2） |
| OD-W4-4 | (a)/(b) 均拒；**新增并裁定 (c)**：后端内部语义检查（与 normalized defaults 比对），前端仅收 values-free posture `default/customized/unknown` |
| OD-W4-5 | **(b)**：W2 英文错误串另开小刀，**不混入 W4-0 readiness 安全底座** |
| OD-W4-6 | **(a)**：人员数取 active `user_orgs`；组覆盖数单独取 group membership |
| OD-W4-7 | **修订后的 (a)**：只恢复已持久化进度；未保存预填必须确认、可撤销；不声称刷新后自动恢复 |

原选项菜单保留于下供追溯（推荐值已被上表裁决覆盖）：

- **OD-W4-1 readiness 聚合宿主与 org 门**：(a) core-backend router + `user_orgs` 门（S7-5 姿态）
  （**recommended**，理由 §1-5/§4.1）；(b) plugin 路由 + `withPermission`（与配置端点一致但继承 orgId
  信任缺口）。选 (a) 时显式记录：与 plugin 配置端点姿态不一致是**有意的**（汇总面风险更高）。
- **OD-W4-2 入口形态**：(a) canonical admin section + 任务首页 action（**recommended**）；(b) 仅任务
  首页第 5 组（改栅格）；(c) 轻量首访提示（**recommended 并入 (a)**，仅提示不拦截）；(d) 首次进入
  强拦截（不推荐）。
- **OD-W4-3 模板载体**：(a) FE 常量模块（**recommended**，零 BE 面）；(b) BE 常量端点（不推荐，
  纯读也无必要，且靠近「万能端点」红线）。
- **OD-W4-4 ④/⑥ 步「已配置」判定深度**：(a) 存在性布尔（settings 键已显式保存过 / 渠道配置非空）
  （**recommended**，values-free 且不碰运维值——GET settings 会回传 ipAllowlist/geoFence 等运维值，
  向导 UI 不得透传展示）；(b) 语义校验（更准但需读值，与 values-free 张力）。
- **OD-W4-5 W2 已知项处置**（规则卡透传英文 API 错误串，新 synthetic org 必现）：(a) Wave 4 首个
  runtime 切片顺手 i18n 化该错误面（**recommended**，一次性小diff，避免向导 readiness 面首屏出现
  英文错误串）；(b) 记 deferred 继续留已知项。
- **OD-W4-6 影响人数口径**：(a) `memberCount`/`groupsWithMembers` 派生的计数（**recommended**）；
  (b) 逐用户名单预览（不推荐，与 values-free 及只读面冲突）。
- **OD-W4-7 中途退出恢复合同**（章程 L358 读法，owner P2-4 四点合同，(a) **recommended**）：
  (a) **四点合同**——①已保存进度由 readiness 重算恢复（无持久向导态）；②**未保存表单不承诺恢复**，
  离开向导预填未保存时给离开前提示（beforeunload/切区确认）；③若保存模板选择，只存模板 ID，
  存储 key **必须含 `userId + orgId`**（防多用户/多组织串状态）；④「未完成」提示来自 readiness，
  不来自访问史。W4-1 完成门断言：中途退出→重进 ⇒ 判别矩阵与直接重算逐项一致 + 未保存离开提示
  真实弹出 + 存储 key 含双 id 的负向测试（换 user/org ⇒ 互不可见）。
  (b) 持久向导态（不推荐——引入新状态真源，与 R1 及无流程状态机设计相悖）。

## 9. 切片（严格串行，全部 RATIFY 后开工；每片完成门 = 章程 §8.1 十一门 + 本锁红线负向断言 + Opus 对抗审 0 P1/P2 + PR 门禁记录）

- **W4-0 readiness 底座**：纯模块 + `setup-readiness` 端点 + §4.5 通知 readiness port + 契约/判别
  矩阵测试。红线与追加门禁断言（owner round-1）：R1 + §4.3 per-surface 403 + **两组织真库矩阵**
  （A org 管理员伪造 `orgId=B` ⇒ 在任何聚合 SQL 执行前 403）+ **计数 SQL 逐项含 `org_id=$1` 审计**
  （全局信号显式 `scope=deployment`）+ **query seam 只接受 SELECT**（写语句 mutation ⇒ 契约测试
  精确翻红）+ 生效时间来源逐行登记。**W4-0 无 UI：三视口门标 N/A**（视觉证据从 W4-1 起，
  避免形式化假验收——owner 追加门禁 5）。
- **W4-1 向导壳与七步导航**：`AttendanceSetupReadiness.vue` + section 注册 + 任务首页 action + 帮助。
  红线断言：R2（深链全 query 形，负向：hash 导航零出现）+ §3 未知态 fail-closed 显示。
- **W4-2 模板预填 + ⑦预览**：模板常量 + 预填跳转 + 预览派生。红线断言：R3（preview 期零写请求）+
  R4（受禁开关全清单的「向导不触碰」负向测试：mock 层断言向导交互全程对 settings PUT / flag 类端点
  零调用）。
- 每片三视口证据（1440/1024/390，拍前真在场断言 + 目检）+ 波次验证 MD；§9 指标（20 分钟到
  preview-ready，无 JSON/内部 ID）在 W4-2 收口用合成 org 实测。

## 10. 完成定义与 ratify 流程

**完成定义**：三切片全合 + 验证 MD 在 main + §9 指标合成实测记录 + 红线四条各有存活的负向断言。
本锁不改变：S7 flag 默认 OFF、真实租户视觉复核等 operator 项（owner 裁决⑥，不计 UI 完成度）。

**预写 ratify 收尾序**（#4370 先例逐字）：①锁分支刷新至最新 main（drift 复核）→ ②PROPOSED→RATIFIED
（记录 OD-W4-1..7 裁决与日期）→ ③章程 §15 Wave 4 行同步（DESIGN-LOCK-GATED → RATIFIED / landing）
→ ④转 ready 等 fresh required checks 全绿合并 → ⑤从合并后 main 开 W4-0。

## §11.1 六项记录（章程 L459-468）

1. 基线 SHA：`6feff1b2b`（origin/main，Wave 0-3 收档后）。
2. 查重：`git log origin/main` + 全仓 grep `readiness/setup/onboarding`——无既有七步聚合、无
   `AttendanceSetupReadiness.vue`、无冲突在飞分支（本锁分支独占）。
3. 修改文件：本 PR 仅本文档（docs-only）；未来切片碰撞车道 = `AttendanceView.vue`（单热文件串行，
   与 Wave 5 不并开——owner 裁决⑤）。
4. IN/OUT：§2。
5. 权威数据源/唯一写路径/权限真源：readiness 真源 = `setup-readiness` 聚合（各计数 SQL 单点）；
   向导零写路径（唯一写 = 既有表单各自的保存端点）；权限真源 = router 级 rbacGuard + `user_orgs` 门。
6. 完成门与 mutation 目标：§9 各片列出；对抗审 0 P1/P2 每片必过。

## 附录 A：四模板预填字段集（满足表约束的最小合法集）

| 模板 | attendance_type | 预填示例字段（全部走既有表单校验） |
|---|---|---|
| 办公室固定班 | `fixed_shift` | 组名、时区=组织时区/用户选择、班次 09:00-18:00、working_days [1..5]、宽限 10/10 |
| 门店排班 | `scheduled_shift` | 组名、时区=组织时区/用户选择、早/晚两班次模板、轮班规则提示（③ hasRotationRules 信号联动） |
| 工厂多班次 | `scheduled_shift` | 组名、时区、三班次模板、跨夜 is_overnight 示例 |
| 销售/外勤 | `free_time` | 组名、时区、外勤打卡方式提示（深链 settings 表单，不代存） |

（字段值为预填示例，不代表保存；保存校验以各表单/端点现行规则为准——`index.cjs:37804-37856` 等。）
