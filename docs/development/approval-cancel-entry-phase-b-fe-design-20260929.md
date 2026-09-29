# 请假撤销 —— 产品入口 阶段 B(只前端)设计与验证记录 —— **草稿**

| 项 | 值 |
|---|---|
| 状态 | 草稿:实现 7 个提交 + 门审 r1(0 P1 / 1 P2 / 7 P3 / 4 NIT)后的修复轮 1(见 §8、§10);门审 r2 APPROVE-with-hardening(0 P1 / 0 P2 / 7 P3 / 3 NIT);前端 14 提交已叠到后端头 `84dd4545e`;其后 **B2**(7 个代码 / 测试提交 + 1 个本文件提交,§11)—— B2 未门审;未推送、未开 PR;合并按 owner 2026-09-29 17:1x 的条件式预授权(§1),条件尚未满足 |
| 分支 | `feat/approval-cancel-entry-phase-b-fe` |
| 基线 | 起初:后端分支 `feat/approval-cancel-entry-phase-a-read-launch` 的 `2e44d6053`(阶段 A + A2;其基线 `main @ f47054d88e`);现:同一后端分支的门审头 `84dd4545e`(阶段 C 过门,r3),本分支 B2 起点 `a538caf0a` |
| 改动面 | 只 `apps/web/**` 与本文件;**后端零改动**,**DDL 零** |
| 权威锁 | 撤销锁 v5.9(RATIFIED 2026-09-18)抬头「RATIFY 追记 —— 产品入口增补 v2(P-1…P-11)」(2026-09-28) |
| 实现模型 | Claude Opus 5.5 |

---

## 0. 范围

**本阶段做的**(每项一个提交,见 §8):

1. **P-2 词表与共享核心** —— `statusDomains.ts` 新增 `cancelRound` 域(V1–V8);`approvals/cancelRound.ts`(考勤侧四条路由的客户端、V 词解析、错误码文案、未知 `business_blocked:<code>` 的分类级文案、审批侧办理的请假 id 解析)。
2. **P-2 五个渲染面** —— 五处 approvalInstance 域的 `StatusTag` 经同一个选择器按 `workflowKey` 选域;另把 `ApprovalDetailView` 里两处不经 `StatusTag` 的实例状态文字(审批记录表「结束」行、复制摘要)与时间线的系统收口行一并接上。
3. **④ 审批人办理** —— 撤销轮实例在审批详情、审批中心(行内 / 行驳回 / 批量)上的通过 / 驳回改走 `POST /api/attendance/requests/:id/cancel-round/actions`。
4. **① 考勤自助面入口 + ② 轮次摘要呈现 + ③ 申请人撤回** —— `AttendanceView`「最近申请」的**请假行**(不是换班列表)挂 `AttendanceCancelRoundPanel`。
5. **⑦ required web lane 登记** + 本文件。
6. **P-6 席位呈现边界(审批侧)** —— 撤销轮实例在审批详情时间线「当前处理人」行与审批中心详情窗格「待处理人」行不渲染具体人名,只渲染 V1 词(§4.4)。
7. 本文件修订(owner 2026-09-29 16:5x 三项选项入 §1、§9)。

**B2 补做(§11)**:考勤侧「待我审批的撤销」列表、待办中心撤销轮子类型标(P-11 (b))与深链落点核对、P-5 投递状态呈现、对后端 `84dd4545e` 真实响应形状的合同核对、开关 OFF 时已有轮次的 spec(owner 18:3x)、门审 r2 遗留(本文件合并行、批量抬头计数)。下段「不做的」是 B2 之前的原记录,其中已由 B2 补做的项在 §9 各条后注明。

**本阶段不做的**:后端任何改动(摘要 `entryEnabled`、办理成功体最小形、P-5 投递状态、P-11 待办由后端 lane 在后端分支上做);P-11 待办中心呈现(阶段 C);P-5 投递状态呈现(阶段 C);P-6′ 管理员通知(owner 16:5x 选择暂缓,见 §1);考勤侧「待我审批的撤销」列表(owner 16:5x 新增,后端路由不在本基线,见 §9);阶段 D 真浏览器验收。

---

## 1. 授权(只引 owner 原话 / 选项原文;我方建议不是授权)

来源:`goal-four-items-20260928.md` §0(逐字录 owner 选项)与撤销锁抬头「RATIFY 追记 —— 产品入口增补 v2」。

