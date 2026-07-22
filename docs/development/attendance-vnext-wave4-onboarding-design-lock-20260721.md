# 考勤 vNext Wave 4 · 首次启用向导（onboarding）design-lock — 2026-07-21

> **Status: RATIFIED（重新 ratify，§10 重启序步③——以本 re-ratify PR 的 owner 终裁 comment 为
> 生效凭据，终裁日期以该 comment 为准；本 head 呈审时点 owner 最近动作 = CHANGES REQUESTED
> 2026-07-21，已全项吸收，尚待终裁）。W4-0 解冻，自本 PR 合入后的
> main 开工（§9 切片序；冻结库存 `b2789cce7` 仅作材料库逐项 re-port——owner 裁决③）。**
> **W4-PRE-1 完成证据（§10 步③要求记录）**：PR **#4521** 合入 = **`e20371b1a`**（2026-07-21，基
> errata 后 main `57d89bc1d`）；Opus 对抗门 **APPROVE 0 P1/P2**（6/6 独立 mutation killed，含
> 「写挪到事务提交后⇒原子性腿精确红」承重刀；门记录 = #4521 comment-5038977540）；done-gate 第 5 项
> 产出 canonical surface = **`POST /api/admin/users`**（已回填 §3① 行修复动作格）。
> **W4-PRE-1b 补票（owner 对本 PR 首轮 CHANGES REQUESTED 复核 2026-07-21 的吸收）**：PR **#4526**
> 合入 = **`3727cd92e`**——完整生命周期（bind/unbind/迁移/归档/backfill/显式 org 建人/门双活）；
> 门链 = Opus 正门 REQUEST_CHANGES（单 P2 租户谓词零覆盖）→ 测试补刀 → **独立复核
> KILLED-CONFIRMED**（8/8 mutation killed 终态；门记录 = #4526 comment-5041872425）。owner 四
> findings 处置：P1 生命周期 ✅ #4526；P2 步骤循环 ✅ #4526 显式 `attendanceOrgId`；P2 角色化 ✅ 本次
> 锁 §3① 行合同（W4-1 强制）；P2 effectiveTime 回退 ✅ 本次恢复四态+`effectiveAt` 并记录勘误。
> 开发+验证 MD = `attendance-vnext-w4-pre1-development-verification-20260721.md`（含 PRE-1b 章，
> 与本 PR 同批入仓）。
>
> （以下为被取代的 errata 时点 Status，保留作历史：）
> ~~Status: RATIFICATION SUSPENDED / W4-0 FROZEN（owner errata 裁决 2026-07-21，errata PR #4513 为其入仓记录）。~~
> 本锁曾以 PR #4509（合入为 `d0c1669b`）标记 **RATIFIED** 并授权 W4-0 开工；owner 复核后裁定
> **撤回该 ratification**：合入版是较早稿的定稿，遗漏了 round-3 材料分支上的关键内容与勘误，且含
> 两处实质错误（见下方 errata 历史块）。撤回时点事实：**W4-0 runtime PR 不存在，无代码损害**
> （main 上全仓 grep `setup-readiness|setupReadiness|SetupReadiness` = 0 命中；另存在一条已推送、
> **未合入 main** 的 WIP 分支 `claude/w4-0-setup-readiness-20260721`（errata 建 PR 时点 head
> `eb98e6f0a`，单提交 +1122 行、无 PR；**勘误门审期间观测到该分支仍在前进**——2026-07-21 门审时已至
> **最终冻结 head `b2789cce7`**，新增真库双组织测试与 plugin-tests.yml 接线提交，并曾于竞态期开出
> **PR #4514——现已 CLOSED、未合并**。事后问责已收口（owner P3 勘误 2026-07-21）：执行体 =
> 考勤-260717 死会话的恢复工作流，launch 早于其可见撤回裁决，时间线竞态非有意越权，已自停并清理
> 现场，见 #4513 comment-5032093531 与 #4514 关闭说明）
> ——**该分支及其后续任何前进同属冻结范围，冻结期不得再开 PR、不得合入**，其处置属 owner 决定）。
> 材料分支 `claude/w4-onboarding-design-lock-20260721-5p2-round3`（head `daea4301d`）为**只读材料库**，
> 其内容已逐条对现 main 重验后手工移植入本文（该分支基于旧基线 `6feff1b2b`，禁止 merge/rebase/
> cherry-pick；owner：保留至 errata 移植完成，之后作为历史证据关闭）。
>
> **重启顺序（owner 裁定，必须依次）**：本 errata 合入（过 docs-vs-code 门）→ **W4-PRE-1**（§3.3，
> `user_orgs` 生产维护写路径）落地 → 方可重新 ratify 本锁 → 之后才开 W4-0。在此之前 Wave 4 一切
> runtime 切片保持 FROZEN；Wave 5（explainability）维持 DATA-CONTRACT-GATED，不与 Wave 4 并开。
> 上位文档：`attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md`
> （RATIFIED；§4.5/§4.6/§6.2/§7-Wave4/§9/§13-3/§15），OD-VX3/OD-VX4 已按推荐值 ratify。
> 基线 = `origin/main` **`6ea0ccfab20be6ffebc13630c081e734cde3bb47`**（本 errata 分支的起点；§11.1）。
>
> **Errata 历史块（2026-07-21，owner 裁决原文转写；逐条覆盖合入版对应条款）**：
> 1. **撤回 ratification**：#4509 合入版 header 所记「RATIFIED（owner 终裁 2026-07-21）……RATIFY
>    授权 §9 切片序开工」**作废**；§15 台账同步撤回（同批 errata PR）。
> 2. **④ 裁决推翻（实质更正一）**：合入版所记「**④=(b) default → ready**（显示「使用平台默认策略」）」
>    被 owner **推翻**——**④ 的 posture `default` 映射判别值 `manual_review_required`，绝不 `ready`**。
>    它可以不阻断 preview-ready（§3.2 维持「不阻断」裁决），但**必须**出现在 ⑦ 的人工 canonical
>    activation checklist 上，由真人在 canonical settings 面确认。`customized→ready`、
>    `unknown→unknown`（fail-closed）不变。
> 3. **③ 依原文不可计算（实质更正二）**：「排班制组存在时另需 hasRotationRules」缺少「排班制组
>    是否存在」的信号来源，合同内无从计算。owner 补齐缺失信号（逐字，§3③）：
>    `scheduledShiftGroupCount = attendance_groups WHERE org_id=$1 AND attendance_type='scheduled_shift'`；
>    `step3Ready = shiftCount > 0 AND (scheduledShiftGroupCount = 0 OR activeRotationRuleCount > 0)`。
>    并显式声明：这是 **org 级存在性判定，不是逐组 rotation 覆盖度**——今日 schema **没有**权威的
>    组↔轮班规则关联（实证见 §3③）。
> 4. **① 被新前置票 W4-PRE-1 阻塞**：owner 侦察结论（本 errata 已逐条对代码复核，见 §3.3）——
>    **没有任何生产写路径维护 `user_orgs`**；在 W4-PRE-1 落地前 ① 只能报 `unknown`。
> 5. **锚点整批勘误**：合入版沿用了 round-2 稿的错误锚点（`index.cjs:14192`/`:37718`/`:41833`/
>    `:37752`/`:13733-13760`/`:6215-6224`、`routes/attendance-production.ts`、
>    `AttendanceView.vue:14389-14396`、章程 `L350-355` 等）；本 errata 以材料库 round-3 勘误表为底、
>    对新基线逐条重开后整批替换（§11.1-附）。重验中发现材料库自身一处偏移：`get leader` 实为
>    `AttendanceScheduler.ts:201-203`（材料写 `:200-202`），已改。
>
> —— 以下 round-1..3 修订史移植自材料库（`daea4301d`），是本锁真实的 owner 审阅血统；合入版 header
> 对 round-3 的转写（含已被推翻的「④=(b)」）不再是权威记录。——
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
> COUNT `index.cjs:31185-31190`；**round-3 漂移刷新：原引 `index.cjs:14192` 为错误锚点**——那是旧班次
> 改名的兼容 helper，不是计数原料）；每步「计划生效时间」入响应结构为 posture；⑦更名 **preview-ready + 人工
> canonical activation checklist**（绝不暗示已启用）；模板时区禁硬编码（取组织显式时区，取不到要求
> 用户选择）。OD 裁决全录 §8；两非阻断项（聚合单 CTE 或短 TTL org-scoped cache；§10 编号 1..7）
> 已吸收。owner：修订完成并再次核对后方建议 PROPOSED → RATIFIED。
>
> **Amendment round-3（2026-07-21，owner 复审 = CHANGES_REQUESTED，0 P1 / 5 P2 + 基线漂移刷新；
> 措辞取自 owner 原文；本轮内容曾仅存于材料分支，未进入 #4509 合入版——errata 移植并重验）**：
> **P2-1 ④步闭环**——posture 比对必须只比**打卡策略闭集**（整包 normalized 比对会被无关设置误判为
> `customized`；实证：`performHolidaySync` 经 `saveSettings` 机器写 `holidaySync.lastRun`，
> `index.cjs:11888-11894`），闭集在 §3.1 逐键点名；且**显式裁定 `manual_review_required`/`default`
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

