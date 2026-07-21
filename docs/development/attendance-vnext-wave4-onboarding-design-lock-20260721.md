# 考勤 vNext Wave 4 · 首次启用向导（onboarding）design-lock — 2026-07-21

> **Status: PROPOSED — docs-only，不授权任何 runtime。** owner 2026-07-21 裁决原文授权范围 =
> 「只读侦察 + docs-only design-lock，暂不授权 runtime」。本锁不改任何代码、不建端点、不动 flag；
> runtime 切片只有在 owner RATIFY 本锁之后按 §9 切片序逐一开工。Wave 5（explainability）保持
> DATA-CONTRACT-GATED，且按同一裁决**不与 Wave 4 runtime 并开**。
> 上位文档：`attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`
> （RATIFIED；§4.5/§4.6/§6.2/§7-Wave4/§9/§13-3/§15），OD-VX3/OD-VX4 已按推荐值 ratify。
> 基线 = `origin/main` `1f06ecea9`（round-3 漂移刷新后；原 `6feff1b2b` → 现 `1f06ecea9`，
> 区间仅 2 个提交 `e91d20e5c` / `1f06ecea9`，均未触碰任何 attendance 文件——`git diff --stat 6feff1b2b 1f06ecea9`
> 对 `plugins/plugin-attendance/index.cjs`、`packages/core-backend/src/{routes,services}/attendance*`、
> `apps/web/src/views/attendance*` 全空。Wave 0-3 已收档，3/3 波次验证 MD 在 main）。
>
> **Amendment round-1（2026-07-21，owner 审阅 = CHANGES REQUESTED，0 P1 / 4 P2 + 五条追加门禁；
> 措辞取自 owner 审阅原文）**：P2-1 步骤① memberCount 真源改 `user_orgs`（原考勤组成员数与步骤②
> 循环依赖）→ §3①/§4.2；P2-2 步骤④ `attendance.settings` 为部署级单键（`index.cjs:291`
> SETTINGS_KEY 无 org 维度，保存写入完整 normalized defaults；**round-3 漂移刷新：原引 `index.cjs:135`
> 为错误锚点**，135 行是审批步骤解析，与 settings 无关）——「key 存在」会跨组织假绿 →
> 重定义为「平台级打卡策略已显式确认」+ `scope=deployment` 显式标记，无法证明人工确认 ⇒
> `manual_review_required`，绝不 `ready`（§3④/§4.2）；P2-3 步骤⑥历史 delivery 行非配置真源 →
> 新增 core-backend 只读 runtime readiness port（当时字段 = `workerEnabled/defaultChannelAvailable/
> availableChannelCount/orgRecipientBindingReady`，仅布尔/计数；port 缺失 ⇒ `unknown`，禁由
> delivery 存在性推断）（§4.5）——**这组字段已被 round-3 P2-2 整体删除并改为三信号，此处仅存历史，
> 实施以 §4.2/§4.5 现行形状为准**；P2-4 恢复合同与「无向导态」矛盾 → OD-W4-7 重写为四点恢复合同
> （已保存=readiness 重算恢复 / 未保存不承诺+离开提示 / 模板选择只存 ID 且 key 含 userId+orgId /
> 「未完成」提示来自 readiness 非访问史）。追加门禁五条入 §9。owner 核心判断维持：core-backend
> 聚合 + user_orgs 门方向正确；①④⑥真源修正后 OD-W4-1..7 方可提交 ratify。
>
> **Amendment round-2（2026-07-21，owner 复审 + OD-W4-1..7 全套裁决，措辞取自 owner 原文）**：
> ④再收紧为 values-free posture 枚举 `default / customized / unknown`（scope=deployment，default 显示
> 「待确认」绝不伪装组织已配置）+ OD-W4-4 新增并裁定 (c)「后端内部语义检查、前端仅收 values-free
> posture」；模板预填补**覆盖确认 + 原表单快照 + 取消完整恢复**合同（OD-W4-3 附加条件）；③补
> `rotationRuleCount/hasRotationRules`（排班制信号闭合，原料 `attendance_rotation_rules` 的 org-scoped
> COUNT `index.cjs:31186-31189`；**round-3 漂移刷新：原引 `index.cjs:14192` 为错误锚点**——那是旧班次
> 改名的兼容 helper，不是计数原料）；每步「计划生效时间」入响应结构为 posture；⑦更名 **preview-ready + 人工
> canonical activation checklist**（绝不暗示已启用）；模板时区禁硬编码（取组织显式时区，取不到要求
> 用户选择）。OD 裁决全录 §8；两非阻断项（聚合单 CTE 或短 TTL org-scoped cache；§10 编号 1..7）
> 已吸收。owner：修订完成并再次核对后方建议 PROPOSED → RATIFIED。
>
> **Amendment round-3（2026-07-21，owner 复审 = CHANGES_REQUESTED，0 P1 / 5 P2 + 基线漂移刷新；
> 措辞取自 owner 原文）**：
> **P2-1 ④步闭环**——posture 比对必须只比**打卡策略闭集**（整包 normalized 比对会被无关设置误判为
> `customized`；实证：`performHolidaySync` 经 `saveSettings` 机器写 `holidaySync.lastRun`，
> `index.cjs:11888-11894`），闭集在 §3④ 逐键点名；且**显式裁定 `manual_review_required`/`default`
> 不阻断 preview-ready**（owner 二选一里取后者，理由：前者要新增写面，与 R4「向导整体禁写」及章程
> §7-Wave4 L351-355 首版禁止清单相撞）→ §3④/§3⑦/§4.2/§9。
> **P2-2 ⑥步拆三信号**——今天的深链是投递**历史**（只读，`AttendanceView.vue:1722-1737` 自带
> 「仅读取 C5 outbox 的投递真实状态」文案），per-org/per-recipient 偏好是 FUTURE 设计
> （`AttendanceNotificationDeliveryWorker.ts:202-207`），二者不等价；`workerEnabled` 单读 env 不足以
> 证明「调度器真的起来了且投递作业已注册」→ 字段**删除**，改为 (i) 部署运行期就绪 / (ii) 组织收件人
> 绑定覆盖 / (iii) 收件范围配置 = `unsupported` → §3⑥/§4.2/§4.5。
> **P2-3 ①步本地组织误判**——章程原文「同步**或**创建」是 OR 语义；完成真值 = `orgActiveMemberCount>0`，
> `directoryLinked` 降为来源/能力 posture，不参与完成判定；切片门加**两个正控**（纯本地组织 /
> 钉钉已联通组织）→ §3①/§4.2/§9。
> **P2-4 安全门测试身份与只读证明**——「A org 管理员」写死为**仅持 `attendance:admin`、是 A org 成员
> 且不是 B org 成员的受托管理员**（平台 admin 依设计绕开 `user_orgs`，`attendance-admin.ts:373`，
> 只能当**单列标注的旁路对照**）；SELECT-only 证明**禁**首词匹配/正则，改为 **Postgres 只读事务**结构约束，
> 并补 **writable CTE** 与 **多语句 `SELECT; DELETE`** 两条必拒测试 → §4.2/§9。
> **P2-5 单一真源收口**——§5.4「向导只读存在性」改为 OD-W4-4(c) 后端语义检查；§8 历史选项菜单整块降为
> **非规范附录（已被裁决取代）**并删除全部 recommended 标记；§7 值域补 `manual_review_required`/
> `unsupported`；§9「每片三视口」改为 W4-1/W4-2（W4-0 三视口 N/A）；§3 七步句 ⑦ 去「并启用」并标注
> 章程原文差异。
> **漂移刷新**：基线 `6feff1b2b` → `1f06ecea9`，全文 `file:line` 锚点逐条重开，勘误清单见 §11.1 附表；
> §11.1 查重对新 main 重跑。owner 已 DECIDED 的 OD-W4-1..7 裁决本轮**不重议**。

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
§7-Wave4 L351-355（首版禁止清单）、§13-3「不自动改 operator flag」。

## 1. Grounded problem statement（现状，全部对 `1f06ecea9` 实证）

