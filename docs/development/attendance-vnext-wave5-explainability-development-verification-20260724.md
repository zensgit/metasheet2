# 考勤 vNext Wave 5（explainability）开发与验证记录 — 2026-07-24

> 规格真源：`attendance-vnext-wave5-explainability-data-contract-lock-20260722.md`（**RATIFIED**，
> owner 终裁 comment（PR #4546）@2026-07-23T07:30Z，对象 = merged exact SHA `15a256fe2`，
> APPROVE 0 P1/0 P2/0 P3）§0/§0.1/§3/§4/§5/§9/§10 + 章程
> `attendance-vnext-dingtalk-benchmark-ux-development-charter-20260720.md` §4.6/§7-Wave5/§8.1/§9。
> 本文是锁 **§10 完成定义**中「每片验证 MD」与「§9 指标合成 org 实测记录」两项的载体
> ——owner 授权链（RATIFY comment 五点）用单数「验证 MD」，锁 §10 用「每片」；本文以**一份 MD
> 内含四个每片验证章**的形制同时满足两处措辞（Wave 4 先例 `attendance-vnext-wave4-w40-w42-
> development-verification-20260722.md` #4544 同形制，经 owner APPROVE）。
> **收官判定属 owner——本文只呈实证，不宣布收官，不代 owner 触发任何后续 runtime/flag。**
>
> 四片交付（全部已合 `origin/main`，`git log`/`gh pr view` 实证，2026-07-24 核验）：
>
> | 片 | PR | 合入 main（exact SHA） | 门禁最终判定 |
> |---|---|---|---|
> | W5-0 数据合同 runtime（六类只读 trace + 结算第七读面 + lot `overtime_source` 投影） | #4557 | `beef6c134` | Opus 正门 **APPROVE 0 P1/0 P2/3 P3**（预门 26 findings 全吸收；G1-G7 逐门 PASS；twoUserReplay PASSED；独立 mutation 9/9 killed） |
> | W5-7 前置小票（comp_time `leaveTypeCode` 参数化，OD-W5-7=(b)，须在 W5-1 之前落地） | #4562 | `ebe798d47` | Opus **APPROVE 0 P1/0 P2/1 P3**（双刀 mutation 互补承重，零株连） |
> | W5-1 `AttendanceDecisionTrace.vue` 双面展示 + comp_time 通道 UI + 三视口证据 | #4564 | `9d6ab3e1c` | 第一轮 APPROVE_WITH_HOLDS（0/1P2/3P3）→ 修复 `da4681e42` → 独立复核 **APPROVE，KILLED-CONFIRMED**（0 P1/0 P2/3 P3 已修/2 NIT 转呈） |
> | W5-2 上下文帮助（四类）+ trace 深链 | #4576 | `e10816380` | 第一轮 APPROVE_WITH_HOLDS（0/1P2/4P3/2NIT）→ 修复 `7389409ca` → 独立复核 **APPROVE，KILLED-CONFIRMED**（三条 finding 全 KILLED-CONFIRMED） |
>
> 四片门禁记录来源（一手 PR comment，本文写作时逐条 `gh pr view <n> --json comments` 核验，未凭记忆
> 转述）：#4557 comment（2026-07-23）、#4562 comment、#4564 comment（两轮）、#4576 comment（两轮）。
> **本文作者未重跑四片各自的历史 mutation**——四片数字均为一手 PR comment 转录并逐条核验存在性；
> 本文独立新跑的验证只有 §3/§4 的 12 格指标矩阵与其 mutation（本片新增交付）。
>
> 本文全部 file:line 锚点对本文所在分支基 `origin/main` `e10816380`（= W5-2 合入点）实证；
> 四片本身均已入仓，未见其后续被其它 PR 触碰（`git log e10816380 -- packages/core-backend/src/
> services/AttendanceDecisionTrace.ts apps/web/src/views/attendance/AttendanceDecisionTrace.vue
> apps/web/src/views/attendance/attendanceDecisionTrace.ts` 顶端提交即四片自身）。

## 1. 四片交付映射（锁条文 → 实现，一手来源 = 各 PR body/门禁记录 comment）

### 1.1 W5-0 数据合同 runtime（#4557 → `beef6c134`）

| 锁条款 | 实现 |
|---|---|
| §3.1 通用 trace 形制 + 硬规则 1-6 | `packages/core-backend/src/services/AttendanceDecisionTrace.ts`：六个 `buildXxxTrace` + `deriveAttendanceDecisionTraceConfidence`（纯派生：every env `snapshot_frozen` ⇒ `grounded`；任一 `undeterminable` ⇒ 整体 `undeterminable`；否则 `partial`，`:187-197`） |
| §3.3 六类逐类合同 | ①`buildTodayStatusTrace`(`:350`) ②`buildLateEarlyTrace`(`:449`) ③`buildMissingPunchTrace`(`:628`) ④`buildOvertimeSegmentationTrace`(`:773`) ⑤`buildCompTimeBalanceTrace`(`:949`) ⑥`buildApproverSourceTrace`(`:1181`)——逐类断环条件与 §1 点名的真源一一对应，本文 §3 12 格矩阵逐格引用具体行号 |
| §4.1 双宿主 + 授权 | admin 宿主复用 `rbacGuard('attendance','admin')` + `user_orgs` 门；self 宿主 admin prefix/guard 外独立 path，token subject + 归属谓词 subject-constrained（four-leg org 选择） |
| §9 W5-0-G1..G7 | 断环矩阵 / 脱敏 allowlist（禁记录 response body）/ 只读结构约束 / enum-strict / not_in_effect≠undeterminable / 快照优先禁反推 / 双宿主授权矩阵（含 two-user/same-org 六类负例）——G1-G7 逐门独立裁定全 PASS（#4557 comment） |
| §9 完成门实跑 | 单测 61 + 真库 42 + 邻面 27 全绿；双 typecheck 0 错；独立 mutation 9/9 killed（#4557 comment） |
| 遗留 3 P3（记录，未阻断） | ①②E2 规则白名单参数投影未接线；E3 更正读面浅层（单条最近行标记）；`classifyOwedPunch`/`suggestRequestType` 手拷 TS 副本仅手动防漂——三项均不破合同（诚实缺环=undeterminable 方向） |