## 1. Grounded problem statement（现状，全部对 `6ea0ccfab` 实证）

1. **七步无聚合真源。** 全仓唯一 attendance readiness 读端点是 S7-5 的
   `GET /api/attendance-admin/directory-readiness`（`packages/core-backend/src/routes/attendance-admin.ts:392-412`）,
   只覆盖「目录联通」一个维度。组/班次/节假日/规则集/审批流/设置的完备度今天需 5-6 次独立 list
   调用拼装（各端点 `COUNT(*)::int … WHERE org_id=$1` 原料已齐，errata 重开后的准确锚点：
   考勤组 `index.cjs:37720`、班次 `:39710`、规则集 `:32306`、审批流 `:30924-30926`、
   排班规则 `:31185-31190`、节假日 `:41835-41837`）。
   章程 §7-Wave4 L343 明令「不得假设七步都已有统一状态端点」——实证：确实没有。
2. **`AttendanceSetupReadiness.vue` 尚不存在**（章程 §6.2 预留名；main 实证，冻结中的 WIP 分支
   见 header，不在 main）；仓内两个貌似相关的抽取组件
   `AttendanceProvisioningSection.vue` / `AttendanceSettingsSection.vue` **未被任何 src import**（死代码，
   运行时对应区块是 `AttendanceView.vue` 内联版本）——本锁不以它们为接缝。
3. **入口接缝已就绪。** 管理中心默认首屏 = 任务首页（`apps/web/src/views/AttendanceView.vue:14390-14397`
   `hasExplicitAdminSectionTarget()` + `adminTaskHomeOpen = ref(!hasExplicitAdminSectionTarget())`；
   注意宿主文件在 `views/` 根，不在 `views/attendance/`）；新增 admin
   section 只需注册 `ATTENDANCE_ADMIN_SECTION_IDS`（`useAttendanceAdminRail.ts:12-46`）+ nav items/groups
   （`:168-274`），注册后自动获得 `?section=` 深链、rail、快速跳转。章程 §3.4 L147:「实施入口不得与
   员工日常页面混在同一首屏」——admin 侧入口满足。
4. **「只预填不提交」的机制先例已在。** 同宿主预填→跳转：`prefillRequestFromAnomaly`
   （`AttendanceView.vue:1000` 调用点）、`prefillRequestFromRecordTimeline`（`:16051`）直接写 reactive
   表单再走原保存路径；深链只承载 section id（`views/attendance/AttendanceExperienceView.vue:146-149`），
   不支持带参——因此模板预填必须与表单同宿主完成（§5.2），而非发明新 route 参数。
5. **org 隔离双姿态并存（本锁最大安全决策，OD-W4-1）。** S7-5 端点在 core-backend router，带
   `user_orgs` 成员门（`packages/core-backend/src/routes/attendance-admin.ts:367-379`）+ router 级
   `rbacGuard('attendance','admin')`（`:386`）；而 plugin 配置端点的 org 隔离靠 `getOrgId(req)` 完全
   信任客户端传入（`plugins/plugin-attendance/index.cjs:6215-6223`：`req.body.orgId ?? req.query.orgId ??
   user.orgId ?? user.workspaceId ?? x-org-id` 依次取值，无成员校验），`attendance:admin` 是全局权限
   ——A org 受托管理员传 `orgId=B` 即可读 B org 配置计数。
   **平台 admin 依设计绕开该门（P2-4 关键）**：`canReadAttendanceDirectoryReadiness` 在查 `user_orgs`
   **之前**先 `if (hasLegacyAdminClaim(req) || await isRbacAdmin(userId)) return true`
   （`attendance-admin.ts:373`）——因此用平台 admin 跑跨组织矩阵**不能证明 org 门存在**，只能作为
   单列标注的旁路对照（§9 W4-0-G1）。
6. **权限失败信号不可复用全局 flag。** `adminForbidden` 是 last-writer-wins（约 90 处成功路径重置，
   W3 审阅实证）；章程 L358 要求「缺配置与权限不足明确区分」⇒ readiness 面必须 per-surface 信号（§4.3）。
7. **对标事实边界。** tracker 中不存在钉钉「首次启用/快速配置」行为的权威记载（全树 grep 实证）；
   仓内可引的只有章程 §2.1 L82 一行判定（「首次配置与管理导航…明显落后，本轮主战场」）。本锁**不**
   凭记忆补写对手细节（§1.2 L47-48 + OD-VX4 双重禁止）。
8. **（errata 新增）`user_orgs` 无生产维护写路径。** ① 步与 org 门共同依赖的 `user_orgs` 表，
   今天**只有一次性迁移回填**这一个写点；四条生产建人路径全都不写它（逐条实证见 §3.3）。这是
   W4-PRE-1 存在的原因，也是 ① 在其落地前只能报 `unknown` 的原因。

## 2. Scope

**IN（v1，重新 RATIFY 后方可开工）**：七步 readiness 聚合读端点（R1）；`AttendanceSetupReadiness.vue`
+ 纯逻辑模块 `attendanceSetupReadiness.ts`（判别矩阵完整，分支不埋 template——章程 L267-268）；
四模板 FE 常量 + 预填跳转（R3）；向导入口（admin section + 任务首页 action）；§4.6 页内 values-free 帮助。