1. **七步无聚合真源。** 全仓唯一 attendance readiness 读端点是 S7-5 的
   `GET /api/attendance-admin/directory-readiness`（`packages/core-backend/src/routes/attendance-admin.ts:392-412`）,
   只覆盖「目录联通」一个维度。组/班次/节假日/规则集/审批流/设置的完备度今天需 5-6 次独立 list
   调用拼装（各端点 `COUNT(*)::int … WHERE org_id=$1` 原料已齐，round-3 逐条重开后的准确锚点：
   考勤组 `index.cjs:37720`、班次 `:39710`、规则集 `:32306`、审批流 `:30924-30926`、
   排班规则 `:31186-31189`、节假日 `:41835-41837`）。
   章程 §7-Wave4 L343 明令「不得假设七步都已有统一状态端点」——实证：确实没有。
2. **`AttendanceSetupReadiness.vue` 尚不存在**（章程 §6.2 预留名）；仓内两个貌似相关的抽取组件
   `AttendanceProvisioningSection.vue` / `AttendanceSettingsSection.vue` **未被任何 src import**（死代码，
   运行时对应区块是 `AttendanceView.vue` 内联版本）——本锁不以它们为接缝。
3. **入口接缝已就绪。** 管理中心默认首屏 = 任务首页（`apps/web/src/views/AttendanceView.vue:14390-14397`
   `hasExplicitAdminSectionTarget()` + `adminTaskHomeOpen = ref(!hasExplicitAdminSectionTarget())`；
   注意宿主文件在 `views/` 根，不在 `views/attendance/`）；新增 admin
   section 只需注册 `ATTENDANCE_ADMIN_SECTION_IDS`（`useAttendanceAdminRail.ts:12-46`）+ nav items/groups
   （`:168-274`），注册后自动获得 `?section=` 深链、rail、快速跳转。章程 §3.4 L147:「实施入口不得与
   员工日常页面混在同一首屏」——admin 侧入口满足。
4. **「只预填不提交」的机制先例已在。** 同宿主预填→跳转：`prefillRequestFromAnomaly`
   （`AttendanceView.vue:1000`）、`prefillRequestFromRecordTimeline`（`:16051`）直接写 reactive 表单再走
   原保存路径；深链只承载 section id（`AttendanceExperienceView.vue:146-149`），不支持带参——因此模板
   预填必须与表单同宿主完成（§5.2），而非发明新 route 参数。
5. **org 隔离双姿态并存（本锁最大安全决策，OD-W4-1）。** S7-5 端点在 core-backend router，带
   `user_orgs` 成员门（`packages/core-backend/src/routes/attendance-admin.ts:367-379`）+ router 级
   `rbacGuard('attendance','admin')`（`:386`）；而 plugin 配置端点的 org 隔离靠 `getOrgId(req)` 完全
   信任客户端传入（`plugins/plugin-attendance/index.cjs:6215-6223`：`req.body.orgId ?? req.query.orgId ??
   user.orgId ?? user.workspaceId ?? x-org-id` 依次取值，无成员校验），`attendance:admin` 是全局权限
   ——A org 受托管理员传 `orgId=B` 即可读 B org 配置计数。
   **平台 admin 依设计绕开该门（P2-4 关键）**：`canReadAttendanceDirectoryReadiness` 在查 `user_orgs`
   **之前**先 `if (hasLegacyAdminClaim(req) || await isRbacAdmin(userId)) return true`
   （`attendance-admin.ts:373`）——因此用平台 admin 跑跨组织矩阵**不能证明 org 门存在**，只能作为
   单列标注的旁路对照（§9 W4-0 门）。
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

## 3. 七步合同（章程 §4.5 L202-208；①-⑥ 逐字继承，⑦ 见下方显式差异登记）与信号派生矩阵

七步 = ①同步**或**创建组织人员 → ②创建考勤组并选择人员 → ③选择班制与班次模板 → ④配置允许的打卡方式
→ ⑤关联审批流程 → ⑥配置通知渠道与接收范围 → ⑦**预览影响范围（preview-ready，只读）**。
每步必须显示：完成状态、缺失项、影响人数、计划生效时间、预览入口、修复动作（L210）。

**逐字继承的范围与两处显式差异（P2-3 / P2-5e）**：①-⑥ 逐字继承章程 §4.5 L202-207；两处差异登记如下，
不得当作转写失真——
- **①「同步或创建」= OR 语义**（章程 L202 原文）：完成真值 = `orgActiveMemberCount>0`，
  `directoryLinked` 只是**来源/能力 posture**、不参与完成判定。纯本地组织（人员经 LOCAL provider 直接建，
  无任何外部目录）在 `user_orgs` 有 active 成员却无 `directory_account_links` 行——实证：`user_orgs`
  由 `users` 全量回填、与目录无耦合（`packages/core-backend/src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts:33-40`），
  而 `provider='local'` 是一等公民 provider（`…/zzzz20260717100000_create_directory_department_bindings.ts:22-23`
  的 `local_provider='local' AND remote_provider<>'local'` CHECK）。若用 AND 判定，这类组织**永远不会转绿**。
- **⑦ 章程 L208 原文作「预览影响范围并启用」；本锁按 round-2 裁决把 ⑦ 收敛为 preview-only**
  （向导只做只读预览 + 展示人工 canonical activation checklist，绝不暗示已启用，见 §5.3 与 R3/R4）。
  引用保持，语义差异在此显式登记。
- **⑥ 步名逐字保留章程 L207「配置通知渠道与接收范围」，但其中「接收范围」部分今天 = `unsupported`**
  （P2-2）：按组织/按收件人配置接收范围**在仓内不存在**，深链落到的是只读投递历史面。步名不改，
  但 readiness 信号与文案必须如实反映这一点（§3⑥/§4.5(iii)）——不得给出一个不存在的修复动作。

| 步 | 完成信号（values-free 计数/布尔） | 现有原料（file:line） | 修复动作深链（§6，query 形） |
|---|---|---|---|
| ① | **完成真值 = `orgActiveMemberCount>0`**（真源 = `user_orgs` 该 org 的 active 成员数，P2-1：绝不用考勤组成员数——那与步骤②循环依赖）；`directoryLinked` **仅为来源/能力 posture，不参与完成判定**（P2-3，OR 语义见上） | `user_orgs`（S7-5 门查同表：`attendance-admin.ts:375`）；`directoryLinked` 复用 `readOrgDirectoryReadiness`（`attendance-admin.ts:336-360`，EXISTS-only） | `attendance-admin-user-access` |
| ② | `groupCount>0 && groupsWithMembers>0` | `index.cjs:37720`（`COUNT(*)::int … FROM attendance_groups WHERE org_id=$1`；同端点列表带 member_count 子查询） | `attendance-admin-groups` |
| ③ | `shiftCount>0`；排班制组存在时另需 `hasRotationRules`（`rotationRuleCount>0`，round-2 闭合项） | `index.cjs:39710`（attendance_shifts COUNT）；`index.cjs:31186-31189`（attendance_rotation_rules 的 org-scoped COUNT，带 `is_active` 过滤） | `attendance-admin-shifts` |
| ④ | `punchPolicyPosture ∈ {default, customized, unknown}`（**values-free posture，`scope=deployment`**，比对范围 = 下方**打卡策略闭集**且仅此闭集；posture 由**后端内部语义检查**得出（OD-W4-4=(c)：闭集逐键与 normalized defaults 比对，前端只收枚举）；`default` 显示「待确认」**绝不伪装已配置**，`unknown` fail-closed；**`default`/`manual_review_required` 均不阻断 ⑦ preview-ready**，见下「闭环裁决」） | `system_configs key='attendance.settings'`：SETTINGS_KEY `index.cjs:291`、`DEFAULT_SETTINGS` `:295-512`、`loadSettings` `:13715-13725`、`saveSettings` `:13749-13759`（单键、无 org 维度、写入完整 normalized 结果） | `attendance-admin-settings` |
| ⑤ | `approvalFlowCount>0`（含 active 判定） | `index.cjs:30924-30926` | `attendance-admin-approval-flows` |
| ⑥ | **三个互不等价的信号（P2-2，不得合并）**：(i) `deliveryRuntime ∈ {ready, not_ready, unknown}`（部署运行期就绪）；(ii) `orgRecipientBinding: {boundRecipientCount, hasAnyBoundRecipient}`（组织收件人绑定覆盖）；(iii) `recipientScopeConfig = 'unsupported'`（收件范围配置——**今天不存在该能力**，恒为 `unsupported`，不得显示为「未配置/去配置」）。判据与真源见 §4.5 | (i) `AttendanceScheduler.ts:310-320/399-412` + `packages/core-backend/src/index.ts:2482-2492`；(ii) `AttendanceNotificationDeliveryWorker.ts:484-501`（directory_account_links ⋈ directory_accounts ⋈ directory_integrations）；(iii) `AttendanceNotificationDeliveryWorker.ts:202-207`（per-org/per-recipient 路由是 design-lock §3 **follow-up**，非现状） | `attendance-admin-notification-deliveries`（**只读投递历史**，`AttendanceView.vue:1722-1737`：「仅读取 C5 outbox 的投递真实状态」；深链文案必须写「查看投递历史」，**不得**写「配置接收范围」） |
| ⑦ | **`previewReady` = ①②③⑤ 四步全 `ready`**；④⑥ 为 advisory，**不参与** previewReady 判定（闭环裁决，见下）；步名 = **「预览影响范围（preview-ready）」**——向导只做只读预览 + 展示**人工 canonical activation checklist**（逐项列出真人要去哪些 canonical 面完成启用，④ 的 posture 与 ⑥ 的三信号**必然逐项出现在该 checklist 上**），**绝不暗示已启用**（round-2）；影响人数=①②计数派生 | 聚合派生 | （无——预览在向导内，只读） |