### 1.2 W5-7 前置小票（#4562 → `ebe798d47`）

严格限于 `AttendanceView.vue` 三处 `leaveTypeCode='annual'` 硬编码参数化（`loadAnnualSelfBalance`/
`loadAnnualLeaveBalance`/管理面对应函数），零新 UI、零后端改动（OD-W5-7=(b) 逐字）。双刀 mutation
互补承重：①回退硬编码 ⇒ 恰 3 条 comp_time 通道 spec 红；②丢 annual 默认 ⇒ 恰 3 条 byte-stable spec
红——零株连。web-guard 33 文件 711 绿、vue-tsc、build ✓（#4562 comment）。

### 1.3 W5-1 `AttendanceDecisionTrace.vue` 双面展示（#4564 → `9d6ab3e1c`）

| 锁条款 | 实现 |
|---|---|
| §6 组件形状 | `apps/web/src/views/attendance/attendanceDecisionTrace.ts`（纯模块，1199 行：closed sets + strict parse + copy doors + `deriveAttendanceDecisionTraceDisplay` 完整判别矩阵）+ `AttendanceDecisionTrace.vue`（600 行，纯展示 props/emit，唯一按钮 = 只读 reload/retry）+ `useAttendanceDecisionTrace.ts`（HTTP 折叠） |
| R2 wire 逐键对账 | 12 个闭集 FE ⊇ backend，零处 FE 严于后端（门审独立核验，非实现自报） |
| W5-8 / R4 文案门 | `attendanceTraceCurrentLiveCopy`「当前规则（无历史版本）」+ `attendanceTraceMayDifferCopy`「可能不同于决策当时的规则。」两门必伴随（`postureDisplay('current_live_no_history')`，`:894-901`）；`attendanceTraceUndeterminableCopy`「无法确定依据」（fail-closed 唯一出口） |
| ⑤ retention disclosure（OD-W5-5=(b) + P3 时序护栏） | `attendanceCompTimeRetentionDisclosure`——W5-1 实现时重验 FK 仍 `onDelete('cascade')`（唯一触及该 FK 的 migration），本文写作时**再次重验**：`packages/core-backend/src/db/migrations/zzzz20260603120000_create_attendance_leave_balances.ts:63` 仍为 `onDelete('cascade')`，无后续修复 migration（`ls packages/core-backend/src/db/migrations/ | grep -i balance` 只见原建表+两处不相关列扩展 migration，均未改该 FK）——披露仍然如实、未过期 |
| 三视口证据 | `docs/development/assets/w5-1-vnext-20260723/`（6 张 PNG + capture-harness 三件套，本文 §3 复用其 harness 机制扩展新场景） |
| 门禁两轮 | 第一轮 APPROVE_WITH_HOLDS（P2-1 ⑤ lot `sourceResolution` 闭集守卫零回归保护——唯一负例落在 `mapped` 分支，unknown 分支未覆盖）→ 修复 `da4681e42`（新增 `unknown_source` 分支判别腿）→ 独立复核**亲跑**：修前+neuter 67/67 全绿（守卫裸奔）→ 修后+neuter 1 failed/45 passed（恰红，定位新腿 `:347`，旧腿 `:335` 未失败）→ 全 run-list 37 文件/790 绿 |
| NIT 转呈 owner（未改，见 §7） | NIT-1 横幅「不会生成」vs 章程 L72「不生成」用词差；NIT-3 390 图 `restday` 折行（纯观感，`scrollWidth<=clientWidth` 通过） |

### 1.4 W5-2 上下文帮助（#4576 → `e10816380`）

| 锁条款 | 实现 |
|---|---|
| §4.6 四类帮助 | `attendanceContextHelp.ts`（closed-set 内容模块，'setup-wizard'①②/'import'③/'self-request-center'④ 分布式挂载——每 context 只带其最需要的类）+ `AttendanceContextHelp.vue` |
| L225 values-free | 每类逐项零出现扫描（env 名/主机/token/内部日志路径/真实客户名等） |
| ④ trace 深链 | 复用 W5-1 canonical query-form deep link builder（R2 零 hash）+ `missing_punch` preset（实现者自选，锁未指定，依据标题字面 1:1） |
| 门禁两轮 | 第一轮 APPROVE_WITH_HOLDS（P2-1：③闭集漂移只有「同源条数」守卫——加第 5 个失败码成员漏掉展示数组，`vue-tsc`+全绿溜过，逃过的是 `test(20.x)` required CI 本身，因其对 apps/web 只 build 不跑 spec）→ 修复 `7389409ca`（两手写字面量数组+穷尽 switch → `Record<UnionType,...>`，spec 改 import 派生集）→ 独立复核**亲跑**：7 刀 tsc+vitest 双腿表，Door A/B 排他 | 判定绑 `7389409ca`；合入 head `b9e6c84af` 多一个纯注释 NIT-2 修正 commit，非注释行改动数=0（机器核验） |
| 转呈 owner（未阻断，见 §7） | 四类分布式挂载（非每点四类）/ 仅 3-of-4 候选挂载点（跳过班次/考勤组配置）/ ④ `missing_punch` preset 选型——均为产品裁量，门审判「可辩护」不阻塞 APPROVE |
| 治理记录 | `attendance-web-guard` **不在 main 的 required contexts**（required `web-tests` 清单排除 attendance）——本片三个新 spec 的红腿对人可见非硬阻断；是否提升为 required 属仓库治理决定，本文 §7 转呈 |