**OUT（显式）**：一键跨资源提交、任何「万能保存」后端端点（章程 L354-355）；向导写
`/api/attendance/settings`（R4）；S7/通知/外发/生产 flag 的任何自动变更（R4）；移动端 UA 专项
（沿 Wave 1 已知项口径）；对手行为细节对照（§1-7）；Wave 5 explainability（独立 DATA-CONTRACT 门）；
**W4-PRE-1 本身**（§3.3——它是本锁的**前置票**，独立立项、独立完成门，不是 Wave 4 切片，本锁不授权
其 runtime）。

## 3. 七步合同（章程 §4.5 L202-208；①-⑥ 逐字继承，⑦ 见下方显式差异登记）与信号派生矩阵

七步 = ①同步**或**创建组织人员 → ②创建考勤组并选择人员 → ③选择班制与班次模板 → ④配置允许的打卡方式
→ ⑤关联审批流程 → ⑥配置通知渠道与接收范围 → ⑦**预览影响范围（preview-ready，只读）**。
每步必须显示：完成状态、缺失项、影响人数、计划生效时间、预览入口、修复动作（L210）。

**逐字继承的范围与两处显式差异（P2-3 / P2-5e）**：①-⑥ 逐字继承章程 §4.5 L202-207；两处差异登记如下，
不得当作转写失真——
- **①「同步或创建」= OR 语义**（章程 L202 原文）：完成真值 = `orgActiveMemberCount>0`，
  `directoryLinked` 只是**来源/能力 posture**、不参与完成判定。OR 语义的依据：`provider='local'`
  是一等公民 provider（`…/zzzz20260717100000_create_directory_department_bindings.ts:22-23`
  的 `local_provider='local' AND remote_provider<>'local'` CHECK），纯本地组织不会有任何
  `directory_account_links` 行——若用 AND 判定，这类组织**永远不会转绿**。
  **未来态表述（owner P2 勘误 2026-07-21）：W4-PRE-1 落地后，已建立 active membership 的纯本地
  组织方可独立转绿。** 今天**不能**以一次性回填迁移作为「本地组织在 `user_orgs` 有 active 成员」
  的证据（本 errata 早期稿曾如此声称，勘误于此）：该回填
  （`packages/core-backend/src/db/migrations/zzzz20260114110000_create_user_orgs_table.ts:33-41`）
  仅执行一次、**仅写 `'default'` org**、仅覆盖迁移时点已存在且 `is_active` 的 `users` 行，且带
  `checkTableExists(db, 'users')` 守卫（`:32-33`，表不存在则整段跳过）——fresh DB 上迁移时点
  `users` 无行（用户是运行期数据），**可能根本没有可回填行**；非 default 的本地组织即使有存量
  用户也永远得不到行；LOCAL provider 建人路径同样不写 `user_orgs`（§3.3）。
- **⑦ 章程 L208 原文作「预览影响范围并启用」；本锁按 round-2 裁决把 ⑦ 收敛为 preview-only**
  （向导只做只读预览 + 展示人工 canonical activation checklist，绝不暗示已启用，见 §5.3 与 R3/R4）。
  引用保持，语义差异在此显式登记。
- **⑥ 步名逐字保留章程 L207「配置通知渠道与接收范围」，但其中「接收范围」部分今天 = `unsupported`**
  （P2-2）：按组织/按收件人配置接收范围**在仓内不存在**，深链落到的是只读投递历史面。步名不改，
  但 readiness 信号与文案必须如实反映这一点（§3⑥/§4.5(iii)）——不得给出一个不存在的修复动作。