| 条款 / 事项 | owner 原话(选项原文) | 本阶段落点 |
|---|---|---|
| 目标 | 「你所说的这4项能否定为目标来开发执行么？根据代码难度自动选择模型，另外完成后给出设计及验证MD」 | 本分支 + 本文件 |
| Q1′ 挂载侧 | 「(i) Attendance-side (Recommended)」 | 前端只调考勤侧四条路由 |
| P-1 / P-2 / P-4 / P-6 | 「P-1 (Q1) entry + predicates」「P-2 (Q2) status wording」「P-4 (Q4) round-summary read」「P-6 (Q6) seat display lift」 | §2、§3、§4;P-6 → §4.3(自助面零人名)+ §4.4(审批侧两处) |
| P-7 / P-8 / P-9 / P-10 | 「P-7 (Q8) unknown codes」「P-8 (Q9) error-code registry」「P-9 (Q10) seed visibility」「P-10 (Q11) code prerequisite」 | §5 |
| P-3 | 「(iii) Round-summary endpoint (Recommended)」;④ 量纲「Reuse leave-balance formatter (Recommended)」 | 结果行经 `formatLeaveBalanceMinutes` |
| P-6′ | 「(ii) Reuse approval notices (Recommended)」(选项说明含 “weaker employee-facing copy until RC (c) lands”);其后 2026-09-29 16:5x ①「Defer: weak copy only (Recommended)」 | 席位类两码用弱版文案(16:5x 选择下员工面文案与 code 不变,本分支无需改动);管理员通知暂缓,不在本分支 |
| 审批人路径 | 2026-09-29 11:0x 「Attendance-side + OFF flag (Recommended)」 | ④ 走考勤侧 `…/actions`;③ 走考勤侧 `…/withdraw` |
| 开关对前端可见 | 2026-09-29 14:3x 「Summary exposes entryEnabled (Recommended)」 | `entryEnabled` 缺失按 false |
| 办理成功体 | 2026-09-29 14:3x 「Minimal action response (Recommended)」 | 前端不读写路由成功体,成功后重读 |
| 无席位码 | 2026-09-29 14:3x 「Keep, same as approval side (Recommended)」 | 无席位 403 沿用服务端既有句 |
| 审批人入口 | 2026-09-29 16:5x ②「Attendance-side list (Recommended)」;选项说明原文(`goal-four-items-design-20260929.md` §0.2 #24):「Add a 'cancellations waiting for me' list on the attendance side, guarded by attendance:approve and filtered to the viewer's own live seats (same seat source as the actions route) — matches #22 = (i), no grant-policy change. Small backend route + frontend panel.」 | **B2 已做前端面板(§11.2)**,按与后端 lane 约定的合同;后端路由不在 `84dd4545e` 上(后端 lane 并行)。B2 之前的记录:**本分支未做**:需要的后端列表路由不在基线 `2e44d6053` 上,修复轮时后端分支头 `6f9e1cc5dc` 上也没有;前端面板不按猜测的合同先写。门审 r1 定为**阶段 D 验收之前**必须落地(§9 第 11 项) |
| P-5 投递条数 | 2026-09-29 16:5x ③「Show the list (Recommended)」;选项说明原文(同上 §0.2 #25):「Keep the per-delivery list as implemented (follows your 'Full status, no raw ids/errors' choice); mapping outcome_unknown→pending and hiding zero-attempt superseded/skipped rows as documented.」 | 后端在阶段 C;**呈现在 B2(§11.4)** |
| P-11 (b) 待办中心 | 2026-09-29 18:3x(goal §0 记录标签;转录:问 10:13:37Z / 答 12:40:04Z = 20:40 +0800)O-12「**Shown + subtype label (Recommended)**」;选项说明原文(主会话转录):「Cancel-round items appear in the todo centre AND carry a cancel-round subtype label keyed on workflowKey (the addendum text); both count toward phase D.」(goal §0 的中文括注是其译述) | B2 §11.3 |
| 开关 OFF 的前端 | 同上一问,O-13「**Hide launch, keep existing (Recommended)**」;选项说明原文(主会话转录):「OFF hides only the launch entry; rounds that already exist keep their progress view and withdraw, so nobody is stranded mid-round.」(goal §0 的中文括注是其译述) | 与现状一致;B2 用 spec 钉住(§11.6) |
| **合并** | 2026-09-29 17:1x ①「**Yes, merge under those conditions (Recommended)**」。**选项说明原文**(转录派生记录:`goal-four-items-design-20260929.md` §0.2 #26、`cancel-entry-phase-d-acceptance-plan-20260929.md` §0.1):「Main session merges (squash, neutral body) as soon as all conditions hold; flag stays OFF; switch-on and deploy remain separate asks.」;**问题正文(条件,经选项标签「under those conditions」并入;同一出处)**:「Conditions: every gate CONFIRMED with 0 P1 / 0 P2, phase D acceptance passed, 13/13 required checks on the exact head, merge preview / ⑨ / pins / manifest / identity checks all pass. The launch switch ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED stays OFF (feature invisible); turning it on and any deploy still need your separate approval.」;goal §0 所录「条件原文」:「every gate CONFIRMED with 0 P1 / 0 P2, phase D acceptance passed, 13/13 required checks on the exact head, merge preview / ⑨ / pins / manifest / identity checks all pass;开关 `ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED` 保持 OFF;**打开开关与任何部署仍须 owner 另行批准**」—— 其中两句中文是 owner 所选文本(上引选项说明与问题正文末句)的译述 | 本分支(实现 / 修复代理)不推送、不开 PR、不合并;合并只由主会话在上列条件全部满足时执行,今天未满足(B2 未门审、阶段 D 未做、未推送)。合并后开关保持 OFF;打开开关与任何部署另请 owner。goal §0 更早的「这些新 PR 的合并未被点名 ⇒ 完成后单独请示」已被 17:1x 选项取代(门审 r2 P3-1:此前本行把译述标成「记录者文字」,有误,已改) |

---

## 2. 消费的后端合同

以 `2e44d6053` 的路由为准,外加任务写明的两条已定变更(后端 lane 并行实现,本分支不含):

| 路由 | 守卫 | 前端用法 |
|---|---|---|
| `GET /api/attendance/requests/:id/cancel-round` | `attendance:read` | 自助面读摘要;`data.entryEnabled` **缺失按 false**;`data.round` 为 null 或摘要 |
| `POST /api/attendance/requests/:id/cancel-round` | `attendance:write`(默认 OFF 开关) | 发起;成功后**重读摘要**,不读响应体 |
| `POST /api/attendance/requests/:id/cancel-round/withdraw` | `attendance:write` | 申请人撤回;成功后重读摘要 |
| `POST /api/attendance/requests/:id/cancel-round/actions` | `attendance:approve` | 审批人通过 / 驳回:**先**读摘要确认轮次(§4.2),成功后只读成功体的 `roundId` 做事后核对,再重读审批详情(不把响应体写进 store,它不是 `UnifiedApprovalDTO`) |

- 写路由成功体将只有 `{ requestId, roundId, outcome, status }`(后端分支 `ece1bd0a87` 起;`6f9e1cc5dc` 的 `respondCancelRoundActionOutcome`,`plugins/plugin-attendance/index.cjs:37114-37123`)。前端**只读审批人办理成功体的 `roundId`**(修复轮 1,§4.2);发起 / 撤回的成功体不读。**注意**:基线 `2e44d6053` 本身的 `/actions` 成功体是 `{ requestId, ...summary }`,顶层**没有** `roundId` —— 只拿本分支对基线联调,每次办理都会落到「无法确认…请刷新后核对」一句;真 HTTP 联调(阶段 D)必须在叠到后端头之后做。
- 失败体按插件形 `{ ok:false, error:{ code, message } }` 或核心形 `{ error: '…' }` 解析,抛出带 `status` / `code` 的 `ApprovalApiError`。
- **审批侧请假 id 的来源(已查清)**:撤销轮实例的 `businessKey` = **原审批实例 id**(`createCancelRoundInstance` 写入 `documentId`),不是考勤请求 id;原实例的 `businessKey` = `attendance-request:<考勤请求 id>`(插件 `buildAttendanceApprovalInstancePayload`)。因此两跳:`GET /api/approvals/<撤销轮.businessKey>` → 解析 `attendance-request:` 前缀。**任何一跳失败都报错,绝不回落到通用 `/api/approvals/:id/actions`**。

---

## 3. P-2 词表(`cancelRound` 域)

词表来源:ratify 的 P-2 文本「词表(V1–V8)见提案 §3.2」—— 该表在 **v1** 提案 `approval-cancel-round-phase3-fe-entry-design-proposal-20260920.md` §3.2;v2 提案(任务书所指)的 §3.2 是另一节,只回指 v1 §3.2。下表 V1–V8 的中英文与 v1 §3.2 的「建议中文 / 建议英文」两列逐字相同。

`approvalInstance` 域一字未改。`cancelRound` 域每个词带主语:

| 键 | V | 中文 | English | 色调 | 终态 |
|---|---|---|---|---|---|
| `cancellation_pending_approval` | V1 | 撤销申请审批中 | Cancellation pending approval | warning | 否 |
| `leave_cancelled` | V2 | 请假已取消 | Leave cancelled | success | 是 |
| `cancellation_rejected` | V3 | 撤销申请被驳回 | Cancellation rejected | danger | 是 |
| `cancellation_withdrawn` | V4 | 撤销申请已撤回 | Cancellation withdrawn | info | 是 |
| `cancellation_window_closed` | V5 | 撤销窗口已过,申请自动关闭 | Cancellation window closed | neutral | 是 |
| `cancellation_blocked` | V6 | 该请假已无法撤销(业务原因) | Cancellation blocked | neutral | 是 |
| `action_incomplete_retry` | V7 | 本次操作未完成,请稍后重试 | Action failed, still pending | **warning** | **否** |
| `system_busy_retry` | V8 | 系统繁忙,请稍后重试 | System busy | **warning** | **否** |
| `status_resolving` | —(非 V 词) | 撤销结果读取中 | Loading cancellation result | neutral | — |
| `status_unavailable` | —(非 V 词) | 撤销结果暂时无法读取 | Cancellation result unavailable | neutral | — |

- 自助面在 V1 / V3–V6 旁另写「请假仍然有效」,V2 不写(词本身是「请假已取消」)。
- **系统终结与审批人驳回的判据** = 锁 lock:131 那一条(系统终结身份 + `cancelRoundCloseReason`):
  - 自助面:摘要的 `status` / `outcome`(`expired` / `blocked` 与 `rejected` 是不同 outcome)。
  - 审批详情(`getApproval`):DTO 白名单投影 `cancelRoundCloseReason`;有 ⇒ V5 / V6,无 ⇒ V3。
  - **审批列表**(列表 DTO **不带**该判据):只有 `rejected` 有歧义。对「撤销轮 ∧ `rejected` ∧ 行上无原因」的行,读一次详情再定;读取中渲染「读取中」、失败渲染「暂时无法读取」,**从不**在读到判据之前渲染 V3 或 approvalInstance 的「已驳回」。`pending` / `approved` / `revoked` 直接得 V1 / V2 / V4。
  - 时间线:系统收口行的 actor 哨兵显示为「系统」(不渲染原始 id),动作词用 V5 / V6 而不是「驳回」。
- `status_resolving` / `status_unavailable` 是「还没读到判据」的呈现态,不是新 V 词;先例 = P-8 ③「不得与『没有撤销轮』同形」。

---

## 4. 组件与路由对照

### 4.1 五个渲染面(普查)

`git grep -n 'domain="approvalInstance"' 2e44d6053 -- apps/web/src` = 8 行:**5 个渲染点** + 3 行注释(`ApprovalCenterView.vue:1254`、`ApprovalDetailView.vue:2100`、`ApprovalMobileList.vue:119`)。与 ratify 文本的「五个」相符。HEAD 上该 grep 只剩 3 行注释。

| 渲染点(基线行号) | 数据 | 选域方式 |
|---|---|---|
| `ApprovalCenterTable.vue:54` | 列表 DTO | `useCancelRoundCloseReasons().tagProps(row)`(rejected 撤销轮行读详情) |
| `ApprovalCenterDetailPane.vue:9` | 列表行 + 单次详情 | 详情到了用详情;未到「读取中」,详情失败「暂时无法读取」 |
| `ApprovalDetailView.vue:45` | 详情 DTO | `approvalStatusTagProps(approval)` |
| `ApprovalMobileList.vue:29` | 列表 DTO | 同桌面表 |
| `MetaRecordApprovalPanel.vue:121` | 多维表记录提交(不是审批实例 DTO,**无 `workflowKey`**) | 经同一选择器;恒为 approvalInstance。撤销轮不会成为记录提交(撤销轮只经专用创建路径产生;P-9 腿 C:普通 actor 以 seed 模板创建得 404) |

另两处不经 `StatusTag` 的实例状态文字(`ApprovalDetailView.vue:1467` 记录表「结束」行、`:2862` 复制摘要)改用同一选择器。

### 4.2 审批人办理(④)

| 面 | 入口 | 撤销轮 | 普通实例 |
|---|---|---|---|
| `ApprovalDetailView` | `submitAction`(桌面 + 移动) | 考勤侧 `…/actions`,成功后 `store.loadDetail(id)` | `store.executeAction`(不变) |
| `ApprovalCenterView` | 行内通过、行驳回、详情窗格通过(同一处理函数)、批量 | `dispatchApprovalDecision` → 考勤侧 | `dispatchAction`(不变) |
| 待办中心 `TodoCenterView` | —— | 该视图没有通过 / 驳回按钮(`git grep dispatchAction\|executeAction` 只命中上两者) | —— |

- 详情页上撤销轮的通过 / 驳回按钮改为随该路由实际校验的 `attendance:approve`(或管理员)显示,仍须 `canDecideCurrentNode`;转交 / 加签 / 减签 / 退回对撤销轮隐藏(锁 §9-9 允许集只有 approve / reject / revoke / comment)。这只是呈现,服务端(席位、§9-9、授权码)仍是权威。
- 无席位:服务端 403 `APPROVAL_ASSIGNMENT_REQUIRED` 的**原句**照旧显示,与审批侧相同(owner「Keep, same as approval side」)。

**轮次确认(修复轮 1,门审 r1 P2)**。考勤侧 `/actions` 不带实例 id,服务端办理的是该请假的**最新**轮次(基线 `approval-cancel-round-entry-port.ts:358-375` 的 `selectLatestCancelRoundRow`,待审优先)。于是陈旧页面(页面上的轮次已被撤回、申请人又发起了新一轮)点「通过」会落到审批人从未看过的新一轮上,且不可逆。前端在 `decideCancelRoundFromApproval` 里补了客户端一半(服务端「带期望实例 id、不符 409」归后端 lane / owner,见 §9 第 16 项):

| 步 | 做什么 | 失败时 |
|---|---|---|
| 1 | 两跳解析请假 id(§2) | 「无法定位…」,不发任何写 |
| 2 | `GET …/cancel-round`(`attendance:read` + I7)读摘要 | `CANCEL_ROUND_CLIENT_ROUND_UNVERIFIED`:「暂时无法核对这条撤销申请的当前状态;未执行任何操作,请刷新后重试或联系管理员」,不发写(委托人等读不到原请假的人同样在此处失败关闭) |
| 3 | 要求 `round.engineInstanceId === 页面上的实例 id` 且 `round.outcome === 'pending'` | `CANCEL_ROUND_CLIENT_ROUND_NOT_CURRENT`:「这条撤销申请已不在审批中,或已有更新的撤销申请;未执行任何操作,请刷新后查看」,不发写 |
| 4 | `POST …/actions` | 服务端码照 §5 映射 |
| 5 | 要求成功体 `data.roundId === 第 2 步读到的 roundId` | `CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED`:「操作已提交,但无法确认它作用于页面上的这条撤销申请,请刷新后核对结果」——**不**弹「审批已通过 / 已驳回」,也不说「失败,请重试」;`roundId` 缺失同样按「无法确认」处理 |

- 三个码是**客户端**码(`CANCEL_ROUND_CLIENT_*`),不在 §5 的服务端登记表里,不冒充服务端码。
- 详情页收到三者之一会重读详情与时间线;审批中心的行内通过 / 行驳回会重载列表;批量本来就重载。「重试失败项」:B2 之前会把「已提交但未能确认」的行也重跑一遍(被第 2–3 步拒绝、不发第二次写,但随后被记成失败);B2 起只重发真失败的行,这类行不重发、留在清单里单列计数(§11.7,测试钉住)。
- 这只能挡住「页面陈旧」,挡不住第 2 步与第 4 步之间毫秒级的竞态;第 5 步只保证那种情况下不报「成功」。根治在服务端(§9 第 16 项)。
- **id 同一性的依据**:`approval_rounds.engine_instance_id` 就是撤销轮自己的审批实例 id —— 基线 `ApprovalProductService.ts:9538-9546` 创建撤销轮时 `INSERT INTO approval_rounds (…, engine_instance_id, …)` 写入的是本实例的 `instanceId`;迁移 `zzzz20260918090000_create_approval_rounds.ts:66-68` 的头注释同述;真库测试 `approval-cancel-round-attendance-entry.db.test.ts:600` 直接用 `round.engineInstanceId` 调 `/api/approvals/:id/actions`。

**按钮显示谓词(修复轮 1,门审 r1 P3)**。`canDecideCancelRoundWith`(`cancelRound.ts`)= 管理员 ∨ `attendance:approve` ∨ `attendance:admin`,照抄插件 `withAnyPermission` 对 `attendance:approve` 的放行(基线 `plugins/plugin-attendance/index.cjs:23782`);详情页主按钮与审批中心 `isRowBatchSelectable`(它同时喂行内按钮、详情窗格快捷动作、批量勾选)对撤销轮行都用它,普通行不变。第 2 步的摘要读挂在 `attendance:read` 上,而 `withAnyPermission` 只把 `attendance:admin` 映射给 approve / import,不映射给 read;仓内种子里凡持 approve 或 admin 的角色都同时持 read(`zzzz20260208100000_create_roles_table.ts` 的 `attendance_approver` / `attendance_admin`;`admin` 角色见 `zzzz20260117090000_add_attendance_permissions.ts`),所以谓词不加 read;逐人单独授予 approve 却不给 read 的,会在第 2 步失败关闭(「暂时无法核对…」),不会发写。

### 4.3 考勤自助面(①②③)

`AttendanceView.vue`「最近申请」列表的每个 `request_type === 'leave'` 行挂 `AttendanceCancelRoundPanel`(换班列表不挂;挂载位置由测试钉住)。

| 条件 | 呈现 |
|---|---|
| 非请假,或请假状态不是 approved / cancelled | 不读、不渲染 |
| 摘要 404 | 不渲染 |
| 摘要其它失败 | 「撤销状态暂时无法读取」+ 重试(与「无轮次」不同形)—— 开关 OFF 时是否也该这样,是 owner 待裁问题(§9 第 14 项),修复轮未改 |
| `entryEnabled` 为 false / 缺失 | **不渲染发起入口**(不是禁用);已有轮次的进度与撤回仍显示 —— 这是 owner 2026-09-29 18:3x O-13「**Hide launch, keep existing (Recommended)**」(选项说明原文见 §1:「OFF hides only the launch entry; rounds that already exist keep their progress view and withdraw, so nobody is stranded mid-round.」);B2 以 spec 钉住(§11.6)。(B2 之前本行把它记为「实现选择、待 owner 确认」,§9 第 15 项) |
| 摘要里的轮次已 `applied`(V2)而父列表仍说 approved | 不渲染发起入口(修复轮 1;面板不刷新父列表的 `request.status`,此前会留着一个服务端必拒的按钮) |
| entryEnabled ∧ approved ∧ 本人 ∧ 无在途轮 | 「申请撤销」可用 → 对话框(确认 + 可选说明 ≤2000)→ POST → 重读 |
| 同上但**有在途轮**(I3 不满足) | 按钮**禁用**,原因「这条请假已有一个撤销申请在审批中」(`aria-describedby`)+ 页内链接到进度区(审批详情页对员工 403,故不外链) |
| 在途轮 ∧ 本人 | 「撤回撤销申请」:可用性取服务端 `canWithdraw`;窗口已关显示原因;非请求人(`APPROVAL_REVOKE_FORBIDDEN`)不显示 |
| V2 | 结果行(下) |
| V6 | 分类级文案 + 折叠的「技术细节」(原始 code,可复制);不拼 detail |

「我是不是本人」与「是不是已批准」只决定**显示**;服务端在行锁下复核全部谓词。页面不显示任何审批人 / 席位人名(P-6)。样式只用 `--ms-*` token(`AttendanceView.vue` 的十六进制色棘轮未动)。

**P-3 结果行**(`attendanceCancelRoundPresentation.ts`,分钟经 `formatLeaveBalanceMinutes`):

| 分类 | 文案 |
|---|---|
| `cancelled` | 本次已返还 {返还}(共 {lots} 个批次) |
| `cancelled_with_unrecoverable_expired` | 本次已返还 {返还};另有 {过期} 因额度已过期未能返还 |
| `cancelled_reversal_unreported`,或无结果 | 返还结果暂未能读取,请联系管理员核对余额(**不渲染 0**) |
| `alreadyReversed` | 附:此前已返还过,本次未重复返还 |

### 4.4 P-6 席位呈现边界(审批侧)

ratify 的 P-6(§15.6)在其解除条件满足前禁止撤销进度界面渲染「将由谁审批 / 当前审批人」的具体人名(只显示「审批中」),也禁止委托来源标;P-1 把审批详情页定为撤销轮的只读进度面。本分支上的解除条件未满足(RC (c) 未落地,故员工面仍用弱版文案)。普查(`apps/web/src/views/approval/**`、`approvals/**`、`MetaRecordApprovalPanel.vue`)与处理:

| 渲染点 | 内容 | 撤销轮上的处理 |
|---|---|---|
| `ApprovalDetailView.vue` 时间线「当前处理人：{名} · 已等待 {时长}」(`currentHandlerEntries`) | 当前审批人人名,每席一行 | 收成**一行**「撤销申请审批中 · 已等待 {时长}」(V1 词,带主语;不显示人名,也不显示席位数) |
| `ApprovalCenterDetailPane.vue`「待处理人：{名、名}」(`pendingApproverLabels`) | 当前审批人人名 | 换成 V1 词「撤销申请审批中」 |
| `ApprovalDetailView.vue` 时间线后续节点摘要(`nodeAssigneeSourceSummary`) | 只有来源类别或人数(「指定成员（N 人）」等),**从不含人名** | 不改 |
| 委托来源标 | `grep -nE "委托\|delegat\|Delegat"` 对 `ApprovalDetailView.vue`、`ApprovalCenterDetailPane.vue` 零命中 | 无需改 |
| `MetaRecordApprovalPanel.vue` 待处理人 | 多维表记录提交(撤销轮不会成为记录提交) | 不改 |
| 自助面 `AttendanceCancelRoundPanel` | 本来就不渲染任何审批人 / 席位人名 | 不改 |

普通实例的两行逐字不变(测试钉住)。时间线 / 记录表里**已发生动作**的执行人名、`cancelledAssigneesLabel`(「其他审批人已失效」)不在 P-6 字面范围(不是「将由谁 / 当前」),未改,列 §9 第 12 项待门审。

---

## 5. 错误码文案(P-7 / P-8 / P-6′)

**计数说明**:ratify 文本写「登记 11 个 erratum 码」。本阶段不猜这 11 个是哪些,而是在 `2e44d6053` 上机械枚举 `packages/core-backend/src` 的 `'CANCEL_ROUND_*'` 字面量:**16 个**(比 P-8 列出的 14 个多 `CANCEL_ROUND_ROLLOUT_LOCK_SCOPE_CHANGED`、`CANCEL_ROUND_BUSINESS_TARGET_MISSING`),另加 P-8 ③ 点名的 `ATTENDANCE_CALCULATION_ROLLOUT_BUSY`。17 个全部给了中英文案并由测试逐个钉住;覆盖的是超集,「每个码有一条用户文案」对任一子集都成立。锁锚码两个(`SUITE_FORBIDDEN` lock:357、`OUTLET_FORBIDDEN` lock:351)。

| 类 | 码 | 中文 |
|---|---|---|
| ① 创建期 | `DOCUMENT_NOT_APPROVED` | 只有已通过的请假才能发起撤销 |
| | `REQUESTER_ONLY` | 只有请假本人可以发起撤销 |
| | `SUITE_FORBIDDEN` | 该类型的请假不支持撤销 |
| | `ALREADY_PENDING` | 这条请假已有一个撤销申请在审批中 |
| | `NO_ELIGIBLE_APPROVER`、`SEAT_INELIGIBLE` | **暂时无法发起撤销,请联系管理员**(P-6′ 弱版,不声称原因) |
| | `SUITE_UNKNOWN`、`WINDOW_OUT_OF_RANGE` | 该请假的撤销规则配置有误,请联系管理员 |
| | `OUTLET_FORBIDDEN` | 撤销申请不支持该操作,请联系管理员 |
| | `CREATE_FAILED` | 撤销申请未能创建,请稍后重试 |
| ③ 可重试(非终态) | `WINDOW_ANCHOR_MISSING`、`INVARIANT_VIOLATION`、`EXECUTION_PORT_UNAVAILABLE`、`ROLLOUT_LOCK_SCOPE_CHANGED` | V7:本次操作未完成,请稍后重试(撤销申请仍在审批中) |
| | `DISPATCH_CONTENDED`、`ATTENDANCE_CALCULATION_ROLLOUT_BUSY` | V8:系统繁忙,请稍后重试(撤销申请仍在审批中) |
| 非终态、重试无益 | `BUSINESS_TARGET_MISSING` | 本次操作未完成(撤销申请仍在审批中),请联系管理员 |
| 撤回 | `APPROVAL_REVOKE_WINDOW_CLOSED`、`INVALID_STATUS_TRANSITION` | 已有审批人处理过,无法再撤回本次撤销申请 |
| | `APPROVAL_REVOKE_FORBIDDEN` / `APPROVAL_REVOKE_DISABLED` | 只有请假本人可以撤回撤销申请 / 该撤销申请不允许撤回 |
| 其它 | 未登记的码(含无席位 `APPROVAL_ASSIGNMENT_REQUIRED`) | 服务端原句(与审批侧同) |

表中省略了 `CANCEL_ROUND_` 前缀。`ROLLOUT_LOCK_SCOPE_CHANGED`、`BUSINESS_TARGET_MISSING` 的归类是实现选择(前者在任何写入之前拒绝 ⇒ 可重试;后者回滚、轮次仍 pending,但重试不会成功),**不是 ratify 条款**,列此待门审 / owner 核。

**P-7**:已知的 `business_blocked:<code>` 只有三个(C-1 的 `ATTENDANCE_CANCELLATION_REVIEW_REQUIRED`;锁内策略求值的 `CANCEL_ROUND_SUITE_UNKNOWN` / `CANCEL_ROUND_WINDOW_OUT_OF_RANGE`),各有文案;其它一律「该请假已不可撤销(业务原因)」+ 折叠原始 code,不写「原因未知」,不拼 `cancelRoundBlockDetail`(它不在线路上)。

**P-6′ 弱版**:RC (c) 未落地前,员工面对席位类失败只说「暂时无法发起撤销,请联系管理员」,不说原审批人失格。

---

## 6. i18n

沿用仓内既有机制:审批面 `useLocale()` / `isZh` + 状态词表 zh / en 两列(`statusDomains.ts`);考勤面 `tr(en, zh)`;`ApprovalDetailView` 继续 `force-locale="zh"`(该页其它 chrome 为中文)。仓内「STRICT-ZERO」守卫只覆盖多维表(`git grep STRICT` 只命中 `multitable-*` spec),本阶段文件不在其范围。

---

## 7. 测试矩阵与读数

**环境**:工作树 node_modules 为软链到 canonical 的影子目录(`apps/web/node_modules` 与 `packages/core-backend/node_modules` 是本地目录、逐项软链,`.tmp` / `.vite` / `.vite-temp` / `.vue-global-types` 本地化,避免写穿);Node 20.20.2;工具直调 `node node_modules/...`,**未经 pnpm**。前端切片**无真库步骤**(未建库,未连库)。

### 7.1 新 spec(全部登记进 required web lane)

| spec | 用例 | 读数 |
|---|---|---|
| `cancelRoundEntryCore.spec.ts` | 词表主语 / V7-V8 色调 / V3-V5-V6 可辨;V 词解析;域选择器;17 码文案、席位类弱版、未登记码用服务端原句;P-7 未知 code;客户端路径与请求体、`entryEnabled` 缺失 ⇒ false;请假 id 两跳与失败即抛;V7 映射 | 16/16 |
| `cancelRoundEntrySurfaces.spec.ts` | 桌面表:普通行不变 / 撤销轮换域 / rejected 行读详情前「读取中」后 V5 / 详情无原因 ⇒ V3 / 读失败 ⇒「暂时无法读取」;移动列表同;详情窗格三态;多维表记录面板经同一选择器;**P-6**:窗格上撤销轮只有 V1 词、无人名、无「待处理人」,普通实例仍列人名 | 10/10 |
| `cancelRoundEntryDetailView.spec.ts` | 页头 V6 / V3 / 普通实例;时间线与记录表:哨兵 ⇒「系统」、V5 词、不出现「驳回」与原始哨兵;④:仅 `attendance:approve` 的审批人见通过 / 驳回、次要动作隐藏、通过走考勤路由且不调 `executeAction`、成功后重读详情;仅 `approvals:act` 不显示撤销轮办理按钮;409 可重试 ⇒ V7 文案;请假 id 解析失败 ⇒ 对话框报错且零考勤调用零通用调用;普通实例仍走 `executeAction`;**P-6**:两席撤销轮只一行 V1 词、无人名,普通实例两行「当前处理人：{名}」 | 11/11 |
| `cancelRoundEntryCenterRoute.spec.ts` | 行内通过 / 行驳回(带意见)/ 批量(撤销轮行 → 考勤路由,普通行 → `dispatchAction`);无席位 403 原句;不可解析的请假不回落 | 4/4 |
| `cancelRoundEntryAttendancePanel.spec.ts` | entryEnabled 缺失 ⇒ 不渲染、false+有轮 ⇒ 仅进度;仅本人已批准请假有入口、非请假 / pending 不读;**I3 不满足 ⇒ 禁用 + 原因 + 页内链接**;读失败与 404 不同形;发起对话框 → POST → 重读 → V1;席位类弱版、503 ⇒ V8 warning;撤回 → V4、入口重新可用;撤回窗口关闭原因、非本人无撤回;**V2 三值**(1天 / 1天 1小时 + 过期 1小时 + 已返还附注 / unreported 不出现 0);V5 与 V3 可辨;V6 未知 code 折叠;AttendanceView 挂载位置(请假行、最近申请内、换班列表前、唯一一处) | 12/12 |

合计 **53/53**(按 lane token 过滤一次跑五个文件;提交 5 时为 49/49,提交 6 加 4 条 P-6 用例)。修复轮 1 之后是 **72/72**,新增用例见 §10。

### 7.2 mutation(每条:恰一处替换 → 跑 → cp 还原 → `cmp` 逐字节;脚本 `g4cb-mut.py`)

| # | 手术 | 读数 |
|---|---|---|
| C1a | 未读到判据的 rejected 撤销轮 ⇒ V3 | 1 red |
| C1b | `SEAT_INELIGIBLE` 换回声称原因的文案 | 2 red |
| C1c | `entryEnabled` 缺失按 true | 1 red |
| C1d | V7 色调改 danger | 1 red |
| C2-table / C2-mobile | 列表 StatusTag 恢复 approvalInstance 硬编码 | 3 red / 1 red |
| C2-pane | 窗格详情未到时直接用行(⇒ V3) | 1 red |
| C2-record | 记录面板恢复硬编码域 | 1 red |
| C2-lazy | 列表不读判据(⇒ V3) | 3 red |
| C2-dvhead / dvactor / dvlabel / dvend | 详情页头硬编码 / 时间线不映射哨兵 / 系统收口行动作词回「驳回」/「结束」行回 approvalInstance | 2 / 1 / 1 / 1 red |
| C3-dvroute | 详情页撤销轮不走考勤路由 | 3 red |
| C3-dvgate | 撤销轮按钮回到 `approvals:act` | 4 red |
| C3-dvsecondary | 次要动作对撤销轮不隐藏 | 1 red |
| C3-inline / rowreject / batch | 中心三处回到 `dispatchAction` | 2 / 1 / 1 red |
| C3-failclosed-prefix / read | 请假 id 解析失败时回落为其它 id | 1 / 3 red |
| C4-flag | 入口不看 `entryEnabled` | 1 red |
| C4-hide | I3 不满足时隐藏而非禁用 | 2 red |
| C4-owner | 去掉「本人」判断 | 2 red |
| C4-errshape | 读失败按「无」渲染 | 1 red |
| C4-withdraw | 撤回后不重读 | 1 red |
| C4-fold | 不折叠 V6 的 code | 1 red |
| C4-formatter | 不用 `formatLeaveBalanceMinutes` | 1 red |
| C4-unreported | unreported 渲染成「已返还 0天」 | 1 red |
| C4-wiring | AttendanceView 去掉请假行限定 | 1 red |
| L1 | lane 删掉一个新 token 而不重生 manifest | manifest 守卫 7 red |
| C6-dvseat | 详情页 `currentHandlerEntries` 去掉撤销轮分支 | 1 red |
| C6-dvtpl | 详情页模板不按 `seatNamesWithheld` 分支(回到「当前处理人：」前缀) | 1 red |
| C6-paneseat | 窗格 `cancelRoundPendingWord` 恒空(回到人名行) | 1 red |

### 7.3 回归与守卫

| 项 | 读数 |
|---|---|
| `vue-tsc -b`(先删本地 `.tmp` 再跑,与基线 `2e44d6053` 的输出 `cmp`) | 留有日志的读数:提交 1、2、3 后各一次,提交 5 时的 HEAD 一次(提交 5 不改 `.ts` / `.vue`,故覆盖提交 4 的源码),提交 6 后一次 —— 全部**逐字节相同**(EXIT 2,仅已知 TS2769 vite 插件类型)。提交 4 本身没有单独的日志 |
| 提交 6 触及面(引用 `ApprovalDetailView` / `ApprovalCenterDetailPane` / `ApprovalCenterView` 的 37 个 spec 文件) | 844 通过 / 5 失败;5 个即上一行在基线上复现的同 5 条(`approval-ui-workspace` 2、`approvalMobileDetailActions` 3) |
| 触及面既有 spec(引用五个渲染面 / 中心 / 详情 / statusDomains / StatusTag 的 44 个文件) | 970 通过 / 5 失败;5 个失败在基线上逐条复现(`approval-ui-workspace` 2、`approvalMobileDetailActions` 3,均不在 required lane) |
| 引用 `AttendanceView` 的 28 个 spec(含 `attendance-selfservice-dashboard`、十六进制色棘轮) | 644 通过 / 9 失败;9 个在基线上同样失败(`attendance-import-batch-timezone-status` 5、`attendance-record-timeline` 4,均不在 required lane) |
| `required-web-lane-token-manifest-guard` + `required-web-lane-registration-shape`(core-backend 单测) | 63/63 |
| `run-required-web-tests-shape.spec.ts` | 5/5 |
| token 双向子串普查(540 个 token) | 零重复、零碰撞;五个新 token 各恰好命中自己的文件,既有 token 零命中新文件 |
| required web lane 全量(540 token,本地分 9 块各 ≤4 min) | 623 文件 / 10519 通过(最终读数;过程见 §7.4) |

### 7.4 required web lane 分块读数

manifest 的 540 个 token 按字母序每 60 个一块(9 块),每块一次 `vitest run <tokens> --reporter=dot`(`perl alarm 225`)。这是**近似**:lane 实际是 19 条 gating `vitest run` 调用,个别调用带自己的参数;本地未逐条复刻。

| 块 | 最终读数(HEAD) | 过程 |
|---|---|---|
| aa | 60 文件 / 1115 通过 | 首跑 1 失败(`approval-detail-record-table` 首个用例 5 s 超时),复跑两次全绿 |
| ab | 60 / 1094 | 前两跑各 1 失败(`approval-process-attachment-dialog` 首个用例 5 s 超时),后两跑全绿;同块在**基线 src** 上两跑全绿 |
| ac | 62 / 1168(含五个新 spec) | 首跑 1 失败(`fwb-rule-authoring`,多维表自动化,与本分支无交集),复跑全绿 |
| ad | 112 / 1353 | 一次全绿 |
| ae / af / ag / ah / ai | 63 / 1071、78 / 1112、66 / 1282、62 / 1366、60 / 958 | 一次全绿 |
| 合计 | **623 文件 / 10519 通过** | |

两个超时用例单独跑:HEAD 与基线 src 下首个用例都约 0.9–1.2 s(各两跑),无可见差异;超时只在并发负载下出现,且在 HEAD 上复跑即消失。判为负载类偶发,但**没有**做到「同负载下 HEAD 与基线逐次对照」的证明强度 —— 列为残留(§9 第 9 项)。

---

## 8. 提交

1. `feat(web): cancel-round entry core — vocabulary, error copy, attendance client`
2. `feat(web): cancel-round status on the five approval render points`
3. `feat(web): cancel-round approver decisions through the attendance route`
4. `feat(web): leave cancellation entry on the attendance self-service list`
5. `test(web): register the cancel-round entry specs in the required web lane` + 本文件
6. `feat(web): cancel-round progress names no current approver on the approval side`(P-6,§4.4)
7. `docs(approval): phase-B record — owner 16:5x selections, P-6 surfaces, verification readings`(本文件修订)

修复轮 1(门审 r1 之后,新提交,不 amend):

8. `fix(web): cancel-round approver decisions confirm the round on screen`(P2,§4.2 轮次确认)
9. `fix(web): one grant predicate for cancel-round decisions on both approval surfaces`(P3,§4.2 显示谓词)
10. `test(web): pin four cancel-round guards that no spec covered`(P3,门审 U1 / U3 / U5 / U7)
11. `fix(web): cancel-round cleanups — applied round hides the entry, batch refuses a missing row, drop an unused helper`(三条 NIT)
12. 本文件修订(门审 r1 的合并行、残留、§10)
13. `test(web): pin the approval center's list reload after a cancel-round client refusal`
14. 本文件再修订(§9 第 18 项、§10 读数)

每个提交(树 / diff / 提交信息)已按私有短语表自扫,0 命中(修复轮的扫描把提交触及文件的**全文**也扫了,不只 diff)。

---

## 9. 残留与 NOT RUN

1. **列表 DTO 不带 `cancelRoundCloseReason`**:列表面对「撤销轮 ∧ rejected」行逐行读一次详情(终态,结果缓存)。在列表 DTO 上白名单投影该字段即可去掉这次读取 —— 属后端改动,归后端 lane / owner。
2. **审批侧撤回**:撤销轮在审批详情上的「撤回」仍走通用路由(`approvals:act`);员工的撤回入口在考勤自助面(③)。未在 ④ 的点名范围内,未改。
3. **P-6 在审批侧**:已按 ratify 的 P-6 在两处落实(§4.4,提交 6):撤销轮上「当前处理人」「待处理人」不再渲染人名。自助面本来零人名。
4. **请假 id 两跳的边界**:第二跳读原实例受原实例的读准入约束。若某席位持有者不是原实例的参与者,第二跳 404 ⇒ 对话框报「无法定位…请到考勤页面办理或联系管理员」,不回落。撤销轮 DTO 若直接带考勤请求 id 可去掉此跳 —— 后端改动,待 owner。
5. **开发模式 mock**:`approvals/api.ts` 在 DEV 下默认 mock,`getApproval` 返回夹具,审批侧撤销轮办理在 mock 模式下会报「无法定位」。只影响本地 mock。
6. **后端两条已定变更不在本分支基线上**:`entryEnabled` 与最小成功体由后端 lane 实现;本分支对二者的处理(缺失按 false;办理只读成功体的 `roundId`)已由测试钉住。只对基线 `2e44d6053` 联调时,`/actions` 成功体顶层没有 `roundId`,每次办理都会显示「无法确认…请刷新后核对」(§2)。两分支叠合后的真 HTTP 联调 **NOT RUN**。
7. **P-11**(待办中心子类型标 / href 指向原请假)、**P-5**(投递状态;owner 16:5x「Show the list」)不在本阶段(→ **B2 已做呈现**:§11.3、§11.4;href 由后端给出,前端原样使用);**P-6′ 管理员通知**由 owner 16:5x「Defer: weak copy only」暂缓(员工面弱版文案与 code 不变)。
8. **真浏览器 / 阶段 D 验收**:NOT RUN。CI:未推送,NOT RUN。独立门审:未做。
9. **本地全量 lane 的偶发超时**:分块跑时两个挂载 `ApprovalDetailView` 的既有 spec 的首个用例偶发 5 s 超时,复跑即绿;单独计时 HEAD 与基线无差异(§7.4)。CI 上若出现同形红,按已知环境类(worker 负载)处理前应先对照基线。
10. **不写安全机理**:本文件与提交信息不含任何未修缺陷的机理;相关事项见私有记录。
11. **考勤侧「待我审批的撤销」列表**(owner 2026-09-29 16:5x「Attendance-side list (Recommended)」):本 lane 起跑之后才选定;所需后端列表路由不在基线 `2e44d6053` 上,修复轮时后端分支头 `6f9e1cc5dc` 上也没有,前端面板未按猜测的合同先写。门审 r1(P3):在它落地之前,非管理员审批人**没有 UI 路径**办理 —— 审批侧 `GET /api/approvals/:id` 在 `rbacGuard('approvals','read')` 后面,而 `approvals:read` 默认零授予。**阶段 D 验收之前必须落地**(后端路由 → 前端面板,挂 `attendance:approve`,只列查看者自己的在席席位,办理仍走 `…/cancel-round/actions` 且同样做 §4.2 的轮次确认)。→ **B2 已做前端面板**(§11.2,轮次确认同 §4.2,另比对轮次 id);后端路由由后端 lane 并行实现,两分支叠合后核合同(第 24 项)。
12. **P-6 字面范围之外的两处**:撤销轮时间线 / 记录表中已发生动作的执行人名,与 `cancelledAssigneesLabel`(「其他审批人已失效:{名}」),均非「将由谁审批 / 当前审批人」,本分支未改;是否一并收,列给门审。
13. **本 lane 的续跑**:本分支前五个提交由同一 lane 的上一次运行写成(同一工作树、同一分支);本次运行复核了其读数(vue-tsc 逐字节、五个 spec、manifest `--check`、逐提交私有短语扫描),并补提交 6、7。
14. **开关 OFF 时摘要读失败的呈现(门审 r1 P3,owner 待裁,修复轮未改)**。具体情形:开关 OFF、迁移未应用 ⇒ 摘要读返回 503 `DB_NOT_READY` ⇒ 「最近申请」里**每一条**已批准 / 已取消的请假都显示「撤销状态暂时无法读取」+ 重试,且每行各发一次 GET(开关 OFF 时也发)。两种读法各有依据:(a) 现状 —— 读失败不得与「没有撤销轮」同形(P-8 ③ 的先例);(b) owner 11:0x 选项说明原文「so merging never exposes a half-working flow」—— 例如「只有此前一次成功读已确认开关为开或已有轮次时才显示失败态,否则什么都不渲染」,并考虑开关已知为关时合并 / 跳过读取。取 (b) 会让「已有轮次但这次读失败」在开关 OFF 时看起来像没有轮次。这是产品取舍,实现不代选。
15. **开关 OFF 时仍显示已有轮次的进度与撤回(门审 r1 P3)**:见 §4.3;门审认为「入口 = 发起入口」的读法可接受,待 owner 确认;确认则无需改代码。→ **owner 2026-09-29 18:3x「Hide launch, keep existing (Recommended)」已定**,与现状一致;B2 spec 钉住(§11.6)。第 14 项仍待 owner。
16. **服务端的期望实例校验(门审 r1 P2 的服务端一半)**:`/actions` 与 `/withdraw` 接受期望的 `engineInstanceId`、不符回 409 —— 归后端 lane / owner。本分支的轮次确认(§4.2)只是客户端一半:它挡住陈旧页面,挡不住读与写之间的毫秒级竞态,那种情况下只保证不报「成功」。另(门审 r2 P3-3):要让委托席位持有者按 owner 14:3x ① 选项说明「A acts from the approval-side todo item」从审批侧办理,须本项(服务端期望实例 id,预读才能去掉)与第 4 项(撤销轮 DTO 直接带考勤请求 id,第二跳才能去掉)**同时**落地;阶段 D D2 实测。
17. **申请人撤回(考勤自助面)没有做轮次确认**:另一个标签页里撤回并重新发起后,旧标签页的「撤回」会撤回新一轮(申请人自己的、可再发起的动作)。不在门审 r1 的前端修复范围内,由第 16 项的服务端校验覆盖;未改。
18. **审批中心在客户端拒绝后的呈现**:行内通过 / 行驳回重载列表,已由 spec 钉住(提交 13;两条 mutation 均红)。**批量结果清单的计数**:`CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED` 进 `failed`,而清单抬头写「成功 N 项,失败 M 项」/「全部 M 项处理失败」——那一行的决定其实已被服务端接受,行内文案(「操作已提交,但无法确认…」)与抬头的「失败」不一致。「重试失败项」会被预读拒绝,不会发第二次写(spec 钉住)。批量对话框的计数语义本切片未改。→ **B2 已改**(§11.6):抬头单列「已提交但未能确认」计数,不计入失败;无此类行时两种原抬头逐字不变;「重试失败项」不再重发这类行、只有真失败时可点(§11.7)。
19. **批量快照缺行即拒(NIT)**:今天不可达(每个 id 都来自发起时的快照),所以没有 spec;把它改回「回落到通用路由」的 mutation 存活,属预期(§10)。
20. **审批侧 V 词只看 `cancelRoundCloseReason`(门审 r1 NIT,只记录)**:锁 lock:131 的判据是「系统终结身份 + 专用 reason」,审批侧只用了后一半。今天等价:该键唯一的写入点是系统收口路径(基线 `ApprovalProductService.ts:9842`)。未改。
21. **门审 r1 的自报残留(P3,owner 定是否扩范围)**:第 2 项(审批侧撤回仍走通用路由)、第 4 项(第二跳对非原实例参与者的席位持有者失败关闭)、第 12 项(会签驳回时 `cancelledAssigneesLabel` 列出已失效席位人名)——本切片不改。
22. **开关 OFF 时考勤审批人看到的撤销卡片(B2,owner 待裁,与第 14 项同族)**:考勤侧「待我审批的撤销」卡片只按授权码显示(§11.2),不看开关。开关 OFF 且从未开过时它恒为「暂无待我审批的撤销申请」—— 每个持 `attendance:approve` 的人都会在考勤概览看到一张空卡片,而 17:1x 问题正文写的是 “stays OFF (feature invisible)”。两种读法:(a) 现状 —— 开关只门发起(owner 11:0x、18:3x「Hide launch, keep existing」),ON 期间开出的轮次在 OFF 后仍须能办理,所以列表不能跟开关一起消失;(b) 列表为空且开关 OFF 时整卡不渲染(需要前端知道开关态:列表响应不带它,摘要读才带)。实现不代选,记为 owner 问题;阶段 D 取实现读数。
23. **委托席位在考勤侧列表上的办理(B2,与门审 r2 P3-3 同族)**:列表行的办理同样先读摘要(`attendance:read` + I7 于原单);读不到原请假的席位持有者(如委托人)会在预读处失败关闭(「暂时无法核对…未执行任何操作」),不发写。根治同第 16 项。
24. **列表路由的合同只按约定实现(B2)**:`GET /api/attendance/cancel-rounds/pending` 与字段集按主会话与后端 lane 约定的形状写;该路由不在 `84dd4545e` 上,`cancelRoundEntryContract` 因此不核它(§11.5)。**两分支叠合后须核**:成功体键集、`requesterName` 可空、`total` 语义、无授权码 403 的呈现(前端按读失败渲染)、非法 / 缺失字段。NOT RUN。另:B2 收尾时后端分支本地头 `735b8bacca`(C2 lane 的提交,门审状态不由本 lane 判定)上已有该路由,只读 `git show` 对照见 §11.5 —— 形状与约定一致;叠合后的 spec 与真 HTTP 仍 NOT RUN。
25. **深链落点的聚焦标签**:从待办中心进入时,聚焦行的标签仍是既有的「来自审批中心 / Opened from Approval Center」(既有 spec 钉住);措辞与来源不完全一致,只是呈现,未改。
26. **待办中心的可达范围**:`/api/todo/items` / `count` 仍挂 `approvals:read`(默认零授予,阶段 C 门审 r3 §三)⇒ 子类型标今天只到达管理员与被显式授予 `approvals:read` 的人。前端无可改;去处见阶段 C 门审 r3。
27. **投递列表的读者**:投递状态随摘要返回,摘要对任何满足 I7 的读者返回(申请人,以及能读原单的审批人;阶段 D 方案 N1 同述)。前端只渲染摘要给的内容,不另加读者判断。

---

## 10. 修复轮 1(门审 r1 之后)

门审 r1 结论:0 P1 / 1 P2 / 7 P3 / 4 NIT。逐条处置:

| 级 | 项 | 处置 | 提交 |
|---|---|---|---|
| P2 | 审批侧通过 / 驳回映射到按单据取最新轮的考勤路由,陈旧页面会办理审批人没看过的新一轮 | 客户端轮次确认(§4.2):先读摘要要求 `engineInstanceId` = 页面实例且 `pending`,读失败即拒;办理后核对 `roundId`,不符不报成功;详情页重读、中心重载 | 8 |
| P3 | 开关 OFF 时仍显示已有轮次的进度与撤回 | 不改代码,待 owner 确认读法(§9 第 15 项) | —— |
| P3 | 开关 OFF 时摘要读失败每行都显示失败态、每行都发 GET | 不改代码,owner 待裁(§9 第 14 项,写明具体情形与两种读法) | —— |
| P3 | 按钮显示与路由实际授予漂移(详情页漏 `attendance:admin`;中心行内 / 窗格 / 批量不查授予) | 共享谓词 `canDecideCancelRoundWith`,两个面都用 | 9 |
| P3 | 四个守卫的 mutation 存活(U1 / U3 / U5 / U7) | 每个守卫加一条 spec,门审的四条 mutation 原样重跑全红 | 10 |
| P3 | 本文件「合并」行把记录者文字放进 owner 原话列、漏了 17:1x | §1 合并行只放 owner 选项原文,记录者文字移到落点列并注明 | 12 |
| P3 | 考勤侧审批人列表未做 | 后端路由仍不存在;记为阶段 D 前置(§9 第 11 项) | —— |
| P3 | 自报残留(审批侧撤回、第二跳、会签已失效人名) | owner 定;本切片不改(§9 第 21 项) | —— |
| NIT | `blockCodeFromCloseReason` 无调用方 | 删除 | 11 |
| NIT | 批量快照缺行时回落到通用路由 | 改为拒绝(不可达,无 spec) | 11 |
| NIT | V2 之后「申请撤销」仍可点 | `showEntry` 加 `round.outcome !== 'applied'` + spec | 11 |
| NIT | 审批侧 V 词只看 close reason | 只记录(§9 第 20 项) | —— |

### 10.1 新增用例(全部在既有五个 spec 文件里;无新文件 ⇒ lane 登记与 manifest 不变)

| spec | 新增用例 |
|---|---|
| `cancelRoundEntryCore` | 先读摘要再办理(调用顺序);新一轮 ⇒ 拒绝、零写;轮次非 pending / 无轮次 ⇒ 拒绝、零写;摘要读失败 ⇒ 失败关闭、零写;成功体 `roundId` 不符或缺失 ⇒ 「无法确认」且不含「失败」;谓词真值表;200 + `ok:false` 四个客户端函数都抛错。另:既有 V7 用例的 409 改由按路由分派的 mock 落在 POST 上(断言不变);「写路由」用例改为断言办理返回 `roundId` |
| `cancelRoundEntryDetailView` | 陈旧页面:零考勤写、对话框报「未执行任何操作」、重读详情与时间线;`roundId` 不符 ⇒ 不弹「审批已通过」;`attendance:admin` 单独可见按钮;`canDecideCurrentNode === false` 时撤销轮按钮隐藏;既有成功用例加断言「审批已通过」确实弹出 |
| `cancelRoundEntryCenterRoute` | 行内通过遇新一轮 ⇒ 零写、无成功提示、列表重载;行驳回遇非 pending 轮 ⇒ 零写、行内报错、对话框不关、列表重载(提交 13);批量:`roundId` 不符进失败清单,「重试失败项」被预读拒绝、不发第二次写;无授予 ⇒ 撤销轮行无行内按钮且不进批量(普通行照常);`attendance:admin` 单独有行内按钮。既有「无席位 403」用例的 403 改为只落在 POST 上(断言不变) |
| `cancelRoundEntryAttendancePanel` | 本人行上服务端回 `APPROVAL_REVOKE_FORBIDDEN` ⇒ 无撤回;V2 之后入口消失 |
| `cancelRoundEntrySurfaces` | `useCancelRoundCloseReasons`:读失败后下一次 `ensure()` 重试,已解析 / 在途不重复读 |

### 10.2 mutation(脚本 `g4cb-r1fix-mut.py`:备份 → 恰一处替换 → 跑五个 spec → 从备份还原 → `cmp` 逐字节)

| # | 手术 | 读数 |
|---|---|---|
| F1a | 去掉实例 id 比对 | red(3) |
| F1b | 去掉 `pending` 比对 | red(2) |
| F1c | 摘要读失败时照样办理 | red(1) |
| F1d | 去掉事后 `roundId` 核对 | red(3) |
| F1e | 不读成功体 `roundId` | red(4) |
| F1f | 详情页客户端拒绝后不重读 | red(1) |
| F1g / F1h | 中心行内通过 / 行驳回在客户端拒绝后不重载列表 | red(1) / red(1) |
| F2a / F2b | 谓词去掉 `attendance:admin` / `attendance:approve` | red(3) / red(12) |
| F2c | 中心 `isRowBatchSelectable` 不查授予 | red(1) |
| F2d | 详情页回到私有谓词(漏 `attendance:admin`) | red(1) |
| U1 / U3 / U5 / U7 | 门审 r1 的四条,old / new 原样 | 各 red(1) |
| N3 | V2 之后入口不消失 | red(1) |
| N2 | 批量缺行回落通用路由(不可达) | **存活,预期**(§9 第 19 项) |

全部还原 `cmp` OK。

### 10.3 回归与守卫(修复轮代码头 `c3c632ab5a`;五个 spec 另在提交 13 后重跑)

| 项 | 读数 |
|---|---|
| 五个新 spec | 5 文件 / **72/72**(提交 13 之后;`c3c632ab5a` 时 71/71) |
| `vue-tsc -b`(先删本地 `.tmp`) | 与门审 r1 留存的基线 `2e44d6053` 输出**逐字节相同**(EXIT 2,仅已知 TS2769) |
| 引用 `ApprovalDetailView` / `ApprovalCenterView` / `ApprovalCenterDetailPane` / `approvals/cancelRound` / `useCancelRoundCloseReasons` 的 38 个 spec | 826 通过 / 5 失败 —— 与 §7.3 记录的同 5 条(`approval-ui-workspace` 2、`approvalMobileDetailActions` 3)逐条相同;失败原因(源文件样式正则、store mock 缺 `pendingApprovals`)与本轮改动无关;本轮未在基线上重跑(未新建基线工作树) |
| 引用 `AttendanceView` / `AttendanceCancelRoundPanel` 的 29 个 spec | 658 通过 / 9 失败 —— 同 §7.3 的 9 条(`attendance-import-batch-timezone-status` 5、`attendance-record-timeline` 4) |
| `run-required-web-tests-shape.spec.ts` | 5/5 |
| manifest `--check` | MATCHES(540 token);无新 spec 文件,未 `--write` |
| 私有短语自扫 | 修复轮每个提交 0 命中(提交信息、新增行、所触文件全文) |

NOT RUN(本轮):required web lane 全量、真浏览器、阶段 D、CI(未推送)、修复后的独立复审。前端切片无真库步骤(未建库、未连库)。

---

## 11. B2(门审 r2 之后,前端叠到后端头 `84dd4545e` 之后)

起点 `a538caf0a`;只动 `apps/web/**` 与本文件(`git diff --name-only a538caf0a..HEAD` 核),**后端零改动、DDL 零、无真库步骤**(纯前端切片,未建库、未连库)。授权只引 §1 所列 owner 选项;B2 本身未门审。

### 11.0 续跑说明

B2 由同一 lane 的两次运行写成(同一工作树 `g4-cancel-b2`、同一分支):第一次运行写了提交 1–6(`a81e81cff`…`cfa44ea53`)并开始修订本文件,在写 §11 之前中断;第二次运行(本节作者)复核了其读数 —— 逐提交 mutation 日志、vue-tsc 与基线逐字节、回归失败集与基线相同 —— 并按复核结论补提交 7(§11.7)与本文件。私有短语扫描器的正控在第一次运行中未跑完(日志为 `alarm` 超时),第二次运行补跑:在一份临时提交信息里加入一条短语 ⇒ `HIT [msg]`、exit 1;之后对 8 个提交逐个以提交模式扫描(§11.8)。

### 11.1 提交

| # | 提交 | 内容 | 任务项 |
|---|---|---|---|
| 1 | `a81e81cff` `feat(web): attendance-side list of cancellations awaiting my approval` | 考勤侧「待我审批的撤销」卡片 + 客户端 + 共享办理路径 | ① |
| 2 | `ce37029f1` `feat(web): cancel-round sub-type label in the todo center` | 待办中心子类型标;深链落点 spec | ② |
| 3 | `21cf0a254` `feat(web): cancel-round notice delivery status on the attendance panel` | P-5 投递状态 | ③ |
| 4 | `e625d61e9` `test(web): pin the cancel-round client to the server's response shapes` | 读源码的合同 spec;无差异 ⇒ 无前端改动 | ④ |
| 5 | `7b3e40165` `test(web): launch flag OFF keeps an existing round's progress and withdraw` | O-13 spec | ⑤ |
| 6 | `cfa44ea53` `fix(web): batch result counts accepted-but-unconfirmed cancel-round rows apart` | 批量抬头单列计数 | ⑥ |
| 7 | `850843152` `fix(web): cancel-round batch retry and approver-list landing` | 重试不重发已受理行;审批人从深链落到自己的办理行;办理文案 | ⑥ ② ① 的补修(§11.7) |
| 8 | 本文件 | §0 / §1 / §4 / §9 修订 + 本节 | ⑥ |

新 spec 三个(`cancelRoundEntryApproverList`、`cancelRoundEntryTodoCenter`、`cancelRoundEntryContract`),各在引入它的提交里登记进 `run-required-web-tests.sh` 的同一 exec 块与 `.tokens`,并 `node scripts/ops/required-web-lane-token-manifest.mjs --write`(540 → 543)。

### 11.2 ① 考勤侧「待我审批的撤销」列表

owner 2026-09-29 16:5x ②「Attendance-side list (Recommended)」(选项说明原文见 §1)。

- **组件** `AttendanceCancelRoundApproverPanel.vue`,挂在 `AttendanceView` 概览页,**自成一张卡片**,位于折叠的「申请工具」`<details>` 之前、不在其内(spec 按源码钉住唯一挂载点与位置)。
- **显示谓词** = 共享的 `canDecideCancelRoundWith(auth.getAccessSnapshot())` = 管理员 ∨ `attendance:approve` ∨ `attendance:admin` —— 照抄插件 `withAnyPermission` 对 `withPermission('attendance:approve')` 的放行(与审批侧两处同一谓词,§4.2)。谓词为假 ⇒ 不渲染、**不发读**。只是显示;路由(授权码、席位)才是判据。
- **读**:`GET /api/attendance/cancel-rounds/pending`,合同按主会话与后端 lane 的约定:`{ ok: true, data: { items: [{ requestId, roundId, engineInstanceId, requesterUserId, requesterName, requestType, startAt, endAt, launchedAt }], total } }`,`requesterName` 可空。`normalizePendingCancelRoundList` 严格:缺 `data.items` 数组、或任一行缺三个办理用 id(`requestId` / `roundId` / `engineInstanceId`)⇒ **整次读失败**;`total` 非数或小于行数 ⇒ 取行数;`total > items.length` 时显示「显示 N 条,共 M 条」。
- **读失败 ≠ 没有待办**:非 2xx(含路由不存在的 404、无授权码的 403)、畸形体 ⇒ 独立的失败态「待我审批的撤销申请暂时无法读取」+ 重试(`data-cancel-round-pending-state="error"`);空列表是另一句「暂无待我审批的撤销申请」。二者不同形(spec + mutation A1 / A7)。
- **每行**:申请人名(空则「用户 {id}」)、请假类型(页面自己的 `formatRequestType`)、请假起止与撤销发起时刻(页面自己的 `formatDateTime`,即考勤时区)、V1 词「撤销申请审批中」。**不渲染任何审批人 / 席位人名**(P-6)。
- **办理**:通过 / 驳回 → 行内确认(驳回可填说明 ≤2000)→ `decideCancelRoundOnRequest(requestId, { engineInstanceId, roundId }, action)`。这是把 §4.2 的轮次确认从审批侧抽出来的**同一条路径**(`decideCancelRoundFromApproval` 现在先解析请假 id,再委托它):先读摘要,要求摘要里的轮次 `engineInstanceId` 与 `roundId` 都等于该行、且 `outcome === 'pending'`,否则**不发写**;读失败同样失败关闭;办理后核对成功体 `data.roundId`,不符 ⇒「操作已提交,但无法确认…」(`unconfirmed`,既不是成功也不是失败)。审批侧只知道实例 id,不传 `roundId`,行为不变。每次尝试之后**重读列表**。
- **开关不参与**:`entryEnabled` 只门发起(owner 11:0x「a default-OFF flag on the launch endpoint」、18:3x O-13),本卡片不读它;spec 的摘要夹具故意给 `entryEnabled: false`,办理照常。开关 OFF 时这张卡片是否整卡隐藏,见 §9 第 22 项(owner 待裁)。
- **深链**:`?requestId=` 命中的行加标记;落点见 §11.7。

### 11.3 ② 待办中心子类型标与深链落点(P-11 (a)(b))

owner 2026-09-29 18:3x O-12「Shown + subtype label (Recommended)」(选项说明原文见 §1)。

- `PendingItem` 增可选 `workflowKey?: string | null`(后端 `84dd4545e` 的 `pending-source-registry.ts` 已声明、`approval-pending-source.ts` 已填;合同 spec 核)。
- `workflowKey === 'approval.cancel-round'`(`isCancelRoundWorkflow`,与审批侧同一判据)的项在标题旁显示子类型标「撤销申请 / Cancellation request」;**只看 `workflowKey`,不看标题前缀**(标题像撤销但无 key、或无 key 的项都不显示;mutation B1 / B2 红);不可导航(非站内相对 href)的惰性行同样显示(B4 红)。
- `href` 原样交给 `router-link`(后端给的是原请假深链 `/attendance?section=attendance-overview-requests&requestId=<id>`,前端不改写;B3 红)。
- **考勤页能否按该深链定位并展开该请假**:能,无需补。`AttendanceExperienceView` 把 `route.query.requestId` 传给 `AttendanceView` 的 `initialRequestId`;列表加载时另读 `GET /api/attendance/requests/:id`(`attendance:read`,非本人还须 `canAccessOtherUsers` = 考勤管理员或 `attendance:approve`,所以撤销轮审批人可读)并把它**放在第一行、标为聚焦**;`section=attendance-overview-requests` 与 `requestId` 都会打开折叠的「申请工具」。`attendance-selfservice-dashboard` 新用例钉住:查看者 ≠ 请假人,深链落到已批准请假,工具区打开,该行第一且聚焦,行上挂着撤销块并显示 V1(B5 / B6 红)。审批人的办理行不在这个请假行上,而在 §11.2 的卡片里 —— 落点补修见 §11.7。

### 11.4 ③ P-5 投递状态

ratify P-5「(iii) Full delivery」+「Full status, no raw ids/errors (Recommended)」;owner 16:5x ③「Show the list (Recommended)」。

- 摘要轮次新增 `deliveries`,由 `normalizeCancelRoundDeliveries` **逐字段拷贝**六个字段(`channelType` / `status` / `attempts` / `createdAt` / `lastAttemptAt` / `updatedAt`),线上多出的任何字段都到不了页面(mutation C4「整行展开」红)。
- 缺失 / 非数组 ⇒ `null` ⇒ **不渲染**(「没报告」不是「没发」;C1 红);`[]` ⇒ 独立空态「暂无这条撤销申请的通知投递记录」(C8 红)。
- 状态三值固定文案:`delivered`「已送达」、`pending`「发送中或结果待确认」、`failed`「未能送达(不影响撤销申请本身)」;三值之外的状态行不列(与服务端对未知账本态的处理同形;C2 红)。渠道类型:`dingtalk_approval_card`「钉钉审批卡片」、`dingtalk_todo`「钉钉待办」,未知类型用中性标签「其他通知渠道」,不显示原始串(C3 红)。
- 时间走页面自己的 `formatDateTime`(C7 红)。**投递失败不改轮次的 V 词与色调**(锁不变量「投递失败不改变撤销轮任何状态」;C5 红);失败文案不说「失败」二字(C6 红)。
- 读者:随摘要返回,前端不另加读者判断(§9 第 27 项)。

### 11.5 ④ 与后端真实响应形状对齐

`cancelRoundEntryContract.spec.ts`:只 `readFileSync` 读本分支树里的后端源码(即 `84dd4545e` 的后端文件),按符号名解析、锚点找不到即红,不按行号。先例 `attendance-rules-me-contract-sync.spec.ts`。逐项:

| 项 | 后端出处 | 核法 | 结果 |
|---|---|---|---|
| 办理 / 撤回 200 体恰 4 键 | 插件 `respondCancelRoundActionOutcome` 的 `data:` 块;`/actions` 与 `/withdraw` 都经它回 | 键集 == `{outcome, requestId, roundId, status}`;两路由都调用它;前端从 `data.roundId` 读(不从顶层) | 一致(D1 红) |
| 摘要 `entryEnabled` | 插件摘要路由 `data: { requestId, ...summary, entryEnabled: isAttendanceCancelRoundEntryEnabled() }` | 正则钉住 | 一致 |
| 摘要轮次字段集 | 端口 `CancelRoundSummaryRoundV1` | 用服务端字段造一条线上轮次过前端 normalizer,键集相等 | 一致(D2 红) |
| 状态 / outcome / 撤回原因词表 | `CancelRoundSummaryStatusV1`、`CancelRoundOutcomeV1`、`CancelRoundWithdrawBlockedReasonV1` | 状态 == 前端 V 键集;每个 outcome 都映射到 V 词;每个撤回原因都有文案 | 一致(D3 / D8 红) |
| `deliveries` | `CancelRoundDeliveryV1`、`CancelRoundDeliveryStatusV1`、`CancelRoundDeliveryChannelTypeV1` | 字段集、状态联合、渠道联合分别等于前端拷贝与标签 | 一致(D4 / D9 红) |
| 错误码 | `core-backend/src/**` 与插件中所有带引号的 `CANCEL_ROUND_*` 字面量 | 每个都有前端文案 | 一致(D5 红) |
| 待办项 `workflowKey` / `href` | `pending-source-registry.ts` 的 `PendingItem`;`approval-pending-source.ts` 的 `workflowKey: row.workflowKey,`、`ATTENDANCE_REQUESTS_SECTION`、`attendanceRequestHref`;`w4c3b-central-approval-hooks.ts` 与插件的 `APPROVAL_CANCEL_ROUND_WORKFLOW_KEY` | 字段存在;撤销轮 key 两侧同串;href 模板 == 前端 section id + `requestId`,且 `AttendanceExperienceView` 读这两个参数 | 一致(D6 / D7 红) |

结论:**对 `84dd4545e` 无差异,提交 4 不改前端代码**。

**待我审批列表路由**不在 `84dd4545e` 上,合同 spec 不核它。B2 收尾时后端分支本地头 `735b8bacca`(C2 lane 的提交;本 lane 只读 `git show`,不碰其工作树,门审状态不由本 lane 判定)上已有 `GET /api/attendance/cancel-rounds/pending`:`withPermission('attendance:approve')`;成功体 `{ ok: true, data: { items: listed.slice(offset, offset + pageSize), total: listed.length } }`,每行恰为约定的 9 个键,`requesterName` 为空串 / 缺失时给 `null`,`launchedAt` 可为 `null`;分页用插件 `parsePagination`(默认 50、最大 200),`total` 是分页前的全部可列轮次数;503 `DB_NOT_READY` / 500 失败体。与前端 normalizer 一致(前端不发分页参数 ⇒ 最多显示 50 行并提示「共 M 条」,见 §11.9)。叠合后的 spec 与真 HTTP **NOT RUN**(§9 第 24 项)。

### 11.6 ⑤ O-13 spec 与 ⑥ 门审 r2 遗留

- **O-13**(owner 18:3x「Hide launch, keep existing (Recommended)」):`cancelRoundEntryAttendancePanel` 新增两例 —— `entryEnabled: false` + 在途轮 ⇒ 进度在、撤回可用且真的发出并重读、无发起入口;`entryEnabled: false` + 已结束轮(V2 结果行、V3 词)⇒ 结果可读、无发起入口。代码无改动(与现状一致),面板头注释改为引 owner 选项。mutation E1(撤回也看开关)、E2(进度也看开关)、E3(发起不看开关)、E4(面板只在有入口时渲染)全红。
- **门审 r2 P3-1(本文件合并行)**:§1 合并行改为选项说明原文 + 问题正文条件(出处为转录派生记录),删去「记录者文字」表述,注明 goal §0 的两句中文是 owner 所选文本的译述。同理,§1 的 O-12 / O-13 两行补了选项说明原文(取自主会话转录;goal §0 的中文括注是译述)。
- **门审 r2 P3-6(批量抬头)**:`CANCEL_ROUND_CLIENT_ACTED_ROUND_UNCONFIRMED` 的行单列计数:「成功 N 项,已提交但未能确认 K 项,失败 M 项:」,每行带 `data-batch-result-kind`(`unconfirmed` / `failed`);无此类行时两种原抬头逐字不变(spec 钉住)。mutation F1–F4 全红。重试语义见 §11.7。
- **门审 r2 P3-3**:§9 第 16 项已补「委托席位走审批侧办理须第 16 项与第 4 项同时落地」;考勤侧列表的同族情形见 §9 第 23 项。

### 11.7 提交 7:复核后的补修

第二次运行复核提交 1–6 时发现三处,合为一个提交:

1. **「重试失败项」把已受理的行改记为失败**。提交 6 之后,只有一条「已提交但未能确认」行时抬头是「成功 0 项,已提交但未能确认 1 项,失败 0 项:」,但「重试失败项」仍可点;点了会重跑该行,预读拒绝(不发第二次写),然后抬头变成「全部 1 项处理失败:」—— 一条服务端已接受的决定被记成失败,与「不算失败」相反。改为:重试**只重发真失败的行**;「已提交但未能确认」的行不重发、带着原文案留在清单里、单列计数;没有真失败时按钮禁用。spec:原「重试被预读拒绝」用例改为断言按钮禁用、点击零读零写、抬头不变;三类计数用例追加一次重试 —— 只重发 `apv_bad`、考勤写仍 1 次、抬头「成功 0 项,已提交但未能确认 1 项,失败 1 项:」、行序 `unconfirmed, failed`。
2. **审批人从待办深链进来,办理行在视野之外**。撤销轮待办项是**审批人**的待办,点它的人通常不是请假人;深链把页面滚到「申请工具」卡片(`block: 'start'`),而审批人的办理行在其上方的 §11.2 卡片里。改为:卡片首次读到并标记深链行后,把该行滚入视野(`block: 'center'`,每个 `requestId` 只一次,办理后的重读不再滚动),并发 `focused-row-shown`;页面记下该 `requestId`,其深链滚动(`focusInitialAttendanceSection`)对同一 `requestId` 不再把视野拉走。「申请工具」照常打开、聚焦行照常在第一行。spec:卡片级(滚动一次、`this` 是标记行、事件一次;不在列表里的 id 零滚动零事件);页面级(`attendance-selfservice-dashboard`:持 `attendance:approve` 的查看者 ≠ 请假人,最后一次 `scrollIntoView` 的对象是卡片里的标记行,且该行有「通过」按钮,工具区仍打开);AttendanceView 源码级(事件绑定、滚动守卫)。
3. **办理文案承诺了结果**。确认句原为「确认通过这条撤销申请?通过后该请假将被取消。」,成功句「已通过撤销申请」;会签轮次需要每个席位,通过的轮次也可能因业务原因落到 V6。改为说这一下做了什么:「确认通过这条撤销申请?撤销申请全部审批通过后,该请假才会被取消。」/「确认驳回这条撤销申请?撤销申请被驳回时,请假仍然有效。」;成功句「已提交通过意见」/「已提交驳回意见」(英文同义)。结果由重读后的列表与自助面 V 词呈现。

### 11.8 测试与读数(HEAD = 提交 7 的树;Node 20.20.2;工具直调 `node node_modules/…`,**零 pnpm**)

**spec 读数**(回归集一次跑,见下):

| spec | 用例 | B2 前(`a538caf0a`) |
|---|---|---|
| `cancelRoundEntryApproverList`(新) | 14/14 | —— |
| `cancelRoundEntryTodoCenter`(新) | 3/3 | —— |
| `cancelRoundEntryContract`(新) | 9/9 | —— |
| `cancelRoundEntryAttendancePanel` | 20/20 | 14 |
| `cancelRoundEntryCenterRoute` | 10/10 | 9 |
| `cancelRoundEntryCore` / `DetailView` / `Surfaces` | 23/23 / 15/15 / 11/11 | 同 |
| 八个 `cancelRoundEntry*` 合计 | **105/105** | 72 |
| `attendance-selfservice-dashboard` | 87/87(B2 新增 2 例) | 85 |
| `TodoCenterView` / `todoApi` / `approval-center` / `approval-center-master-detail` / `run-required-web-tests-shape` | 15/15 / 6/6 / 30/30 / 32/32 / 5/5 | —— |

**mutation**(每条:cp 备份 → 恰一处替换 → 跑点名 spec → 从备份还原 → `cmp` 逐字节且 `git diff --quiet`;脚本 `g4b2-mut.py`;全部 `restored=True`):

| 提交 | 条目 | 读数 |
|---|---|---|
| 1 | A1 读失败按空列表 · A2a 模板不看谓词 · A2b 读不看谓词 · A3 去掉 `roundId` 比对 · A4 卡片不传 `roundId` · A5 「无法确认」按错误 · A6 办理后不重读 · A7 畸形体按空列表 · A8 页面谓词恒真 · A9 去掉实例 id 比对 · A10 去掉 `pending` 比对 | 11/11 红(A3 / A9 / A10 跨四个 spec 跑) |
| 2 | B1 按标题前缀判子类型 · B2 恒不标 · B3 改写 href · B4 惰性行不标 · B5 聚焦行不挂撤销块 · B6 聚焦行不在第一 | 6/6 红 |
| 3 | C1 缺失按空 · C2 未知状态保留 · C3 未知渠道显示原串 · C4 整行展开 · C5 投递失败改轮次词 · C6 失败文案写「发送失败」· C7 不用页面时间格式 · C8 空列表不渲染 | 8/8 红 |
| 4 | D1 `roundId` 从顶层读 · D2 丢一个轮次字段 · D3 少一个 V 键 · D4 少一个渠道标签 · D5 少一条码文案 · D6 section id 漂移 · D7 workflowKey 漂移 · D8 outcome 未映射 · D9 丢一个投递字段 | 9/9 红 |
| 5 | E1–E4(见 §11.6) | 4/4 红 |
| 6 | F1 不记录未确认行 · F2 抬头不单列 · F3 失败数含未确认 · F4 判定函数恒 false | 4/4 红 |
| 7 | G1 重试含未确认行 · G2 按钮恒可点 · G3 重试后丢掉未确认行 · G4 抬头失败数含未确认 · H1 不滚动 · H2 每次重读都滚 · H3 不发事件 · H4b 页面去掉滚动守卫(源码级 spec)· H5 页面不接事件 · H6 确认句回到承诺结果 · H7 成功句回到「已通过撤销申请」 | 11/11 红 |
| 7 | H4a 页面去掉滚动守卫,只跑 `attendance-selfservice-dashboard` | **存活**:jsdom 里页面的深链滚动先于卡片读完发生,守卫只在「卡片先、页面后」的次序下起作用;该次序只由源码级 spec(H4b)钉住 |

**回归集**(`g4b2-regress.sh`:引用撤销轮 / 审批中心 / 待办 / `AttendanceView` 等的 61 个 spec 文件,分 6 块):HEAD **61 文件 / 1217 用例 / 1206 通过 / 11 失败**;基线 `a538caf0a` 58 文件 / 1182 / 1171 / 11。11 条失败的用例名逐行 `diff` **与基线相同**(`approval-ui-workspace` 2、`attendance-import-batch-timezone-status` 5、`attendance-record-timeline` 4,均为 B2 之前既有)。提交 1、2、3、6 之后各跑一次,失败集同样与基线相同。

| 项 | 读数 |
|---|---|
| `vue-tsc -b`(先清本地 `apps/web/node_modules/.tmp`,输出与基线 `a538caf0a` 的输出 `cmp`) | 基线、提交 1、2、3、4、6(提交 5、6 合跑)、7 之后 —— 全部**逐字节相同**,sha256 `ec44fee420b32b96…`(与门审 r2 留存的 `2e44d6053` 基线同一哈希),EXIT 2,仅已知 TS2769;`tsbuildinfo` 含 `attendancecancelroundapproverpanel.vue` / `approvalcenterview.vue` / `todocenterview.vue`(确非空转) |
| `node scripts/ops/required-web-lane-token-manifest.mjs --check` | 19 gating invocations,**543 = 543**,MANIFEST MATCHES |
| 新 token 普查(543 个 token、871 个 spec 文件) | 三个新 token 各恰命中自己的文件;无其它 token 命中它们的文件;无子串关系 |
| core-backend `required-web-lane-registration-shape` + `required-web-lane-token-manifest-guard` | 63/63 |
| 私有短语逐提交自扫(三份短语表,大小写不敏感;提交信息 + 新增行 + 所触文件后像相对父提交的新增命中) | 正控:临时信息加一条短语 ⇒ `HIT [msg]`、exit 1;8 个提交各 **0 命中** |
| 提交身份 | 8 个提交作者 / 提交者均为 `zensgit <77236085+zensgit@users.noreply.github.com>`,尾行 `Co-Authored-By: Claude Opus 5.5` |
| canonical 工作树 | `git status --porcelain` 与 B2 开跑前逐字节相同(md5) |

### 11.9 NOT RUN 与 B2 残留

- **NOT RUN**:required web lane 全量(543 token);与后端分支叠合后的 spec 与真 HTTP(含列表路由,§9 第 24 项);真浏览器与阶段 D;CI(未推送);B2 的独立门审。
- **列表无分页 UI**:前端不发分页参数,路由默认每页 50;超过时卡片显示前 50 条并提示「共 M 条」。审批人一次有 50 条以上待办撤销时要靠办理后重读逐步看到其余 —— 是否需要翻页,阶段 D 取读数。
- **深链落点**:卡片首次读到深链行时才滚动;若列表读失败或该请假不在查看者的在席列表中,页面保持原有落点(「申请工具」里的聚焦请假行);聚焦行的来源标签仍写「来自审批中心」(§9 第 25 项)。
- §9 第 22–27 项为 B2 新增的残留与 owner 待裁项;第 14 项仍待 owner。