## 2. 锁 §10 完成定义逐项对账

锁 §10 原文（逐字）：「**完成定义**：三切片全合 + 每片验证 MD 在 main + 红线四条各有存活的负向断言 +
章程 §9「解释完整性」指标（L427）以合成 org 实测记录（六类各至少一条 grounded 解释 + 一条
undeterminable fail-closed 展示，均截图 + DOM 断言）。**证据面 values-free 义务（P2-a）**：截图
仅用合成数据（真实用户数据零入公开验证证据）；trace response body 不入验证 MD/CI artifact/测试
日志。」

| # | 完成定义项 | 对账 | 证据锚点 |
|---|---|---|---|
| 1 | 三切片全合 | ✅（本波实为**四**片交付——W5-0/W5-7/W5-1/W5-2，W5-7 为 OD-W5-7=(b) 裁定的前置小票，锁 §9 亦已单独立项） | W5-0 `beef6c134` / W5-7 `ebe798d47` / W5-1 `9d6ab3e1c` / W5-2 `e10816380`，均在 `origin/main` first-parent 链上（`git log e10816380 --oneline` 实证依赖顺序） |
| 2 | 每片验证 MD 在 main | ⚠️ **本文即该交付物，本文合入后满足** | 本文 §1 四片映射即「每片」章的载体（Wave 4 单份覆盖三片同形制，owner APPROVE 先例） |
| 3 | 红线四条各有存活的负向断言 | ✅ | 见 §5——R1-R4 逐条断言锚点 + mutation 证据（四片各自门禁记录汇编 + 本文新跑的 12 格矩阵 mutation） |
| 4 | §9 指标：六类各一条 grounded + 一条 undeterminable，截图+DOM 断言 | ⚠️ **PENDING-OWNER**：证据侧已全部产出，但**本条能否判成立取决于 owner 对锁的一次释义**——锁 §10 字面要求的 `confidence==='grounded'` 在 ①-⑤ **结构上不可达**（§3.0 已证：锁 §3.2/§3.3④E2/§3.3⑤E3 强制这些依据环为非冻结，而 `deriveAttendanceDecisionTraceConfidence` 要求**每环** `snapshot_frozen` 才判 grounded）⇒ **锁内部条款冲突**。本文按「该类结构性可达的最佳正向格」解读产出证据，但**该解读属合同释义，不在本片权限内自裁**（见 §7-8，收官前置）。⑥ 类字面可达 grounded，①-⑤ 诚实上限为 `partial` | 见 §3——12 格 fixture + `apps/web/tests/attendance-decision-trace-metric.spec.ts`（14 tests）+ 12 张 PNG |

**P2-a 证据面 values-free 义务**：本文与 §3 截图均为合成数据（synthetic fixtures，工作日期/分钟数/
displayLabel 全部虚构值，`identityPosture` 覆盖 resolved/inactive 两档但均为演示标签「演示审批人」
「已停用用户」，非真实用户）；`attendance-decision-trace-metric.spec.ts` 的全部断言落在
`textContent`/`getAttribute` 局部字符串或结构字段，**零处**对完整 trace response body 做
snapshot/console 输出；本文不粘贴任何 fixture 的完整 JSON（§3 表格只引用 posture/confidence 值与
lock 依据行号，不复制 conclusion 明细数值全集）。

## 3. §9「解释完整性」12 格指标矩阵（六类 × {正向格, undeterminable 格}）

### 3.0 posture 上限说明（诚实澄清，读本节前请先读）

对六个 `buildXxxTrace` 与 `deriveAttendanceDecisionTraceConfidence`（`AttendanceDecisionTrace.ts:187-197`：
`grounded` 要求 basis 内**每个**环 `snapshot_frozen`；任一 `undeterminable` 环 ⇒ 整体
`undeterminable`；否则 `partial`）逐函数核验后的结论：

- **①②③**：`currentRuleBasisEnv(rule)`（`:288-293`）在记录存在时**无条件**push，posture 恒
  `current_live_no_history`（或规则不可解析时 `undeterminable`）——**从不** `snapshot_frozen`。
  故 ①②③ 的 confidence **结构性不可能**达到字面 `'grounded'`，只能 `'partial'`（record 存在）或
  `'undeterminable'`（record 缺失/规则环缺失）。
- **④**：live-rule 环（`:877-884`）**无条件** push（`current_live_no_history` 或规则表无行时
  `undeterminable`），故 ④ 同样结构性不可能达到 `'grounded'`。
- **⑤**：`compTimeFromOvertime` policy_gate 环（`:1044-1046`）**无条件** push（`current_live_no_
  history` 或 `not_in_effect`，两者均非 `snapshot_frozen`），故 ⑤ 同样结构性不可能达到 `'grounded'`。
- **⑥ 是六类中唯一能达到字面 `'grounded'` 的类**：`ATTENDANCE_APPROVAL_DYNAMIC_ASSIGNEE_SOURCES_
  ENABLED` policy_gate 环**仅当** `hasDynamicStep`（存在 `direct_manager`/`dept_head`/
  `manager_at_level` 三种动态 kind 之一）**才** push（`:1281-1287`）——若全部步骤是 `static`/
  `legacy_fallback`（无动态 kind），该环整条**不出现**，其余四环（assignments/records/
  requester_snapshot/approvalFlow）在正常路径下均可 `snapshot_frozen`，此时 confidence 字面
  = `'grounded'`。