| 步 | 完成信号（values-free 计数/布尔） | 现有原料（file:line） | 修复动作深链（§6，query 形） |
|---|---|---|---|
| ① | **完成真值 = `orgActiveMemberCount>0`**（真源 = `user_orgs` 该 org 的 active 成员数，P2-1：绝不用考勤组成员数——那与步骤②循环依赖；正确计数必须同时要求 `user_orgs.is_active=true` **且** `users.is_active=true`，先例 `index.cjs:15532-15541`「RD-3 target population: active org members only」）；`directoryLinked` **仅为来源/能力 posture，不参与完成判定**（P2-3，OR 语义见上）。**W4-PRE-1 已落地，冻结解除（re-ratify 2026-07-21）**：PR #4521 = `e20371b1a` 建立两条生产写路径——admin 建人（写点现于 `admin-users.ts:3359`、`transaction()` `:3297` 内——#4526 重构后行号；org 对提交的 group/shift 校验）与目录 admission（写点经 #4526 单点化入 helper `upsertActiveUserOrgMembership`，`directory-sync.ts:4912`，DT-HARDEN-02 SAVEPOINT 内、org 自 `directory_integrations` NOT-NULL-FK 解析 fail-closed），均同事务写且被真库三件套+6 刀独立 mutation 锁定（含「挪到事务提交后⇒原子性腿红」承重刀）；**W4-PRE-1b（PR #4526 = `3727cd92e`）补齐完整生命周期**：bind/auto-match/本地建号 upsert、解绑/归档按「同 org 无其他有效绑定」（#4526 机制语义，owner 原句为疑问式表述）条件失活（跨 org 租户谓词独立复核 KILLED-CONFIRMED）、真实存量 backfill 迁移（幂等不复活）、S7-5 门双 `is_active` 过滤——owner P1「只做新建准入」由此闭合——冻结解除的具名前置（W4-PRE-1 落地）由此满足，① 恢复按真数据计算；owner 原话约束「不能只补它便宣布 ① 闭合」继续有效：**是否据此判 ① 闭合，属 owner re-ratify 终裁**（本 PR 只呈证据：写路径存在且被行为验证，非仅补计数口径）。**已知残差（不改判定语义）**：部署级注册与 OAuth JIT 为显式记录的不写路径（`AuthService.ts:299`/`dingtalk-oauth.ts:615`），仅经这两路建人的 org 在 admin/目录面补录前计数为 0，① 如实 `missing`（fail-closed 方向正确） | `user_orgs`（S7-5 门查同表：`attendance-admin.ts:375`）；`directoryLinked` 复用 `readOrgDirectoryReadiness`（`attendance-admin.ts:336-360`，EXISTS-only） | **修复动作 = `POST /api/admin/users`（admin 建人面，路由 `admin-users.ts:3094`——#4526 后行号）**——W4-PRE-1 done-gate 第 5 项具名并行为验证的 create/sync canonical surface；**自 W4-PRE-1b（#4526）起对全新组织真无条件**：带显式 `attendanceOrgId`（`admin-users.ts:3109`）即写 membership，不再依赖考勤组/班次前置（owner P2「步骤循环」修复；「org 存在」采 validate-can-fail 读法即 404 拒不可知 org——双读法已呈 owner，#4526 body）。**角色化合同（owner P2，W4-1 强制）**：该面权限门为平台 admin（`ensurePlatformAdmin`，def `admin-users.ts:351`，路由首行即调）——向导展示修复动作**必须按查看者角色分支**：平台 admin 见可操作深链（canonical query 形，依 R2）；受托 `attendance:admin` 见「联系平台管理员」说明性文案，**绝不渲染必然 403 的操作入口**（`UserManagementView.vue:27` 页面提示同源）。目录已联通 org 亦经目录 admission/bind 自动补录（helper `directory-sync.ts:4912`，admission/bind/sync-loop 共用写点）。历史注记：errata 冻结期此格曾为 `unavailable`（`attendance-admin-user-access` 只管权限不管成员资格，不得顶替——该排除继续有效） |
| ② | `groupCount>0 && groupsWithMembers>0` | `index.cjs:37720`（`COUNT(*)::int … FROM attendance_groups WHERE org_id=$1`；同端点列表带 member_count 子查询） | `attendance-admin-groups` |
| ③ | **owner errata 逐字**：`scheduledShiftGroupCount = attendance_groups WHERE org_id=$1 AND attendance_type='scheduled_shift'`；`step3Ready = shiftCount > 0 AND (scheduledShiftGroupCount = 0 OR activeRotationRuleCount > 0)`。**显式声明：这是 org 级存在性判定，不是逐组 rotation 覆盖度**——今日 schema 没有权威的组↔轮班规则关联（`attendance_rotation_rules` 无 group 列，`zzzz20260120114000_create_attendance_rotation_tables.ts:12-23`；`attendance_rotation_assignments` 把规则绑到**用户**而非组，`:30-44`）。原稿「排班制组存在时另需 hasRotationRules」不可计算：合同内没有「排班制组存在」的信号来源 | `index.cjs:39710`（attendance_shifts COUNT）；`index.cjs:31185-31190`（attendance_rotation_rules 的 org-scoped COUNT，`is_active` 过滤即 `activeRotationRuleCount`）；`attendance_type` 值域 CHECK ∈ {fixed_shift, scheduled_shift, free_time}（`zzzz20260529213000_add_attendance_group_type.ts:12-27`；type 过滤先例 `index.cjs:15187`） | `attendance-admin-shifts` |
| ④ | `punchPolicyPosture ∈ {default, customized, unknown}`（**values-free posture，`scope=deployment`**，比对范围 = §3.1 **打卡策略闭集**且仅此闭集；posture 由**后端内部语义检查**得出（OD-W4-4=(c)：闭集逐键与 normalized defaults 比对，前端只收枚举））。**判别值映射（owner errata，推翻合入版 ④=(b)）**：`customized→ready`（「已自定义」）、**`default→manual_review_required`（「待确认：当前使用平台默认策略」），绝不 `ready`**、`unknown→unknown` fail-closed。`manual_review_required` 不阻断 ⑦ preview-ready（§3.2），但**必须**出现在 ⑦ 人工 activation checklist 上 | `system_configs key='attendance.settings'`：SETTINGS_KEY `index.cjs:291`、`DEFAULT_SETTINGS` `:295-512`、`loadSettings` `:13715-13725`、`saveSettings` `:13749-13759`（单键、无 org 维度、写入完整 normalized 结果） | `attendance-admin-settings` |
| ⑤ | `approvalFlowCount>0`（含 active 判定） | `index.cjs:30924-30926` | `attendance-admin-approval-flows` |
| ⑥ | **三个互不等价的信号（P2-2，不得合并）**：(i) `deliveryRuntime ∈ {ready, not_ready, unknown}`（部署运行期就绪）；(ii) `orgRecipientBinding: {boundRecipientCount, hasAnyBoundRecipient}`（组织收件人绑定覆盖）；(iii) `recipientScopeConfig = 'unsupported'`（收件范围配置——**今天不存在该能力**，恒为 `unsupported`，不得显示为「未配置/去配置」）。判据与真源见 §4.5 | (i) `AttendanceScheduler.ts:310-320/399-412` + `packages/core-backend/src/index.ts:2482-2492`；(ii) `AttendanceNotificationDeliveryWorker.ts:484-501`（directory_account_links ⋈ directory_accounts ⋈ directory_integrations）；(iii) `AttendanceNotificationDeliveryWorker.ts:202-207`（per-org/per-recipient 路由是 design-lock §3 **follow-up**，非现状） | `attendance-admin-notification-deliveries`（**只读投递历史**，`AttendanceView.vue:1722-1737`：「仅读取 C5 outbox 的投递真实状态」；深链文案必须写「查看投递历史」，**不得**写「配置接收范围」） |
| ⑦ | **`previewReady` = ①②③⑤ 四步全 `ready`**；④⑥ 为 advisory，**不参与** previewReady 判定（§3.2）；步名 = **「预览影响范围（preview-ready）」**——向导只做只读预览 + 展示**人工 canonical activation checklist**（逐项列出真人要去哪些 canonical 面完成启用，④ 的 `manual_review_required`/posture 与 ⑥ 的三信号**必然逐项出现在该 checklist 上**），**绝不暗示已启用**（round-2）；影响人数=①②计数派生。**errata 注**：W4-PRE-1 落地前 ① 恒 `unknown` ⇒ previewReady 不可达——这正是冻结的语义（W4-0 本就排在 W4-PRE-1 之后，见 §9/§10 顺序），非状态机卡死 | 聚合派生 | （无——预览在向导内，只读） |

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

### 3.2 ④/⑥ 的闭环裁决（round-3 P2-1「不阻断」维持 + errata ④ 映射更正）

`attendance.settings` 是**部署级单键、无任何确认时间戳/确认人字段**，因此「管理员已显式接受默认策略」
在今天**没有持久真源**；本锁**不**新增确认写面（owner 选项 A），因为那要么改这个单键、要么另建写路径，
两者都与 R4「向导对 settings 整体禁写」及章程 §7-Wave4 L351-355 首版禁止清单相撞。
**owner errata 定稿（推翻合入版「④=(b) default→ready」）**：

> **④ 的 `default` 映射 `manual_review_required`（「待确认：当前使用平台默认策略」），绝不 `ready`。**
> `manual_review_required`（含 ④ 的 `default`）与 ⑥(iii) 的 `unsupported` **不阻断 ⑦ preview-ready**：
> `previewReady = ①②③⑤ 四步全 ready`；④⑥ 的 posture 一律 advisory，**必然**逐项出现在 ⑦ 的人工
> canonical activation checklist 上，由真人在 canonical 面确认/完成。

两条不可混淆的推论：①「不阻断」**不等于**「显示为已完成」——④ 的 `default` 显示「待确认」并深链
canonical settings 面、`unknown` 仍 fail-closed 显示「未知，去核查」（章程 L232），⑥(iii) 仍显示
`unsupported`（「当前版本不支持按组织配置接收范围」）；②因此 ⑥(i) 的 `unknown`（见 §4.5：投递作业
注册状态今天不可观测）**不会把组织卡死**在永远到不了 preview-ready 的吸收态（① 的冻结期 `unknown`
另有具名恢复路径 = W4-PRE-1，见 §3③①行内注）。

