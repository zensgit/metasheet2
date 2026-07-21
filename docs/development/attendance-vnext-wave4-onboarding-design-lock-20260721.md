# 考勤 vNext Wave 4 · 首次启用向导（onboarding）design-lock — 2026-07-21

> **Status: PROPOSED — docs-only，不授权任何 runtime。** owner 2026-07-21 裁决原文授权范围 =
> 「只读侦察 + docs-only design-lock，暂不授权 runtime」。本锁不改任何代码、不建端点、不动 flag；
> runtime 切片只有在 owner RATIFY 本锁之后按 §9 切片序逐一开工。Wave 5（explainability）保持
> DATA-CONTRACT-GATED，且按同一裁决**不与 Wave 4 runtime 并开**。
> 上位文档：`attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`
> （RATIFIED；§4.5/§4.6/§6.2/§7-Wave4/§9/§13-3/§15），OD-VX3/OD-VX4 已按推荐值 ratify。
> 基线 = `origin/main` `6feff1b2b`（Wave 0-3 已收档，3/3 波次验证 MD 在 main）。

---

## 0. Owner 四条红线（一等公民，覆盖本锁一切条款）

owner 2026-07-21 裁决原文，逐条落为 v1 硬边界；每个 runtime 切片的完成门必须含对应负向断言：

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

七步 = ①同步/创建组织人员 → ②创建考勤组并选择人员 → ③选择班制与班次模板 → ④配置允许的打卡方式
→ ⑤关联审批流程 → ⑥配置通知渠道与接收范围 → ⑦预览影响范围并启用。
每步必须显示：完成状态、缺失项、影响人数、计划生效时间、预览入口、修复动作（L210）。

| 步 | 完成信号（values-free 计数/布尔） | 现有原料（file:line） | 修复动作深链（§6，query 形） |
|---|---|---|---|
| ① | `directoryLinked`（S7-5 原样复用）+ `memberCount>0` | `attendance-admin.ts:336-360`；groups members 计数 | `attendance-admin-user-access` |
| ② | `groupCount>0 && groupsWithMembers>0` | `index.cjs:37718`（含 member_count 子查询） | `attendance-admin-groups` |
| ③ | `shiftCount>0`（排班制另加 rotation 存在） | `index.cjs:39710` | `attendance-admin-shifts` |
| ④ | 打卡方式设置已显式保存过（settings 键存在性,非值） | `system_configs key='attendance.settings'`（`index.cjs:291-295,13733-13760`） | `attendance-admin-settings` |
| ⑤ | `approvalFlowCount>0`（含 active 判定） | `index.cjs:30924` | `attendance-admin-approval-flows` |
| ⑥ | 通知渠道配置存在性布尔（**不回传渠道值**） | deliveries/settings 存在性 | `attendance-admin-notification-deliveries` |
| ⑦ | 前六步全 `ready` ⇒ `previewReady`；影响人数=①②计数派生 | 聚合派生 | （无——预览在向导内，只读） |

判别值域（纯模块判别矩阵的行）：`ready / missing / forbidden / unknown / db_not_ready`——
`forbidden` 为 per-surface（§4.3），`unknown` fail-closed 显示为「未知，去核查」，绝不显示为已完成
（章程 L232 未知态红线）；`db_not_ready` 对应各端点统一 503 `DB_NOT_READY` 档（`index.cjs:37752` 等）。

## 4. Readiness 聚合契约（R1）

**4.1 端点（OD-W4-1 推荐 =(a)）**：`GET /api/attendance-admin/setup-readiness?orgId=…`，落
core-backend `attendance-admin.ts` router——继承 router 级 `rbacGuard('attendance','admin')` + S7-5 同款
`user_orgs` org-membership 门 + 平台 admin 直通（`:367-379` 先例逐字复用）。**不选** plugin 路由：
那将继承「信任客户端 orgId」缺口（§1-5），对一个汇总全 org 配置面的端点不可接受。
**4.2 响应形状（values-free by construction）**：仅布尔与非负整数计数
`{directoryLinked, memberCount, groupCount, groupsWithMembers, shiftCount, approvalFlowCount, punchSettingsSaved, notifyConfigured, …}` ——
契约测试断言 SQL 文本不含任何标识列（S7-5 单测先例：`attendance-admin-directory-readiness-s7-5.test.ts:82-191`）,
且响应键集合恒等锁定。错误档：400 `ORG_ID_REQUIRED` / 401 / 403 / 503 `DB_NOT_READY` / 500 泛化文案。
**4.3 权限信号**：端点级 403 = 整面 `forbidden`；不复用 `adminForbidden` 全局 flag（§1-6）。FE 纯模块
将 403 映射为对应步 `forbidden`，与 `missing` 显示语义分离（L358）。
**4.4 读放大**：单次聚合替代 5-6 次 list 调用；GET 不限流（`attendance-production.ts:461-497` 现状），
IP allowlist 对 `/api/attendance-admin/*` 的既有覆盖自动适用。