**因此本节「正向格」栏对 ①-⑤ 展示 `confidence:'partial'`（该类诚实可达上限），对 ⑥ 展示字面
`confidence:'grounded'`——这不是「未达标」，是**如实反映本仓「决策时落快照，非策略版本化」的
设计**（锁 §1 总括）：五类的规则/策略环恒定引用一个活体维度，因此除非该维度结构性缺席（唯 ⑥
成立），否则不可能全链冻结。把 ①-⑤ 的正向格伪造成 `'grounded'` 会违反 R2「指真实记录禁猜」——
本文明确拒绝这样做，并以 `attendance-decision-trace-metric.spec.ts` 末尾「cross-cutting posture
ceiling」两个测试把该结论断言为**可执行合同**（mutation 证据见 §4）。

### 3.1 十二格表

| # | 类 | 格 | confidence | 关键 posture / 依据 | 锁依据（逐句） | fixture / DOM 断言 | 截图 |
|---|---|---|---|---|---|---|---|
| 1 | ①今日状态 | 正向 | `partial` | 记录环 `snapshot_frozen`（写入时冻结）；规则环 `current_live_no_history` + 「可能不同于决策当时的规则。」声明；`reasonCode`='normal' | §1-1「解释面对状态类的『版本/生效日』只能诚实呈现 `current_live_no_history`」；§3.2 末段「UI 必须显示……可能不同于决策当时的规则」 | `todayA()`；断言 confidence='partial'、may-differ 在场、规则环非 `snapshot_frozen` | `w5m-1440x900-self-today-a.png` |
| 2 | ①今日状态 | undeterminable | `undeterminable` | 记录不存在 ⇒ 整类断环，`reasonCode` 键缺席 | §3.3①「断环 ⇒ fail-closed：record 行不存在 ⇒ 整类 `undeterminable`」 | `todayB()`；断言 fail-closed 横幅 + `[data-trace-reason]` 不在场 + 结论行全部「无法确定依据」 | `w5m-1024x768-self-today-b.png` |
| 3 | ②迟到/早退 | 正向 | `partial` | tier 环 `snapshot_frozen`（post-migration 行，真实 `severeLateCount=1` 等冻结计数） | §1-2「迟到分级……是半个快照：每次 upsert 按当时 rule 阈值计算并冻结进 `meta.severe_late_count`」 | `lateA()`；断言 tier 环 posture=`snapshot_frozen`、`severeLateCount` 文本='1' | `w5m-1440x900-admin-late-a.png` |
| 4 | ②迟到/早退 | undeterminable | `undeterminable` | legacy 行无 tier keys ⇒ tier 环 `undeterminable`；`lateMinutes` 仍真实（25 分钟），severeLateCount 显示门文案非 0 | §1-2「legacy 行无这些 key」；§3.3②断环「禁把 report 侧的 fallback-0 读作『无严重迟到』证据」 | `lateB()`；断言 `severeLateCount`='无法确定依据'（非'0'）且 `lateMinutes` 含'25' | `w5m-1024x768-admin-late-b.png` |
| 5 | ③缺卡 | 正向 | `partial` | 单侧缺卡（`check_in`），无 absent 生成来源环参与 | §3.3③ 结论 `owedPunchReason` 闭集；`classifyOwedPunchRecord` 既有归因码 | `missingA()`；断言 `missingSide`='上班卡'、无 `auto_absence_generation` 环 | `w5m-1440x900-self-missing-a.png` |
| 6 | ③缺卡 | undeterminable | `undeterminable` | absent 行：生成来源环 `auto_absence_generation` 恒 `undeterminable`（「谁在何时判我旷工」不可知），但 `missingSide`='both' 仍真实 | §1-3「作业运行本身零持久痕……对 absent 行 `undeterminable`」；§3.3③「E3 生成来源环（absent 材料化：恒 `undeterminable`）」 | `missingB()`；断言生成来源环 posture=`undeterminable` + `missingSide`='上下班卡' | `w5m-390x844-self-missing-b.png` |
| 7 | ④加班分段 | 正向 | `partial` | `coverageNote:'full'`；分段快照+加班规则快照双 `snapshot_frozen`，与现行规则**并列显式区分**（`current_live_no_history`），段级 `reasonCode`='group' | §3.3④「E2 规则环……二者并列呈现、显式区分」；硬规则 6「快照排他」 | `overtimeA()`；断言快照环=`snapshot_frozen`、live 规则环=`current_live_no_history`、段文案含'考勤组日历策略' | `w5m-1440x900-admin-overtime-a.png` |
| 8 | ④加班分段 | undeterminable | `undeterminable` | `coverageNote:'partial_legacy'`；分段快照环 `undeterminable`（poison 整体），`overtimeSegmentation` 策略开关环**独立**呈现 `not_in_effect`（非 `undeterminable`，两者不合并） | §3.3④断环「快照缺失……⇒分段环 `undeterminable`」+「口径差强制声明」；硬规则 2「`not_in_effect` 与 `undeterminable` 是两个判别值」 | `overtimeB()`；断言 `coverageNote` 文案在场 + 策略开关环=`not_in_effect` 且**不**携带 undeterminable 门文案 | `w5m-390x844-admin-overtime-b.png` |
| 9 | ⑤调休余额 | 正向 | `partial` | `mapped`/`unknown_source` 两 lot 并列（item 级判别）；留存边界披露在场 | §3.3⑤「lot item = `sourceResolution` 判别的 known/unknown discriminated union」 | `compTimeA()`；断言两种 `data-trace-lot-resolved` 值均在场 + retention disclosure 含'留存边界' | `w5m-1024x768-self-comptime-a.png` |
| 10 | ⑤调休余额 | undeterminable | `undeterminable` | 引擎 ON（`current_live_no_history`）但账本为空 ⇒ 台账/流水两环 `undeterminable`（OD-W5-4 缺口）——**区别于** dormant org 的 `not_in_effect` 策略事实 | §3.3⑤断环「被 cap 拒绝/池空未入池 ⇒ 无行可引，恒 `undeterminable`」；硬规则 2 | `compTimeB()`；断言账本环=`undeterminable` 且策略开关环=`current_live_no_history`（非 `not_in_effect`，证明未被误判为 dormant） | `w5m-390x844-self-comptime-b.png` |
| 11 | ⑥审批人来源 | **grounded（六格中唯一字面 grounded）** | `grounded` | 全部步骤为 `static`/`legacy_fallback`（无动态 kind）⇒ 动态门环整条不出现 ⇒ 其余四环全 `snapshot_frozen` | §3.3⑥「E1 指派环……E2 时间线环……E3 冻结环……E4 规则环」；§1-6「既成指派经 `approval_records` 时间线」 | `approverA()`；断言 confidence='grounded'、门环 querySelector 为 null、4 环全 `snapshot_frozen`、时间线引用 `approval_records` | `w5m-1024x768-admin-approver-a.png` |
| 12 | ⑥审批人来源 | undeterminable | `undeterminable` | 零 active 指派（`steps=[]`）+ 审计环缺失；`requester_snapshot` 环仍真实冻结（不因「看起来更破」而伪造成 unknown） | §3.3⑥断环「解析失败历史恒 `undeterminable`」（**注**：本格代表的是「已创建实例但零有效指派/零审计行」，非「resolver 决策失败未创建实例」——后者结构上不产生 trace body，见 §7 转呈项） | `approverB()`；断言 `steps` 空文案在场 + `requester_snapshot` 环=`snapshot_frozen`（非 undeterminable） | `w5m-390x844-admin-approver-b.png` |