判别值域（纯模块判别矩阵的行）：`ready / missing / forbidden / unknown / manual_review_required /
unsupported / db_not_ready`，
且每信号携带 `scope: 'org' | 'deployment'`（全局信号显式标 `deployment`，追加门禁 2）——
`forbidden` 为 per-surface（§4.3），`unknown` fail-closed 显示为「未知，去核查」，绝不显示为已完成
（章程 L232 未知态红线）；`manual_review_required` 显示为「需人工确认」并给出**指向 canonical 面的深链**
（向导本身不提供确认动作——R4）；`unsupported` 显示为「当前版本不支持」，**不得**渲染成「未配置/去配置」
（否则给出一个不存在的修复动作）；`db_not_ready` 对应各端点统一 503 `DB_NOT_READY` 档
（`index.cjs:37751` 等）。三者与 `missing` 语义严格分离（章程 L358），且按上文均**不阻断** `previewReady`。
**「计划生效时间」逐步来源规则（追加门禁 4 + round-2 结构闭合；re-ratify 勘误 2026-07-22 恢复
#4509 已锁四态合同）**：生效时间入响应结构为逐步 posture
`effectiveTime: {source: <权威来源标识>, posture: 'immediate'|'scheduled'|'manual_activation'|'undeterminable', effectiveAt?}`
——立即生效 `immediate`；有权威定时来源（如排班生效日、节假日同步窗口）为 `scheduled` 且**必须携带
`effectiveAt`**；需人工启用为 `manual_activation`；无权威来源为 `undeterminable` 显示「无法确定」，
**不得省略、不得猜测**；各步来源在 W4-0 判别矩阵逐行登记。
**回退勘误记录（owner P2 复核 2026-07-21）**：errata #4513 曾将此处静默回退为
`'known'|'undeterminable'` 且丢失 `effectiveAt`，而 #4509 已锁四态、errata 未记录撤销该裁决——本次
恢复 #4509 合同并将该回退在此记录为勘误。

### 3.3 W4-PRE-1（新前置票，owner errata 2026-07-21）——`user_orgs` 生产维护写路径

**owner 侦察结论 + 本 errata 对 `6ea0ccfab` 的逐条代码复核（三条声称全部证实）**：

- **全仓写点盘点（双语法 grep：raw `INSERT INTO user_orgs` + kysely `insertInto('user_orgs')`，
  含 UPDATE/DELETE）**：生产代码（`packages/core-backend/src`、`plugins`、`apps`）中 `user_orgs`
  的**唯一写点**是一次性迁移回填
  `zzzz20260114110000_create_user_orgs_table.ts:33-41`（`users WHERE is_active=true` 全量 →
  `'default'` org）。其余全部命中都是**读**（`attendance-admin.ts:375` org 门、
  `api-tokens.ts:155`、`AttendanceNotificationDeliveryWorker.ts:1335`、
  `automation-executor.ts:4084`、`dingtalk-group-destination-service.ts:215-234`、
  `index.cjs` 各处）或测试/staging smoke 夹具。
- **声称一（证实）：admin 建人不写 `user_orgs`。** `POST /api/admin/users`
  （`packages/core-backend/src/routes/admin-users.ts:3072`）写 `users`（`:3215`）、
  `user_roles`（`:3241`）、`user_permissions`（`:3252`）、attendance onboarding 的
  `attendance_group_members`（`:3269`）与 `attendance_shift_assignments`（`:3284`）——
  **全文件零 `user_orgs`**。注意该路径在带 `attendanceOrgId` 时**明知权威 org** 却不落成员表。
- **声称二（证实）：目录同步 admission 不写 `user_orgs`。**
  `createDirectoryAdmittedUserInTransaction`（`packages/core-backend/src/directory/directory-sync.ts:4976`）
  写 `users`（`:5066`）+ 目录绑定（`applyDirectoryAccountBindInTransaction` `:4829` →
  `INSERT INTO directory_account_links` `:4960`）——**全文件零 `user_orgs`**。
- **声称三（证实）：`attendance-admin-user-access` 深链管的是权限，不是成员资格。**
  该 section（「User Access / 用户权限」，`AttendanceView.vue:3301-3318`）的动作是
  `loadProvisioningUser` / `grantProvisioningRole` / `revokeProvisioningRole`
  （`:20142/:20160/:20214`），grant 调 `POST /api/attendance-admin/users/:id/roles/assign`
  （`:20171-20174`，role templates）——不触碰 `user_orgs`。
- 其余生产建人写点（同属 W4-PRE-1 盘点范围）：`AuthService.ts:527`（注册）、
  `packages/core-backend/src/auth/dingtalk-oauth.ts:642`（OAuth JIT 建人）——亦不写 `user_orgs`。

**W4-PRE-1 票面（记录于此，独立立项，本锁不授权其 runtime）**：
1. 盘点**每一个**建人/目录 admission 写点（上列四处起步，含未来新增），在**已知权威 org** 的路径上，
   于**同一事务**内维护 `user_orgs`（admin 建人带 `attendanceOrgId` 的场景是第一优先）；
2. 权威 org 不可知的路径（如部署级注册）显式记录其策略，不得静默猜测 org；
3. 测试三件套：**fresh-DB**（新库直装后建人 ⇒ `user_orgs` 行在）/ **upgrade**（旧库迁移后新建人 ⇒
   行在，且回填行不被破坏）/ **two-org**（A/B 两 org 各自建人 ⇒ 计数互不串）；
4. 计数正确性口径：`user_orgs.is_active=true` **且** `users.is_active=true`
   （先例 `index.cjs:15532-15541`「RD-3 target population: active org members only」）——
   但**只补双 is_active 不闭合 ①**（owner：不能只补「双 is_active」便宣布闭合；真值来源必须先有人维护）；
5. **done-gate 增项（owner P2 勘误 2026-07-21）：具名并验证「建人/同步成员」的真实 create/sync
   canonical surface**（file:line + 行为验证：经该面建人/同步 ⇒ 同一事务内 `user_orgs` 行在）——
   它是重新 ratify 时回填 §3① 行修复动作深链的**唯一合法来源**；在此之前 ① 的修复动作恒为
   `unavailable`（§3① 行），不得以任何既有面（含 `attendance-admin-user-access`）顶替。

**顺序（owner 裁定）**：本 errata 合入（过 docs-vs-code 门）→ W4-PRE-1 落地 → 重新 ratify 本锁 →
方开 W4-0。**（进度 2026-07-21：票面五项已全部落地 = PR #4521 `e20371b1a`，Opus 门 APPROVE 0 P1/P2，
done-gate 第 5 项产出 `POST /api/admin/users`；验证 MD 与本 re-ratify 同批入仓。）**

## 4. Readiness 聚合契约（R1）

**4.1 端点（OD-W4-1 已裁 =(a)）**：`GET /api/attendance-admin/setup-readiness?orgId=…`，落
core-backend `attendance-admin.ts` router——继承 router 级 `rbacGuard('attendance','admin')` + S7-5 同款
`user_orgs` org-membership 门 + 平台 admin 直通（`:367-379` 先例逐字复用）。**不选** plugin 路由：
那将继承「信任客户端 orgId」缺口（§1-5），对一个汇总全 org 配置面的端点不可接受。
**4.2 响应形状（values-free by construction）**：仅布尔、非负整数计数与闭合枚举，每信号带 `scope` 标记