## 5. 模板与预填契约（R3/R4）

**5.1 四模板 = FE 常量**（OD-W4-3 推荐）：办公室固定班 / 门店排班 / 工厂多班次 / 销售外勤（OD-VX3
已裁），落 `attendanceSetupTemplates.ts` 纯常量模块——BE 零新增（现有 rule-templates/role-templates
均非其载体，实证 `engine/template-library.cjs:288`；「只预填不提交」使 FE 常量即真源充分）。
**5.2 预填机制**：向导与表单同宿主（AttendanceView），模板选择 = 写既有 reactive 表单
（`shiftForm:15251` / `ruleSetForm:15484` / `attendanceGroupForm:15493` / `holidayForm:15329`）+
`selectAdminSection(目标)` 跳转（`:14593-14601`）——先例 `prefillRequestFromAnomaly` 同型。保存仍走
各表单既有保存路径与校验（group name 必填、timezone 过 `resolveExplicitTimeZoneOrThrow` 等，
`index.cjs:37804-37856`）。**预填值域约束**：模板字段必须满足各表 NOT NULL/枚举（`attendance_type ∈
fixed_shift/scheduled_shift/free_time` 等，migrations 实证）——锁附录 A 列四模板逐字段预填集。
**5.3 preview 无副作用**：⑦步预览 = 聚合读 + 派生展示；完成门负向测试断言 preview 全程零写请求。
**5.4 受禁开关全清单（R4 执行面）**：env 层（API 不可改，列举以供断言）：`ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`、
`ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED`、`ATTENDANCE_SCHEDULER_ENABLED`、
`ATTENDANCE_AUTO_SHIFT_*`、`ATTENDANCE_REPORT_*` 等（`AttendanceScheduler.ts:311-400`、
`index.cjs:14749-14768` 清单）；settings 层 enabled 键（`autoAbsence/holidaySync.auto/compTimeFromOvertime/
multiShiftDay/annualLeavePolicy/attendanceResultEditPolicy`）——向导对 settings **整体禁写**（§0-R4），
「④打卡方式」的修复动作=深链到 settings 表单由人保存，向导只读存在性。

## 6. 入口与导航合同（R2）

**6.1 注册形态（OD-W4-2 推荐 =(a)+(c)）**：新增 admin section `attendance-admin-setup`（canonical 注册，
自动获得 `?section=attendance-admin-setup` 深链/rail/快速跳转）+ 任务首页「基础配置」组新增首位 action
「启用准备」（button 型 sectionId action，`adminTaskHomeGroups:14452` 内加一项——**不加第 5 组**，避免
4 列栅格改动 `AttendanceAdminTaskHome.vue:175-179`）。不做首次进入自动拦截（现状无 first-run 逻辑，
强拦截违背「不与日常混首屏」的克制姿态；localStorage 首访信号仅用于任务首页 action 上的轻量「未完成」
提示，OD-W4-2(c)）。
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

## 8. Open Decisions（OD-W4，含推荐值；ratify 即按推荐值锁定，除非 owner 明改）

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

## 9. 切片（严格串行，全部 RATIFY 后开工；每片完成门 = 章程 §8.1 十一门 + 本锁红线负向断言 + Opus 对抗审 0 P1/P2 + PR 门禁记录）

- **W4-0 readiness 底座**：纯模块 + `setup-readiness` 端点 + 契约/判别矩阵测试。红线断言：R1（端点
  零写路径 mutation）+ §4.3 per-surface 403。
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
（记录 OD-W4-1..6 裁决与日期）→ ③章程 §15 Wave 4 行同步（DESIGN-LOCK-GATED → RATIFIED / landing）
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
| 办公室固定班 | `fixed_shift` | 组名、时区 Asia/Shanghai、班次 09:00-18:00、working_days [1..5]、宽限 10/10 |
| 门店排班 | `scheduled_shift` | 组名、时区、早/晚两班次模板、轮班提示 |
| 工厂多班次 | `scheduled_shift` | 组名、时区、三班次模板、跨夜 is_overnight 示例 |
| 销售/外勤 | `free_time` | 组名、时区、外勤打卡方式提示（深链 settings 表单，不代存） |

（字段值为预填示例，不代表保存；保存校验以各表单/端点现行规则为准——`index.cjs:37804-37856` 等。）