12 张 PNG 均已入仓 `docs/development/assets/w5-verification-20260724/`；capture-harness 三件套
（`w5MetricDecisionTraceHarness.ts` / `decision-trace-metric-harness.html` /
`capture-decision-trace-metric.mjs`）同目录 `capture-harness/` 子目录，与 W5-1 harness 同一机制
（拍前 in-page 断言 fail-closed + `elementFromPoint` + `scrollWidth<=clientWidth`，逐场景独立
`KEY_PROBES`，见该 `.mjs` 文件）；12/12 presence PASS，逐张人工目检（本文撰写时逐张查看，§3.1
表格「关键 posture」列即目检要点）。

**⑥-undeterminable 格的诚实边界（转呈 owner 参考，非阻断项）**：锁 §1-6①/OD-W5-2=(a) 描述的
「审批人来源」核心 undeterminable 叙事是 **resolver 决策失败、创建被阻断、零持久化**——这个场景
**结构上不产生任何 trace response body**（`buildApproverSourceTrace` 首步即 `attendance_requests.
user_id=subject AND approval_instance_id=target` 查找，找不到 instance 即返回
`ATTENDANCE_DECISION_TRACE_NOT_FOUND` ⇒ 404，走组件既有 `errorKind:'not_found'` 分支，非
`confidence:'undeterminable'` 的 trace body）。本格选用的「零 active 指派 + 零审计行」是**另一个
真实、code-path 可达的 undeterminable 场景**（`steps.length>0 ? snapshot_frozen : undeterminable`,
`:1255`），用同一套 fail-closed 门证明同一纪律，但不是锁原文最强调的那个叙事。§7 已将此按诚实
四栏原则列入「已验证但有边界」。

## 4. 实跑与 mutation（本文新跑，12 格矩阵专属）

### 4.1 实跑（本地真跑，2026-07-24，`e10816380` 分支基）

| 命令 | 结果 |
|---|---|
| `pnpm --filter @metasheet/web exec vitest run attendance-decision-trace-metric --reporter=verbose` | **14/14 passed** |
| `pnpm --filter @metasheet/web exec vitest run <attendance-web-guard.yml 全 41 文件 run-list，含新 spec>` | **41 files / 852 tests 全绿** |
| `pnpm --filter @metasheet/web exec vue-tsc -b` | 0 错 |
| `pnpm --filter @metasheet/web build` | ✓ built in 11.23s（chunk-size 警告为既有，非本次引入） |
| `node docs/development/assets/w5-verification-20260724/capture-harness/capture-decision-trace-metric.mjs` | 12/12 presence PASS，`scrollWidth<=clientWidth` 三视口全通过 |

guard 接线：`attendance-decision-trace-metric.spec.ts` 已进 `.github/workflows/attendance-web-guard.yml`
的 `pull_request`/`push` 双 path filter + 真 `vitest run` run-list（不只是 harness 的 in-page
`throw`）——满足章程 §8.1.4「新增或重命名的 spec 必须同时加入实际 Vitest run-list」义务。

**CI 真收集证据（非仅本地跑/非仅接线在场——「触发≠验证」纪律）**：PR #4582 的
`attendance-web-guard` workflow 已在 CI 实跑。**head-scoped 证据**（判定绑 SHA 纪律）：run
`30093726205`（`headSha=9d89b511e` = 本文现 head）同样 **41 files / 852 tests 全绿**、四个
`attendance-decision-trace*` 文件各自独立收集 46/14/9/12；下述逐行日志核验取自初稿 commit
`cace01030` 上的 run `30084615126`，日志逐行核验
（`gh run view 30084615126 --log`）：`tests/attendance-decision-trace-metric.spec.ts (14 tests)`
作为**独立文件**被收集并全部通过——同一日志中 `attendance-decision-trace.spec.ts`（46
tests）、`attendance-decision-trace-wiring.spec.ts`（9 tests）、`AttendanceDecisionTrace.spec.ts`
（12 tests）均各自单独出现，证明 run-list 的四个 `attendance-decision-trace*` 子串未互相吞没
（无一个文件的用例数被错误并入另一文件）；CI 终态 = **41 files / 852 tests 全绿**，与本地实跑
数字逐字节一致。

### 4.2 Mutation（11 刀，全部本地亲跑、逐刀精确路径还原，未使用 `git checkout -- .`）