```
{
  directoryLinked,              // scope=org，仅 source/capability posture，不参与 ① 完成判定（P2-3）
  orgActiveMemberCount,         // scope=org，① 的完成真值（W4-PRE-1 落地前 ① 判别恒 unknown，§3③①行）
  groupCount, groupsWithMembers,
  shiftCount,
  scheduledShiftGroupCount,     // scope=org（errata 新增，③ 的缺失信号：owner 逐字定义见 §3③）
  activeRotationRuleCount,      // scope=org（原稿名 rotationRuleCount；errata 依 owner 公式定名，
                                //   = attendance_rotation_rules org-scoped COUNT with is_active=true）
  hasRotationRules,             // = activeRotationRuleCount > 0（派生）
  approvalFlowCount,
  punchPolicyPosture,           // 'default'|'customized'|'unknown'，scope=deployment，比对范围=§3.1 闭集；
                                //   判别映射 default→manual_review_required（errata，绝不 ready）
  notify: {                     // P2-2 三信号，互不等价，不得合并
    deliveryRuntime,            // 'ready'|'not_ready'|'unknown'，scope=deployment
    orgRecipientBinding: { boundRecipientCount, hasAnyBoundRecipient },   // scope=org
    recipientScopeConfig        // 恒为 'unsupported'，scope=deployment（§4.5）
  },
  previewReady,                 // = ①②③⑤ 全 ready（§3.2），④⑥ 不参与；③ 按 step3Ready（§3③）
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
底层 `integration/db/connection-pool.ts:155-175` 真发 `BEGIN`/`COMMIT`/`ROLLBACK` 于独占 client），
handler 的**第一条**语句为 `SET TRANSACTION READ ONLY`，其后才跑各计数。**明令禁止**用「首词是否为
SELECT」或任何正则来证明只读：那既拦不住 data-modifying CTE（`WITH x AS (DELETE … RETURNING *)
SELECT * FROM x` 首词就是 `WITH`/`SELECT`），也拦不住多语句串。只读事务是**执行期**约束，两类都由
Postgres 直接报错拒绝。配套三条必红测试见 §9 W4-0-G2。

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
两者在 `packages/core-backend/src/index.ts:2482-2492` 汇合（type-guard 过滤 null 后传 `jobs`）。
**因此单读 `ATTENDANCE_NOTIFICATION_DELIVERY_WORKER_ENABLED` 不足以证明任何事**——这正是 owner 点名的不足。
判据：
- `schedulerStarted` **今天可观测**：`getSharedAttendanceScheduler()`（`AttendanceScheduler.ts:318-320`）
  非 null ⇔ 调度器已构造并 `start()`。
- `deliveryJobRegistered` **今天不可观测**：作业表 `private jobs`（`AttendanceScheduler.ts:84`），
  类上只有 `registerJob()`（`:205-214`）、模块级包装 `registerAttendanceSchedulerJob`（`:321-323`）
  与 `get leader`（`:201-203`），**没有任何列举/查询已注册作业名的公开访问器**。本锁**不发明**该 API。
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
（`createAttendanceDeliveryChannelsFromEnv` `:370-401`，各渠道 `env.* === 'true'` 才 push）。

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
——round-1 的「只读存在性」表述已被 round-2 的 OD-W4-4(c) 取代，round-3（P2-5）在此彻底删除，
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
或 `?section=` query 深链（`views/attendance/AttendanceExperienceView.vue:146-149` 只接受
`attendance-admin-` 前缀的 `route.query.section`，不带其他参数）；禁 hash 形；禁新增 route 参数。
中途退出即自然落在 canonical form，无需「恢复」状态机——向导本身无持久向导态（readiness 是重进即重算
的派生，非流程状态）。
**⑥步例外说明**：其深链落到只读投递历史面，文案必须写「查看投递历史」而非「去配置」（§4.5(iii)）。
**6.3 帮助（OD-VX4 已裁）**：每步页内上下文帮助四类内容（章程 §4.6 L216-225），values-free 红线
逐字继承；不复制外部手册。

## 7. 组件与文件形状

- `apps/web/src/views/attendance/attendanceSetupReadiness.ts`（新，纯模块）：聚合响应 → 七步
  判别矩阵，**值域必须与 §3 完全一致（P2-5c）**：
  `ready / missing / forbidden / unknown / manual_review_required / unsupported / db_not_ready`
  （七值，一个不少——round-2 稿此处漏列 `manual_review_required`，round-3 补齐并新增 `unsupported`）；
  另导出 `previewReady` 派生（= ①②③⑤ 全 `ready`，§3.2；③ 按 step3Ready）。零 DOM/零 fetch；
  单测覆盖判别矩阵全行 + mutation 目标（任一判别分支取反 ⇒ 对应腿红），并含**值域穷尽断言**
  （模块导出的值域常量恒等于上述七值集合）。
- `apps/web/src/views/attendance/AttendanceSetupReadiness.vue`（新，章程 §6.2 预留名，main 确认尚不存在）：
  纯展示 props（`tr` + steps 数组）+ emit（`select-section`/`open-template`）——AttendanceAdminTaskHome
  同型（props/emit 先例 `AttendanceAdminTaskHome.vue:105-112`）；tokens.css `--ms-*`（新组件零硬编码 hex，
  不以存量 hex 债为先例）。
- 父层 `apps/web/src/views/AttendanceView.vue`（注意在 `views/` 根，不在 `views/attendance/`）：
  readiness 加载/聚合调用/模板预填写入/section 注册（§6.2「留父层」条款）。
- `packages/core-backend/src/routes/attendance-admin.ts`：`setup-readiness` 端点 + 契约单测
  （S7-5 测试同型：状态码矩阵 + SQL values-free 断言 + 响应键集合锁定）。
- guard 接线（§8.1.4）：新 spec 进 run-list 显式 pattern + 双 path filter + 收集证明 + 同命令 mutation。

## 8. Open Decisions（OD-W4）——**owner 2026-07-21 round-2 已全部裁决（DECIDED）；④ 判别映射经
errata 更正**

| OD | 裁决 |
|---|---|
| OD-W4-1 | **(a)** core-backend + `user_orgs` 门；授权检查**先于任何聚合 SQL**；双组织伪造 orgId 真库测试（测试身份合同 = §9 W4-0-G1） |
| OD-W4-2 | **(a)**；拒绝 localStorage 首访提示——「未完成」徽标由 readiness 派生 |
| OD-W4-3 | **(a)** + 附加条件：动态时区、覆盖确认、取消快照恢复合同（§5.2） |
| OD-W4-4 | (a)/(b) 均拒；**新增并裁定 (c)**：后端内部语义检查（与 normalized defaults 比对），前端仅收 values-free posture `default/customized/unknown`。*round-3 P2-1 细化（不改裁决，只收窄比对范围）：比对范围 = §3.1 打卡策略闭集，非整包 settings。**errata 更正判别映射：`default→manual_review_required`，绝不 `ready`（推翻合入版 ④=(b)）** * |
| OD-W4-5 | **(b)**：W2 英文错误串另开小刀，**不混入 W4-0 readiness 安全底座** |
| OD-W4-6 | **(a)**：人员数取 active `user_orgs`（双 is_active，§3③①行；前置 W4-PRE-1）；组覆盖数单独取 group membership |
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

## 9. 切片（**FROZEN**——严格串行，且必须先 W4-PRE-1、再重新 RATIFY 方可开工；每片完成门 = 章程
§8.1 十一门 + 本锁红线负向断言 + Opus 对抗审 0 P1/P2 + PR 门禁记录）

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

  **W4-0-G3 ①步两个正控（P2-3，缺一不可；依 W4-PRE-1 落地为前提——落地前 ① 恒 `unknown`，
  两正控在 W4-PRE-1 完成门先跑一遍，W4-0 完成门复跑）**——
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
  正控：只改 `punchPolicy.unscheduled.mode` ⇒ `customized`（判别 `ready`）；
  **负控（关键）**：只改 `holidaySync.lastRun`（模拟后台同步机器写，`index.cjs:11888-11894`）
  或只改 `annualLeavePolicy` ⇒ 仍为 `default`（若实现整包比对，该用例必红）——且 `default` 的判别
  必须是 `manual_review_required`（若实现把 default 映射 `ready`，该断言必红——errata ④ 更正的
  可执行化）。

- **W4-1 向导壳与七步导航**：`AttendanceSetupReadiness.vue` + section 注册 + 任务首页 action + 帮助。
  红线断言：R2（深链全 query 形，负向：hash 导航零出现）+ §3 未知态 fail-closed 显示 +
  **⑥步文案负向断言**：⑥ 的修复动作文案不得含「配置接收范围」类措辞（§4.5(iii)），
  且 `unsupported` 不得渲染成「未配置/去配置」。
- **W4-2 模板预填 + ⑦预览**：模板常量 + 预填跳转 + 预览派生。红线断言：R3（preview 期零写请求）+
  R4（受禁开关全清单的「向导不触碰」负向测试：mock 层断言向导交互全程对 settings PUT / flag 类端点
  零调用）+ **⑦文案负向断言**：不含「已启用/enabled」类完成时态（§5.3）。
- **三视口证据（1440/1024/390，拍前真在场断言 + 目检）= W4-1 与 W4-2 两片**；
  **W4-0 三视口 N/A**（无 UI，见上；P2-5d：round-2 稿此处的「每片三视口」与 W4-0 的 N/A 冲突，
  round-3 改为逐片限定）。波次验证 MD 每片必出；章程 §9 指标（20 分钟到 preview-ready，无 JSON/内部 ID）
  在 W4-2 收口用合成 org 实测——**该合成 org 必须能真的到达 preview-ready**，这正是 §3.2 闭环裁决
  存在的原因（否则 ④「待确认」或 ⑥ `unknown` 会让该指标永远不可达；① 侧的前提是 W4-PRE-1 已落地）。

## 10. 完成定义与 ratify 流程

**完成定义**：三切片全合 + 验证 MD 在 main + §9 指标合成实测记录（含 **W4-0-G1..G5 五组门全绿**）
+ 红线四条各有存活的负向断言。
本锁不改变：S7 flag 默认 OFF、真实租户视觉复核等 operator 项（owner 裁决⑥，不计 UI 完成度）。

**重启序（owner errata 裁定，取代合入版「预写 ratify 收尾序」）**：
① 本 errata PR 合入（docs-only，过 docs-vs-code 门）——RATIFICATION SUSPENDED / W4-0 FROZEN 生效
→ ② **W4-PRE-1** 独立立项、落地（§3.3 票面 + fresh-DB/upgrade/two-org 三件套完成门）
→ ③ 锁分支刷新至最新 main（drift 复核）+ owner 重新 ratify（SUSPENDED → RATIFIED，记录日期与
W4-PRE-1 完成证据）
→ ④ 章程 §15 Wave 4 行同步
→ ⑤ 之后才从新 main 开 W4-0（§9 切片序）。

**重启序进度（2026-07-21）**：① ✅ errata #4513 合入 = `57d89bc1d`；② ✅ W4-PRE-1 = PR #4521 合入
`e20371b1a`（Opus 门 APPROVE 0 P1/P2，门记录 comment-5038977540，验证 MD 同批入仓）；③ = 本
re-ratify PR（锁分支基最新 main `3727cd92e`；drift 账：`6ea0ccfab..749ba92d0` 考勤面零漂移、
`749ba92d0..57d89bc1d`=errata 本身、`57d89bc1d..e20371b1a`=#4521 本身、`e20371b1a..3727cd92e`=#4526
本身（admin-users +70/directory-sync +283 使 #4521 时代行号位移）——**现势锚点已对 `3727cd92e`
重验并校准**（rev2 预审 P2-1 吸收；errata 时点锚点保留其原基线限定不改）；④ 章程 §15 行同步（同 PR）；⑤ W4-0 于本 PR 合入后开工。
**首轮呈审后进度**：owner CHANGES REQUESTED（2026-07-21，1P1+3P2）→ W4-PRE-1b #4526=`3727cd92e`
（P1 生命周期+P2 步骤循环，门链见 header）→ 本次修订吸收 P2 角色化+P2 effectiveTime（docs）——
四 findings 全闭合，重呈 owner 复审+RATIFY。

## §11.1 六项记录（章程 L459-468）

1. 基线 SHA：**`6ea0ccfab20be6ffebc13630c081e734cde3bb47`**（origin/main，本 errata 分支起点，
   2026-07-21）。材料库基线 `1f06ecea9` → 本基线区间 = 4 个提交（`381e2f8a4` automation dispatch、
   `1ab788a77` ops OAuth 记录、`d0c1669b2` 即 #4509 锁文档本身、`6ea0ccfab` stock-prep sidecar
   #4512——与考勤无关），`git diff --stat` 对
   `plugins/plugin-attendance`、`packages/core-backend/src/{routes,services,middleware}/attendance*`、
   `packages/core-backend/src/index.ts`、`packages/core-backend/src/db`、`apps/web/src/views/**` 全空
   ⇒ **本锁引用的运行时事实自 round-3 重开以来零漂移**；本 errata 仍对本基线逐条重开了全部锚点
   （结果：仅材料库一处自误 `get leader :200-202` → 实为 **`:201-203`**，已改；其余全数复核无误）。
2. 查重（对 `6ea0ccfab` 重跑）：
   - 全仓 grep `setup-readiness|setupReadiness|SetupReadiness`（`apps/ packages/ plugins/`，
     `.ts/.vue/.cjs`）⇒ **main 上 0 命中**；
   - 全仓考勤域 readiness 端点 ⇒ 仅 `attendance-admin.ts:392` 的 `directory-readiness`
     （S7-5，单维度）；`packages/core-backend/src/routes/federation.ts:1373/3115` 的
     `release-readiness` 属 PLM 联邦域，**同名不同域**，不构成重复。
   - `AttendanceSetupReadiness.vue` / `attendanceSetupReadiness.ts` main 上**均不存在**（`ls`
     `apps/web/src/views/attendance/` 实证）；`AttendanceProvisioningSection.vue` /
     `AttendanceSettingsSection.vue` 存在但**零 import**（死代码，§1-2 结论维持）。
   - 在飞分支（errata 时点实况）：`claude/w4-onboarding-design-lock-20260721-5p2-round3`
     （`daea4301d`，只读材料库，待关闭为历史证据）与
     `claude/w4-0-setup-readiness-20260721`（errata 时点 `eb98e6f0a`；门审时已前进至**最终冻结
     head `b2789cce7`**；曾于竞态期开出 **PR #4514——现已 CLOSED、未合并**，问责见该 PR 关闭说明
     与 #4513 comment-5032093531；**该分支及后续任何前进均在冻结范围内，冻结期不得再开 PR、
     不得合入**）——
     除此之外无同题分支。
3. 修改文件：本 errata PR 仅两份文档（本文 + 章程 §15 行，docs-only）；未来切片碰撞车道 =
   `AttendanceView.vue`（单热文件串行，与 Wave 5 不并开——owner 裁决⑤）。
4. IN/OUT：§2（W4-PRE-1 显式 OUT，独立立项）。
5. 权威数据源/唯一写路径/权限真源：readiness 真源 = `setup-readiness` 聚合（各计数 SQL 单点）；
   向导零写路径（唯一写 = 既有表单各自的保存端点）；权限真源 = router 级 rbacGuard + `user_orgs` 门
   （① 计数真源在 W4-PRE-1 落地前**不可信**，§3.3）。
6. 完成门与 mutation 目标：§9 各片列出；对抗审 0 P1/P2 每片必过。

### §11.1-附 锚点勘误表（round-3 首开于 `1f06ecea9`，errata 对 `6ea0ccfab` 逐条复验；合入版 #4509
沿用的是下表「原稿锚点」列的错误值，本 errata 一并替换）

**结论先行**：`6feff1b2b → 1f06ecea9 → 6ea0ccfab` 之间**没有任何 attendance 运行时文件变更**，因此
**零条锚点因 main 前进而移动**。下表全部是**round-2 稿自身的错误**（错行/错路径/错文件/引错语义），
按 owner 要求逐条登记为 finding 而非静默修正；合入版 #4509 未吸收这些勘误，故其正文锚点不可信，
以本文为准。

**A. 语义错误（引用指向了完全不同的代码，影响结论可信度）**

| # | 原稿锚点 | 原稿声称 | 实际 | 更正 |
|---|---|---|---|---|
| 1 | `index.cjs:135` | `SETTINGS_KEY`（部署级单键） | 135 行是审批步骤解析（`if (!step \|\| typeof step !== 'object') return null`），与 settings 无关 | `SETTINGS_KEY` = **`:291`**；`DEFAULT_SETTINGS` = **`:295-512`**；出现两处（round-1 修订说明、§3④）均已改 |
| 2 | `index.cjs:14192` | `rotationRuleCount` 的计数原料 | 14190-14199 是旧班次改名的兼容 helper（`SELECT id, shift_sequence … WHERE org_id=$1 AND EXISTS(…)`），**不是 COUNT** | org-scoped COUNT = **`:31185-31190`**（带 `is_active` 过滤）；§1-1、§3③、round-2 修订说明均已改 |
| 3 | `AttendanceScheduler.ts:311-400` 含 `ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_ENABLED` | 该 env 在调度器 | 该文件内**无**此 env；它在 `plugins/plugin-attendance/index.cjs:119` | §5.4 已按逐条 env → 逐条锚点重写 |

**B. 路径错误（文件不在所写目录，按原路径打不开）**

| # | 原稿路径 | 实际路径 | 备注 |
|---|---|---|---|
| 4 | `packages/core-backend/src/routes/attendance-production.ts` | `packages/core-backend/src/**middleware**/attendance-production.ts` | `routes/` 下**不存在**该文件；行号 `:461-462/:470/:481-489` 复核无误（§4.4 已注明勘误） |
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
| 16 | `AttendanceScheduler.ts:200-202`（`get leader`，材料库自误，errata 新发现） | **`:201-203`** | 200 是空行；getter 体在 201-203。§4.5(i) 已改 |

**D. 复核无误（errata 对 `6ea0ccfab` 逐条重开，行号与语义均正确，登记以证明真的开过）**
`attendance-admin.ts:336-360`（`readOrgDirectoryReadiness`）、`:367-379`
（`canReadAttendanceDirectoryReadiness`）、`:373`（平台 admin 旁路）、`:375`（`user_orgs` 查询）、
`:386`（router 级 `rbacGuard`）、`:392-412`（S7-5 端点）、`:323-330`（`hasLegacyAdminClaim`）；
`index.cjs:39710`（班次 COUNT）、`:30924-30926`（审批流 COUNT）、`:43053-43058`（settings 保存即重排程
+ 发事件，R4 依据）、`:37804-37811/:37824-37826`（考勤组保存校验）、`:6389`
（`resolveExplicitTimeZoneOrThrow`）、`:15251/:15329/:15484/:15493`（四个 reactive 表单）、
`:14593-14601`（`selectAdminSection`）、`:1000`/`:16051`（两处预填先例）、`:14452`
（`adminTaskHomeGroups`）、`:287`（`ATTENDANCE_GROUP_TYPES`）、`:15187`（`attendance_type='scheduled_shift'`
过滤先例）、`:15532-15541`（RD-3 双 is_active 先例）、`:11888-11894`（`performHolidaySync` 机器写）、
`:20264-20310`（`enforcePunchConstraints`）、`:25348/:25380/:25418-25422`（打卡路由）、
`:12549-12673`（`normalizeSettings`）、`:20474/:20500`（`scheduleHolidaySync`）、`:18573`（merge 读点）、
`:296-511`（24 顶层键逐键行号见 §3.1）、`:119`（dynamic-assignee env）、
`:14749/:14753/:14760/:14768`（auto-shift/report envs）、`:297/:324/:356/:378/:386/:476`
（settings enabled 键）；
`AttendanceScheduler.ts:84`（`private jobs`）、`:205-214`（`registerJob`）、`:310-311`/`:318-320`/
`:321-323`/`:334`/`:363`/`:380`/`:399-412`；`packages/core-backend/src/index.ts:2482-2492`（双门汇合）；
`packages/core-backend/src/db/pg.ts:22-26` + `integration/db/connection-pool.ts:155-175`（事务助手）；
`AttendanceView.vue:1722-1737`（只读投递历史面）、`:11682`（`defaultTimezone` = 浏览器时区）、
`:3301-3318`（User Access 面）、`:20142/:20160/:20214`（provisioning 三动作）；
`useAttendanceAdminRail.ts:12-46`/`:168-274`；`views/attendance/AttendanceExperienceView.vue:146-149`；
`AttendanceAdminTaskHome.vue:105-112`/`:175-179`；`engine/template-library.cjs:288-293`；
`admin-users.ts:3072/:3215/:3241/:3254/:3269/:3284`；`directory-sync.ts:4829/:4976/:5066`（+`:4960`
绑定写点）；`AuthService.ts:527`；`auth/dingtalk-oauth.ts:642`；`api-tokens.ts:155`；
migrations `zzzz20260114110000_create_user_orgs_table.ts:33-41`、
`zzzz20260717100000_create_directory_department_bindings.ts:22-23`、
`zzzz20260120114000_create_attendance_rotation_tables.ts:12-23/:30-44`、
`zzzz20260529213000_add_attendance_group_type.ts:12-27`；
章程 `L47-48/L82/L147/L202-208/L210/L211/L216-225/L232/L267-268/L343/L351-355/L358/L459-468`。

**E. 已不存在的引用** —— 无。逐条重开后，本锁引用的每个文件与符号在 `6ea0ccfab` 上均存在；
唯一「打不开」的是 B-4 的 `routes/attendance-production.ts`，但那是 round-2 稿写错目录，文件本身在
`middleware/` 下健在。

## 附录 A：四模板预填字段集（满足表约束的最小合法集）

| 模板 | attendance_type | 预填示例字段（全部走既有表单校验） |
|---|---|---|
| 办公室固定班 | `fixed_shift` | 组名、时区=组织时区/用户选择、班次 09:00-18:00、working_days [1..5]、宽限 10/10 |
| 门店排班 | `scheduled_shift` | 组名、时区=组织时区/用户选择、早/晚两班次模板、轮班规则提示（③ step3Ready 信号联动） |
| 工厂多班次 | `scheduled_shift` | 组名、时区、三班次模板、跨夜 is_overnight 示例 |
| 销售/外勤 | `free_time` | 组名、时区、外勤打卡方式提示（深链 settings 表单，不代存） |

（字段值为预填示例，不代表保存；保存校验以各表单/端点现行规则为准——`index.cjs:37804-37856` 等。）