### 3.1 ④步「打卡策略闭集」——逐键点名（P2-1，实现者不得再自行推导）

`DEFAULT_SETTINGS` 有 **24 个顶层键**（`index.cjs:296-511`），`normalizeSettings` 一次性重建全部 24 键
（`index.cjs:12549-12673`）。**整包比对必然误判**：`performHolidaySync` 在同步成功后经 `saveSettings`
把 `holidaySync.lastRun` 写回同一个键（`index.cjs:11888-11894`，由 `scheduleHolidaySync` `:20474/:20500`
定时触发）——那是**机器写**，不是管理员配置；整包比对会仅仅因为「后台跑过一次节假日同步」就把 ④ 报成
`customized`。年假、报表摘要、加班银行等同理。

**闭集判据（一句话）：闭集 = 打卡请求路径实际读取的 settings 键，其他一律排除**——真源是唯一的打卡
约束函数 `enforcePunchConstraints`（`index.cjs:20264-20310`，仅被 `POST /api/attendance/punch`
`:25348` 于 `:25380` 调用）与同路由的排班日校验 `:25418-25422`。

| 闭集成员（IN，4 键） | 定义处 | 打卡路径读取处 | 纳入理由（一句） |
|---|---|---|---|
| `punchPolicy` | `index.cjs:348-352`（组注释 `:345-347` 自称「打卡策略组 (punch-policy group) — shared foundation (design-lock #2203 / S0)」） | `:20280`（outdoor.requireApproval）、`:25420`（unscheduled.mode）、`:18573`（merge） | 该组三个子树 unscheduled/merge/outdoor 就是「允许的打卡方式」本身 |
| `ipAllowlist` | `:330` | `:20265-20270`（`IP_RESTRICTED`，拒打卡） | 打卡请求的网络边界，即「允许从哪儿打卡」 |
| `geoFence` | `:331` | `:20277-20283`（`LOCATION_RESTRICTED`，拒打卡） | 打卡请求的地理边界，即「允许在哪儿打卡」 |
| `minPunchIntervalMinutes` | `:332` | `:20289-20308`（`PUNCH_TOO_SOON`，拒打卡） | 打卡动作本身的频率约束 |

**排除（OUT）及理由（各一句）**：`annualLeavePolicy`（`:385` 年假余额引擎，与打卡动作无关）、
`compTimeFromOvertime`（`:377` 加班转调休授予）、`formula`（`:359` 报表公式别名）、
`holidayPolicy`（`:301` 节假日工时/加班计算口径）、`holidaySync`（`:314` 节假日数据同步，且含机器写
`lastRun`）、`calendarPolicy`（`:311` 工作日日历覆盖）、`multiShiftDay`（`:355` 一天多班次排班能力）、
`comprehensiveHours`（`:365` 综合工时上限）、`shiftEditPolicy`（`:333` 排班编辑窗口）、
`shiftCompliance`（`:339` 排班合规上限）、`autoAbsence`（`:296` 缺勤补记作业）、
`overtimeSegmentation`（`:405`）/`overtimeBankPolicy`（`:412`）/`leaveBalanceDeductionPolicy`（`:420`）/
`attendanceBonusPolicy`（`:425`）（均为加班与结算口径）、`attendanceReportDigestPolicy`（`:433` 报表订阅）、
`makeupPunchPolicy`（`:446` **补卡申请**配额与窗口——走的是申请/审批路径即步骤⑤，不是打卡时的「打卡方式」）、
`attendanceResultEditPolicy`（`:475` 异常结果编辑护栏）、`autoShiftMatching`（`:483` 自动排班匹配）、
`reportSync`（`:504` 报表同步）。共 20 键排除，4 键纳入，24 键账平。
**契约测试**：闭集常量与 `DEFAULT_SETTINGS` 顶层键集合做**对账断言**（IN∪OUT 恒等于全键集，任一键新增
未归类 ⇒ 红），确保新增 settings 键不会被静默算进 ④。

### 3.2 ④/⑥ 的闭环裁决（P2-1，owner 二选一取「不阻断」）

`attendance.settings` 是**部署级单键、无任何确认时间戳/确认人字段**，因此「管理员已显式接受默认策略」
在今天**没有持久真源**；本锁**不**新增确认写面（owner 选项 A），因为那要么改这个单键、要么另建写路径，
两者都与 R4「向导对 settings 整体禁写」及章程 §7-Wave4 L351-355 首版禁止清单相撞。
**故取 owner 选项 B 并写死**：

> **`manual_review_required`（以及 ④ 的 `default`「待确认」、⑥(iii) 的 `unsupported`）不阻断 ⑦ preview-ready。**
> `previewReady = ①②③⑤ 四步全 ready`；④⑥ 的 posture 一律 advisory，**必然**逐项出现在 ⑦ 的人工
> canonical activation checklist 上，由真人在 canonical 面确认/完成。

两条不可混淆的推论：①「不阻断」**不等于**「显示为已完成」——④ 的 `default` 仍显示「待确认」、`unknown`
仍 fail-closed 显示「未知，去核查」（章程 L232），⑥(iii) 仍显示 `unsupported`（「当前版本不支持按组织
配置接收范围」）；②因此 ⑥(i) 的 `unknown`（见 §4.5：投递作业注册状态今天不可观测）**不会把组织卡死**
在永远到不了 preview-ready 的吸收态。

判别值域（纯模块判别矩阵的行）：`ready / missing / forbidden / unknown / manual_review_required /
unsupported / db_not_ready`，
且每信号携带 `scope: 'org' | 'deployment'`（全局信号显式标 `deployment`，追加门禁 2）——
`forbidden` 为 per-surface（§4.3），`unknown` fail-closed 显示为「未知，去核查」，绝不显示为已完成
（章程 L232 未知态红线）；`manual_review_required` 显示为「需人工确认」并给出**指向 canonical 面的深链**
（向导本身不提供确认动作——R4）；`unsupported` 显示为「当前版本不支持」，**不得**渲染成「未配置/去配置」
（否则给出一个不存在的修复动作）；`db_not_ready` 对应各端点统一 503 `DB_NOT_READY` 档
（`index.cjs:37751` 等）。三者与 `missing` 语义严格分离（章程 L358），且按 §3.2 均**不阻断** `previewReady`。
**「计划生效时间」逐步来源规则（追加门禁 4 + round-2 结构闭合）**：生效时间入响应结构为逐步 posture
`effectiveTime: {source: <权威来源标识>, posture: 'known'|'undeterminable'}`——有权威来源（如排班生效日、
节假日同步窗口）才 `known`；否则 `undeterminable` 显示「无法确定」，**不得省略、不得猜测**；各步来源在
W4-0 判别矩阵逐行登记。

## 4. Readiness 聚合契约（R1）

**4.1 端点（OD-W4-1 已裁 =(a)）**：`GET /api/attendance-admin/setup-readiness?orgId=…`，落
core-backend `attendance-admin.ts` router——继承 router 级 `rbacGuard('attendance','admin')` + S7-5 同款
`user_orgs` org-membership 门 + 平台 admin 直通（`:367-379` 先例逐字复用）。**不选** plugin 路由：
那将继承「信任客户端 orgId」缺口（§1-5），对一个汇总全 org 配置面的端点不可接受。
**4.2 响应形状（values-free by construction）**：仅布尔、非负整数计数与闭合枚举，每信号带 `scope` 标记

```
{
  directoryLinked,              // scope=org，仅 source/capability posture，不参与 ① 完成判定（P2-3）
  orgActiveMemberCount,         // scope=org，① 的完成真值
  groupCount, groupsWithMembers,
  shiftCount, rotationRuleCount, hasRotationRules,
  approvalFlowCount,
  punchPolicyPosture,           // 'default'|'customized'|'unknown'，scope=deployment，比对范围=§3.1 闭集
  notify: {                     // P2-2 三信号，互不等价，不得合并
    deliveryRuntime,            // 'ready'|'not_ready'|'unknown'，scope=deployment
    orgRecipientBinding: { boundRecipientCount, hasAnyBoundRecipient },   // scope=org
    recipientScopeConfig        // 恒为 'unsupported'，scope=deployment（§4.5）
  },
  previewReady,                 // = ①②③⑤ 全 ready（§3.2），④⑥ 不参与
  perStep.effectiveTime: { source, posture }   // posture ∈ 'known'|'undeterminable'
}
```

**已删除字段（P2-2）**：`workerEnabled` / `defaultChannelAvailable` / `availableChannelCount` /
`orgRecipientBindingReady` 四个平铺字段整体**移除**——`workerEnabled` 曾被读作「env 变量已设」，而 owner
判定它必须意味着「调度器真的起来了且投递作业已注册」，现状不支持这个读法（§4.5），保留该名会把不等价的
状态继续压成一个布尔。
聚合实现采用**单条 CTE 或短 TTL org-scoped cache**（owner 非阻断项）。

**只读证明 = 结构约束，不是文本匹配（P2-4）**：聚合的 query seam 必须在
**Postgres 只读事务**内执行——用既有 `transaction()` 助手（`packages/core-backend/src/db/pg.ts:22-26`，
底层 `connection-pool.ts:155-175` 真发 `BEGIN`/`COMMIT`/`ROLLBACK` 于独占 client），handler 的**第一条**
语句为 `SET TRANSACTION READ ONLY`，其后才跑各计数。**明令禁止**用「首词是否为 SELECT」或任何正则来证明
只读：那既拦不住 data-modifying CTE（`WITH x AS (DELETE … RETURNING *) SELECT * FROM x` 首词就是 `WITH`/
`SELECT`），也拦不住多语句串。只读事务是**执行期**约束，两类都由 Postgres 直接报错拒绝。
配套三条必红测试见 §9 W4-0。

契约测试断言 SQL 文本不含任何标识列（S7-5 单测先例：
`packages/core-backend/tests/unit/attendance-admin-directory-readiness-s7-5.test.ts:82-189`），
且响应键集合恒等锁定。错误档：400 `ORG_ID_REQUIRED` / 401 / 403 / 503 `DB_NOT_READY` / 500 泛化文案
（S7-5 现行档位逐字复用：`attendance-admin.ts:394-411`）。
**4.3 权限信号**：端点级 403 = 整面 `forbidden`；不复用 `adminForbidden` 全局 flag（§1-6）。FE 纯模块
将 403 映射为对应步 `forbidden`，与 `missing` 显示语义分离（L358）。
**4.4 读放大**：单次聚合替代 5-6 次 list 调用；GET 不限流（**路径勘误：真源在
`packages/core-backend/src/middleware/attendance-production.ts`，不在 `routes/`**——`:461-462`
只对 `/api/attendance-admin/` 且 `method !== 'GET'` 挂写限流器），IP allowlist 对 `/api/attendance-admin/*`
的既有覆盖自动适用（`:470` + `:481-489`）。

**4.5 通知 readiness port（P2-2 重写，W4-0 新增，core-backend 只读）**：⑥步拆成的三个信号各有独立真源，
**不得互相推断**。

**(i) `deliveryRuntime`（部署运行期就绪，scope=deployment）**——语义 = 「调度器真的起来了 **且** 投递作业
已注册」，不是「env 变量已设」。现状实证：注册需要**两个**门同时为真——`startAttendanceScheduler` 在
`ATTENDANCE_SCHEDULER_ENABLED !== 'true'` 时直接返回 `null`（`AttendanceScheduler.ts:310-311`），
而 `resolveAttendanceNotificationDeliveryJob` 在 `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED !== 'true'`
时返回 `null`（`:399-400`），否则返回名为 `attendance-notification-delivery` 的作业（`:409`）；
两者在 `packages/core-backend/src/index.ts:2482-2492` 汇合（`.filter(Boolean)` 后传 `jobs`）。
**因此单读 `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED` 不足以证明任何事**——这正是 owner 点名的不足。
判据：
- `schedulerStarted` **今天可观测**：`getSharedAttendanceScheduler()`（`AttendanceScheduler.ts:318-320`）
  非 null ⇔ 调度器已构造并 `start()`。
- `deliveryJobRegistered` **今天不可观测**：作业表 `private jobs`（`AttendanceScheduler.ts:84`），
  类上只有 `registerJob()`（`:205-214`）与 `get leader`（`:200-202`），**没有任何列举/查询已注册作业名的
  公开访问器**。本锁**不发明**该 API。
- 故映射：`schedulerStarted === false` ⇒ `deliveryRuntime='not_ready'`（可给出明确修复动作：
  运维开启调度器）；`schedulerStarted === true` ⇒ `deliveryRuntime='unknown'` **fail-closed**
  （「调度器在跑，但无法证明投递作业已注册」），**绝不**报 `ready`；port 缺失/异常同样 ⇒ `unknown`。
  若未来要真正判 `ready`，前置 = 给 `AttendanceScheduler` 加一个只读的已注册作业名访问器——那是**独立的
  runtime 变更，本锁不授权**，也不计入 W4-0。
  按 §3.2，该 `unknown` **不阻断** preview-ready，因此合成组织不会被卡死。

**(ii) `orgRecipientBinding`（组织收件人绑定覆盖，scope=org）**——真源 = 投递通道解析收件人时查的同一组
目录表：`directory_account_links(link_status='linked')` ⋈ `directory_accounts(provider, is_active)`
⋈ `directory_integrations(provider, status='active', org_id)`
（`AttendanceNotificationDeliveryWorker.ts:484-501`；0 行 ⇒ `dingtalk_recipient_not_bound` 终止为
`skipped`，`:537-540`；企微同型 `:763`）。port 只回 `{boundRecipientCount, hasAnyBoundRecipient}` 计数/布尔，
**不回 userId、external_user_id、integration id、渠道名或 env 名**。

**(iii) `recipientScopeConfig`（收件范围配置）= 恒 `unsupported`**——今天**不存在**按组织/按收件人配置
接收范围的能力：默认渠道是**部署级单值** `ATTENDANCE_NOTIFICATION_DEFAULT_CHANNEL`，其注释逐字写明
「Per-org / per-recipient routing is the design-lock §3 follow-up」（`:202-207`），静默时段同样是
deployment-wide v1（`:249-250`）；而 `attendance-admin-notification-deliveries` 深链落到的是**投递历史**
只读面（`AttendanceView.vue:1722-1737`）。因此⑥的修复动作**不得**写成「去配置接收范围」——那是一个不存在
的动作；深链文案 = 「查看投递历史」，另附 `unsupported` 说明。渠道注册本身仍逐个 env-gated、default-off
（`createAttendanceDeliveryChannelsFromEnv` `:370-401`，四个渠道各自 `env.* === 'true'` 才 push）。

**契约测试**：port 零 env 值/凭据外泄（响应键集合恒等锁定 + 断言无 `ATTENDANCE_` 前缀字符串）；
缺 port 时聚合端点仍 200 且 notify 块 = `{deliveryRuntime:'unknown', …}`；
**负向断言：不得由 `attendance_notification_deliveries` 行存在性推断任何一个信号**
（mutation 目标：把 (ii) 改成查 delivery 历史表 ⇒ 契约测试红）。

## 5. 模板与预填契约（R3/R4）

**5.1 四模板 = FE 常量**（OD-W4-3 已裁 =(a)）：办公室固定班 / 门店排班 / 工厂多班次 / 销售外勤
（OD-VX3 已裁），落 `attendanceSetupTemplates.ts` 纯常量模块——BE 零新增（现有 rule-templates/
role-templates 均非其载体，实证 `plugins/plugin-attendance/engine/template-library.cjs:288-293`
= `SYSTEM_TEMPLATES + CUSTOM_TEMPLATES` 的规则模板库，与「向导预填」无关；「只预填不提交」使 FE 常量
即真源充分）。
**5.2 预填机制（round-2 收紧：模板不得污染共享表单）**：向导与表单同宿主
（`apps/web/src/views/AttendanceView.vue`），模板选择 = 写既有 reactive 表单
（`shiftForm:15251` / `ruleSetForm:15484` / `attendanceGroupForm:15493` / `holidayForm:15329`）
+ `selectAdminSection(目标)` 跳转（`:14593-14601`）——先例 `prefillRequestFromAnomaly`（`:1000` 调用点）
同型。**强制合同（OD-W4-3 附加条件，owner round-2）**：
①应用模板**前**显示受影响字段清单并确认覆盖（表单已有未保存内容时尤其）；②应用前保存原表单
**快照**，「取消」完整恢复快照；③只承诺恢复**已保存**的资源，未保存预填不承诺刷新后存活；
④模板**时区禁硬编码**——取组织显式时区，取不到则要求用户在预填确认时选择（仍过
`resolveExplicitTimeZoneOrThrow`，`index.cjs:6389`）。**注意现状不可直接沿用**：既有表单默认时区
`defaultTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'`
（`AttendanceView.vue:11682`，`shiftForm`/`attendanceGroupForm` 均取它）——那是**浏览器时区**，
不是组织显式时区，模板路径不得把它当作「组织时区」使用。保存仍走各表单既有保存路径与校验
（group name 必填等：`POST /api/attendance/groups` zod schema `index.cjs:37804-37811`
+ `normalizeSafeDisplayName`/`resolveExplicitTimeZoneOrThrow` `:37824-37826`）。**预填值域约束**：模板字段必须满足各表 NOT NULL/枚举（`attendance_type ∈
fixed_shift/scheduled_shift/free_time` 等，migrations 实证）——锁附录 A 列四模板逐字段预填集
（时区列为「组织时区/用户选择」占位，非常量）。
**5.3 preview 无副作用**：⑦步 = 只读预览（聚合读 + 派生展示）+ **人工 canonical activation
checklist**（列出真人逐项去 canonical 面完成的启用动作），UI 文案与状态**绝不暗示「已启用」**
（round-2）；完成门负向测试断言 preview 全程零写请求 + 文案不含「已启用/enabled」类完成时态。
**5.4 受禁开关全清单（R4 执行面）**：env 层（API 不可改，列举以供断言）——
`ATTENDANCE_SCHEDULER_ENABLED`（`AttendanceScheduler.ts:311`）、
`ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED`（`AttendanceScheduler.ts:400`）、
`ATTENDANCE_UNSCHEDULED_REMINDER_ENABLED`（`:363`）、`ATTENDANCE_COMP_TIME_EXPIRY_REMINDER_ENABLED`（`:380`）、
`ENABLE_ATTENDANCE_SCHEDULER_LEADER_LOCK`（`:334`）、
`ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED`（**路径勘误：真源在
`plugins/plugin-attendance/index.cjs:119`，不在 `AttendanceScheduler.ts`**）、
`ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED` / `ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED`
（`index.cjs:14749/14753`）、`ATTENDANCE_REPORT_DIGEST_ENABLED` /
`ATTENDANCE_REPORT_SYNC_SCHEDULED_TRIGGER_ENABLED`（`index.cjs:14760/14768`）；
settings 层 enabled 键（`autoAbsence.enabled` `:297`、`holidaySync.auto.enabled` `:324`、
`compTimeFromOvertime.enabled` `:378`、`multiShiftDay.enabled` `:356`、`annualLeavePolicy.enabled` `:386`、
`attendanceResultEditPolicy.enabled` `:476`）——向导对 `PUT /api/attendance/settings` **整体禁写**（§0-R4）。
**「④打卡方式」的修复动作 = 深链到 settings canonical 表单由人保存；向导侧只消费后端给出的
values-free posture（OD-W4-4(c) 后端内部语义检查，比对范围 = §3.1 闭集），不是「只读存在性」**
——round-1 的「只读存在性」表述已被 round-2 的 OD-W4-4(c) 取代，本轮（P2-5）在此彻底删除，
避免与 §3④ 形成第二真源。

## 6. 入口与导航合同（R2）

**6.1 注册形态（OD-W4-2 已裁 =(a)+(c)）**：新增 admin section `attendance-admin-setup`（canonical 注册，
自动获得 `?section=attendance-admin-setup` 深链/rail/快速跳转；注册点 = `ATTENDANCE_ADMIN_SECTION_IDS`
`apps/web/src/views/attendance/useAttendanceAdminRail.ts:12-46` + nav items/groups `:168-274`）
+ 任务首页 **`people-groups`（人员与考勤组）组**新增首位 action「启用准备」（button 型 sectionId action，
`adminTaskHomeGroups`（`AttendanceView.vue:14452`）内加一项——**不加第 5 组**，避免 4 列栅格改动
`AttendanceAdminTaskHome.vue:175-179`（`grid-template-columns: repeat(4, …)`）；任务首页实有四组
= daily-operations / people-groups / work-time-policies / reporting-payroll，归组位置 owner 可在
ratify 时调整）。不做首次进入自动拦截（现状无 first-run 逻辑，
强拦截违背「不与日常混首屏」的克制姿态）。任务首页 action 上的轻量「未完成」提示**来自 readiness
派生，不来自「是否访问过」的本地信号**（round-1 P2-4 第 4 点，OD-W4-2(c) 修订）；判据与 §3.2 一致
——**提示条件 = ①②③⑤ 存在非 `ready` 步**，④⑥ 的 advisory posture 不触发「未完成」徽标
（否则每个部署都会永久挂一个消不掉的红点）。
**6.2 深链纪律**：向导内七步「去配置/修复」全部 = `selectAdminSection`（`AttendanceView.vue:14593-14601`）
或 `?section=` query 深链（`AttendanceExperienceView.vue:146-149` 只接受 `attendance-admin-` 前缀的
`route.query.section`，不带其他参数）；禁 hash 形；禁新增 route 参数。中途退出即自然落在 canonical form，
无需「恢复」状态机——向导本身无持久向导态（readiness 是重进即重算的派生，非流程状态）。
**⑥步例外说明**：其深链落到只读投递历史面，文案必须写「查看投递历史」而非「去配置」（§4.5(iii)）。
**6.3 帮助（OD-VX4 已裁）**：每步页内上下文帮助四类内容（章程 §4.6 L216-225），values-free 红线
逐字继承；不复制外部手册。

## 7. 组件与文件形状

- `apps/web/src/views/attendance/attendanceSetupReadiness.ts`（新，纯模块）：聚合响应 → 七步
  判别矩阵，**值域必须与 §3 完全一致（P2-5c）**：
  `ready / missing / forbidden / unknown / manual_review_required / unsupported / db_not_ready`
  （七值，一个不少——round-2 稿此处漏列 `manual_review_required`，round-3 补齐并新增 `unsupported`）；
  另导出 `previewReady` 派生（= ①②③⑤ 全 `ready`，§3.2）。零 DOM/零 fetch；
  单测覆盖判别矩阵全行 + mutation 目标（任一判别分支取反 ⇒ 对应腿红），并含**值域穷尽断言**
  （模块导出的值域常量恒等于上述七值集合）。
- `apps/web/src/views/attendance/AttendanceSetupReadiness.vue`（新，章程 §6.2 预留名，仓内确认尚不存在）：
  纯展示 props（`tr` + steps 数组）+ emit（`select-section`/`open-template`）——AttendanceAdminTaskHome
  同型（props/emit 先例 `AttendanceAdminTaskHome.vue:105-112`）；tokens.css `--ms-*`（新组件零硬编码 hex，
  不以存量 hex 债为先例）。
- 父层 `apps/web/src/views/AttendanceView.vue`（注意在 `views/` 根，不在 `views/attendance/`）：
  readiness 加载/聚合调用/模板预填写入/section 注册（§6.2「留父层」条款）。
- `packages/core-backend/src/routes/attendance-admin.ts`：`setup-readiness` 端点 + 契约单测
  （S7-5 测试同型：状态码矩阵 + SQL values-free 断言 + 响应键集合锁定）。
- guard 接线（§8.1.4）：新 spec 进 run-list 显式 pattern + 双 path filter + 收集证明 + 同命令 mutation。

## 8. Open Decisions（OD-W4）——**owner 2026-07-21 round-2 已全部裁决（DECIDED）**

| OD | 裁决 |
|---|---|
| OD-W4-1 | **(a)** core-backend + `user_orgs` 门；授权检查**先于任何聚合 SQL**；双组织伪造 orgId 真库测试 |
| OD-W4-2 | **(a)**；拒绝 localStorage 首访提示——「未完成」徽标由 readiness 派生 |
| OD-W4-3 | **(a)** + 附加条件：动态时区、覆盖确认、取消快照恢复合同（§5.2） |
| OD-W4-4 | (a)/(b) 均拒；**新增并裁定 (c)**：后端内部语义检查（与 normalized defaults 比对），前端仅收 values-free posture `default/customized/unknown`。*round-3 P2-1 细化（不改裁决，只收窄比对范围）：比对范围 = §3.1 打卡策略闭集，非整包 settings* |
| OD-W4-5 | **(b)**：W2 英文错误串另开小刀，**不混入 W4-0 readiness 安全底座** |
| OD-W4-6 | **(a)**：人员数取 active `user_orgs`；组覆盖数单独取 group membership |
| OD-W4-7 | **修订后的 (a)**：只恢复已持久化进度；未保存预填必须确认、可撤销；不声称刷新后自动恢复 |

**上表是本锁 OD-W4-1..7 的唯一可实施合同。** 下面 §8-附 仅为历史追溯。

### §8-附（**非规范附录 · 已被上表裁决整体取代 · 不得据以实施**）

> **P2-5b 处置**：本附录**全部 recommended 标记已删除**——它们是裁决**之前**的提案，其中数条已被
> owner 明确**驳回**（最典型：OD-W4-4(a) 存在性布尔曾标 recommended，round-2 已裁「(a)/(b) 均拒，
> 改 (c)」）。保留原文会让本锁同时存在两份合同。任何与上表冲突之处，**一律以上表为准**；
> 实施者请只读上表与 §3/§4/§5/§6。以下条目仅记录「当时考虑过哪些选项」。

- **OD-W4-1 readiness 聚合宿主与 org 门**（→ 已裁 (a)）：(a) core-backend router + `user_orgs` 门
  （S7-5 姿态，理由 §1-5/§4.1）；(b) plugin 路由 + `withPermission`（与配置端点一致但继承 orgId
  信任缺口）。选 (a) 时显式记录：与 plugin 配置端点姿态不一致是**有意的**（汇总面风险更高）。
- **OD-W4-2 入口形态**（→ 已裁 (a)+(c)）：(a) canonical admin section + 任务首页 action；(b) 仅任务
  首页第 5 组（改栅格）；(c) 轻量首访提示（仅提示不拦截，已并入 (a) 并按 P2-4 改为 readiness 派生）；
  (d) 首次进入强拦截（**已弃**）。
- **OD-W4-3 模板载体**（→ 已裁 (a) + 附加条件）：(a) FE 常量模块（零 BE 面）；(b) BE 常量端点
  （**已弃**——纯读也无必要，且靠近「万能端点」红线）。
- **OD-W4-4 ④/⑥ 步「已配置」判定深度**（→ **(a)/(b) 均已被 owner 驳回，改裁 (c)**）：
  (a) 存在性布尔（settings 键已显式保存过 / 渠道配置非空）——**已驳回**：部署级单键使「key 存在」
  跨组织假绿；(b) 语义校验并读值——**已驳回**：与 values-free 张力（GET settings 会回传
  ipAllowlist/geoFence 等运维值，向导 UI 不得透传展示）。现行 = (c) 后端内部语义检查 + 前端只收
  posture 枚举，比对范围 = §3.1 闭集。
- **OD-W4-5 W2 已知项处置**（规则卡透传英文 API 错误串）（→ 已裁 **(b)**）：(a) Wave 4 首个 runtime
  切片顺手 i18n 化该错误面——**已弃**（不混入 W4-0 安全底座）；(b) 记 deferred 继续留已知项。
- **OD-W4-6 影响人数口径**（→ 已裁 (a)）：(a) `user_orgs` active 计数 + `groupsWithMembers` 派生；
  (b) 逐用户名单预览（**已弃**，与 values-free 及只读面冲突）。
- **OD-W4-7 中途退出恢复合同**（章程 L358 读法，owner round-1 P2-4 四点合同）（→ 已裁「修订后的 (a)」）：
  (a) **四点合同**——①已保存进度由 readiness 重算恢复（无持久向导态）；②**未保存表单不承诺恢复**，
  离开向导预填未保存时给离开前提示（beforeunload/切区确认）；③若保存模板选择，只存模板 ID，
  存储 key **必须含 `userId + orgId`**（防多用户/多组织串状态）；④「未完成」提示来自 readiness，
  不来自访问史。W4-1 完成门断言：中途退出→重进 ⇒ 判别矩阵与直接重算逐项一致 + 未保存离开提示
  真实弹出 + 存储 key 含双 id 的负向测试（换 user/org ⇒ 互不可见）。
  (b) 持久向导态（**已弃**——引入新状态真源，与 R1 及无流程状态机设计相悖）。

## 9. 切片（严格串行，全部 RATIFY 后开工；每片完成门 = 章程 §8.1 十一门 + 本锁红线负向断言 + Opus 对抗审 0 P1/P2 + PR 门禁记录）

- **W4-0 readiness 底座**：纯模块 + `setup-readiness` 端点 + §4.5 三信号 readiness port + 契约/判别
  矩阵测试。红线与追加门禁断言（owner round-1）：R1 + §4.3 per-surface 403 + **计数 SQL 逐项含
  `org_id=$1` 审计**（全局信号显式 `scope=deployment`）+ 生效时间来源逐行登记。
  **W4-0 无 UI：三视口门标 N/A**（视觉证据从 W4-1 起，避免形式化假验收——owner 追加门禁 5）。

  **W4-0-G1 org 门测试身份（P2-4，写死，不得替换）**——真库矩阵的「A org 管理员」= **受托管理员**：
  仅持 `attendance:admin`，**是 A org 的 active `user_orgs` 成员**，**不是 B org 成员**，且
  **不持任何平台 admin 声明**（不满足 `hasLegacyAdminClaim`：无 `role='admin'`、无 `roles` 含
  `admin`、无 `perms` 含 `*:*`/`admin:all`——`attendance-admin.ts:323-330`；`isRbacAdmin` 亦为假）。
  必过用例：
  1. 该受托管理员请求 `orgId=A` ⇒ 200；
  2. 该受托管理员伪造 `orgId=B` ⇒ **在任何聚合 SQL 执行前 403**（断言：查询 mock 的调用计数为 0，
     不是「结果为空」）；
  3. **单列标注的旁路对照**：平台 admin 请求 `orgId=B` ⇒ 200 **且测试名/注释显式写明这是设计内的
     旁路（`attendance-admin.ts:373` 在 `user_orgs` 查询之前 return true），因此该用例不证明 org 门
     存在**，绝不可拿它替代用例 2。

  **W4-0-G2 只读证明（P2-4，结构约束）**——聚合在 `SET TRANSACTION READ ONLY` 事务内执行（§4.2）。
  必过（全部必须**被拒**）：
  1. mutation：把任一计数换成 `UPDATE`/`INSERT`/`DELETE` ⇒ 事务报错 ⇒ 契约测试精确翻红；
  2. **writable CTE**：`WITH d AS (DELETE FROM attendance_groups WHERE org_id=$1 RETURNING 1)
     SELECT COUNT(*)::int AS total FROM d` ⇒ 必须被拒（**证明首词匹配无效**——首词是 `WITH`，
     正则/首词法会放行）；
  3. **多语句串**：`SELECT 1; DELETE FROM attendance_groups WHERE org_id=$1` ⇒ 必须被拒。
  **负向元断言**：实现中不得出现基于首词/正则的「只读校验」（grep 守卫 + 代码评审项）；
  只读事务是唯一被认可的证明。

  **W4-0-G3 ①步两个正控（P2-3，缺一不可）**——
  1. **纯本地组织**：`user_orgs` 有 ≥1 active 成员、**零** `directory_account_links` 行 ⇒
     `orgActiveMemberCount>0` 且 `directoryLinked=false` ⇒ **① 判为 `ready`**（负向：若实现用
     `directoryLinked && count>0`，该用例必红）；
  2. **钉钉已联通组织**：存在 `directory_integrations(provider='dingtalk', status='active')` +
     `linked` 的 `directory_account_links` ⇒ `directoryLinked=true` 且 `orgActiveMemberCount>0` ⇒
     ① 同样 `ready`，且 `directoryLinked` 作为 posture 正确回 true。
  两控合起来锁死「`directoryLinked` 不参与完成判定，但仍如实上报」。

  **W4-0-G4 ⑥步三信号不塌缩（P2-2）**——断言 `notify` 块恒含三个独立字段；
  `deliveryRuntime` 在「仅设 `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED=true`、调度器未启动」
  时 ⇒ `not_ready`（不是 `ready`）；调度器已启动时 ⇒ `unknown`（不是 `ready`）；
  `recipientScopeConfig` 恒 `unsupported`；且 `previewReady` 在上述任一 notify 组合下均**不受影响**
  （§3.2 闭环裁决的可执行断言）。

  **W4-0-G5 ④步闭集（P2-1）**——闭集常量与 `DEFAULT_SETTINGS` 顶层键对账（§3.1）；
  正控：只改 `punchPolicy.unscheduled.mode` ⇒ `customized`；
  **负控（关键）**：只改 `holidaySync.lastRun`（模拟后台同步机器写，`index.cjs:11888-11894`）
  或只改 `annualLeavePolicy` ⇒ 仍为 `default`（若实现整包比对，该用例必红）。
- **W4-1 向导壳与七步导航**：`AttendanceSetupReadiness.vue` + section 注册 + 任务首页 action + 帮助。
  红线断言：R2（深链全 query 形，负向：hash 导航零出现）+ §3 未知态 fail-closed 显示 +
  **⑥步文案负向断言**：⑥ 的修复动作文案不得含「配置接收范围」类措辞（§4.5(iii)），
  且 `unsupported` 不得渲染成「未配置/去配置」。
- **W4-2 模板预填 + ⑦预览**：模板常量 + 预填跳转 + 预览派生。红线断言：R3（preview 期零写请求）+
  R4（受禁开关全清单的「向导不触碰」负向测试：mock 层断言向导交互全程对 settings PUT / flag 类端点
  零调用）+ **⑦文案负向断言**：不含「已启用/enabled」类完成时态（§5.3）。
- **三视口证据（1440/1024/390，拍前真在场断言 + 目检）= W4-1 与 W4-2 两片**；
  **W4-0 三视口 N/A**（无 UI，见上；P2-5d：round-2 稿此处的「每片三视口」与 W4-0 的 N/A 冲突，
  本轮改为逐片限定）。波次验证 MD 每片必出；章程 §9 指标（20 分钟到 preview-ready，无 JSON/内部 ID）
  在 W4-2 收口用合成 org 实测——**该合成 org 必须能真的到达 preview-ready**，这正是 §3.2 闭环裁决
  存在的原因（否则 ④「待确认」或 ⑥ `unknown` 会让该指标永远不可达）。

## 10. 完成定义与 ratify 流程

**完成定义**：三切片全合 + 验证 MD 在 main + §9 指标合成实测记录（含 **W4-0-G1..G5 五组门全绿**）
+ 红线四条各有存活的负向断言。
本锁不改变：S7 flag 默认 OFF、真实租户视觉复核等 operator 项（owner 裁决⑥，不计 UI 完成度）。

**预写 ratify 收尾序**（#4370 先例逐字）：①锁分支刷新至最新 main（drift 复核）→ ②PROPOSED→RATIFIED
（记录 OD-W4-1..7 裁决与日期）→ ③章程 §15 Wave 4 行同步（DESIGN-LOCK-GATED → RATIFIED / landing）
→ ④转 ready 等 fresh required checks 全绿合并 → ⑤从合并后 main 开 W4-0。

## §11.1 六项记录（章程 L459-468）

1. 基线 SHA：**`1f06ecea9`**（origin/main，2026-07-21 round-3 刷新；原 `6feff1b2b`）。
   区间 = 2 个提交（`e91d20e5c` core-backend 测试 fixture 清理、`1f06ecea9` material-reconciliation D1），
   `git diff --stat 6feff1b2b 1f06ecea9` 对全部 attendance 路径为空 ⇒ **本锁引用的运行时事实零漂移**；
   下方勘误表中的锚点更正**全部是原稿的行号/路径错误**，不是 main 移动造成的。
2. 查重（对 `1f06ecea9` 重跑）：
   - `git log --grep='readiness|setup|onboarding' -i` ⇒ 命中均为既有已落地面（S7-5 目录 readiness、
     W2 员工总览、钉钉微应用 setup 帮助页等），**无第二个七步/启用向导实现**；
   - 全仓 grep `setup-readiness|setupReadiness|SetupReadiness`（`apps/ packages/ plugins/`，
     `.ts/.vue/.cjs`）⇒ **0 命中**；
   - 全仓 grep 考勤域 readiness 端点 ⇒ 仅 `attendance-admin.ts:392` 的 `directory-readiness`
     （S7-5，单维度）；`packages/core-backend/src/routes/federation.ts:1373/3115` 的
     `release-readiness` 属 PLM 联邦域，**同名不同域**，不构成重复。
   - `AttendanceSetupReadiness.vue` / `attendanceSetupReadiness.ts` 仓内**均不存在**（`ls`
     `apps/web/src/views/attendance/` 实证）；`AttendanceProvisioningSection.vue` /
     `AttendanceSettingsSection.vue` 存在但**零 import**（死代码，§1-2 结论维持）。
   - 在飞分支：`git ls-remote --heads origin` 中唯一名字相近者 =
     `codex/multitable-ai-readiness-m1b-20260611`（多维表 AI 域，非考勤），**本锁分支仍独占该题**。
3. 修改文件：本 PR 仅本文档（docs-only）；未来切片碰撞车道 = `AttendanceView.vue`（单热文件串行，
   与 Wave 5 不并开——owner 裁决⑤）。
4. IN/OUT：§2。
5. 权威数据源/唯一写路径/权限真源：readiness 真源 = `setup-readiness` 聚合（各计数 SQL 单点）；
   向导零写路径（唯一写 = 既有表单各自的保存端点）；权限真源 = router 级 rbacGuard + `user_orgs` 门。
6. 完成门与 mutation 目标：§9 各片列出；对抗审 0 P1/P2 每片必过。

### §11.1-附 锚点勘误表（round-3 漂移刷新，全文 `file:line` 逐条重开于 `1f06ecea9`）

**结论先行**：`6feff1b2b → 1f06ecea9` 之间**没有任何 attendance 文件变更**，因此**零条锚点因 main
前进而移动**。下表全部是**原稿自身的错误**（错行/错路径/错文件/引错语义），按 owner 要求逐条登记为
finding 而非静默修正。

**A. 语义错误（引用指向了完全不同的代码，影响结论可信度）**

| # | 原稿锚点 | 原稿声称 | 实际 | 更正 |
|---|---|---|---|---|
| 1 | `index.cjs:135` | `SETTINGS_KEY`（部署级单键） | 135 行是审批步骤解析（`if (!step \|\| typeof step !== 'object') return null`），与 settings 无关 | `SETTINGS_KEY` = **`:291`**；`DEFAULT_SETTINGS` = **`:295-512`**；出现两处（round-1 修订说明、§3④）均已改 |
| 2 | `index.cjs:14192` | `rotationRuleCount` 的计数原料 | 14190-14199 是旧班次改名的兼容 helper（`SELECT id, shift_sequence … WHERE org_id=$1 AND EXISTS(…)`），**不是 COUNT** | org-scoped COUNT = **`:31186-31189`**（带 `is_active` 过滤）；§1-1、§3③、round-2 修订说明均已改 |
| 3 | `AttendanceScheduler.ts:311-400` 含 `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED` | 该 env 在调度器 | 该文件内**无**此 env；它在 `plugins/plugin-attendance/index.cjs:119` | §5.4 已按逐条 env → 逐条锚点重写 |

**B. 路径错误（文件不在所写目录，按原路径打不开）**

| # | 原稿路径 | 实际路径 | 备注 |
|---|---|---|---|
| 4 | `packages/core-backend/src/routes/attendance-production.ts` | `packages/core-backend/src/**middleware**/attendance-production.ts` | `routes/` 下**不存在**该文件；行号 `:461-497` 本身正确（§4.4 已注明勘误） |
| 5 | `AttendanceView.vue`（隐含在 `views/attendance/`） | `apps/web/src/**views/AttendanceView.vue**`（`views/` 根） | 同目录下另有 `views/attendance/` 的众多子组件，易混；§1-3/§5.2/§6.1/§7 已补全路径 |
| 6 | `attendance-admin-directory-readiness-s7-5.test.ts` | `packages/core-backend/**tests/unit**/…`（全文件 217 行） | 原稿行段 `:82-191` 越过用例边界，收敛为 **`:82-189`**（§4.2） |

**C. 行号偏移（同一文件内指偏，语义未变）**

| # | 原稿 | 实际 | 说明 |
|---|---|---|---|
| 7 | `index.cjs:37718` | **`:37720`** | 考勤组 COUNT（37718 是 `try {`） |
| 8 | `index.cjs:32305` | **`:32306`** | 规则集 COUNT |
| 9 | `index.cjs:41833` | **`:41835-41837`** | 节假日 COUNT（41833 是 `try {`） |
| 10 | `index.cjs:37752` | **`:37751`** | `DB_NOT_READY` 503 档 |
| 11 | `index.cjs:6215-6224` | **`:6215-6223`** | `getOrgId` 函数体（6224 为空行） |
| 12 | `index.cjs:13733-13760` | **`:13715-13725`（loadSettings）/ `:13749-13759`（saveSettings）** | 原段起点落在 `getSettings` 缓存包装上，未覆盖真正的写点 |
| 13 | `AttendanceView.vue:14389-14396` | **`:14390-14397`** | 14389 是注释尾行；真正的默认首屏判定是 `hasExplicitAdminSectionTarget()` + `adminTaskHomeOpen` |
| 14 | 章程 `§7-Wave4 L350-355` | **L351-355** | L350 为空行，「首版禁止」小标题在 L351 |
| 15 | `AttendanceNotificationDeliveryWorker.ts:370+` | **`:370-401`**（`createAttendanceDeliveryChannelsFromEnv`） | 开区间改闭区间；同时新增 `:202-207`/`:249-250`/`:484-501`/`:537-540` 四处 P2-2 依据 |

**D. 复核无误（逐条重开，行号与语义均正确，登记以证明真的开过）**
`attendance-admin.ts:336-360`（`readOrgDirectoryReadiness`）、`:367-379`
（`canReadAttendanceDirectoryReadiness`）、`:373`（平台 admin 旁路）、`:375`（`user_orgs` 查询）、
`:386`（router 级 `rbacGuard`）、`:392-412`（S7-5 端点）；
`index.cjs:39710`（班次 COUNT）、`:30924-30926`（审批流 COUNT）、`:43053-43058`（settings 保存即重排程
+ 发事件，R4 依据）、`:37804-37856`（考勤组保存校验）、`:6389`（`resolveExplicitTimeZoneOrThrow`）、
`:15251/:15329/:15484/:15493`（四个 reactive 表单）、`:14593-14601`（`selectAdminSection`）、
`:1000`/`:16051`（两处预填先例）、`:14452`（`adminTaskHomeGroups`）；
`useAttendanceAdminRail.ts:12-46`（section ids）、`:168-274`（nav items/groups）；
`AttendanceExperienceView.vue:146-149`（query-only 深链）；`AttendanceAdminTaskHome.vue:105-112`
（props/emit）、`:175-179`（4 列栅格）；`engine/template-library.cjs:288`；
章程 `L47-48/L82/L147/L202-208/L210/L211/L216-225/L232/L267-268/L343/L354-355/L358/L459-468`。

**E. 新增锚点（本轮为 P2-1..P2-5 论证新开，均已实证）**
`index.cjs:11888-11894`（`performHolidaySync` 经 `saveSettings` 机器写 `lastRun`）、
`:20264-20310`（`enforcePunchConstraints` 唯一打卡约束点）、`:25348/:25380/:25418-25422`（打卡路由与调用）、
`:12549-12673`（`normalizeSettings` 重建全 24 键）、`:20474/:20500`（`scheduleHolidaySync`）、
`:18573`（merge 策略读点）、`:296-511`（24 个顶层键逐键行号见 §3.1）；
`AttendanceScheduler.ts:84`（`private jobs`）、`:200-202`（`get leader`）、`:205-214`（`registerJob`）、
`:310-311`/`:318-320`/`:399-412`；`packages/core-backend/src/index.ts:2482-2492`（双门汇合）；
`packages/core-backend/src/db/pg.ts:22-26` + `integration/db/connection-pool.ts:155-175`（事务助手）；
`AttendanceView.vue:1722-1737`（只读投递历史面）、`:11682`（`defaultTimezone` = 浏览器时区）；
`attendance-admin.ts:323-330`（`hasLegacyAdminClaim`）；
migrations `zzzz20260114110000_create_user_orgs_table.ts:33-40`、
`zzzz20260717100000_create_directory_department_bindings.ts:22-23`。

**F. 已不存在的引用** —— 无。逐条重开后，本锁引用的每个文件与符号在 `1f06ecea9` 上均存在；
唯一「打不开」的是 B-4 的 `routes/attendance-production.ts`，但那是原稿写错目录，文件本身在
`middleware/` 下健在。

## 附录 A：四模板预填字段集（满足表约束的最小合法集）

| 模板 | attendance_type | 预填示例字段（全部走既有表单校验） |
|---|---|---|
| 办公室固定班 | `fixed_shift` | 组名、时区=组织时区/用户选择、班次 09:00-18:00、working_days [1..5]、宽限 10/10 |
| 门店排班 | `scheduled_shift` | 组名、时区=组织时区/用户选择、早/晚两班次模板、轮班规则提示（③ hasRotationRules 信号联动） |
| 工厂多班次 | `scheduled_shift` | 组名、时区、三班次模板、跨夜 is_overnight 示例 |
| 销售/外勤 | `free_time` | 组名、时区、外勤打卡方式提示（深链 settings 表单，不代存） |

（字段值为预填示例，不代表保存；保存校验以各表单/端点现行规则为准——`index.cjs:37804-37856` 等。）
