# 请假撤销 —— 产品入口 阶段 A(只后端)设计与验证记录 —— **草稿**

| 项 | 值 |
|---|---|
| 状态 | 草稿(实现 + 本地真库验证已完成;未推送、未开 PR;独立门审 r1 / r2 已做,本稿为 r2 之后的修复轮;**合并未被授权**) |
| 分支 | `feat/approval-cancel-entry-phase-a-read-launch` |
| 基线 | `main @ f47054d88e`(第 2 轮 rebase;原基线 `68a703038e`。撤销轮 C-1 #5851 `44770107f`、C-2 #5856 `2594ca6e2` 已在其中) |
| 权威锁 | 撤销锁 v5.9(RATIFIED 2026-09-18)及其抬头「**RATIFY 追记 —— 产品入口增补 v2(P-1…P-11)**」(2026-09-28) |
| DDL | **零**(未新增、未修改任何迁移) |
| 实现模型 | Claude Opus 5.5(Fable 回退) |
| 修复轮 | 第 2 轮(门审 r1 / r2 结论的处理见 §7)。推送前已改写本分支历史并 rebase 到 `main @ f47054d88e`,提交号与门审 r1 / r2 所见不同;改写前后分支最终树相同,rebase 只带入 main 的改动与 s6a pin 重算(§5)。本轮修复为新提交 |

---

## 0. 范围

**本阶段做的**(全部在后端):

1. `GET /api/attendance/requests/:id/cancel-round` —— 撤销轮摘要(P-4,承载 P-3 (iii) 的返还结果)。
2. `POST /api/attendance/requests/:id/cancel-round` —— 发起撤销轮(P-1)。
   两个端点**只处理请假**(`request_type = 'leave'`,§3.1);非请假单在本入口视同不存在。
3. 两个端点背后的宿主→插件端口 `approvalCancelRoundEntry`(只注入 plugin-attendance)。
4. 接线日守卫升级(登记项 L-4,见 §3.7)与 CI 接线。

**本阶段不做的**(ratify 后的分期里属于后续阶段):前端入口与五渲染面文案(P-2 呈现、P-7/P-8 文案、P-3 ④ `formatLeaveBalanceMinutes`)、P-6′ 管理员通知、P-5 投递状态、P-11 待办中心呈现、员工侧「撤回本次撤销申请」端点。

---

## 1. ratify 锚点(只引 owner 选项原文 / 锁抬头;我方建议不是授权)

锁抬头「RATIFY 追记 —— 产品入口增补 v2」记录了 owner 2026-09-28 四轮选项原文。本阶段用到的:

| 条款 | owner 选项原文 | 本阶段落点 |
|---|---|---|
| P-1 | 「P-1 (Q1) entry + predicates」 | POST 前置 (a)(b)(c) |
| Q1′ 挂载侧 | 「(i) Attendance-side (Recommended)」(发起 `withPermission('attendance:write')`、读进度 `withPermission('attendance:read')`) | 两个路由挂在 plugin-attendance |
| P-2 | 「P-2 (Q2) status wording」 | `status` 主语化机器词(§4) |
| P-3 | 「(iii) Round-summary endpoint (Recommended)」 | 摘要端点承载四值 + 三值分类 |
| P-4 | 「P-4 (Q4) round-summary read」 | GET 摘要,谓词挂原单实例 |
| P-6 | 「P-6 (Q6) seat display lift」 | 摘要不含任何席位 / 人名数据 |
| P-7 | 「P-7 (Q8) unknown codes」 | `blockCode` 只给 code,不给 detail |
| P-8 | 「P-8 (Q9) error-code registry」 | 逐字复用已登记码,不新造 |
| P-9 | 「P-9 (Q10) seed visibility」 | 腿 A/B/C 验收 |
| P-10 | 「P-10 (Q11) code prerequisite」 | 员工真令牌三步 + 管理员正控 |

**不在本阶段**:P-5「(iii) Full delivery」(阶段 C)、P-6′「(ii) Reuse approval notices (Recommended)」(阶段 B)、P-11「Adopt all 3, split locks (Recommended)」(阶段 C)。
**授权边界**:撤销入口切片的交付 = 分支 + 测试 + PR;**这些 PR 的合并未被点名,完成后单独请示**。登记项 L-1…L-6 **未 ratify**;L-4 在本阶段按任务要求落地(§3.7),不作为 ratify 条款引用。

---

## 2. 端点合同

### 2.1 `GET /api/attendance/requests/:id/cancel-round`

- 守卫:`withPermission('attendance:read')`(插件既有守卫,读 `user_roles` / `user_permissions`)。
- `:id` = 考勤请求 id(UUID;非法 ⇒ 400 `VALIDATION_ERROR`「id must be a UUID」,与兄弟路由同形)。
- 可见谓词:见 §3.1。不可见 / 非请假 ⇒ **404,与不存在的 id 逐字节同形**:`{"ok":false,"error":{"code":"NOT_FOUND","message":"Request not found"}}`。
- 200 响应:

```jsonc
{ "ok": true, "data": {
    "requestId": "<考勤请求 id>",
    "documentInstanceId": "<原审批实例 id>",
    "round": null            // P-4「无轮次时返回空集(200)」在本端点的实现形状
      | {
        "roundId": "apr_…",
        "engineInstanceId": "<撤销轮自己的审批实例 id>",
        "outcome": "pending|applied|rejected|withdrawn|expired|blocked",
        "status": "cancellation_pending_approval|leave_cancelled|cancellation_rejected|cancellation_withdrawn|cancellation_window_closed|cancellation_blocked",
        "startedAt": "ISO", "endedAt": "ISO|null",
        "closeReason": "round_expired|business_blocked:<code>|null",
        "blockCode": "<code>|null",
        "closedBySystem": true|false,
        "canWithdraw": true|false,
        "withdrawBlockedReason": "APPROVAL_REVOKE_FORBIDDEN|APPROVAL_REVOKE_DISABLED|APPROVAL_REVOKE_WINDOW_CLOSED|INVALID_STATUS_TRANSITION|null",
        "cancellationOutcome": null
          | { "status": "cancelled"|"cancelled_with_unrecoverable_expired", "reversal": { "reversed", "lots", "unrecoverableExpired", "alreadyReversed" } }
          | { "status": "cancelled_reversal_unreported", "reversal": null }
      }
} }
```

- 「最新轮」= 有在途轮则取在途轮(I3 保证至多一个),否则取最近开始的一轮。
- 轮次行的 `outcome` 不在上述六值内 ⇒ **显式错误**,路由回既有通用 500 `{"ok":false,"error":{"code":"INTERNAL_ERROR",…}}`,**不**回 `round: null`(那与「无轮次」同形,违背 P-8 ③ 的精神);不新造码。今天受 `approval_rounds` outcome CHECK 约束不可达,单测以桩查询钉住(§5)。
- **超出 P-4 字段表的两项**(均由 P-2 推出,点名而非默默加):`status`(P-2「每一个用户可见状态必须带主语」的机器形态)与 `closeReason`(P-2「该判据必须到达前端」:锁 lock:131 的专用 reason)。
- **不进 DTO**:`policy_snapshot_at_create/_at_decision`(P-4)、任何席位 / 审批人数据(P-6)、`cancelRoundBlockDetail`(P-7)。
- 量纲:`reversed` / `unrecoverableExpired` 为**分钟**(与 C-2 既有测试钉住的生产者一致;FE 呈现用 `formatLeaveBalanceMinutes` 属阶段 B)。

### 2.2 `POST /api/attendance/requests/:id/cancel-round`

- 守卫:`withPermission('attendance:write')`。
- 请求体:`{ "reason"?: string (≤2000) | null }`;非法 ⇒ 400 `VALIDATION_ERROR`(插件 `validationErrorBody` 同形)。
- 顺序与响应:

| # | 判据 | 不满足时 |
|---|---|---|
| 0 | UUID / 可见谓词 + 请假类型(§3.1) | 400 / **404 与不存在同形** |
| 1 | P-1 (a) `attendance_requests.status === 'approved'` | 409 `CANCEL_ROUND_DOCUMENT_NOT_APPROVED` |
| 2 | P-1 (b) 当前用户 = 该请假的 `user_id`(lock:157 仅原 requester) | 403 `CANCEL_ROUND_REQUESTER_ONLY` |
| 3 | P-1 (c) 无在途轮(I3) | 409 `CANCEL_ROUND_ALREADY_PENDING` |
| 4 | 专用创建路径 `createCancelRoundInstance` 在原实例行锁下复核(404 / NOT_APPROVED / REQUESTER_ONLY / SUITE_UNKNOWN / WINDOW_OUT_OF_RANGE / SUITE_FORBIDDEN / ALREADY_PENDING / SEAT_INELIGIBLE / NO_ELIGIBLE_APPROVER / CREATE_FAILED) | 透传 `(status, code)` + message,**丢弃 `details`**;**席位类**两码(`SEAT_INELIGIBLE`、`NO_ELIGIBLE_APPROVER`)的 message 换成中性句(见下) |
| — | 成功 | **201**,`data` 与 GET 同形(含新轮) |

- 0 + 1 合起来与 W4 取消适配器的 `approvedLeave` 谓词相同(`status === 'approved' && request_type === 'leave'`),因此**发起时**不会在 W4 兑现必然拒绝的单据上开轮。发起之后请求仍可能改变(例如经既有直接取消路由取消),入口无从拦截,见 §6 第 0b 项。
- 1–3 的 message 与创建路径同码的 message 逐字相同。
- **席位类 message 中性化**(P-6′ ②;owner P-6′ 选中「(ii) Reuse approval notices (Recommended)」,该选项说明含 “weaker employee-facing copy until RC (c) lands”,见 goal §0 原文):创建路径对这两码的 message 面向管理员并点明原因(审批人资格 / 归属失败),员工面不得呈现;端口改回一句不声称原因的中性句 `A cancellation cannot be started for this document right now — please contact an administrator`(导出常量 `CANCEL_ROUND_SEAT_CLASS_NEUTRAL_MESSAGE`)。**code 不变**,阶段 B 前端按 code 渲染。其余码的 message 照旧透传。
- 发起**只**经 `ApprovalProductService.createCancelRoundInstance`(锁 §14.1 专用路径);**不**经公开 `createApproval`。本路由不写 `attendance_requests`,因而与迁移 `zzzz20260918110000` 的 `approval_workflow_key <> 'approval.cancel-round'` CHECK 无交集。
- 其它异常:500 `{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to start cancellation"}}`(插件既有通用形状);表缺失 503 `DB_NOT_READY`(同兄弟路由)。

### 2.3 错误码(P-8)

本阶段用到的码**全部**已在 `ApprovalProductService.ts` / `ApprovalBridgeService.ts` 登记(C-1/C-2 已合入 main):`CANCEL_ROUND_DOCUMENT_NOT_APPROVED`、`CANCEL_ROUND_REQUESTER_ONLY`、`CANCEL_ROUND_SUITE_FORBIDDEN`、`CANCEL_ROUND_ALREADY_PENDING`、`CANCEL_ROUND_NO_ELIGIBLE_APPROVER`、`CANCEL_ROUND_SEAT_INELIGIBLE`、`CANCEL_ROUND_SUITE_UNKNOWN`、`CANCEL_ROUND_WINDOW_OUT_OF_RANGE`、`CANCEL_ROUND_CREATE_FAILED`(①类,创建期);`CANCEL_ROUND_OUTLET_FORBIDDEN` 与 ③类可重试码不在发起 / 读路径上出现。**零新码**:端口缺失时不注册路由(§3.4),因此也没有「端口不可用」码。

**非请假单的拒绝形状 —— 暂定实现选择,待 owner / 门审择一(不是裁决)**:本轮取「与不存在同形的 404」(复用本入口已有的 not-found 体,不新造码)。门审列出的三个选项:
1. 复用 `CANCEL_ROUND_SUITE_FORBIDDEN` —— 会把锁锚码(lock:357)的含义扩到「非请假」;
2. 修 C-1 的 suite 推导(按 `metadata.requestType` 派生)—— 改动已合入 main 的 C-1 代码,超出本阶段;
3. 返回 404(本轮采用)—— 不新造码、不扩锁锚码、不动 C-1,且可逆。

---

## 3. 谓词与守卫

### 3.1 可见谓词 = I7,挂原单实例

`SELECT … FROM attendance_requests WHERE id = $1 AND org_id = $2`(org 解析与兄弟路由 `GET /api/attendance/requests/:id` 同一函数)→ 请求须为请假(`request_type = 'leave'`)→ 取 `approval_instance_id` → `canReadApprovalInstance(pool, viewer, 原实例 id)`(`services/approval-instance-readability.ts`,五臂:requester / 席位 / 历史 actor / 抄送 / DB 管理员)。**不自造「已到达」谓词**(lock:153)。

四种情形同一 404 体:id 不存在(含请求行在别的 org);请求不是请假;请求无 `approval_instance_id`(I7 无对象可判);viewer 不满足 I7。本端点按 P-4「非参与者 404」,不可见与不存在逐字节同形。

### 3.2 发起前置在两层各判一次

路由层用**考勤请求行**判请假类型与 P-1 (a)(b)(c);创建路径用**原审批实例**在 `FOR UPDATE` 下复核(实例 `status`、`requester_snapshot.id`、套件闸、在途轮、席位资格)。两层数据不同,各有独占的反例:
- 仅路由层能拒:非请假单(创建路径的 suite 对无标签实例默认 `leave`,认不出);请求行未批准而实例已批准;请假 `user_id` ≠ 实例 `requester_snapshot.id`。最后一种是**纵深防御**:插件自己的请求写入方今天都把请求的 `user_id` 写进 `requester_snapshot.id`,插件不会产生这种形状;测试直接构造它来证明路由层这道检查确实生效(lock:157「委托人不可;代理发起另案」)。
- 仅创建路径能拒:套件 / 窗口 / 席位资格 / 并发下的 I3。

### 3.3 `canWithdraw` 在服务端解析

读与**引擎层**撤回闸(`ApprovalProductService.dispatchAction` 的 revoke 分支)**相同的输入、相同的顺序**:已发布定义 `runtime_graph.policy.allowRevoke / revokeBeforeNodeKeys`、撤销轮实例 `requester_snapshot.id` / `status` / `current_node_key`、当前节点已处理记录数。给出的否定原因即引擎会回的码。测试在进程内双向钉住(§5 T-WD)。

**它只回答引擎层**:本阶段员工**没有**可用的 HTTP 撤回路径 —— 审批侧动作路由在引擎之前另有权限闸,员工令牌在那里得 403(T-WD 的 HTTP 见证,钉住核心 403 体且轮次仍 `pending`)。因此 `canWithdraw: true` 在阶段 A 还不是可点的按钮;**阶段 B 的前置(建议,待 owner 裁决)**:考勤侧撤回端点,或 owner 另行裁定撤回走哪条通道(§6 第 2 项)。

### 3.4 端口与最小特权

- `PluginServices.approvalCancelRoundEntry`:`canReadDocument` / `readRoundSummary` / `launch` 三个方法;`src/index.ts` 只对 `plugin-attendance` 注入(与 `approvalAssigneeResolver` 同姿态),其它插件得 `undefined`。守卫由 `tests/unit/attendance-approval-resolver-port-scoping.test.ts` 新增的三条用例钉住(正控:plugin-attendance 得到三方法齐全的端口;负控:`plugin-some-other`、`plugin-integration-core` 得 `undefined`);把端口注入所有插件(M9)⇒ 两条负控红。
- 插件在激活时检查端口三方法齐全才注册两个路由;缺失 ⇒ 不注册(无入口,而不是半接线)。
- 插件从不 import core,也不拼写创建方法名。

### 3.5 结果投影:一个投影器,三个读面

`cancellationOutcome` / `closeReason` 只经 `readCancelRoundDurableProjectionV1`(C-2 已有的逐键白名单投影器,两个 `getApproval` 实现同用)读出,本端口不写自己的 SQL。

### 3.6 摘要不是快照读(接受撕裂读)

轮次行、持久投影、`closedBySystem`、`canWithdraw` 是四条独立语句,不在同一快照内;两条语句之间落地的状态迁移可能产生短暂不一致的视图。**有意接受、不加事务**:摘要是参考性的,它可能影响的每个决定都由执行方在行锁下复核(发起 → 创建路径;撤回 → 引擎),下一次读即收敛;而快照包装是在生产读路径上加一段测试无法见证的连接处理代码。

### 3.7 接线日守卫(登记项 L-4,与调用方同提交)

- 静态普查 `tests/unit/approval-cancel-round-dormancy-unreachable.test.ts`:从「生产代码零调用方」改为「**恰好一个被点名调用方** = `src/approvals/approval-cancel-round-entry-port.ts`,恰一处调用;定义文件仍只声明、零调用;其余生产文件零提及 / 零调用 / 零声明 / 零字符串分派;`src/routes/` 零提及」。与端口同一提交(6099f3bfff)。升级前版本对新代码实测 **2 红**(提及、调用两条),升级后 **18/18 绿**。
- 动态探针 `tests/harness/approval-cancel-round-dormancy-probe.ts`:路由 token 检查改为**精确 (method, path) 白名单**两条;白名单外命中仍失败(退出码 2);白名单路由缺失也失败(退出码 5);到达计数只容忍栈经过被点名端口的到达(否则退出码 1)。与路由同一提交(8b3493937c)。

---

## 4. P-2 词表映射(机器词,文案属阶段 B)

| 词表 | 轮次 outcome | `status` | 区分依据 |
|---|---|---|---|
| V1 | pending | `cancellation_pending_approval` | — |
| V2 | applied | `leave_cancelled` | 附 `cancellationOutcome` 三值 |
| V3 | rejected | `cancellation_rejected` | `closedBySystem=false` |
| V4 | withdrawn | `cancellation_withdrawn` | — |
| V5 | expired | `cancellation_window_closed` | `closedBySystem=true` + `closeReason=round_expired` |
| V6 | blocked | `cancellation_blocked` | `closedBySystem=true` + `blockCode` |
| V7/V8 | (仍 pending) | — | 请求期非终态拒绝,**不出现在读面**;FE 须从动作错误渲染(阶段 B) |

`closedBySystem` 由撤销轮实例最新一条终态审计行的 actor 是否为系统哨兵派生(lock:131 的判据本身),不是新存事实。

---

## 5. 测试矩阵与读数(本地真库 + 真 HTTP)

**环境**:第 0 轮一次性库 `ms2_g4cancela_r2_20260929`、第 1 轮 `ms2_g4cancela_fix1_20260929`、**第 2 轮** `ms2_g4cancela_fix2_20260929`(均为 `createdb -O ms2testbed` 的一次性库,非超级;`select current_database()` 每次运行前断言;用后 `dropdb`);`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它(approval real-DB step 只用 `DATABASE_URL`,另一个一并指向以防插件侧读取);迁移用仓内入口 `tsx src/db/migrate.ts` + CI 的 `MIGRATION_EXCLUDE`(EXIT 0,419 条);本机 PostgreSQL 15.17、Node 20.20.2;工具直接调用 `node_modules/.bin/*`,未经 pnpm。**下文读数为第 2 轮**(代码头 = rebase 后、本 MD 提交之前的一个提交;本 MD 提交只改文档),另行标注的是门审读数。

**新套件** `tests/integration/approval-cancel-round-attendance-entry.db.test.ts`:**22/22 通过**(含 EXPECT_DB 哨兵;第 0 轮 20 条 + 第 1 轮新增 LEAVE ONLY、ORG SCOPE 两条;第 2 轮未增删用例)。CI 形(仅 `DATABASE_URL`)21 通过 / 1 跳过(EXPECT_DB 哨兵)。服务端 `pluginDirs=[plugins/plugin-attendance]`,`RBAC_BYPASS='false'` 设置并断言;员工面令牌一律经**真实登录路由**签发;唯一替身是 C-1 考勤取消执行提供方(经生产注册表保存/恢复),用于确定性地产生三值分类。运行后库内:用户 / 角色 / 用户权限 / 命名空间准入 / 考勤请求 / 审批实例 / 轮次 / 打卡事件 / 考勤记录计数均为 0;**保留**:LEAVE ONLY 用例经真实插件批准补卡写入的 1 行 `attendance_record_target_revisions`(只追加的修订历史,直接删除被其守卫拒绝)与登录类 `operation_audit_logs` 行(第 0 轮同样存在)。

| 用例 | 判据 | 读数 |
|---|---|---|
| harness | 授权真开;路由已注册(未知 id 404 体、非法 id 400) | 绿 |
| T-P10 员工 | 仅 `attendance_employee` 的真令牌;同令牌 `GET /api/approvals/:id` = 403 `{"error":"Insufficient permissions"}`;读 200(round null)→ 发起 201 → 读 200 同轮;重复发起 409 ALREADY_PENDING,轮数仍 1 | 绿 |
| T-P3 ×3 | `cancelled` / `cancelled_with_unrecoverable_expired` / `cancelled_reversal_unreported`(显式 `"reversal":null`);各读两次逐字节相同(刷新后仍可查);与 `GET /api/approvals/<轮实例>` 的 `cancellationOutcome` 深等 | 3 绿 |
| T-V3 | 审批人驳回 ⇒ `cancellation_rejected`、`closedBySystem=false`;同单可再发起(撤销不限次) | 绿 |
| T-V5 | 锚点老化 200 天 ⇒ `cancellation_window_closed`、`closedBySystem=true`、`closeReason=round_expired` | 绿 |
| T-V6 | 业务拒绝 ⇒ `cancellation_blocked`、`blockCode` 为裸码;响应不含适配器自由文本 | 绿 |
| T-WD | `canWithdraw` 与**引擎层**撤回闸双向一致:管理员视角 false / `APPROVAL_REVOKE_FORBIDDEN` ⇒ 进程内引擎撤回同码 403;请求人 true;**HTTP 见证**:同一员工令牌 `POST /api/approvals/<轮实例>/actions {revoke}` ⇒ 403 `{"error":"Insufficient permissions"}`,轮次仍 `pending`、`canWithdraw` 仍 true;随后进程内引擎撤回成功 ⇒ `cancellation_withdrawn` | 绿 |
| T-I7 | 外人 GET/POST 与不存在 id 逐字节同形 404;本人但无审批实例的请求 404 同形 | 绿 |
| T-P1b 参与者 | 审批人可读(200,round null)、发起 403 REQUESTER_ONLY,零轮次 | 绿 |
| T-P1b 快照 requester ≠ 请假本人 | **构造形状(纵深防御)**:快照 requester 发起 403 REQUESTER_ONLY(**仅路由层能拒的夹具**);请假本人读 404(I7 后果) | 绿 |
| T-P1a | 请求行 `pending`(实例已批准)⇒ 409 NOT_APPROVED,零轮次 | 绿 |
| **T-LEAVE**(新) | 员工经**真实插件路由**建补卡(`missed_check_in`)201 → 管理员经插件批准 200;前置断言请求 `approved`、类型非请假、原实例 `approved`;GET 与 POST 均与不存在 id 逐字节同形 404,零轮次 | 绿 |
| **T-ORG**(新) | 本人已批准请假,请求行改到另一 org:GET 与 POST 均与不存在 id 逐字节同形 404,零轮次 | 绿 |
| T-P8 | SUITE_FORBIDDEN 409 只含 `{code,message}`,message 为创建路径原句;SEAT_INELIGIBLE 409 与 NO_ELIGIBLE_APPROVER 409(原单唯一批准记录改标为自动化)整体等于 `{code, message: 中性句}`,不含 `details` 与审批人 id;三单零轮次 | 绿 |
| T-P10 管理员正控 | 管理员真令牌:本人假读 200 → 发起 201 → 读 200;他人单读 200(I7 管理员臂)、发起 403 | 绿 |
| T-P10 (c) | 仅 `attendance:read`(夹具角色承载 + 考勤命名空间准入)的真令牌:读 200、发起 = 插件守卫 403 逐字节 `{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}`,零轮次;无 `attendance:read` 的主体读同形 403 | 绿 |
| P-9 腿 A | 管理员 HTTP:不带申请人选择 ⇒ 422 `APPROVAL_REQUESTER_CHOICE_REQUIRED`;带上 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(事务内 DB 可见性);零实例、零轮次 | 绿 |
| P-9 腿 B | 员工 HTTP ⇒ 403 `{"error":"Insufficient permissions"}`(`rbacGuard('approvals','write')`,在模板查找之前) | 绿 |
| P-9 腿 C | 普通 actor 进程内 `createApproval` ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`,与不存在模板同码;零实例、零轮次 | 绿 |

**mutation(每条:一处替换 → 核 `git diff --numstat` 恰 1 文件 1/1 行 → 跑 → cp 还原 → `cmp` 逐字节 → 工作树 clean;第 2 轮在 rebase 后的代码头重测)**:

| mutation | 读数 |
|---|---|
| M1 去掉投影(`cancellationOutcome` 恒 null) | **3 failed / 19 passed**(T-P3 三条) |
| M2 去掉路由层 requester 检查 | **1 failed / 21 passed**(T-P1b 构造形状夹具) |
| M3 去掉 POST 的 `withPermission` | **1 failed / 21 passed**(T-P10 (c):无写权主体不再 403) |
| M4 去掉 GET 的 `withPermission` | **1 failed / 21 passed**(T-P10 (c):无读权主体不再 403) |
| ML 去掉请假类型限定 | **1 failed / 21 passed**(T-LEAVE) |
| M6 org 条件改恒真(保留 `$2`) | **1 failed / 21 passed**(T-ORG) |
| MS 去掉席位类 message 中性化 | **1 failed / 21 passed**(T-P8) |
| **MN3** 未知 outcome 退回 `round: null`(新,单测) | 摘要单测 **1 failed / 1 passed**(未知 outcome 一条;正控仍绿) |
| M9 端口注入所有插件(单测) | 第 2 轮未重跑(端口注入代码自第 1 轮未变);第 1 轮与门审 r2 读数均为 **2 failed / 5 passed** |

**回归与守卫**(第 2 轮,rebase 后):

| 项 | 读数 |
|---|---|
| `tsc --noEmit -p tsconfig.json`(core-backend) | EXIT 0,0 error |
| 单测 7 文件:摘要未知 outcome(新)2、端口作用域 7、静态普查 dormancy-unreachable 18、`approval-cancel-round-ci-wiring` 6、`approval-ci-coverage-enumeration` 370(第 1 轮 369 + 新单测文件被 T4 枚举 1 条)、`attendance-uuid-validation-routes` 101、`approval-cancel-round-plugin-mirror-constant` 9 | **513/513** |
| `required-web-lane-token-manifest-guard` | 29/29 |
| 读 `plugin-tests.yml` 的 `scripts/ops/*.test.mjs`(50 文件,排除打包类),`node --test` 直调 | 1028/1028 |
| `sealed-export-package-provenance.test.cjs`(`node` 直调) | OK |
| s6a pin:rebase 时 `pluginTestsWorkflow` 冲突(main 在 #6138 改了 `plugin-tests.yml`) | 取 main 的 pins 文件、只改 `pluginTestsWorkflow` = rebase 后 `plugin-tests.yml` 的 sha256 `16cc053d…9b`;与 `computePackageProvenancePinSet(<工作树>)` 全量深等,差异 0;与 main 的 pins 相比只有这一个键不同 |
| 动态探针(真服务端) | 正控 `DORMANCY_PROBE_CONTROL=self` 到达 1,PASS;实跑打 960 条路由,白名单外 0、缺失 0、到达 0,PASS |
| CI 相邻同序:seed-template-visibility → attendance-entry → template-groups-lifecycle | 59 通过 / 3 跳过(62) |
| 撤销轮真库尾部(CI 同序)上半:lock-order-census / creation / redemption | 126 通过 / 3 跳过(129) |
| 下半:seat-guards / attendance-fk-migration / outlet-guards / node-timeout-effect | 22 通过 / 4 跳过(26) |
| 单测大批(第 1 轮 95 文件 / 1844 条) | 第 2 轮未重跑 |

**门审读数(不是本轮实测,单列)**:门审 r1 以真实插件请假为原单、经新路由发起、到真实 W4 边界兑现,得 `leave_cancelled`;门审 r2 在旧头 `76c79fe734` 上重跑撤销轮真库尾部 126+3 / 22+4 跳过,并以探针 G2-X 实测 §6 第 0b 项。

---

## 6. 残留与 NOT RUN

0. **⚠️ 合并 / 部署顺序风险(请 owner 裁决;本 PR 不得被描述为「休眠」或「无行为变化」)**。本阶段让 C-1/C-2 的撤销轮在 API 面**可达**,且**无开关**:合入并部署后,持 `attendance:write` 的员工(`attendance_employee` 角色持有该码)即可对自己已批准的请假发起撤销轮,创建路径照常入队审批任务创建事件。而撤销轮的**审批人动作**与**请求人撤回**今天走的是:
   - 本仓 HTTP 审批动作路由 `POST /api/approvals/:id/actions`、legacy `POST /api/approvals/:id/approve` / `reject`、`POST /api/approval-card-deliveries/:deliveryId/actions` —— 均挂 `rbacGuard('approvals','act')`,本仓迁移目录**无** `approvals:act` 行 ⇒ 非管理员无产品路径可获该码(管理员经 admin bypass 可操作);
   - 唯一不经该闸的审批人通道是钉钉 Stream 互动卡片回调(`integrations/dingtalk/interactive-card-callback.ts` → `ApprovalCardDeliveryAction`),以钉钉卡片投递已配置为前提;**撤销轮任务是否会产生卡片,本阶段 UNVERIFIED**。
   后果:在上述条件下轮次可能长期停在 `pending`,并按 I3 阻止同单再次发起。另 P-8 条款写明「入口不得在登记完成前上线」(码 + 用户文案 + FE 钉点属阶段 B)。**建议**(不是授权):阶段 A 不先于审批人 / 撤回通道与阶段 B 合并或部署;或由 owner 指定顺序 / 加开关。
0b. **⚠️ 合并 / 部署顺序的第二项 owner 输入:发起后原请假被既有直接取消通道取消 ⇒ 轮次停在 `pending`、审批人批准得 500**(门审 r2 探针 G2-X 实测;请 owner 知悉并与第 0 项一并裁决)。
   - 序列:员工对自己已批准的请假经本入口发起撤销轮(201,轮次 `pending`)→ 员工再经**既有**直接取消路由 `POST /api/attendance/requests/:id/cancel` 取消同一请假(200,请求 `cancelled`)→ 持席位审批人批准撤销轮 ⇒ **500 `APPROVAL_ACTION_DISPATCH_FAILED`**;摘要仍 `outcome: pending` / `status: cancellation_pending_approval`,而请假已 `cancelled`;再次发起 409 `CANCEL_ROUND_DOCUMENT_NOT_APPROVED`。
   - 可恢复:持席位审批人**驳回**可清掉该轮(门审 r1 已证);请求人的目标(请假已取消)已经达成,I3 的阻断在此情形下没有实际损失。「窗口关闭后批准 ⇒ `expired` 收口」这条自愈路径未测。
   - 缺陷所在:已合入的 C-1 / C-2 兑现路径(#5851 / #5856)对「原单已不是已批准请假」这一业务拒绝走的是抛错,没有走锁 §3 C-3 的 `blocked` 持久化收口(C-3:「业务拒绝与基础设施异常是两条路径、两种返回,不共用 throw」)。不在本分支 diff 内,但**只能经本入口到达**;入口的请假谓词只在发起时判定(§2.2),无从拦截。
   - **建议**(不是授权):修复归 C-1 线 —— 兑现侧把这一拒绝改走 C-3 的 `blocked` 收口;或由 owner 另定「有在途撤销轮时直接取消路由拒绝」之类的守卫(锁级决定)。另请 owner 知悉:同一请假今天并存两条撤销通道(需审批的撤销轮、既有的本人直接取消),这是 main 既有行为,本分支未改。
1. **P-3 三个读面**:`/history` 与两个 `getApproval` 的 `cancellationOutcome` 投影已随 #5856 在 main;本阶段按 owner 所选 (iii) 再加摘要端点。P-3 条款写「不得同批」,本 PR 只加 (iii),字面成立;摘要端点复用同一投影器且有一致性用例。**请 owner 知悉:同一事实现有三个读面、一个投影规则**;员工只能到达 (iii)(P-10)。
2. **员工撤回本轮无 HTTP 路径(阶段 B 前置,建议,待 owner 裁决)**:`canWithdraw` 只回答**引擎层**撤回闸;员工唯一的 HTTP 撤回路径是审批侧动作路由,员工令牌在那里得 403(见 0;T-WD 钉住该 403 与轮次不变)。阶段 B 上线前端「撤回本次撤销申请」之前,须有考勤侧撤回端点,或 owner 另行裁定撤回通道;在此之前 FE 不应把 `canWithdraw: true` 渲染成可点按钮。
3. **快照 requester ≠ 请假本人的单据**:插件自己的请求写入方今天不会产生这种形状(都把请求 `user_id` 写进 `requester_snapshot.id`),路由层的 requester 检查对它是**纵深防御**;若将来出现(例如另案的代理发起),请假本人不是原实例参与者时摘要对其 404、发起不可达(I7 与 lock:157 的直接后果)。
4. **无审批实例的考勤请求 / 非请假请求 / 别 org 的请求行**:均返回与不存在同形的 404,不另给码。非请假单的拒绝形状是**暂定实现选择,待 owner / 门审择一**(三个选项见 §2.3)。
5. **「无写权」主体的测试构造**:夹具角色承载授予 + 考勤命名空间准入(见私有记录)。
6. **测试夹具在共享库留下目录行**:共享帮助函数为创建原单插入 `approvals:write` 目录行(与 redemption 套件同一既有做法);本套件删除自己的授予行,但不删目录行。
7. **L-4 不是 ratify 条款**:按任务要求落地;静态普查与探针的新形状待门审确认。
8. **测试残留**:LEAVE ONLY 用例经真实插件批准补卡,会写入打卡侧行;套件清理打卡事件与考勤记录,但只追加的修订历史行(每次运行 1 行;第 2 轮 10 次运行后库内 10 行)被其守卫拒绝直接删除,保留;登录类 `operation_audit_logs` 行与第 0 轮一样保留。CI 的一次性服务库不受影响。
9. **任务书措辞偏差(判据 (c))**:任务书写的是核心 403 体 `{"error":"Insufficient permissions"}`;考勤侧挂载下拒绝来自插件守卫,体为 `{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}`,与所有既有考勤路由同形,测试钉住的是插件体。核心体只出现在审批侧路由(P-10 判别式、T-WD 见证、P-9 腿 B)。这是任务书措辞偏差,不是代码缺陷。
10. **摘要撕裂读**:有意接受,理由见 §3.6。
11. **NOT RUN**(本轮):前端(阶段 B);P-5 投递状态、P-11(阶段 C);P-6′ 管理员通知(阶段 B);撤销轮任务的钉钉卡片投递(UNVERIFIED);CI(未推送);`attendance-plugin.test.ts` 全量;单测大批 95 文件(第 1 轮读数);M9(第 1 轮与门审 r2 读数);以真实插件请假为原单、经新路由到真实 W4 边界的端到端 —— **本套件**不含(套件的请假原单由核心在进程内创建再改键为考勤单据,W4 执行方用替身),**门审 r1 已跑通**(§5 门审读数),本轮未复跑;CI 所用 PostgreSQL 版本未在本地复现(本地 15.17);第 2 轮修复后的独立复审未做。

---

## 7. 修复记录

### 7.1 第 1 轮(门审 r1 → 第 1 轮)

| 级别 | 门审结论(摘要) | 处理 | 证据 |
|---|---|---|---|
| P2 | 入口接受已批准的**非请假**单;开出的轮次 W4 永远兑现不了,长期 `pending` 并阻止再次发起 | 路由加载器限定 `request_type = 'leave'`(与 W4 `approvedLeave` 同谓词);非请假 ⇒ 与不存在同形 404(**暂定,待 owner / 门审择一**,§2.3) | T-LEAVE(真实插件建补卡 + 批准);ML ⇒ 1 红 |
| P2 | 端口最小特权注入无测试 | 端口作用域单测新增正控 + 两条负控 | M9 ⇒ 2 红 |
| P3 | `canWithdraw` 的文档声称动作端点会接受,实际员工 HTTP 403 | 文档改为「引擎层撤回闸」;T-WD 加 HTTP 403 见证(轮次仍 pending);阶段 B 前置写入 §6 第 2 项(建议,待 owner) | T-WD |
| P3 | 席位类拒绝的面向管理员原句原样到达员工 API;端口文档称丢弃 details 即满足 P-6′ ② | 端口把 `SEAT_INELIGIBLE` / `NO_ELIGIBLE_APPROVER` 的 message 换成中性句,code 不变;文档更正 | T-P8 两码精确体;MS ⇒ 1 红 |
| P3 | 考勤行 org 限定无测试 | 新增别 org 负控 | T-ORG;M6 ⇒ 1 红 |
| NIT | 摘要四条语句非快照 | **不改代码**,写明接受理由(§3.6):摘要参考性、执行方行锁下复核、快照包装无法被测试见证 | 文档 |
| NIT | 代理夹具形状插件不产生,残留 3 夸大可达性 | 路由检查保留为纵深防御;测试注释与 §3.2 / §6 第 3 项改写 | 文档 / 注释 |
| NIT | 任务书判据 (c) 写核心体,插件守卫回插件体 | 代码不改;§6 第 9 项记为任务书措辞偏差 | 文档 |

### 7.2 第 2 轮(门审 r2 → 本轮)

| 级别 | 门审结论(摘要) | 处理 | 证据 |
|---|---|---|---|
| P3 | 发起后原请假被既有直接取消通道取消 ⇒ 兑现 500、轮次停在 `pending`(缺陷在已合入的兑现路径,只能经本入口到达) | 不在本阶段范围内修;作为合并 / 部署顺序的 owner 输入写入 §6 第 0b 项;路由注释与 §2.2 的请假谓词限定为「**发起时**」 | 门审 r2 探针 G2-X;文档 / 注释 |
| P3 | 与当前 main 在 s6a pin 上冲突 | rebase 到 `main @ f47054d88e`;pin 只重算 `pluginTestsWorkflow` | §5:与 `computePackageProvenancePinSet` 全量深等、与 main 仅一键不同;provenance OK;ci-wiring 6/6、coverage-enumeration 370/370 |
| NIT | §2.2 把 owner P-6′ 选项写成中文转述并加引号 | 改为引 goal §0 原文(选项名与英文说明);端口常量注释同改 | 文档 / 注释 |
| NIT | §6 第 11 项与 §5 对 redemption 是否重跑自相矛盾;把门审 r1 已跑通的真实插件请假端到端列为 NOT RUN | §5 / §6 改为本轮实测与门审读数分列 | 文档 |
| NIT | 未知 outcome 回退 `round: null`,与「无轮次」同形(P-8 ③) | 改为显式错误(路由回既有通用 500,不新造码);新增桩查询单测 | MN3 ⇒ 1 红 |