纪律：先 `git commit` 建立检查点，每刀 Edit 精确路径 mutate → 跑
`attendance-decision-trace-metric` → 记录 pass/fail → Edit 精确路径还原 → `git diff --stat` 归零
确认。全部 11 刀跑毕后 `git diff` 对检查点 = 空（已核验）。前 8 刀验证类判别逻辑与共享基础设施
的排他性；独立复核（对抗自身此前的判定）时发现 ②正向/⑤undeterminable/⑥undeterminable 三格
此前仅被 M8（共享徽标绑定）连带杀死、未证明各自 class-specific 断言本身承重——补 M9/M10/M11
三刀逐一补齐。

| # | Mutation | 目标产文件:行 | 结果（对 14 个 test 的精确 pass/fail） | 排他性 |
|---|---|---|---|---|
| M1 | ① `reasonLabel` 分支恒 `null` | `attendanceDecisionTrace.ts` today_status 分支 | **1 failed / 13 passed** | 仅杀①正向格 |
| M2 | ② tier `severeLateCount` null-guard 移除（伪造回退值） | 同文件 late_early 分支 `severeLateCount` 行 | **1 failed / 13 passed** | 仅杀②undeterminable 格（禁 fallback-0 断言） |
| M3 | ③ `missingSideLabel` 恒返回「无」 | 同文件 missing_punch 分支 | **2 failed / 12 passed** | 仅杀③两格（label 映射本身被两格共用，符合预期） |
| M4 | ④ `coverageNote` 三元反转 | 同文件 overtime_segmentation 分支 | **2 failed / 12 passed** | 仅杀④两格 |
| M5 | ⑤ lot `resolved` 判别恒 `true` | 同文件 comp_time_balance 分支 lot 映射 | **1 failed / 13 passed** | 仅杀⑤正向格（undeterminable 格 lots 为空，未触及该判别） |
| M6 | ⑥ 时间线引用改从 `approval_assignments`（非 append-only）读 | 同文件 approver_source 分支 `timelineEnv.find` | **1 failed / 13 passed** | 仅杀⑥grounded 格（唯一断言该引用的测试）——直接对应锁 §3.3⑥E2 点名的 mutation |
| M7 | 共享 `postureDisplay('undeterminable')` 分支移除 `undeterminableNote` | 同文件 `postureDisplay` 函数 | **2 failed / 12 passed**（①undeterminable + ③undeterminable，唯二显式断言该 env 级门文案的测试） | 共享基础设施，footprint 精确等于依赖它的测试集合（另在 W5-1 三个既有 spec 上复核：4 个 spec 合计 **5 failed / 76 passed**，无意外命中） |
| M8 | 组件 `data-trace-confidence-value` 绑定硬编码为 `'grounded'` | `AttendanceDecisionTrace.vue` 徽标绑定 | **12 failed / 2 passed**（唯二存活 = 两个已经预期 `'grounded'` 的 ⑥grounded 断言） | 证明该绑定是整个 ceiling guard 的承重路径——精确符合预期（非全绿也非全红） |
| M9 | ⑤ 空批次提示文案改字（`AttendanceDecisionTrace.vue` 空 lots 分支 `'无有效批次。'`→改字） | `AttendanceDecisionTrace.vue` `decision-trace__empty`（lots 分支） | **1 failed / 13 passed** | 仅杀⑤undeterminable 格——首次独立证明该格 class-specific 断言（非仅靠 M8 徽标连带） |
| M10 | ⑥ 空步骤提示文案改字（同文件空 steps 分支 `'无指派步骤记录。'`→改字） | `AttendanceDecisionTrace.vue` `decision-trace__empty`（steps 分支） | **1 failed / 13 passed** | 仅杀⑥undeterminable 格——首次独立证明该格 class-specific 断言（非仅靠 M8 徽标连带） |
| M11 | ② `severeLateMinutes` 结论行渲染改为硬编码 `minutesLabel(0, tr)`（丢弃 `c.severeLateMinutes` 真值与 null-guard 双重逻辑） | `attendanceDecisionTrace.ts` late_early 分支 `severeLateMinutes` 结论行 | **1 failed / 13 passed** | 仅杀②正向格——首次独立证明该格 class-specific 断言（非仅靠 M8 徽标连带） |

每刀均满足「杀 A 不杀 B」排他性要求（M3/M4 例外说明：两者的判别逻辑天然被同类的正向/undeterminable
两格共用，mutation 精确杀死这两格、不外溢到其它类，仍是正确的排他性）。M7/M8 为跨格共享门的
mutation，各自的失败集合与代码依赖关系精确吻合，非「多道门互相掩护」的假阳性绿；M9/M10/M11
补齐了 M8 未单独证明的三格（②正向、⑤/⑥ undeterminable）各自的 class-specific 判别腿——这正是
任务书第 3 条纪律（「多道 fail-closed 门会互相掩护」「每格的判别腿要分别 neuter、各自排他性
失败」）要求的完整应用形式：**12 格中每一格现在都至少有一刀独立证明其 class-specific 断言承重**
（①正向 M1、①undeterminable M7、②正向 M11、②undeterminable M2、③两格 M3、④两格 M4、⑤正向
M5、⑤undeterminable M9、⑥grounded M6、⑥undeterminable M10——逐格映射穷尽，无遗漏）；此清单
本身是对本文自身初稿的一次对抗性复核结果，而非交付时一次写对。

## 5. 红线四条（R1-R4）——存活的负向断言汇总（四片汇编）

四片各自的 R1-R4 断言与 mutation 证据已分别在其门禁记录 comment 中裁定（本文不重跑其历史
mutation，仅汇编一手来源 + 本文新增的 §4 部分）：

