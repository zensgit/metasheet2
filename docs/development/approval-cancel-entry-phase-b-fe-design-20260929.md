# 请假撤销 —— 产品入口 阶段 B(只前端)设计与验证记录 —— **草稿**

| 项 | 值 |
|---|---|
| 状态 | 草稿:实现与本地验证已完成(7 个提交,见 §8);**独立门审未做**;未推送、未开 PR;**合并未被授权**(见 §1) |
| 分支 | `feat/approval-cancel-entry-phase-b-fe` |
| 基线 | 后端分支 `feat/approval-cancel-entry-phase-a-read-launch` 的 `2e44d6053`(阶段 A + A2;其基线 `main @ f47054d88e`) |
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
| 审批人入口 | 2026-09-29 16:5x ②「Attendance-side list (Recommended)」 | **本分支未做**:需要的后端列表路由不在基线 `2e44d6053` 上,前端面板不按猜测的合同先写;后端路由落地后另起切片(§9 第 11 项) |
| P-5 投递条数 | 2026-09-29 16:5x ③「Show the list (Recommended)」 | 阶段 C(后端 + 呈现),不在本分支 |
| **合并** | 撤销入口 PR 的合并**未被点名**(goal §0:「这些新 PR 的合并未被点名 ⇒ 完成后单独请示」) | 不推送、不开 PR、不合并 |

---

## 2. 消费的后端合同

以 `2e44d6053` 的路由为准,外加任务写明的两条已定变更(后端 lane 并行实现,本分支不含):

| 路由 | 守卫 | 前端用法 |
|---|---|---|
| `GET /api/attendance/requests/:id/cancel-round` | `attendance:read` | 自助面读摘要;`data.entryEnabled` **缺失按 false**;`data.round` 为 null 或摘要 |
| `POST /api/attendance/requests/:id/cancel-round` | `attendance:write`(默认 OFF 开关) | 发起;成功后**重读摘要**,不读响应体 |
| `POST /api/attendance/requests/:id/cancel-round/withdraw` | `attendance:write` | 申请人撤回;成功后重读摘要 |
| `POST /api/attendance/requests/:id/cancel-round/actions` | `attendance:approve` | 审批人通过 / 驳回;成功后重读审批详情(不把响应体写进 store,它不是 `UnifiedApprovalDTO`) |

- 写路由成功体将只有 `{ requestId, roundId, outcome, status }`:前端**任何地方都不读**写路由的成功体(测试用的就是最小形)。
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

### 4.3 考勤自助面(①②③)

`AttendanceView.vue`「最近申请」列表的每个 `request_type === 'leave'` 行挂 `AttendanceCancelRoundPanel`(换班列表不挂;挂载位置由测试钉住)。

| 条件 | 呈现 |
|---|---|
| 非请假,或请假状态不是 approved / cancelled | 不读、不渲染 |
| 摘要 404 | 不渲染 |
| 摘要其它失败 | 「撤销状态暂时无法读取」+ 重试(与「无轮次」不同形) |
| `entryEnabled` 为 false / 缺失 | **不渲染发起入口**(不是禁用);已有轮次的进度与撤回仍显示 —— 「开关只管发起入口,不管进度与撤回」是**实现选择**(依据:开关挂在发起端点上;owner 14:3x 选项说的是「整块隐藏撤销入口」),**不是 owner 条款**,待门审 / owner 核 |
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

合计 **53/53**(按 lane token 过滤一次跑五个文件;提交 5 时为 49/49,提交 6 加 4 条 P-6 用例)。

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

每个提交(树 / diff / 提交信息)已按私有短语表自扫,0 命中。

---

## 9. 残留与 NOT RUN

1. **列表 DTO 不带 `cancelRoundCloseReason`**:列表面对「撤销轮 ∧ rejected」行逐行读一次详情(终态,结果缓存)。在列表 DTO 上白名单投影该字段即可去掉这次读取 —— 属后端改动,归后端 lane / owner。
2. **审批侧撤回**:撤销轮在审批详情上的「撤回」仍走通用路由(`approvals:act`);员工的撤回入口在考勤自助面(③)。未在 ④ 的点名范围内,未改。
3. **P-6 在审批侧**:已按 ratify 的 P-6 在两处落实(§4.4,提交 6):撤销轮上「当前处理人」「待处理人」不再渲染人名。自助面本来零人名。
4. **请假 id 两跳的边界**:第二跳读原实例受原实例的读准入约束。若某席位持有者不是原实例的参与者,第二跳 404 ⇒ 对话框报「无法定位…请到考勤页面办理或联系管理员」,不回落。撤销轮 DTO 若直接带考勤请求 id 可去掉此跳 —— 后端改动,待 owner。
5. **开发模式 mock**:`approvals/api.ts` 在 DEV 下默认 mock,`getApproval` 返回夹具,审批侧撤销轮办理在 mock 模式下会报「无法定位」。只影响本地 mock。
6. **后端两条已定变更不在本分支基线上**:`entryEnabled` 与最小成功体由后端 lane 实现;本分支对二者的处理(缺失按 false;不读成功体)已由测试钉住。两分支合并后的真 HTTP 联调 **NOT RUN**。
7. **P-11**(待办中心子类型标 / href 指向原请假)、**P-5**(投递状态;owner 16:5x「Show the list」)不在本阶段;**P-6′ 管理员通知**由 owner 16:5x「Defer: weak copy only」暂缓(员工面弱版文案与 code 不变)。
8. **真浏览器 / 阶段 D 验收**:NOT RUN。CI:未推送,NOT RUN。独立门审:未做。
9. **本地全量 lane 的偶发超时**:分块跑时两个挂载 `ApprovalDetailView` 的既有 spec 的首个用例偶发 5 s 超时,复跑即绿;单独计时 HEAD 与基线无差异(§7.4)。CI 上若出现同形红,按已知环境类(worker 负载)处理前应先对照基线。
10. **不写安全机理**:本文件与提交信息不含任何未修缺陷的机理;相关事项见私有记录。
11. **考勤侧「待我审批的撤销」列表**(owner 2026-09-29 16:5x「Attendance-side list (Recommended)」):本 lane 起跑之后才选定;所需后端列表路由不在基线 `2e44d6053` 上,前端面板未按猜测的合同先写。后端路由落地后,前端面板另起切片(挂 `attendance:approve`,只列查看者自己的在席席位,办理仍走 `…/cancel-round/actions`)。
12. **P-6 字面范围之外的两处**:撤销轮时间线 / 记录表中已发生动作的执行人名,与 `cancelledAssigneesLabel`(「其他审批人已失效:{名}」),均非「将由谁审批 / 当前审批人」,本分支未改;是否一并收,列给门审。
13. **本 lane 的续跑**:本分支前五个提交由同一 lane 的上一次运行写成(同一工作树、同一分支);本次运行复核了其读数(vue-tsc 逐字节、五个 spec、manifest `--check`、逐提交私有短语扫描),并补提交 6、7。