| 红线 | W5-0 | W5-1 | W5-2 | 本文（12 格矩阵） |
|---|---|---|---|---|
| **R1 只读/零写** | `READ ONLY` 事务结构约束（G3，W4-0-G2 同型三条必拒复用）；解释面零触达任何写端点 | 组件唯一按钮 = 只读 reload/retry；mock 层零写调用负向（dual-face walk 零非-GET 调用） | trace 深链只指读面，零配置写入口 | 本文 fixture 全部走既有纯展示组件路径，未新增任何写调用面；§4 mutation 均限于展示/派生逻辑，不触碰任何写路径 |
| **R2 依据指向真实记录/禁猜** | 断环矩阵 G1（deepEqual 整链）；快照优先禁反推 G6（改动活体规则表 ⇒ 已终审 trace byte-stable） | wire 逐键对账 FE⊇backend（零处 FE 严于后端） | ③闭集复用既有归因码（`BlockedSpreadsheetKind` 等），不新造词表 | **本文核心贡献**：posture-ceiling 交叉断言（§3.0/§4「cross-cutting posture ceiling」两测试 + M1-M6/M8 六刀）——防止任一类的正向格被伪造成结构上不可达的 `grounded` |
| **R3 脱敏 by construction** | 禁字段零出现（managerChainIds/ip/ua/裸内部 id）+ 禁记录 response body（G2） | 组件 R3 属性核验：三值全部来自自有 composable，无第二 store/无姓名回填 | L225 values-free 逐类逐项零出现扫描 | 本文全部断言落在局部字符串/结构字段，零 body dump（§2 P2-a 段） |
| **R4 版本缺口如实暴露** | not_in_effect≠undeterminable（G5，mutation：合并判别 ⇒ 两腿各自红） | W5-8 门（may-differ 声明与 current_live_no_history 必然同现，zh+en 双腿） | — | §3 表格第 8/10 行显式区分 `not_in_effect` 与 `undeterminable`（④/⑤ undeterminable 格断言二者不合并），§4 未新增此维度专属 mutation（复用 W5-0 既有 G5 覆盖，本文不重复造轮子） |

## 6. 诚实四栏

| 类别 | 内容 |
|---|---|
| **已完成** | 四片交付全部合入 main 且门禁 APPROVE（或 KILLED-CONFIRMED）；本文（每片验证 MD 载体）；12 格指标矩阵 fixture + 受 guard 收集的 `attendance-decision-trace-metric.spec.ts`（14 tests，guard 双 path filter + run-list 已接线）；12 张合成截图 + 拍前在场断言 + 逐张人工目检；11 刀 mutation 全部本地亲跑、精确排他、还原复绿
（12 格逐格均有独立承重证据）；CI 真收集证据（PR #4582 run `30084615126` 日志逐行核验）；`vue-tsc`/`build` 双绿；posture-ceiling 交叉断言（本文对 R2 的新增可执行化） |
| **已验证但有边界** | **⑥-grounded 格的代表性边界（本轮门审补充自曝）**：该格之所以能达字面 `grounded`，是因为其步骤**全为 static/legacy_fallback**（门环 `hasDynamicStep` 未触发）——即**根本没有发生 resolver 决策**；凡含动态 kind 步骤者必 push 规则门环 ⇒ **真正由 resolver 决策产生的审批人来源永不可能字面 grounded**。故本波唯一的字面 grounded 格，恰恰是解释负担最轻的那一类；⑥-undeterminable 格代表「零 active 指派/零审计行」而非锁最强调的「resolver 决策失败零持久化」（后者结构上不产生 trace body，见 §3.1 表后说明，属诚实边界非缺陷）；W5-1 的留存披露时序护栏本文重验仍有效（FK 未修复）但本文未独立重跑 W5-0/W5-1/W5-2 各自的历史 mutation，仅转录其一手门禁记录 |
| **未做且为何** | ①**§10 第 4 项未判成立**——证据已全产出，但该条依赖一次 owner 释义（锁内部条款冲突，见上表第 4 行与 §7-8），**本片不自裁**，故本文不宣称 Wave 5 完成定义四项全部满足；②字面 `confidence==='grounded'` 的 ①-⑤ 格**未产出**（结构不可达，非取舍——若 owner 裁定字面口径，需新 runtime 设计而非补 fixture）；③本文未独立重跑 W5-0/W5-1/W5-2 各自的历史 mutation，仅转录其一手门禁记录；④真实租户视觉验收 / flag 开启 / 生产部署未覆盖（均 operator 项，锁 §10 明文本锁不改变）。12 格矩阵本身按诚实上限（§3.0）全部产出，没有因诚实上限而放弃某一格 |
| **转呈 owner 裁量** | 见 §7（汇总四片既有转呈项 + 本文 posture-ceiling 诚实解读是否需要 owner 额外确认） |

## 7. 转呈 owner 清单（汇总，四片 + 本文）

1. **W5-1 NIT-1**：横幅「不会生成」用词 vs 章程 L72「不生成」——门审二轮确认不触发锁 L805-806
   枚举的 UI 逐字门，未改，转呈裁量。
2. **W5-1 NIT-3**：390 视口 `restday` 折行——纯观感，`scrollWidth<=clientWidth` 断言通过，未改。
3. **W5-2 三项产品裁量**：四类上下文帮助采分布式挂载（非每点四类）；仅用 3/4 候选挂载点（跳过
   班次/考勤组配置）；④ 深链的 `missing_punch` preset 系实现者自选（锁未指定）——门审判「可辩护」
   不阻塞 APPROVE，呈 owner 追认。
4. **W5-0 遗留 3 P3**（后端类，记录待后续吸收）：①②E2 规则白名单参数投影未接线；E3 更正读面
   浅层；`classifyOwedPunch`/`suggestRequestType` 手拷副本仅手动防漂。
5. **W5-5/W5-10 runtime 未做**（owner 授权边界⑤已排除，非本波范围）+ **W5-1 静态留存披露的时序
   护栏**：W5-5（balance_events FK 删除免疫修复票）一旦落地，`attendanceCompTimeRetentionDisclosure`
   必须移除或改为后端闭集 retention posture 驱动（`'cascade_delete'|'delete_immune'`）——过期警告
   本身即 R4 同罪的假解释；本文重验（2026-07-24）FK 仍为 `cascade`，披露仍如实，但**下次触碰此
   文件时必须重验**。
6. **`attendance-web-guard` 不在 main required contexts**（W5-2 门审记录，仓库治理决定）——本波
   四片 + 本文新增 spec 的红腿目前均为「对人可见」而非硬阻断，是否提升为 required 属 owner/仓库
   治理裁量，本文不代为决定。
7. **⑥-undeterminable 格的诚实边界**（本文新增转呈项，§3.1 表后已详述）：锁 §1-6①/OD-W5-2=(a)
   描述的「resolver 失败零持久化」叙事结构上无法以 `confidence:'undeterminable'` trace body
   呈现（只能是既有 404/`errorKind:'not_found'` 状态）——本文选用的替代场景（零 active 指派）
   是否需要额外的 UI/文档说明来区分这两种「审批人来源不可知」的成因，呈 owner 判断是否需要
   独立小票（若需要，属 UI 措辞层面，非新 runtime 能力）。
8. **posture-ceiling 诚实解读**（本文新增）：锁 §10「六类各至少一条 grounded 解释」的字面
   `confidence==='grounded'` 在 ①-⑤ 结构上不可达（§3.0 已证明并非实现缺陷）——本文按「该类最佳
   可达正向格」解读满足该条款；若 owner 认为该条款字面要求六类都必须能展示 `'grounded'` 徽标，
   则需要新的 runtime 设计（例如允许 ①-⑤ 的规则/策略环在特定条件下省略，类比 ⑥ 的
   `hasDynamicStep` 门）——**这将是一次锁条款修订/新 OD 裁决，不在本片权限内自行决定**，本文只
   如实呈现现状并等待裁定。**本项为收官前置**：§10 完成定义第 4 项在 owner 就此释义（或修订）
   之前维持 ⚠️ PENDING-OWNER，本文不宣称 Wave 5 完成定义四项全部满足。

## 8. 跨车道注记

issue #4556 的 W4「分段核算与快照」一旦落地，会为分段场景引入**真实的结果快照源**——本波对状态类
（①②③）「只存派生结果、不存规则快照」的前提在该场景下将改变，**Wave 5 的 provenance/posture 上限
（含本文 §3.0 的结构性论证）需同步修订**。此为已知未来工作，不在本波范围（锁 §6 跨车道注记原文
转录，本文补充：#4556 当前进度 = W1/W2/W3 已有独立验证 MD 在 main，W4 未开始——`docs/development/`
无 W4 专属验证 MD 文件（仅 W1、W2-W3 两份），且 W2-W3 验证 MD 自身逐字确认「Issue #4556 correctly
stays OPEN for W4-W8」，与本波「W4 未开始」的判断一致）。

## §11.1 六项记录（本 MD 所在 docs PR）

1. **基线 SHA**：`origin/main` **`e10816380`**（W5-2 #4576 合入后，2026-07-24）。四片交付链
   `beef6c134` → `ebe798d47` → `9d6ab3e1c` → `e10816380` 全部在该基线祖先链上（`git log
   e10816380 --oneline` 逐条核验）。
2. **查重**：开工前 `git fetch origin main` + `git log --oneline -20` 核验无同题在飞分支/PR
   （`gh pr list --search "wave5 verification"`/`gh pr list` 全表 grep `wave5|w5-verif|explain`
   零命中，2026-07-24 核验）；`docs/development/` 内此前无 `attendance-vnext-wave5-*verification*`
   文件（本文是首份）。
3. **修改文件**：本 PR 含 1 份验证 MD + 1 份新 guard-collected 前端 spec
   （`apps/web/tests/attendance-decision-trace-metric.spec.ts`）+ 1 处 workflow 接线
   （`.github/workflows/attendance-web-guard.yml` 双 path filter + run-list）+ 12 张 PNG +
   capture-harness 三件套（docs 资产，不触任何 workflow path glob）——**零** runtime/路由/迁移/
   权限改动（本片任务书逐字「零新 runtime 能力」）。
4. **IN/OUT**：IN = 四片交付映射对账 / §10 完成定义逐项核对 / 12 格指标矩阵证据 + mutation /
   红线四条汇编 / honest 四栏 / 转呈 owner 清单；OUT = 任何锁条款修订、任何 runtime 变更、W5-5/
   W5-10 runtime、收官判定与后续波次解锁（均属 owner，§7 已逐项列明待裁量项）。
5. **权威数据源**：四份 PR body（#4557/#4562/#4564/#4576）+ 四份门禁记录 comment（`gh pr view
   <n> --json comments` 逐条核验，非凭记忆转述）+ 设计锁/章程原文逐句引用 +
   `packages/core-backend/src/services/AttendanceDecisionTrace.ts` /
   `apps/web/src/views/attendance/attendanceDecisionTrace.ts` /
   `apps/web/src/views/attendance/AttendanceDecisionTrace.vue` 现势代码（本文写作时逐函数重读，
   非凭 W5-0/W5-1 PR 描述转述）；本文不新增任何 runtime 事实，§3.0 的 posture-ceiling 结论对
   现势代码逐函数验证得出，非对锁/PR 文本的二次转述。
6. **完成门**：guard 接线 + 真跑实数（§4.1）+ mutation 精确排他证据（§4.2）+ 12 张截图拍前断言
   + 逐张人工目检（§3）——锚点行号为近似值（引用纪律：`AttendanceDecisionTrace.ts`/
   `attendanceDecisionTrace.ts`/`AttendanceDecisionTrace.vue` 三文件行号已按本文撰写时现势
   `e10816380` 重验）。
