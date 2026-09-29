# 请假撤销 —— 产品入口 阶段 A / A2 / C(后端)设计与验证记录 —— **草稿**

| 项 | 值 |
|---|---|
| 状态 | 草稿(阶段 A 实现 + 门审 r1 / r2 / r3 已做;**A2**(默认 OFF 发起开关 + 考勤侧审批人办理 + 申请人撤回,§8)已实现,A2 独立门审 r1 已做(APPROVE-with-hardening,0 P1 / 0 P2 / 3 P3 / 2 NIT,遗留处理见 §9.3);**阶段 C(后端)**(§9)已实现并本地真库验证,P-6′(ii) 管理员通知按 owner 2026-09-29 16:5x ① 暂缓(§9.6);阶段 C 门审 r1 已做(1 P2 / 2 P3 / 2 NIT),修复轮 1 见 §9.10;门审 r2(修复轮 1 的复审)已做(1 P2 / 4 NIT),修复轮 2 见 §9.11;门审 r3(修复轮 2 的复审)已做(APPROVE,0 P1 / 0 P2 / 0 P3 / 1 NIT,NIT 已按其建议改 §9.11);**C2**(owner 16:5x ② 的考勤侧「待我审批的撤销」列表,§10)已实现并本地真库验证,C2 的独立门审未做;P-6′(ii) 按 16:5x ① 记为对 lock:75 的已知缺口(§10.6);未推送、未开 PR;合并见 goal §0 owner 17:1x 选项原文「Yes, merge under those conditions (Recommended)」及其条件,C2 不涉合并) |
| 分支 | `feat/approval-cancel-entry-phase-a-read-launch` |
| 基线 | `main @ f47054d88e`(第 2 轮 rebase;原基线 `68a703038e`。撤销轮 C-1 #5851 `44770107f`、C-2 #5856 `2594ca6e2` 已在其中) |
| 权威锁 | 撤销锁 v5.9(RATIFIED 2026-09-18)及其抬头「**RATIFY 追记 —— 产品入口增补 v2(P-1…P-11)**」(2026-09-28) |
| DDL | **零**(未新增、未修改任何迁移) |
| 实现模型 | Claude Opus 5.5(Fable 回退) |
| 修复轮 | 第 2 轮(门审 r1 / r2 结论的处理见 §7)。推送前已改写本分支历史并 rebase 到 `main @ f47054d88e`,提交号与门审 r1 / r2 所见不同;改写前后分支最终树相同,rebase 只带入 main 的改动与 s6a pin 重算(§5)。门审 r3 遗留与 A2 的处理见 §7.3 / §8,均为其后的新提交 |

---

## 0. 范围

**本阶段做的**(全部在后端):

1. `GET /api/attendance/requests/:id/cancel-round` —— 撤销轮摘要(P-4,承载 P-3 (iii) 的返还结果)。
2. `POST /api/attendance/requests/:id/cancel-round` —— 发起撤销轮(P-1)。
   两个端点**只处理请假**(`request_type = 'leave'`,§3.1);非请假单在本入口视同不存在。
3. 两个端点背后的宿主→插件端口 `approvalCancelRoundEntry`(只注入 plugin-attendance)。
4. 接线日守卫升级(登记项 L-4,见 §3.7)与 CI 接线。

**本阶段不做的**(ratify 后的分期里属于后续阶段):前端入口与五渲染面文案(P-2 呈现、P-7/P-8 文案、P-3 ④ `formatLeaveBalanceMinutes`)、P-6′ 管理员通知、P-5 投递状态、P-11 待办中心呈现。

**A2(同分支,§8)**:发起端点的默认 OFF 开关、考勤侧审批人办理(`POST …/cancel-round/actions`)、申请人撤回(`POST …/cancel-round/withdraw`)。

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
    "entryEnabled": true|false, // 阶段 C 增补(§9.2):开关的全局态
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
          | { "status": "cancelled_reversal_unreported", "reversal": null },
        "deliveries": [ /* 阶段 C 增补(§9.4):{ channelType, status, attempts, createdAt, lastAttemptAt, updatedAt } */ ]
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

**它只回答引擎层**:审批侧动作路由在引擎之前另有权限闸,员工令牌在那里得 403(T-WD 的 HTTP 见证,钉住核心 403 体且轮次仍 `pending`)。员工可达的 HTTP 撤回路径是 A2 的考勤侧撤回端点(§8.3.3),它把 `revoke` 交给同一引擎闸。

**判定顺序与引擎相同**(门审 r3 NIT-4 之后):`allowRevoke` → 请求人 → 终态(轮次 `outcome` 与引擎实例 `status`)→ 当前节点 → `revokeBeforeNodeKeys` → 本节点已处理记录数;唯一更早的出口是轮次行没有引擎实例。因此对**任何**查看者(请求人与否)给出的否定原因都等于引擎会回的码:非请求人读已结束的轮得 `APPROVAL_REVOKE_FORBIDDEN`,与引擎对其 403 同码。

### 3.4 端口与最小特权

- `PluginServices.approvalCancelRoundEntry`:`canReadDocument` / `readRoundSummary` / `launch` 三个方法(A2 增 `decide` / `withdraw`,共五个,§8.4);`src/index.ts` 只对 `plugin-attendance` 注入(与 `approvalAssigneeResolver` 同姿态),其它插件得 `undefined`。守卫由 `tests/unit/attendance-approval-resolver-port-scoping.test.ts` 新增的三条用例钉住(正控:plugin-attendance 得到三方法齐全的端口;负控:`plugin-some-other`、`plugin-integration-core` 得 `undefined`);把端口注入所有插件(M9)⇒ 两条负控红。
- 插件在激活时检查端口方法齐全(A2 起为五个)才注册本入口的全部路由;缺任一 ⇒ 一个都不注册(无入口,而不是半接线)。
- 插件从不 import core,也不拼写创建方法名。

### 3.5 结果投影:一个投影器,三个读面

`cancellationOutcome` / `closeReason` 只经 `readCancelRoundDurableProjectionV1`(C-2 已有的逐键白名单投影器,两个 `getApproval` 实现同用)读出,本端口不写自己的 SQL。

### 3.6 摘要不是快照读(接受撕裂读)

轮次行、持久投影、`closedBySystem`、`canWithdraw` 是四条独立语句,不在同一快照内;两条语句之间落地的状态迁移可能产生短暂不一致的视图。**有意接受、不加事务**:摘要是参考性的,它可能影响的每个决定都由执行方在行锁下复核(发起 → 创建路径;撤回 → 引擎),下一次读即收敛;而快照包装是在生产读路径上加一段测试无法见证的连接处理代码。

### 3.7 接线日守卫(登记项 L-4,与调用方同提交)

- 静态普查 `tests/unit/approval-cancel-round-dormancy-unreachable.test.ts`:从「生产代码零调用方」改为「**恰好一个被点名调用方** = `src/approvals/approval-cancel-round-entry-port.ts`,恰一处调用;定义文件仍只声明、零调用;其余生产文件零提及 / 零调用 / 零声明 / 零字符串分派;`src/routes/` 零提及」。与端口同一提交(不写提交号:推送 / squash 后会变)。升级前版本对新代码实测 **2 红**(提及、调用两条),升级后 **18/18 绿**。
- 动态探针 `tests/harness/approval-cancel-round-dormancy-probe.ts`:路由 token 检查改为**精确 (method, path) 白名单**两条;白名单外命中仍失败(退出码 2);白名单路由缺失也失败(退出码 5);到达计数只容忍栈经过被点名端口的到达(否则退出码 1)。与路由同一提交(同上,不写提交号)。A2 把白名单扩到恰好四条(与注册两条新路由同一提交,§8.6)。

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

**门审读数(不是本轮实测,单列)**:门审 r1 以真实插件请假为原单、经新路由发起、到真实 W4 边界兑现,得 `leave_cancelled`;门审 r2 在其所见的改写前旧头(不写提交号:该对象已不在任何 ref 上)上重跑撤销轮真库尾部 126+3 / 22+4 跳过,并以探针 G2-X 实测 §6 第 0b 项。

---

## 6. 残留与 NOT RUN

0. **合并前置:阶段 A 与 A2 同批合入(A2 的默认 OFF 发起开关是阶段 A 合入的前置)**。owner 已于 2026-09-29 11:0x 选定 「**Attendance-side + OFF flag (Recommended)**」——选项说明原文:Add cancel-round approve/reject on attendance:approve (attendance_approver role already holds it; seat/G3 rules unchanged) and withdraw on attendance:write, matching your #22 = (i). Plus a default-OFF flag on the launch endpoint until phase D acceptance passes, so merging never exposes a half-working flow.
   - 落点:A2 在同一分支上叠加(§8),阶段 A 的提交**不单独合并**,也不先于 A2 合并。开关默认 OFF ⇒ 合入并部署后发起端点对任何人都回与不存在同形的 404、零写入(§8.2);读摘要、审批人办理、申请人撤回不受开关影响(它们只作用于已存在的轮次)。
   - 开关何时打开:owner 的选项写明「until phase D acceptance passes」;打开属 owner / 运维动作,不在本分支。
   - 背景(阶段 A 当时的事实,A2 之前):审批人动作与请求人撤回只经审批侧 `rbacGuard('approvals','act')` 之后的路由,本仓迁移目录无 `approvals:act` 行,非管理员无产品路径可得该码;唯一不经该闸的是钉钉互动卡片回调,撤销轮任务是否产生卡片 UNVERIFIED。A2 的考勤侧两条路由(`attendance:approve` / `attendance:write`)补上了这两条通道。
   - 叠加的 ratify 条款:P-8「入口不得在登记完成前上线」(码 + 用户文案 + FE 钉点属阶段 B)—— 开关默认 OFF 期间入口不可发起,与之不冲突;开关打开前仍须阶段 B / D 完成(owner 选项原文)。
0b. **⚠️ 合并 / 部署顺序的第二项 owner 输入:发起后原请假被既有直接取消通道取消 ⇒ 轮次停在 `pending`、审批人批准得 500**(门审 r2 探针 G2-X 实测;请 owner 知悉并与第 0 项一并裁决)。
   - 序列:员工对自己已批准的请假经本入口发起撤销轮(201,轮次 `pending`)→ 员工再经**既有**直接取消路由 `POST /api/attendance/requests/:id/cancel` 取消同一请假(200,请求 `cancelled`)→ 持席位审批人批准撤销轮 ⇒ **500 `APPROVAL_ACTION_DISPATCH_FAILED`**;摘要仍 `outcome: pending` / `status: cancellation_pending_approval`,而请假已 `cancelled`;再次发起 409 `CANCEL_ROUND_DOCUMENT_NOT_APPROVED`。
   - 可恢复:持席位审批人**驳回**可清掉该轮(门审 r1 已证);请求人的目标(请假已取消)已经达成,I3 的阻断在此情形下没有实际损失。「窗口关闭后批准 ⇒ `expired` 收口」这条自愈路径未测。
   - 缺陷所在:已合入的 C-1 / C-2 兑现路径(#5851 / #5856)对「原单已不是已批准请假」这一业务拒绝走的是抛错,没有走锁 §3 C-3 的 `blocked` 持久化收口(C-3:「业务拒绝与基础设施异常是两条路径、两种返回,不共用 throw」)。不在本分支 diff 内,但**只能经本入口到达**;入口的请假谓词只在发起时判定(§2.2),无从拦截。
   - **与 A2 开关的关系**:该序列要先有一个在途轮;开关默认 OFF 时经本入口开不出新轮,这条路径随之不可达。本分支**不修**它(归 C-1 线),开关打开之前须由 owner 知悉。
   - **建议**(不是授权):修复归 C-1 线 —— 兑现侧把这一拒绝改走 C-3 的 `blocked` 收口;或由 owner 另定「有在途撤销轮时直接取消路由拒绝」之类的守卫(锁级决定)。另请 owner 知悉:同一请假今天并存两条撤销通道(需审批的撤销轮、既有的本人直接取消),这是 main 既有行为,本分支未改。
1. **P-3 三个读面**:`/history` 与两个 `getApproval` 的 `cancellationOutcome` 投影已随 #5856 在 main;本阶段按 owner 所选 (iii) 再加摘要端点。P-3 条款写「不得同批」,本 PR 只加 (iii),字面成立;摘要端点复用同一投影器且有一致性用例。**请 owner 知悉:同一事实现有三个读面、一个投影规则**;员工只能到达 (iii)(P-10)。
2. **员工撤回的 HTTP 路径**:阶段 A 时没有(员工令牌在审批侧动作路由得 403,T-WD 钉住);A2 按 owner 11:0x 选项加了考勤侧撤回端点 `POST …/cancel-round/withdraw`(`attendance:write`,§8.3.3),`canWithdraw: true` 从此对应一个可达的 HTTP 动作。FE 呈现仍属阶段 B。
3. **快照 requester ≠ 请假本人的单据**:插件自己的请求写入方今天不会产生这种形状(都把请求 `user_id` 写进 `requester_snapshot.id`),路由层的 requester 检查对它是**纵深防御**;若将来出现(例如另案的代理发起),请假本人不是原实例参与者时摘要对其 404、发起不可达(I7 与 lock:157 的直接后果)。
4. **无审批实例的考勤请求 / 非请假请求 / 别 org 的请求行**:均返回与不存在同形的 404,不另给码。非请假单的拒绝形状是**暂定实现选择,待 owner / 门审择一**(三个选项见 §2.3)。
5. **「无写权」主体的测试构造**:夹具角色承载授予 + 考勤命名空间准入(见私有记录)。
6. **测试夹具在共享库留下目录行**:共享帮助函数为创建原单插入 `approvals:write` 目录行(与 redemption 套件同一既有做法);本套件删除自己的授予行,但不删目录行。
7. **L-4 不是 ratify 条款**:按任务要求落地;静态普查与探针的新形状待门审确认。
8. **测试残留**:LEAVE ONLY 用例经真实插件批准补卡,会写入打卡侧行;套件清理打卡事件与考勤记录,但只追加的修订历史行(每次运行 1 行;第 2 轮 10 次运行后库内 10 行)被其守卫拒绝直接删除,保留;登录类 `operation_audit_logs` 行与第 0 轮一样保留。CI 的一次性服务库不受影响。
9. **任务书措辞偏差(判据 (c))**:任务书写的是核心 403 体 `{"error":"Insufficient permissions"}`;考勤侧挂载下拒绝来自插件守卫,体为 `{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}`,与所有既有考勤路由同形,测试钉住的是插件体。核心体只出现在审批侧路由(P-10 判别式、T-WD 见证、P-9 腿 B)。这是任务书措辞偏差,不是代码缺陷。
10. **摘要撕裂读**:有意接受,理由见 §3.6。
11. **NOT RUN**(本轮):前端(阶段 B);P-5 投递状态、P-11(阶段 C);P-6′ 管理员通知(阶段 B);撤销轮任务的钉钉卡片投递(UNVERIFIED);CI(未推送);`attendance-plugin.test.ts` 全量;单测大批 95 文件(第 1 轮读数);M9(第 1 轮与门审 r2 读数);以真实插件请假为原单、经新路由到真实 W4 边界的端到端 —— **本套件**不含(套件的请假原单由核心在进程内创建再改键为考勤单据,W4 执行方用替身),**门审 r1 已跑通**(§5 门审读数),本轮未复跑;CI 所用 PostgreSQL 版本未在本地复现(本地 15.17);第 2 轮修复后的独立复审未做(其后门审 r3 已做,见 §7.3)。A2 的 NOT RUN 另见 §8.8。

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

### 7.3 第 3 轮(门审 r3 → 与 A2 同批)

| 级别 | 门审结论(摘要) | 处理 | 证据 |
|---|---|---|---|
| P2 | 中间提交的树中有一组测试辅助代码,须在推送前折叠(见私有记录) | 主会话已做历史折叠(折叠后树与门审所见逐字节相同);A2 的每个新提交(树 / diff / 提交信息)已按同一组私有短语表自扫 | 自扫 0 命中 |
| P3 | §6 第 0 项在问一件 owner 已裁的事;阶段 A 单独合并会与 owner 11:0x 选项相悖 | §6 第 0 项改为逐字引 owner 选项原文,写明阶段 A 与 A2 同批合入、A2 的默认 OFF 开关是阶段 A 合入的前置 | 文档 |
| P3 | 发起后原请假被既有直接取消通道取消 ⇒ 兑现 500(承接 r2) | **不改**(缺陷在 C-1 / C-2 兑现路径,归 C-1 线);§6 第 0b 项补记:开关 OFF 期间经本入口不可达 | 文档 |
| NIT | `canWithdraw` 镜像对非请求人的已结束轮给出的码与引擎不同 | 终态判定挪到请求人判定之后(与引擎同序);文档同改(§3.3) | P-4 canWithdraw 用例增「轮次结束后」一段:管理员摘要 `APPROVAL_REVOKE_FORBIDDEN`、进程内引擎对管理员 403 同码、对请求人 409 `INVALID_STATUS_TRANSITION`;恢复旧序 ⇒ 1 红(§8.7 N4) |
| NIT | §3.7 引用改写前的提交号 | 改为不写提交号 | 文档 |
| NIT | 撤销轮 `created` 审计行的 actorName 是裸用户 id | 发起路由把显示名(插件既有 `getUserLabel`)传给创建路径 | 新用例钉住 `approval_records.actor_name`;去掉显示名 ⇒ 1 红(§8.7 N6) |

---

## 8. A2:审批人路径与开关

### 8.1 授权(只引 owner 原话;我方建议不是授权)

- owner 2026-09-29 11:0x(`goal-four-items-20260928.md` §0,AskUserQuestion 选项原文):「**Attendance-side + OFF flag (Recommended)**」——选项说明原文:Add cancel-round approve/reject on attendance:approve (attendance_approver role already holds it; seat/G3 rules unchanged) and withdraw on attendance:write, matching your #22 = (i). Plus a default-OFF flag on the launch endpoint until phase D acceptance passes, so merging never exposes a half-working flow.
- 仍有效的锁正文:§2 G3(席位规则)、§9-9 允许集 {approve, reject, revoke, comment}(拒 transfer / add_sign / reduce_sign)、§14.1–14.3。A2 **不改**其中任何一条,只新增到达它们的考勤侧入口。
- 事实核对:`attendance_approver` 角色的种子权限为 `attendance:read` + `attendance:approve`(迁移 `zzzz20260208100000_create_roles_table.ts`),与选项说明「attendance_approver role already holds it」一致。
- 合并:撤销入口 PR 的合并**未被点名**(goal §0),完成后单独请示。

### 8.2 开关 `ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED`

| 项 | 值 |
|---|---|
| 写法 | `parseBoolean(process.env.ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED, false)`,插件既有写法(同族:`ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED` 等);**每次调用时读**,不在模块加载时缓存 |
| 默认值 | **OFF**(未设置或无法识别的值 ⇒ OFF;只有 `true` / `1` / `yes` 为 ON,插件 `parseBoolean` 既有语义) |
| 只门住 | `POST /api/attendance/requests/:id/cancel-round`(发起)。读摘要 `GET`、审批人办理、申请人撤回**不受影响**(它们只作用于已存在的轮次) |
| 判定位置 | 401(无用户)与 UUID 400 之后、请求体解析与任何读写之前 |
| OFF 形状 | 与不存在的 id 逐字节同形的 404:`{"ok":false,"error":{"code":"NOT_FOUND","message":"Request not found"}}` |
| OFF 写入 | **零**:测试断言 `approval_instances` / `approval_rounds` / `approval_assignments` / `approval_records` 全表行数不变 |

**为什么是 404,而不是「功能未开启」码**:插件里**没有**统一的「功能未开启」形状 —— 既有的「未开启」拒绝各自造码(环境开关:`AUTO_SHIFT_MATCHING_DISABLED` 403、`AUTO_SHIFT_MATCHING_APPLY_DISABLED` 403;策略开关:`ATTENDANCE_RESULT_EDIT_DISABLED` 403、`ANNUAL_LEAVE_NOT_ENABLED` 422)。为本入口造一个新码违反 P-8(码须先登记;「零新码」);复用本入口已有的 not-found 体不新造码、不泄露单据是否存在,且与 P-4「不可见与不存在同形」一致。代价:开关 OFF 时,调用方无法从响应区分「开关关闭」与「单据不存在」—— 阶段 B 的前端若需按开关决定是否渲染入口,需另有能力读(**建议,待 owner**,§8.8)。

### 8.3 三条新路由合同

#### 8.3.1 发起(A2 只加开关与显示名)

`POST /api/attendance/requests/:id/cancel-round` 的合同见 §2.2,A2 只加两处:① 开关判定(§8.2);② 调用端口 `launch` 时带上调用者显示名(`getUserLabel`,门审 r3 NIT-6),撤销轮 `created` 审计行的 `actor_name` 不再回落为裸 id。

#### 8.3.2 审批人办理 `POST /api/attendance/requests/:id/cancel-round/actions`

- 守卫:`withPermission('attendance:approve')`(插件既有守卫)。
- 请求体:`{ "action": "approve" | "reject", "comment"?: string (≤2000) | null }`(zod)。其它动作(transfer / add_sign / reduce_sign / revoke / comment / handle / return 等)⇒ 400 `VALIDATION_ERROR`,在任何查找之前;其后服务层 §9-9 闸仍在。
- 顺序与响应:

| # | 判据 | 不满足时 |
|---|---|---|
| 0 | 401 / UUID / 请求体 | 401 / 400 / 400 |
| 1 | 请求行:org 限定 + 请假 + 有审批实例(与摘要同一加载器,**不加 I7**) | 404 与不存在同形 |
| 2 | 该单据有撤销轮(取「最新轮」,与摘要同一定义) | 404 与不存在同形 |
| 3 | 以调用者身份经 `ApprovalProductService.dispatchAction` 在**撤销轮自己的实例**上执行:席位校验、§9-9、C-2 兑现、C-3 收口全在服务层原样运行 | 透传服务层 `(status, code, message)`,不带 `details`。例:无席位 ⇒ 403 `APPROVAL_ASSIGNMENT_REQUIRED`「Approval assignment not found for actor」;驳回无意见 ⇒ 400 `REJECT_COMMENT_REQUIRED` |
| — | 成功 | **200**。**阶段 C 起**为最小形 `{ requestId, roundId, outcome, status }`(owner 14:3x ①,§9.1);A2 原为「`data` 与摘要同形」 |

- **不加 I7**:与审批侧 `POST /api/approvals/:id/actions` 相同,席位是办理的依据;在席位之前再加可见谓词会与服务层的判据重复。无席位的 `attendance:approve` 持有者得服务层既有的拒绝码(任务要求的「既有拒绝码」)。

#### 8.3.3 申请人撤回 `POST /api/attendance/requests/:id/cancel-round/withdraw`

- 守卫:`withPermission('attendance:write')`。
- 请求体:`{ "comment"?: string (≤2000) | null }`。
- 顺序与响应:

| # | 判据 | 不满足时 |
|---|---|---|
| 0 | 401 / UUID / 请求体 | 401 / 400 / 400 |
| 1 | 请求行 + I7(与摘要、发起同一加载器) | 404 与不存在同形 |
| 2 | 调用者 = 该请假的 `user_id`(lock:157 仅原 requester,与发起同一规则) | 403 `APPROVAL_REVOKE_FORBIDDEN`「Only the requester can revoke this approval」—— **引擎撤回闸自己的码与句**,不新造 |
| 3 | 该单据有撤销轮 | 404 与不存在同形 |
| 4 | 经同一 `dispatchAction` 对撤销轮实例执行 `revoke`:引擎撤回闸(allowRevoke → requester → 终态 → 窗口)原样判定 | 透传,例:已结束 ⇒ 409 `INVALID_STATUS_TRANSITION` |
| — | 成功 | **200**,轮次 `withdrawn`(V4);I3 随即允许同单再次发起(开关 ON 时)。**阶段 C 起**成功体为最小形 `{ requestId, roundId, outcome, status }`(§9.1) |

- 第 2 步是**纵深防御**:引擎撤回闸比对的是撤销轮实例的 `requester_snapshot.id`;插件自己的写入方不会产生「快照 requester ≠ 请假本人」的单据,测试直接构造该形状证明路由层这道检查生效(与阶段 A 发起的同名夹具同理)。

### 8.4 端口与谓词复用点(不复制、不绕过)

| 规则 | 在哪里判 | A2 做了什么 |
|---|---|---|
| 席位归属 | `dispatchAction` 内 `actorCanAct`(当前节点有效指派 × `assignmentMatchesActor`) | 以调用者身份调用,未改 |
| §9-9 允许集 | `dispatchAction` 内 `assertCancelRoundActionAllowed` | 未改;考勤侧路由另只收 approve / reject(更窄) |
| §2 G3 席位规则 | 创建路径的席位再验证(发起时)+ §14.3 拒绝一切改席位的动作 | 未改 |
| 撤回闸 | `dispatchAction` 的 revoke 分支 | 未改;`canWithdraw` 镜像改为同序(§3.3) |
| I7 可见 | `canReadApprovalInstance`(原单实例) | 撤回与摘要、发起共用加载器;办理路由不加(§8.3.2) |
| C-2 兑现 / C-3 收口 | `dispatchAction` | 未改 |

- 端口 `decide` / `withdraw` 共用一条路径:取单据最新轮(与摘要同一 SQL 定义)→ `new ApprovalProductService().dispatchAction(轮实例 id, { action, comment }, actor)`。这就是 `POST /api/approvals/:id/actions` 对模板运行时实例调用的同一服务层入口。
- 分发的动作带 `roles: []`(办理 / 撤回之后的计数推送另带调用者自己的角色声明,见 §9.5.3,不进分发):撤销轮的席位是**人**席位(创建路径按用户 id 落座;§9-9 / §14.3 拒绝一切能改席位的动作),角色声明不可能是落座依据;不传角色只会更窄、不会更宽。测试断言已发起轮次的每条指派都是 `user` 类型;若将来撤销轮出现角色席位,该断言与办理用例会一起变红。
- 端口仍只注入 plugin-attendance;插件在五个方法齐全时才注册四条路由。

### 8.5 测试矩阵与读数(本地真库 + 真 HTTP)

**环境**:一次性库 `ms2_g4cancela2b_20260929`(`createdb -O ms2testbed`,非超级角色;每次运行前断言 `current_database()`);`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它(approval real-DB step 只用 `DATABASE_URL`);迁移 `tsx src/db/migrate.ts` + CI 的 `MIGRATION_EXCLUDE`,EXIT 0,419 条;PostgreSQL 15.17、Node 20.20.2;工具直调 `node_modules/.bin/*`,未经 pnpm。套件在 `beforeAll` 把开关设为 ON(阶段 A 的每个用例都要发起),`afterAll` 还原。员工 / 审批人令牌一律经真实登录路由签发;席位持有者是夹具审批人,它的 `attendance_approver` 角色在 A2 块内才授予。

| 用例 | 判据 | 读数 |
|---|---|---|
| 开关 OFF | 未设置与 `"false"` 两种:发起 404 且与不存在 id 逐字节同形;同一请假 GET 仍 200(`round: null`);四表全表行数不变;随后 ON 同单发起 201(正控),`approval_instances` / `approval_rounds` 各 +1 | 绿 |
| 无 `attendance:approve` | 席位持有者(仅员工角色)办理 ⇒ 插件 403 逐字节 `{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}`,轮次仍 pending;授予 `attendance_approver` 后同人同轮 approve 200 | 绿 |
| 有席位 approve | 轮次指派全为 `user` 类型且唯一有效席位 = 夹具审批人;approve 200 ⇒ `applied` / `leave_cancelled`,`cancellationOutcome` = C-2 形状 `{status:'cancelled', reversal:{reversed:480, lots:1, unrecoverableExpired:0, alreadyReversed:false}}`,与员工摘要、审批侧 `GET /api/approvals/<轮实例>` 深等;`approval_records` 的 approve 行 actor = 调用者、意见原样 | 绿 |
| **端到端(无替身)** | 员工经真实插件路由建请假(不带薪假类型)→ `attendance_approver` 经插件路由批准 → 员工经本入口发起(唯一有效席位 = 该审批人)→ 该审批人经考勤侧办理路由 approve ⇒ 真实 W4 边界兑现:`applied` / `leave_cancelled`,`cancellationOutcome` = `{status:'cancelled', reversal:{reversed:0, lots:0, unrecoverableExpired:0, alreadyReversed:false}}`(无余额批次,返还为 0;带余额的形状由上一行替身用例钉住),与审批侧投影深等;考勤请求行变为 `cancelled` | 绿 |
| 有席位 reject | 无意见 ⇒ 400 `REJECT_COMMENT_REQUIRED`(服务层规则透传),轮次不变;带意见 ⇒ `rejected` / `cancellation_rejected`、`closedBySystem=false`;兑现边界未被调用;原单实例与请求行仍 `approved` | 绿 |
| 无席位的审批人 | 持 `attendance_approver`、非席位、非请求人:approve / reject ⇒ 403 `APPROVAL_ASSIGNMENT_REQUIRED`(只含 code + message),轮次 pending、审计只有 `created`;无轮次的请假与不存在 id ⇒ 404 同形 | 绿 |
| 非允许动作 | transfer / add_sign / reduce_sign / revoke / comment / handle / return ⇒ 400 `VALIDATION_ERROR`;轮次与审计不变 | 绿 |
| 请求人撤回 | 员工真令牌 ⇒ 200 `withdrawn` / `cancellation_withdrawn`,引擎实例 `revoked`,revoke 审计行 actor = 员工;再撤回 ⇒ 409 `INVALID_STATUS_TRANSITION`;同单再发起 201(新轮),轮次序列 `withdrawn, pending` | 绿 |
| 非请求人撤回 | 审批人(可读的参与者)⇒ 403 `APPROVAL_REVOKE_FORBIDDEN`(引擎原句);外人 ⇒ 404 同形;轮次 pending | 绿 |
| 无 `attendance:write` 撤回 | 仅 `attendance:read` 的请假本人(轮次由进程内创建)⇒ 插件 403 逐字节,轮次 pending;补授 `attendance:write` 后同人撤回 200 | 绿 |
| 撤回路由层 requester 见证 | 构造形状(快照 requester ≠ 请假本人,插件不会产生):快照 requester 撤回 ⇒ 403 `APPROVAL_REVOKE_FORBIDDEN`(仅路由层能拒,引擎单独会接受),轮次 pending | 绿 |
| 身份来自令牌 | 无 Authorization、只带 `x-user-id` 头 ⇒ 办理与撤回均 401,轮次不变 | 绿 |
| 显示名(NIT-6) | 发起后撤销轮 `created` 审计行 `actor_name` = 用户显示名 | 绿 |
| canWithdraw 同序(NIT-4) | 轮次撤回后:管理员摘要 `APPROVAL_REVOKE_FORBIDDEN`;进程内引擎对管理员 403 同码、对请求人 409 `INVALID_STATUS_TRANSITION` | 绿 |

| 运行 | 读数 |
|---|---|
| 本套件(`EXPECT_DB=1`,两条 URL) | **35/35**(阶段 A 22 + A2 13) |
| CI 形(`env -i`,仅 `DATABASE_URL`) | 34 通过 / 1 跳过(EXPECT_DB 哨兵) |
| CI 相邻同序:seed-template-visibility → attendance-entry → template-groups-lifecycle | 72 通过 / 3 跳过(75) |
| 撤销轮真库尾部(CI 同序)上半:lock-order-census / creation / redemption | 126 通过 / 3 跳过(129) |
| 下半:seat-guards / attendance-fk-migration / outlet-guards / node-timeout-effect | 22 通过 / 4 跳过(26) |
| 单测 `tests/unit/approval*`(88 文件) | 1706/1706 |
| 单测 `tests/unit/attendance*`(97 文件,含 UUID 路由、端口作用域) | 1753/1753 |
| 点名单测 8 文件:端口作用域、UUID 路由、静态普查、摘要单测、cancel-round ci-wiring、插件镜像常量、`dispatchAction` 版本前置条件普查、coverage-enumeration | 531/531 |
| `required-web-lane-token-manifest-guard` | 29/29 |
| `tsc --noEmit -p tsconfig.json`(core-backend) | EXIT 0,0 error |

### 8.6 守卫与 CI 接线(登记项 L-4,与路由同一提交)

- **动态探针**:白名单从两条扩到**恰好四条**(新增 `POST …/cancel-round/actions`、`POST …/cancel-round/withdraw`)。实跑:注册 1158 条、打出 962 条,命中 cancel-round token 的 4 条全在白名单内,白名单外 0、缺失 0、创建路径到达 0,PASS;正控 `self` 到达 1,PASS。负控:白名单删去一条新路由 ⇒ 退出码 2。
- **静态普查**(创建路径 `createCancelRoundInstance`):不变 —— 两条新路由只到达引擎的 `dispatchAction`,不到达创建路径;普查 18/18 仍绿。
- **`dispatchAction` 版本前置条件普查**(`approval-legacy-decision-version-precondition-sites.test.ts`):调用方文件按发现式人口计入端口,端口的请求对象不带 `expectedVersion`,仍绿。
- **CI 接线**:A2 用例都在已接线的同一文件里 ⇒ `plugin-tests.yml` approval real-DB step、`vitest.config.ts` exclude、ci-wiring 常量均无需改;`plugin-tests.yml` 未改 ⇒ s6a `pluginTestsWorkflow` pin 不动;`sealed-export-package-provenance.test.cjs` OK(本分支未触碰任何被钉文件)。

### 8.7 mutation(每条:一处替换 → 核与备份的 numstat 恰 `1 1` → 跑 → cp 还原 → `cmp` 逐字节)

| # | 手术 | 读数 | 失败点 |
|---|---|---|---|
| F1 | 去掉发起路由的开关判定 | 1 failed / 22 | 开关 OFF 用例:201 ≠ 404 |
| F2 | 开关默认值改 ON | 1 failed / 22 | 开关 OFF 用例(未设置一腿) |
| R1 | 办理路由去掉 `withPermission('attendance:approve')` | 1 failed / 32 | 无 `attendance:approve` 用例:200 ≠ 403 |
| R2 | 撤回路由去掉请假本人检查 | 1 failed / 32 | 撤回路由层 requester 见证:200 ≠ 403 |
| R3a | 端口改为以轮次席位持有者身份分发(跳过席位校验的路径) | 3 failed / 30 | 无席位用例 200 ≠ 403;两条撤回用例 |
| R3b | 服务层席位校验失效 | 1 failed / 32 | 无席位用例 |
| X1 | 撤回路由去掉 `withPermission('attendance:write')` | 1 failed / 32 | 无 `attendance:write` 撤回用例 |
| X2 | 办理动作枚举放入 `transfer` | 1 failed / 32 | 非允许动作用例 |
| X3 | 撤回路由去掉 I7(改用不带可见谓词的加载器) | 1 failed / 32 | 非请求人撤回用例(外人不再 404) |
| P1 | 探针白名单删去一条新路由 | 探针退出码 2 | 白名单外命中 |
| N4 | `canWithdraw` 恢复旧序(终态先判) | 1 failed / 33 | P-4 canWithdraw 用例 |
| N6 | 发起不传显示名 | 1 failed / 33 | 显示名用例 |

### 8.8 残留与 NOT RUN

1. **办理路由对无席位持有者的应答**:有轮次的单据 403 `APPROVAL_ASSIGNMENT_REQUIRED`,无轮次 / 不存在 404 —— 与审批侧 `POST /api/approvals/:id/actions`(403 / 404)同形,是任务要求的「既有拒绝码」。若 owner 要求两者统一为 404,属合同变更,待裁。
2. **待办角标刷新**:审批侧动作路由在分发之后发布待办计数;考勤侧两条路由不做(待办呈现属阶段 C / P-11)。**阶段 C 已处理**:§9.5.3。
3. **开关的可观测性**(阶段 B 输入,**建议,待 owner**):OFF 与「不存在」同形,前端无从得知开关状态;若阶段 B 要按开关显示 / 禁用入口,需另定能力读取方式(不属本切片)。**owner 14:3x 已裁**「Summary exposes entryEnabled (Recommended)」,阶段 C 已实现:§9.2。
4. **§6 第 0b 项**(兑现侧 500)未修,归 C-1 线;开关 OFF 期间经本入口不可达。
5. **`roles: []` 的前提**(撤销轮只有人席位)由测试断言钉住;若将来改变,见 §8.4。
6. **NOT RUN**:前端(阶段 B);投递与待办(阶段 C);阶段 D 验收;CI(未推送);A2 的独立门审;CI 所用 PostgreSQL 版本(本地 15.17);`attendance-plugin.test.ts` 全量;`scripts/ops/*.test.mjs`;`tests/unit` 中 approval / attendance 前缀之外的文件;钉钉卡片回调对撤销轮的办理(UNVERIFIED,未改)。
7. **测试残留**:与 §6 第 8 项同类(只追加的修订历史行、登录类审计行);端到端用例经真实 W4 取消,每次运行另留 1 行只追加的考勤结果操作行与 1 行修订历史行(二者都有拒绝删除的守卫)。套件删除自己建的请假类型、请求、实例、轮次、用户与角色;以上只追加行随一次性库 drop(CI 的服务库同样是一次性的)。

---

## 9. 阶段 C(后端)

### 9.0 授权与范围(只引 owner 选项原文;我方建议不是授权)

| 项 | owner 选项原文(`goal-four-items-20260928.md` §0) | 本节落点 |
|---|---|---|
| 14:3x ① | 「**Minimal action response (Recommended)**」 | §9.1 |
| 14:3x ② | 「**Summary exposes entryEnabled (Recommended)**」 | §9.2 |
| 14:3x ③ | 「**Keep, same as approval side (Recommended)**」 | 无席位码不改(§8.8 第 1 项维持) |
| P-5 | 「**(iii) Full delivery**」+ 字段「**Full status, no raw ids/errors (Recommended)**」(选项说明原文:Per delivery: status (delivered/pending/failed), channel TYPE, attempt count, timestamps. No external message ids, no raw provider error text (show a fixed category message instead)) | §9.4 |
| P-11 | 「**Adopt all 3, split locks (Recommended)**」((a)(b) → lock B v2.14 §3 PendingItem; (c) → cancel lock §14.1) | §9.5 |
| P-6′ ③ | 「**(ii) Reuse approval notices (Recommended)**」 | §9.6(其后由 16:5x ① 答复) |
| 16:5x ① | 「**Defer: weak copy only (Recommended)**」(§0 记录的选项说明:保持员工面弱版中性文案、code 不变;暂不发管理员通知,作为对 lock:75 的已知缺口记录,待 #5746 与通知通道另定;无新代码) | §9.6 |
| 16:5x ② | 「**Attendance-side list (Recommended)**」(§0 记录的选项说明:考勤侧「待我审批的撤销」列表,挂 `attendance:approve`,只列查看者自己的在席席位,席位来源与 actions 路由同一——与 #22 = (i) 一致,不改授予政策;小后端路由 + 前端面板) | **新范围,不在阶段 C**;阶段 C 时本分支未实现(§9.9 第 8 项)。后端部分其后由 C2 实现:§10 |
| 16:5x ③ | 「**Show the list (Recommended)**」(§0 记录的选项说明:保持逐条投递列表,outcome_unknown→pending、零尝试的 superseded/skipped 不列出,按设计 MD 记录) | §9.4.3 |

- ratify 文本 = 撤销锁 v5.9 抬头「RATIFY 追记 —— 产品入口增补 v2」所引的 errata v2 各条「建议增补原文」,按 owner 取值;P-11 (a)(b) 另见待办中心锁 v2.14 抬头的同日追记。
- 仍只动后端(`packages/core-backend/**`、`plugins/**`)与本文档;**零 DDL**;未碰 `apps/web/**`。合并未被点名,完成后单独请示。

### 9.1 办理 / 撤回成功体改为最小形(14:3x ①)

- `POST …/cancel-round/actions`(approve / reject)与 `POST …/cancel-round/withdraw` 成功 **200** 的 `data` **恰为** `{ requestId, roundId, outcome, status }`:
  - `roundId` = 本次分发所作用的那一轮(分发前取「最新轮」,分发后**按 id** 回读,不再重选「最新」);
  - `outcome` = 该轮 `approval_rounds.outcome`(六值之一,未知值显式报错 → 通用 500);
  - `status` = P-2 主语化机器词(§4)。
- 端口 `decide` / `withdraw` **不再构建摘要**;插件逐字段拷贝这四个值,端口多回任何字段也不会带出。
- 理由(owner 选项所指):摘要是只由 I7 一个谓词门住的读模型;办理路由按设计不加 I7(§8.3.2),在它的成功体里回带摘要等于同一读模型挂在两个判据后面(A2 门审 r1 的 P3-3)。委托场景下,席位持有人要看进度,走审批侧待办(§9.5)或 I7 读面。
- 拒绝体(含无席位 403 `APPROVAL_ASSIGNMENT_REQUIRED` / 无轮次 404)**不变**(14:3x ③)。

### 9.2 摘要带 `entryEnabled`(14:3x ②)

- `GET …/cancel-round` 的 `data` 增布尔 `entryEnabled` = `ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED` 的**全局**态(每次请求现读,与发起路由同一个 `isAttendanceCancelRoundEntryEnabled()`);不含任何每用户数据。
- 发起 201 的 `data` 与 GET 同形,因此也带 `entryEnabled`(发起成功时必为 `true`)。
- 前端用法(owner 选项说明,属阶段 B):`false` ⇒ 整块隐藏撤销入口;`true` ⇒ 按 P-1「禁用而非隐藏」。GET 本身不受开关影响(§8.2)。

### 9.3 A2 门审 r1 遗留

| 项 | 处理 | 证据 |
|---|---|---|
| P3-1「开关只门发起」无测试 | 新用例:开关 ON 下发起两轮 → 删除开关 → 持席位审批人 approve 200、请求人 withdraw 200;同单再发起 = 与不存在同形 404;摘要 `entryEnabled=false` | 门审同款 mutation G-FS1(撤回路由加开关判定)、G-FS2(办理路由加开关判定)**各 1 红** |
| P3-2 撤回「无轮次 ⇒ 404」无用例 | 新用例:请求人对**本人**无轮次的已批准请假撤回 ⇒ 404,与随机 id 逐字节同;先以 GET 200 证明请求人可读(404 来自无轮次分支,不是可见性分支) | G-N1(该分支 `if (false)`)**1 红** |
| P3-3 委托场景读面不一致 | owner 14:3x ① 已裁 ⇒ §9.1 | 四条成功体用例改为逐键 `toEqual`;C1a(成功体多带一个键)**4 红** |
| NIT-1 端口动词白名单单独失效全绿 | 端口分发函数以注入的 `Queryable` 导出;新单测:白名单外六个动词直调 ⇒ 抛错且**零查询**;允许动词 + 无轮次 = 正控(1 次查询、`noRound`) | G-V1(白名单 `if (false)`)**6 红** |
| NIT-2 MD 引改写前旧头 | §5「门审读数」改为「其所见的改写前旧头(不写提交号)」 | 文档 |

### 9.4 P-5:本轮自己的投递状态(values-free)

#### 9.4.1 撤销轮会产生哪些投递(调查)

撤销轮的引擎实例是普通的 platform 实例:席位由创建路径写入,落座即发普通的 `approval.task_created` 事件。全仓按人、按审批实例落账的投递账本只有两本:

| 账本 | 生产者 | 以什么键关联 | 是否计入 |
|---|---|---|---|
| `dingtalk_approval_card_deliveries` | `approval.task_created` 自动化规则的「发送钉钉审批卡片」动作(规则按 `trigger_config.templateId` 路由;撤销轮模板若被配置了规则即会产生) | `instance_id` = 撤销轮引擎实例 | **计入** |
| `dingtalk_todo_mirrors` | 钉钉待办镜像消费者(`DINGTALK_TODO_MIRROR_ENABLED`,默认 OFF) | `instance_id` = 撤销轮引擎实例 | **计入** |
| `attendance_notification_deliveries` | 考勤结果更正、考勤报表摘要、手动漏打卡提醒、调休到期提醒、未排班提醒 | 无撤销轮生产者 | 不计入 |
| `dingtalk_person_deliveries` | 自动化「钉钉个人消息」动作 | 按规则 / 记录,不按审批实例 | 不计入(无法归属到某一轮) |

errata P-5 理由 1–3 的锚点对照:① 考勤投递读面挂 `attendance:admin` 且只按 org 过滤 —— 本节不经它;② 审批卡片 `send_status` 今天只能凭卡片凭据读到 —— 本节在服务端按实例读,只出分类值;③ 投递行含渠道、外部 id、错误文本 —— 本节 SELECT 只取状态 / 计数 / 时间列,id、外部任务号、收件人、节点键、错误文本**一列都不读**。

#### 9.4.2 形状与谓词(并入摘要,不开子路由)

- `round.deliveries: [{ channelType, status, attempts, createdAt, lastAttemptAt, updatedAt }]`,按创建时间升序;`round: null` 时自然没有。
- `channelType` ∈ `dingtalk_approval_card` | `dingtalk_todo`;`status` ∈ `delivered` | `pending` | `failed`;失败原因不给文本,前端按 status 渲染固定分类文案(owner 选项说明)。
- **并入摘要而非子路由的理由**:同一个 I7 谓词、同一次读;不新增路由 ⇒ 动态探针白名单(恰好四条)与静态普查(恰好一个点名调用方)都不变;撤销轮的投递与轮次状态本来就一起呈现。
- 范围 = 该单据最新一轮**自己的**引擎实例;原单自身的投递不列(用例有负控)。
- **不变量**(草案 §15.5 半句,owner 选择保留):投递失败不改变 `approval_rounds.outcome`、引擎实例 `status`、席位。本节的读路径与两本账本的写方都不写这三者;用例实测(§9.7)。

#### 9.4.3 账本状态 → 三值(单测逐行钉住;owner 16:5x ③ 见本节末)

| 账本 | 账本状态 | → status | attempts | lastAttemptAt |
|---|---|---|---|---|
| 审批卡片 `send_status` | `sent` | delivered | 1 | = 行创建时间 |
| | `failed` | failed | 1 | 同上 |
| | `pending` | pending | 1 | 同上 |
| | `outcome_unknown` | **pending**(对方可能已送达,且从不自动重发 ⇒ 「未确认」而非「失败」) | 1 | 同上 |
| 钉钉待办 `status` | `created` / `completing` / `completed` | delivered(待办已建成) | 账本计数 | 账本 `last_attempt_at` |
| | `pending` / `sending` / `outcome_unknown` | pending | 账本计数 | 同上 |
| | `failed` | failed | 账本计数 | 同上 |
| | `superseded` / `skipped`,计数 > 0 | failed(试过、没送到) | 账本计数 | 同上 |
| | `superseded` / `skipped`,计数 = 0 | **不列出**(席位或实例在任何一次尝试之前就已结束:没有投递、也没有尝试) | — | — |
| 任一 | 未知状态 / 未知渠道 | **不列出**(不猜) | — | — |

- 卡片的 `attempts = 1`:卡片行在唯一一次发送调用前插入,一行就是一次发送;重发是新的一行。卡片账本没有计数列,这是推导值,不是读出值。
- 钉钉待办的计数在待办建成之后会被账本复用于「完成待办」阶段(节点前移时重置为 0),所以 delivered 行的 `attempts` 是账本当前计数,不一定是建成前的尝试次数 —— 已知口径差异,记为残留。
- **owner 2026-09-29 16:5x ③**:「**Show the list (Recommended)**」,§0 记录的选项说明原文:保持逐条投递列表,outcome_unknown→pending、零尝试的 superseded/skipped 不列出,按设计 MD 记录。选项点名的是三件事:逐条列出;`outcome_unknown` → pending;计数为 0 的 `superseded` / `skipped` 不列出。表中其余各行照本节原样记录,选项对它们只有「按设计 MD 记录」一句,本文不另加解释。(本节标题原写「暂定实现选择,待门审 / owner 确认」,写于该选项之前。)

### 9.5 P-11:待办中心呈现与席位臂围栏

#### 9.5.1 (a)(b) 待办项(落待办中心锁 §3 `PendingItem`)

- 撤销轮按构造进入待办中心:审批源只有一份共享「待处理」查询(不看 `workflow_key`),计数与列表同一谓词,本节**不加**第二份。
- `PendingItem` 增可选 `workflowKey`(审批源 = `approval_instances.workflow_key`,可为 `null`),前端据 `approval.cancel-round` 选撤销轮的呈现(不靠标题前缀)。
- 撤销轮项的 `href` 指向**原请假单**:`/attendance?section=attendance-overview-requests&requestId=<考勤请求 id>` —— 与审批中心打开考勤审批时用的同一个既有深链形状;经 `approval_rounds`(引擎实例 → 原单)与 `attendance_requests.approval_instance_id`(原单 → 请假)**一次批量读**解析(列表里没有撤销轮时不发这次读);原单不是考勤请求时回落到原单的审批详情 `/approvals/<原单 id>`。
- 待办路由仍挂 `approvals:read`(待办中心首切片既定;该码已登记、默认零授予,P-10 已知)。考勤审批人要在待办中心看到撤销轮,需要这个码 —— 授予不在本阶段(owner 未点名)。

#### 9.5.2 (c) 席位臂围栏(落撤销锁 §14.1)

- 创建路径在任何写入之前判定:撤销轮的每个席位臂 ∈ {`user`, `role`},否则以已登记的 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`(409)拒绝 —— 与紧邻的「种子图被改坏」兜底同码,不新造码。
- 创建路径是撤销轮席位的唯一写方(§9-9 / §14.3 拒绝一切改席位的动作),因此围栏只立在这一处。种子图按用户 id 落座,正常路径不可达;真库见证用例把执行器的一次应答改写成队列席位,判据两条:
  1. 拒绝前后 `approval_request_no_seq` 的 `(last_value, is_called)` 不变。单号由 `nextval` 在创建事务**之外**分配,不随回滚撤销(该序列 CACHE = 1,每次 `nextval` 都会移动 `last_value`),它不变说明拒绝发生在分配单号之前,也就在第一条 INSERT 之前;
  2. 零轮次、`approval_instances` 行数不变 —— 这一条只说明没有留下行:事务内的 INSERT 会被回滚掩盖,单靠它量不出「在任何写入之前」。
  同单不改写即可正常发起,且序列前进(正控,说明探针是活的)。门审 r1 所见版本只有第 2 条,围栏整块移到分配单号或第一条 INSERT 之后仍全绿(门审 r1 P3,§9.10)。
- A2 的 `roles: []` 前提(撤销轮只有人席位,§8.4)不受影响:围栏允许 `role` 臂,是比 A2 断言更宽的锁级围栏;A2 用例仍断言已发起轮次全为 `user`。

#### 9.5.3 办理后计数刷新(复用既有发布机制)

- 宿主注入端口时绑定审批侧动作路由用的**同一个**发布函数(同时发 `approval:counts-updated` 与 `todo:counts-updated`,后者经待办中心的共享查询),不另写计数。
- 发起:发起人 + 新轮的人席位;办理 / 撤回:调用者 + 该轮**分发前**与分发后的人席位(办理 / 撤回会让席位失效,失效前的持有者正是计数下降的人;审批侧路由只读分发后仍有效的席位,这一处更完整)。
- 尽力而为:动作已提交,发布失败只记日志(只含 reason 记号),不把成功的动作变成错误。
- **调用者带自己的角色声明**(门审 r1 P2 的修复,§9.10):插件按核心 `resolveApprovalActorRoles` 的同一读法(`req.user.role` 去空白后并上 `req.user.roles` 里的非空字符串,去重)取调用者的角色声明,在发起 / 办理 / 撤回三处交给端口;端口把调用者作为**第一项**、带这些声明交给发布函数,席位上的其他用户不带声明,且不再重复调用者(发布函数对同一用户只取第一项;审批人办理自己的席位时,调用者本人也在席位里)—— 与审批侧动作路由的 `{ userId, roles: actor.roles }` 同形。于是调用者收到的计数与其自己 `GET /api/todo/count` 用的是同一个 viewer。角色声明只用于这次推送:不进创建路径,也不进分发的动作(`dispatchAction` 仍是 `roles: []`,§8.4 前提不变)。
- 仍在的既有限制(与审批侧相同,`todo-realtime.ts` 自述):**非调用者**在推送里没有角色声明,所有人在推送里都没有 `permissions`;只凭 `role` / 队列席位计数的非调用者,推送的数可能小于其下一次 `GET /api/todo/count`,后者不受影响。
- **更正**:本节旧版写「推送里只带调用者的角色为空集 …… 撤销轮只有人席位,不受其影响」,不对。调用者的计数涵盖其**全部**待办,不只本轮的席位;以角色席位落座的其它待办(例如考勤兜底队列的 `role: admin` 席位)也在其中。门审 r1 以真库 + 真 HTTP 见证:`users.role = admin` 的审批人另有一条 `role: admin` 席位的无关待办,考勤侧办理后推送 0 / GET 2;同一场景经 `/api/approvals/:id/actions` 办理为推送 1 / GET 1。

### 9.6 P-6′ (ii) 管理员通知 —— **按 owner 16:5x ① 暂缓(未实现,无新代码)**

**当前状态**:owner 2026-09-29 16:5x ①「**Defer: weak copy only (Recommended)**」,§0 记录的选项说明原文:保持员工面弱版中性文案、code 不变;暂不发管理员通知,作为对 lock:75 的已知缺口记录,待 #5746 与通知通道另定;无新代码。本分支据此不实现管理员通知;员工面弱版文案早已在位(见下「已在位的一半」)。

下文是 16:5x 之前写的 BLOCKED 记录(写时属实),保留作为该已知缺口的依据;其末条「需 owner 择一」已由上述选项答复。

owner 选项「(ii) Reuse approval notices (Recommended)」的说明原文为 “Send the existing approval notification to the admin resolved by A0 `process`; ratify §15.6.1 ③ (ii) shape; weaker employee-facing copy until RC (c) lands”。与 main 的两处冲突:

1. **「A0 解析器 `process`」在 main 上不存在**。它是 PR #5746(`chore/approval-admin-capability-resolver-phase0`,OPEN,未合并);goal §0「仍不在授权内」明列「#5746 / #5703 / #5698 处置」。main 上 `process` 类管理路由(改派、跳转)仍直接挂 `rbacGuard('approvals:admin')`,没有任何函数能「解析出」某张单据该通知的管理员集合。自行枚举 `approvals:admin` 持有者 = 自造一个解析器,不做。
2. **main 上没有可寻址到任意管理员的「既有审批通知」出口**。按人投递的审批通知只有 `approval.task_created` 事件(→ 按模板路由的自动化规则 → 钉钉审批卡片 / 钉钉待办镜像),它按**席位**产生,卡片只对在席者可操作;为不在席的管理员合成一条 task_created,等于向他宣布一条不属于他的待办。审批 SLA 超时通知(`ApprovalBreachNotifier`)走部署级配置的通道(钉钉群 webhook、`APPROVAL_BREACH_EMAIL_TO` 固定收件地址),不按单据寻址到管理员。errata P-6′ 理由 2 本身也写着「今天没有任何投递通道」。

- **已在位的一半**:员工面弱版文案 —— 阶段 A 起,端口对两个席位类码(`CANCEL_ROUND_SEAT_INELIGIBLE`、`CANCEL_ROUND_NO_ELIGIBLE_APPROVER`)回不声称原因的中性句,code 不变(§2.2),与选项说明的 “weaker employee-facing copy until RC (c) lands” 一致;本阶段未改。
- (写于 16:5x 之前,已由 16:5x ① 答复)**需 owner 择一**(不是建议):① 先裁 #5746 的处置(合入后按其 `process` 能力解析收件人),并点名用哪条通知出口;② 另定收件人口径与出口(锁级决定);③ 维持现状(员工面弱版文案 + 管理员不另收通知)。

### 9.7 测试矩阵与读数(本地真库 + 真 HTTP)

(本节是门审 r1 之前的读数,保持原样;修复轮 1 之后的读数见 §9.10。)

**环境**:一次性库 `ms2_g4cancelc_20260929`(`createdb -O ms2testbed`,非超级角色;每次运行前断言 `current_database()`);`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它;迁移 `tsx src/db/migrate.ts` + CI 的 `MIGRATION_EXCLUDE`,EXIT 0,419 条;`approvals:read` 目录行在(#5901);PostgreSQL 15.17、Node 20.20.2;工具直调 `node_modules/.bin/*`,未经 pnpm。全部用例都在已接线的同一个 `.db.test.ts` 里 ⇒ `plugin-tests.yml`、`vitest.config.ts` exclude、ci-wiring 常量、s6a pins 都无需改。

| 用例 | 判据 | 读数 |
|---|---|---|
| 成功体最小形(改写既有四条) | approve / reject / withdraw / 端到端的 200 体逐键 `toEqual({ ok, data: { requestId, roundId, outcome, status } })`;摘要字段改由员工 GET 核对 | 绿 |
| `entryEnabled` | 员工首读 `data` 含 `entryEnabled: true`;发起 201 `data` 键集恰为 4 个;开关未设置 / `"false"` 时 GET 为 `false`,打开后 GET 与 201 为 `true` | 绿 |
| P3-1 开关只门发起 | 见 §9.3 | 绿 |
| P3-2 无轮次撤回 | 见 §9.3 | 绿 |
| P-5 values-free + 不变量 | 经卡片账本自己的写函数写一条 failed(带提供方错误文本)、一条 sent(带外部任务号);待办镜像一条 failed(计数 3、带错误文本与外部任务号)、一条计数 0 的 superseded;原单实例上另写一条 failed 卡片。员工 GET:`deliveries` 恰为 `[卡片 failed 1, 卡片 delivered 1, 待办 failed 3]`,每项键集恰为 6 个、时间可解析;响应文本不含收件人钉钉 id、两段错误文本、两个外部任务号、四个行 id、审批人 id、节点键;审批人(同一 I7 读面)读到同一列表;轮次仍 `pending`、引擎实例仍 `pending`、席位行逐行相等;随后持席位审批人 approve 200 ⇒ `applied`,投递列表仍在 | 绿 |
| P-11 (a)(b) + 刷新 | 审批人补授 `approvals:read`(清其权限缓存);发起两轮 ⇒ 审批人房间收到 `todo:counts-updated`(≥2)、发起人收到(≥1);`/api/todo/items` 中该轮恰 1 项且逐键等于 `{ source: 'approval', id, title ∋ 撤销, href: 原请假深链, updatedAt, actionable: true, workflowKey: 'approval.cancel-round' }`;`sources = { approval: 'ok' }`;`count == items.length`;最后一次推送的计数 == count;考勤侧 approve 后推送计数 = count − 1、列表不再含该轮、count = −1;另一轮请求人 withdraw 后**审批人**收到推送、计数 = count − 2 | 绿 |
| P-11 (c) 围栏 | 已发起轮次的席位臂 ⊆ {user, role};执行器一次应答改写为队列席位 ⇒ 进程内创建 409 `CANCEL_ROUND_NO_ELIGIBLE_APPROVER`,零轮次、`approval_instances` 行数不变;不改写的同单创建成功(正控) | 绿 |

**单测(新)**:端口动词白名单 7 条;投递映射 18 条(两本账本全部状态逐行 + 未知状态 / 渠道 + 键集);席位臂围栏 7 条。

| 运行 | 读数 |
|---|---|
| 本套件(`EXPECT_DB=1`,两条 URL) | **40/40**(阶段 A 22 + A2 13 + 阶段 C 5) |
| CI 形(`env -i`,仅 `DATABASE_URL`) | 39 通过 / 1 跳过(EXPECT_DB 哨兵) |
| CI 相邻同序:seed-template-visibility → attendance-entry → template-groups-lifecycle | 80/80 |
| 撤销轮真库尾部(CI 同序)上半:lock-order-census / creation / redemption(C-2) | 129/129 |
| 下半:seat-guards / attendance-fk-migration / outlet-guards / node-timeout-effect | 26/26 |
| 待办中心真库闸(#5853 的独立 project,`vitest.todo-center-pending-gate.config.ts`,其 workflow 的 env 原样) | **27/27** |
| 点名单测 15 文件:端口作用域、UUID 路由、静态普查、摘要、ci-wiring、插件镜像常量、`dispatchAction` 版本前置普查、coverage-enumeration、三个新单测、待办注册表、待办实时、双发布接线、web-lane manifest 守卫 | 608/608 |
| `tests/unit/approval*`(91 文件) | 1741/1741 |
| `tests/unit/attendance*`(97 文件) | 1753/1753 |
| 动态休眠探针 `self` / `none` | 正控到达 1,PASS;实跑注册 1158、打出 962、cancel-round 路由 4 条全在白名单、白名单外 0、缺失 0、到达 0,PASS(路由未增减 ⇒ 白名单与静态普查「恰好一个点名调用方」都不需改) |
| s6a:`computePackageProvenancePinSet` 全量重算 | 66 / 66 键,差 0,与已提交 pins 逐字节同;`sealed-export-package-provenance.test.cjs` OK |
| `tsc --noEmit -p tsconfig.json`(core-backend) | EXIT 0 |
| 零 DDL | 本阶段未改任何迁移 / 种子 / SQL 文件 |
| 被本阶段改动文件触发的其它真库 lane(23 个 `approval-realdb-*` / policy-carrier workflow,各自 `run` 行里的文件原样,`EXPECT_DB=1`,两条 URL 指向一次性库) | 在同一个一次性库上顺序跑:19 个 lane 全绿;4 个 lane 红 —— p7r1-coverage-repair 9 红(待办计数期望 2 / 3 / 0,实得 10 / 11 / 8)、projection-key-parity 3 红、sequential-mode 2 红、comments 1 个钩子超时。四个 lane 换到**新建的第二个一次性库** `ms2_g4cancelc2_20260929`(同样迁移 419 条)后:p7r1 67/67、projection-key-parity 17/17、sequential-mode 10/10、comments 58/58。判定:第一个库上的红来自共享库残留(动态探针对 962 条路由打过请求,另有前序 lane 的数据),不是本阶段改动;CI 每个 lane 用自己的新库 |

### 9.8 mutation(每条:cp 备份 → 一处精确替换 → 核 numstat → 跑 → cp 还原 → `cmp` 逐字节 → 工作树无改动)

| # | 手术 | 读数 |
|---|---|---|
| C1a | 办理 / 撤回成功体多带一个键 | 4 红 |
| C1b | GET 的 `entryEnabled` 写死 `true` | 1 红(开关 OFF 用例) |
| G-FS1 | 撤回路由加开关判定 | 1 红(P3-1 用例) |
| G-FS2 | 办理路由加开关判定 | 1 红(P3-1 用例) |
| G-N1 | 撤回路由无轮次分支失效 | 1 红(P3-2 用例) |
| G-V1 | 端口动词白名单失效 | 单测 6 红 |
| C3a | 卡片 `failed` 映射成 `delivered` | 真库 1 红;单测 1 红 |
| C3b | 投递读去掉按本轮实例过滤 | 1 红(原单的卡片被列出) |
| C3c | 投递项多带账本状态键 | 1 红(键集) |
| C4a | 创建路径的围栏判定失效 | 1 红(围栏见证) |
| C4b | 围栏谓词恒真 | 单测 5 红 |
| C4c | 撤销轮项 `href` 回落为通用审批详情 | 1 红 |
| C4d | 待办项去掉 `workflowKey` | 1 红 |
| C4e | 办理 / 撤回的推送收件人去掉分发前席位 | 1 红(撤回后审批人无推送) |
| C4f | 办理 / 撤回不发布计数 | 1 红 |
| C4g | 发起不发布计数 | 1 红 |

### 9.9 残留与 NOT RUN

1. **P-6′(ii)**:owner 16:5x ①「Defer: weak copy only (Recommended)」⇒ 不发管理员通知、员工面弱版文案与 code 不变,作为对 lock:75 的已知缺口记录,待 #5746 与通知通道另定(§9.6)。
2. **§9.4.3 映射**:owner 16:5x ③「Show the list (Recommended)」点名了逐条列出、`outcome_unknown` → pending、零尝试的 `superseded` / `skipped` 不列出;其余行照 §9.4.3 记录(选项说明「按设计 MD 记录」);钉钉待办 delivered 行的计数口径见 §9.4.3 末条。
3. **投递条数可推出通知过几次**(约等于审批人数 × 渠道数):不含人名 / id,P-6 的「不渲染具体人名」不受影响;如 owner 认为条数本身也不宜给员工,属合同变更。
4. **待办中心可见性依赖 `approvals:read`**(§9.5.1),默认零授予 —— 既有状况,本阶段不授予。门审 r1 NIT 复核同此:待办列表与计数两条路由都挂 `rbacGuard('approvals','read')`,非管理员的考勤审批人在这两处得 403,P-11 (a)(b) 今天只到达管理员与显式获授者(真库套件的 P-11 用例须先补授该码并清权限缓存)。审批人的可见性去处:owner 16:5x ② 的考勤侧列表(第 8 项),或另行的授予决定(不在授权内)。阶段 C 不改代码。
5. **§6 第 0b 项**(发起后原请假被既有直接取消通道取消 ⇒ 兑现 500)仍未修,归 C-1 线;开关 OFF 期间经本入口不可达。
6. **NOT RUN**:CI(未推送);`attendance-web-guard.yml`(被插件改动触发,但它只跑 `apps/web` 的 spec,属前端 lane);CI 所用 PostgreSQL 版本(本地 15.17);前端(阶段 B,另一分支);阶段 D 验收;真实钉钉发送(两本账本由其写函数 / 夹具写入,未经真实提供方);钉钉卡片回调对撤销轮的办理(UNVERIFIED,未改);`attendance-plugin.test.ts` 全量;`scripts/ops/*.test.mjs`;`tests/unit` 中 approval / attendance 前缀之外的文件(已跑的待办相关单测除外);阶段 C 的独立门审。
7. **测试残留**:同 §6 第 8 项、§8.8 第 7 项;阶段 C 用例写入的两本投递账本行在 `afterAll` 显式删除(待办镜像无外键级联),运行后库内两表均为 0 行;动态探针对全部路由打请求,会在一次性库留下探针数据,随库 drop。
8. **owner 16:5x ②「Attendance-side list (Recommended)」**(考勤侧「待我审批的撤销」列表,挂 `attendance:approve`,只列查看者自己的在席席位,席位来源与 actions 路由同一;小后端路由 + 前端面板):**新范围,不在阶段 C**,本分支未实现。(其后:后端部分由 C2 实现,见 §10;前端面板属前端 lane。)

### 9.10 阶段 C 门审 r1 的修复轮(修复轮 1)

(本节读数保持原样;下表标「单次」的格子是单次运行的读数,P-5 待办镜像用例有计时抖动,已由 §9.11 的多次读数取代。)

- **对象**:门审 r1 所见的 6 个提交(`2e44d6053..9a661b2d2b`)。本轮新提交(不 amend、未推送、未开 PR):`43111fde0a`(P2)、`a6a2420ba7`(P3 围栏见证)、`6f9e1cc5dc`(P3 待办镜像失败路径),以及本文档的提交。零 DDL;未碰 `apps/web/**`。⑤ P-6′(ii) 不在本轮范围(§9.6)。
- **实现模型**:Claude Opus 5.5。

| 门审 r1 结论 | 级 | 处理 | 证据 |
|---|---|---|---|
| 考勤侧发起 / 办理 / 撤回的计数推送对调用者传空角色集,审批侧(10 处调用点)传调用者的 `actor.roles`;调用者以角色席位落座的待办从推送计数里消失;MD §9.5.3 误称不受影响 | P2 | 端口 actor 增可选 `roles`;插件按 `resolveApprovalActorRoles` 的同一读法在三处填入;端口把调用者作首项、带声明发布,席位里不再重复调用者;分发的动作仍是 `roles: []`;创建路径只收 `{ userId, userName }`;§9.5.3 更正 | 下表 R 用例;R-* 五条 mutation 各 1 红 |
| 围栏见证只能量出「没留下行」,量不出「在任何写入之前」 | P3 | 见证增序列判据与正控(§9.5.2) | F-* 两条各 1 红 |
| P-5 不变量用例只经卡片账本的写函数,待办镜像行是裸 SQL,镜像 worker 的失败路径没走到 | P3 | 新用例经镜像服务与 worker 走失败路径 | M-* 三条各 1 红;worker 两个终态分支本地各实测 |
| MD §9 早于 16:5x 三项答复 | NIT | §9.0 / §9.4.3 / §9.6 / §9.9 引 16:5x 选项原文;16:5x ② 记为新范围;不作我方裁决 | 文档 |
| 待办中心仍挂 `approvals:read`,非管理员考勤审批人 403 | NIT | 阶段 C 不改代码(§9.5.1、§9.9 第 4 项) | — |

**新增 / 改动的真库用例**(同一已接线文件,CI 接线不变):

| 用例 | 判据 | 读数 |
|---|---|---|
| R:计数推送带调用者的角色声明(新) | 一张无关的待办只有 `role: admin` 席位;请求人与审批人 `users.role = admin`、补授 `approvals:read`(清权限缓存)后重新登录。前置:两人各自的 `/api/todo/items` 都含这张无关待办(否则下面三段会空过)。① 请求人发起 ⇒ 请求人恰收 1 次 `todo:counts-updated`,计数 == 其自己的 `GET /api/todo/count`;② 审批人考勤侧 approve ⇒ 审批人恰收 1 次,计数 == 其 GET;③ 请求人对第二张请假发起后撤回 ⇒ 请求人恰收 1 次,计数 == 其 GET。`finally` 还原 `users.role`、撤回授予、停用无关席位 | 绿 |
| P-11 (c) 围栏(改) | 拒绝前后序列 `(last_value, is_called)` 相等;零轮次、实例行数不变;正控后序列前进 | 绿 |
| P-5 不变量经待办镜像(新) | 用生产方的构造函数 `buildApprovalTaskCreatedEvent` 由本轮在席席位造 task_created,经 `applyTodoMirrorTaskCreated`(开关只经 `deps.env` 传入,服务器自身的镜像仍 OFF)⇒ 插入 1 行 pending;真实 `DingTalkTodoMirrorWorker`(真库查询、`maxAttempts: 1`、全部网络注入点为抛错假件)跑一批 ⇒ 恰领 1 行,终态 `failed`(该 org 无启用的钉钉集成,重试额度用尽)或 `skipped`(有集成、收件人未绑定),尝试 1 次、无外部任务号;摘要 `deliveries` 恰为 `[{ dingtalk_todo, failed, 1 }]`;轮次仍 `pending`、引擎实例仍 `pending`、席位行逐行相等;持席位审批人 approve 200 ⇒ `applied` | 绿(单次;该用例有计时抖动,修复与多次读数见 §9.11)。两个终态分支本地各实测一次(临时改判后还原,`cmp` 一致):无集成时改判 `toBe('failed')` 过;临时插入一条启用集成后改判 `toBe('skipped')` 过;无集成时改判 `skipped` 红(负控)。临时集成行用后删除,库内 0 行 |

**读数**(一次性库 `ms2_g4cancelc_fix1_20260929`,`createdb -O ms2testbed`,每次运行前断言 `current_database()`;`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它;迁移 `tsx src/db/migrate.ts` + CI 的 `MIGRATION_EXCLUDE`,EXIT 0,419 条;Node 20.20.2;工具直调 `node_modules/.bin/*`,未经 pnpm):

| 运行 | 读数 |
|---|---|
| 修复前基线(同库,门审所见头) | 40/40 |
| 本套件(`EXPECT_DB=1`,两条 URL) | **42/42**(40 + 新增 2;单次,由 §9.11 取代) |
| 逐提交 | `43111fde0a` 41/41;`a6a2420ba7` 41/41;`6f9e1cc5dc` 42/42(各单次;`6f9e1cc5dc` 起含抖动用例,由 §9.11 取代) |
| CI 形(`env -i`,仅 `DATABASE_URL`) | 41 通过 / 1 跳过(EXPECT_DB 哨兵;单次,由 §9.11 取代) |
| CI 相邻同序:seed-template-visibility → attendance-entry → template-groups-lifecycle | 82/82(单次,由 §9.11 取代) |
| 撤销轮真库尾部上半(lock-order-census / creation / redemption) | 129/129 |
| 下半(seat-guards / attendance-fk-migration / outlet-guards / node-timeout-effect) | 26/26 |
| `approval-realdb-org-writer-w4-s1`(被插件改动触发;其 `run` 行的文件原样) | 15/15 |
| 点名单测 15 文件:撤销轮 ci-wiring / 休眠不可达 / 端口投递 / 端口动词 / 端口摘要 / 插件镜像常量 / 席位臂围栏、coverage-enumeration、双发布接线、端口作用域、UUID 路由、待办镜像配置与迁移 / 消费者 / worker、待办实时 | 636/636 |
| `tests/unit/attendance*`(97 文件) | 1753/1753 |
| `tests/unit/approval*`(91 文件;含 `dispatchAction` 版本前置普查、`approvals-routes`) | 1741/1741 |
| 待办注册表、web-lane manifest 守卫、钉钉互动卡片回调、售后审批桥(4 文件) | 87/87 |
| `tsc --noEmit -p tsconfig.json`(core-backend;CI 无对测试文件的类型检查步骤) | EXIT 0 |
| s6a:`computePackageProvenancePinSet` 全量重算 | 与已提交 pins 深等,差 0(本轮未触碰任何被钉文件);`sealed-export-package-provenance.test.cjs` OK |
| 私有短语自扫(三份短语表) | 本轮每个提交的新增行与提交信息 0 命中;树命中数与各自父提交相同(均为 main 既有文件的旧命中) |

**mutation**(每条:cp 备份 → 精确替换,每处须恰匹配一次 → 只跑点名用例 `-t` → cp 还原 → `cmp` 逐字节 → `git status` 与改前相同):

| # | 手术 | 读数 |
|---|---|---|
| R-launch | 插件发起处去掉 `roles` 一行 | 1 红(① 段:推送 0 / GET 1) |
| R-decide | 插件办理处去掉 `roles` 一行 | 1 红(② 段) |
| R-withdraw | 插件撤回处去掉 `roles` 一行 | 1 红(③ 段) |
| R-port | 端口的调用者项不带 `roles` | 1 红(① 段) |
| R-order | 调用者项移到席位之后,且不再从席位中剔除调用者 | 1 红(② 段:审批人本人也在席位里,发布函数取到的是不带声明的那一项) |
| F-below-alloc | 13 行围栏整块移到分配单号之后 | 1 红(序列 `last_value` 前进 1) |
| F-below-insert | 整块移到第一条 INSERT 之后 | 1 红(同上) |
| M-seat | worker 终态写之后追加一条停用本实例席位的 UPDATE | 1 红(席位行不等;单次,保留的日志显示红在 `:1826` 即该判据行) |
| M-status | 同处追加一条改引擎实例状态的 UPDATE | 1 红(引擎状态 ≠ `pending`;单次,红在 `:1825`) |
| M-noop | 终态写的 WHERE 恒假(终态写不进去) | 1 红(账本停在 `sending`;单次,红在 `:1808`) |

(M-* 三条的红都落在各自判据行,不在领取计数行 `:1798`;修复后的重测见 §9.11。)

**本轮 NOT RUN**:CI(未推送);本修复轮的独立复审;待办中心真库闸(未被本轮文件触发,共享待办查询未改);动态休眠探针(路由未增减);被 `packages/core-backend/**` 宽匹配触发的 `batch2-test-stabilization` / `migration-replay` / `observability-*`;`attendance-web-guard.yml`(前端 lane);CI 所用 PostgreSQL 版本(本地同 §9.7)。

### 9.11 阶段 C 门审 r2 的修复轮(修复轮 2)

- **对象**:门审 r2 所见的分支头 `920e7e37f2`(阶段 C 的 6 个提交 + 修复轮 1 的 5 个提交)。本轮新提交(不 amend、未推送、未开 PR):`0d21f8ec8a`(P2 + 作用域 NIT)、`25e2cb23de`(两条单测 NIT),以及本文档的提交。零 DDL;**无生产文件改动**(只改一个真库用例、新增两个单测文件);未碰 `apps/web/**`。
- **⑤ P-6′(ii)**:未实现,不在本轮范围。§9.6 与 §9.9 第 1 项如实记录了 owner 16:5x ①「Defer: weak copy only (Recommended)」,本轮未改。
- **实现模型**:Claude Opus 5.5。

| 门审 r2 结论 | 级 | 处理 | 证据 |
|---|---|---|---|
| P-5 待办镜像用例是计时抖动:插入与领取落在同一毫秒时,worker 领到 0 行 | P2 | worker 经自身的 `now` 注入点拿一个**固定**、快 60 s 的时钟;不手写账本行 | 修复前:库 A 16 次全文件运行 4 红、库 B 14 次 2 红,红全在领取计数行 `:1798`(`expected +0 to be 1`)。修复后:库 A 25/25、库 B 13/13 全绿(下表) |
| `runBatch()` 从全库领取;`claimed == 1` 与抛错假件的终态写都假设库里没有别的到期行 | NIT | 跑批前断言:本轮实例之外不存在 `pending` / `completing` / `sending` 行,带明确失败信息。这三个状态是领取谓词的在途状态,是「到期」的超集。另断言本轮自己那一行的 `last_attempt_at` 恰等于该 worker 的固定时钟,即这次领取落在这一行 | 守卫探针(下文);`claimed == 1` 在守卫成立时才断言 |
| 两处收窄(分发动作 `roles: []`;创建只收 `{ userId, userName }`)拆掉后套件仍 42/42 | NIT | 新单测 `approval-cancel-round-entry-port-actor-narrowing.test.ts`。服务入口被 mock,入口 actor 带 roles、ip、userAgent。approve / reject / revoke 三个分发动作的 actor 逐键等于 `{ userId, userName, roles: [], ip, userAgent }`;创建参数键集恰为 `userId`、`userName`,无显示名时恰为 `userId` | LEAK-dispatch 3 红;LEAK-create 2 红 |
| 插件 `getActorRoleClaims` 的 `req.user.roles` 数组臂无读数 | NIT | 新单测 `approval-cancel-round-plugin-actor-role-claims.test.ts`:从 `index.cjs` 取该函数的字节(断言恰一处定义)并**运行**,逐个请求形状与核心 `resolveApprovalActorRoles` 及字面量两边比较。形状包括:数组臂单独、两臂去重、role 去空白、数组项不去空白、非字符串 / 空白数组项、非数组 `roles`、无用户。不新增插件导出 | P-array(去掉数组臂)4 红。该单测只钉住函数本身的行为;插件三处调用点确实调用它,由 §9.10 的 R-launch / R-decide / R-withdraw 钉住 |
| 待办中心仍挂 `approvals:read`,非管理员考勤审批人 403 | NIT | 阶段 C 不改代码,记录同 §9.9 第 4 项。去处是 owner 16:5x ② 的考勤侧列表(新范围,§9.9 第 8 项),或另行的授予决定(不在授权内) | — |

**抖动机理(计时问题)**:consumer 插入的行 `next_attempt_at` 取数据库 `now()` 默认值,精度到微秒。worker 领取时用 `this.now().toISOString()` 作 `$1`,精度截断到毫秒,判据是 `next_attempt_at <= $1`。插入与领取落在同一毫秒时,例如 `.682Z` 对 `.682115`,该行不到期,领到 0 行。固定时钟快 60 s,既覆盖毫秒截断,也覆盖进程与数据库之间的小时钟差。用固定时钟而不是走动时钟,是为了能用 `last_attempt_at` 精确认出这一次领取。

**守卫探针**(无文件改动,库 A):
1. 手插一行其它实例的 `pending` 行,`next_attempt_at` 设为一小时前,即已到期。
2. `-t` 只跑本用例 ⇒ 1 红,红在守卫行 `:1812`,报上述失败信息。
3. 该行原样:`pending`、`attempt_count` 0、`last_attempt_at` 与 `claim_worker_id` 为空,即 worker 没有跑到。
4. 删除该行后表内 0 行。

**CI 里的前提**:`vitest.integration.config.ts` 设 `fileParallelism: false`、`maxConcurrency: 1`,同一 step 的文件串行执行,守卫取快照期间没有别的文件在写。该账本表在生产代码里只有镜像服务一处 INSERT,由 `DINGTALK_TODO_MIRROR_ENABLED` 门控。grep 所见:集成测试里除本文件外,没有文件打开这个开关、调用 `applyTodoMirrorTaskCreated` 或构造镜像 worker;`.github/workflows/` 也没有设置该开关。多维表集成测试里出现的 `dingtalk-todo-mirror` 是自动化 outbox 的消费者键,不是这张账本表。本文件的其它用例只留终态行,`afterAll` 删除本文件写入的行。

**读数**:
- 库 A = `ms2_g4cancelc_fix2_20260929`;库 B = `ms2_g4cancelc_fix2b_20260929`,另行新建。
- 两库均 `createdb -O ms2testbed`,迁移 `tsx src/db/migrate.ts` + CI 的 `MIGRATION_EXCLUDE`,EXIT 0,419 条。
- 每次运行前断言 `current_database()`;`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向该库。
- Node 20.20.2;工具直调 `node_modules/.bin/*`,未经 pnpm;结束时两库均已 drop 并核不存在。

| 运行 | 读数 |
|---|---|
| 修复前,门审所见头 `920e7e37f2`,全文件 `EXPECT_DB=1`,库 A | 16 次中 4 红(均在 `:1798`,领取 0 行),12 绿 |
| 修复前,用例文件临时还原为修复前版本(cp 还原后 `cmp` 一致),库 B | 14 次中 2 红(均在 `:1798`),12 绿 |
| 修复后,全文件,库 A | **25 次全绿**,每次 42/42 |
| 修复后,全文件,库 B | **13 次全绿**,每次 42/42 |
| CI 形(`env -i`,仅 `DATABASE_URL`),库 B | 5 次,每次 41 通过 / 1 跳过(EXPECT_DB 哨兵) |
| 三文件一次调用(seed-template-visibility / attendance-entry / template-groups-lifecycle,同 CI run-list 片段),库 B | 3 次,每次 82/82 |
| 两个新单测 | 12/12(5 + 7) |
| coverage-enumeration + 撤销轮 ci-wiring | 381/381;两个新文件在 T4 普查里被枚举并判为已接线,无需改 workflow |
| 默认配置全量单测(`vitest run`,无库) | 1046 文件通过 / 174 跳过;17362 用例通过 / 1634 跳过 |
| `tsc --noEmit -p tsconfig.json`(core-backend) | EXIT 0 |
| 三个改动 / 新增测试文件的类型检查(临时 tsconfig,继承 core-backend 配置,另含 `types/**`;CI 不对测试文件做类型检查) | 集成文件与收窄单测 0 错误。对等单测 1 条 TS1343(`import.meta` 与基础配置的 `module` 设置),既有的 `approval-cancel-round-plugin-mirror-constant.test.ts` 在同一配置下报同样的错 |
| s6a:`computePackageProvenancePinSet` 全量重算 | 与已提交 pins 逐字节相等;`sealed-export-package-provenance.test.cjs` OK |
| 私有短语自扫(三份短语表,去重后 6 条) | 本轮每个提交的新增行与提交信息 0 命中;树命中数与父提交相同(均为 main 既有文件的旧命中) |

**mutation**:每条的步骤同 §9.10,即 cp 备份 → 精确替换(恰匹配一次)→ 跑 → cp 还原 → `cmp` 逐字节 → `git status` 与改前相同。真库条目只跑本用例(`-t`),每条跑 3 次,并记红所在的行。

| # | 手术 | 读数 |
|---|---|---|
| M-seat | 同 §9.10 | 3 次各 1 红,均在 `:1849`(席位行相等) |
| M-status | 同 §9.10 | 3 次各 1 红,均在 `:1848`(引擎状态) |
| M-round(本轮新增) | worker 终态写之后追加一条 UPDATE,把本轮 `approval_rounds.outcome` 改为 `rejected` | 3 次各 1 红,均在 `:1847`(轮次 outcome)。此前这条判据没有 mutation 覆盖。M-outcome 形状见门审 r2 §六(写成 `blocked`);M-round 是同一判据的等价写法 |
| M-noop | 同 §9.10 | 3 次各 1 红,均在 `:1829`(账本停在 `sending`) |
| LEAK-dispatch | 端口分发动作的 `roles: []` 改为 `roles: [...(actor.roles ?? [])]` | 单测 3 红(三个动词),其余 9 过 |
| LEAK-create | 创建参数改为整个 `actor` | 单测 2 红 |
| P-array | 插件 `getActorRoleClaims` 去掉数组臂 | 单测 4 红(涉及数组臂的 4 个形状) |

真库四条的红都不在领取计数行(`:1814`)或守卫行(`:1812`)。

**本轮 NOT RUN**:
- CI(未推送);本修复轮的独立复审。
- 撤销轮真库尾部与其它真库 lane:本轮未改生产代码,只改本用例与两个单测。
- 待办中心真库闸;动态休眠探针(路由未增减)。
- CI 所用的 PostgreSQL 版本(本地 15.17)。

---

## 10. C2:审批人待办列表与 P-6′(ii) 延后

### 10.0 授权与范围(只引 owner 选项原文;我方建议不是授权)

| 项 | owner 选项原文(`goal-four-items-20260928.md` §0,2026-09-29 16:5x 条,AskUserQuestion 选项原文与 §0 记录的选项说明) | 本节落点 |
|---|---|---|
| 16:5x ② | 「**Attendance-side list (Recommended)**」(考勤侧「待我审批的撤销」列表,挂 `attendance:approve`,只列查看者自己的在席席位,席位来源与 actions 路由同一——与 #22 = (i) 一致,不改授予政策;小后端路由 + 前端面板) | §10.1–§10.5(后端部分) |
| 16:5x ① | 「**Defer: weak copy only (Recommended)**」(保持员工面弱版中性文案、code 不变;暂不发管理员通知,作为对 lock:75 的已知缺口记录,待 #5746 与通知通道另定;无新代码) | §10.6(已知缺口,**未满足**) |
| 16:5x ③ | 「**Show the list (Recommended)**」(保持逐条投递列表,outcome_unknown→pending、零尝试的 superseded/skipped 不列出,按设计 MD 记录) | 不变,仍按 §9.4.3;本列表不含投递数据 |

- 只动后端(`packages/core-backend/**`、`plugins/**`)与本文档;**零 DDL**;未碰 `apps/web/**`(前端面板属前端 lane);未改 `plugin-tests.yml`、`vitest.config.ts`、ci-wiring 常量与 s6a pins。
- 合并:见 goal §0 owner 17:1x「Yes, merge under those conditions (Recommended)」及其条件;C2 不涉合并,开关 `ATTENDANCE_CANCEL_ROUND_ENTRY_ENABLED` 保持 OFF。
- 实现模型:Claude Opus 5.5。基于 `84dd4545ec`,不 rebase。

### 10.1 合同 `GET /api/attendance/cancel-rounds/pending`

合同已与并行的前端 lane 约定,字段名不改。

| 项 | 值 |
|---|---|
| 守卫 | `withPermission('attendance:approve')`,即办理路由(§8.3.2)自己的守卫;不改授予政策 |
| 401 | 无用户 ⇒ `{"ok":false,"error":{"code":"UNAUTHORIZED","message":"User ID not found"}}`,与兄弟路由同形 |
| 403 | 无 `attendance:approve` ⇒ 插件既有体,逐字节 `{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}`;**席位持有者同样适用** |
| 200 | `{ ok: true, data: { items, total } }`;有码无席位 ⇒ `{ ok: true, data: { items: [], total: 0 } }`,不是拒绝 |
| 每项 | 恰为九个键:`requestId`、`roundId`、`engineInstanceId`、`requesterUserId`、`requesterName`、`requestType`、`startAt`、`endAt`、`launchedAt`(来源见下表) |
| 排序 / 分页 | `launchedAt` 降序,`roundId` 降序兜底;`page` / `pageSize` 经插件既有 `parsePagination`(默认 50,上限 200),与 `GET /api/attendance/requests` 同一函数;`total` = 全部可列条数。合同只约定 `items` 与 `total`,因此不回显 `page` / `pageSize` |
| 其它错误 | 503 `DB_NOT_READY`(与兄弟路由同);500 `INTERNAL_ERROR`「Failed to list cancellations」。不新造码(P-8) |

| 字段 | 来源 |
|---|---|
| `requestId` | 考勤请求行 `id`(原请假) |
| `roundId` / `engineInstanceId` | `approval_rounds.id` / 该轮自己的引擎实例 |
| `requesterUserId` | 考勤请求行 `user_id`(即发起人,P-1 (b) 仅原 requester) |
| `requesterName` | 目录 `users.name`;取不到(无行、`NULL`、空白)⇒ `null`。理由见 §10.3 |
| `requestType` | 考勤请求行 `request_type`;本入口只收请假,恒为 `leave` |
| `startAt` / `endAt` | 考勤请求行 `requested_in_at` / `requested_out_at`,ISO;为空 ⇒ `null` |
| `launchedAt` | `approval_rounds.started_at`,ISO |

- **合同里没有 `status` 键**。任务字段表列有「状态」,但每一项按构造都是待办:轮次 `outcome = 'pending'`,且查看者此刻能在该轮办理。机器词恒为 V1 `cancellation_pending_approval`(§4)。合同已约定,因此不另加键。
- **不含**:投递数据、其他席位持有人、任何席位 / 节点 / 人名数据(P-6),以及摘要字段。

### 10.2 席位来源与 actions 路由同一(不复制谓词)

办理路由(`POST …/cancel-round/actions`)判一个查看者能否办理,依次经过四道判据。列表逐道对应如下:

| 判据 | 办理路由 | 列表 |
|---|---|---|
| 权限 | `withPermission('attendance:approve')` | 同一守卫 |
| 单据门 | `loadCancelRoundRequestRow`:org 限定,再经 `toCancelRoundRequest`(请假 + 有审批实例) | 同一 `toCancelRoundRequest`;批量读同一 org(`getOrgId(req)`,同一函数)。两处共用这一个映射函数,C2 提交把它从单行加载器里抽出,行为不变 |
| 轮次 | 该单据「最新轮」(有 pending 取 pending) | `outcome = 'pending'` 的撤销轮:每单至多一个(I3,`uq_approval_rounds_pending_document`),且 pending 轮就是「最新轮」的首选 |
| 席位 | 端口以调用者身份、角色声明 `[]` 分发到 `dispatchAction`,其 403 `APPROVAL_ASSIGNMENT_REQUIRED` 闸 = 可决节点上的有效指派 × `assignmentMatchesActor` | `decisionDoorIsSeatGated` + `resolveCanDecideCurrentNode`(`services/approval-seat-authorization.ts`)。输入是该轮引擎实例行与其**有效**指派;`viewerRoles` 用分发时同一个常量 `CANCEL_ROUND_DISPATCH_ROLE_CLAIMS`(今天为空) |
| I7 | 不加(席位是依据,§8.3.2) | 不加 |

- **为什么这两个函数就是「同一来源」**:`resolveCanDecideCurrentNode` 是这道门的判定函数,由门的两个原件组成,即 `assignmentMatchesActor` 与 `decidableNodeKeysForInstance`(门的节点键集合,含并行分支前沿)。已有三处调用它:待办中心的 `actionable`、详情 DTO 的 `canDecideCurrentNode`、`resolveLegacyDecisionSeat`(`routes/approvals.ts`;它也先用 `decisionDoorIsSeatGated` 分出门是否按席位判)。对门不按席位判的行,`resolveCanDecideCurrentNode` 回 `true`(维持现状);但撤销轮办理路由经 `dispatchAction`,后者对无已发布定义的实例直接拒绝,因此列表用 `decisionDoorIsSeatGated &&` 把这类行排除,不列出办理路由会拒的项。它与门的一致性由 `approval-can-decide-current-node.db.test.ts` 钉住(本轮在一次性库亲跑 10/10)。列表只**调用**这两个函数,不重述席位规则。
- **角色声明同源**:端口把分发用的角色声明提成一个导出常量 `CANCEL_ROUND_DISPATCH_ROLE_CLAIMS`(值仍为 `[]`,§8.4 前提不变),分发与列表读同一个常量。以后若改,两边一起变。分发 actor 仍由既有单测 `approval-cancel-round-entry-port-actor-narrowing.test.ts` 逐键钉住。
- **候选收窄不是第二个谓词**:
  - 第一条读只保留这样的 pending 撤销轮:其引擎实例上**有任何一条**指派行(不论是否有效、不论类型)的 `assignee_id` ∈ {查看者} ∪ 分发角色声明。
  - `assignmentMatchesActor` 只可能匹配 `assignee_id` 为这些值之一的行:人臂比 actor id,角色臂比角色声明。所以收窄只是必要条件,不会漏掉谓词会放行的轮次;作用只是让这条读与查看者自己的席位数成正比,而不是扫全部 pending 轮。
  - mutation L-narrow-off(去掉收窄)⇒ 真库 47/47、单测 7/7 全绿,即列出的每一项不变。L-seat(去掉共享谓词、保留收窄)⇒ 红。见 §10.5。
- **不是快照读**:与摘要同理(§3.6)。列表读与之后的办理之间,轮次可能已被他人办理或撤回。办理路由在行锁下按门重新判定,下一次读即收敛。

### 10.3 字段与可见性

- **`requesterName` 取目录名,不读原单**:
  - 任务要求:若显示名需要读原单 I7 以外的数据,就只给 userId。本实现的显示名来自目录 `users.name`(`LEFT JOIN users`),**不读**原单 `requester_snapshot` 或原单任何列。
  - 插件里 `attendance:approve` 持有者本已能读到这些数据:
    - 他人姓名:考勤记录读(`handleAttendanceRecordsGet`,`withPermission('attendance:read')`,查他人时再过 `canAccessOtherUsers` = 考勤管理员或 `attendance:approve`)的 `LEFT JOIN users u … u.name AS user_name`。
    - 请假行本身(类型、起止、`user_id`):`GET /api/attendance/requests/:id` 经 `ensureAttendanceRequestAccess` → `canAccessOtherUsers`。
  - 因此列表不越出该码已有的读面。取不到 ⇒ `null`。
- **不加 I7 的后果(如实记录,不改)**:委托席位还原(锁 §2-G3 第三句读法 (a))的情形下,
  - 委托人 A 坐在撤销轮上,能在列表看到该项并从列表办理(成功体恰 4 键,owner 14:3x ①);
  - A 不是原单参与者,读摘要 `GET …/cancel-round` 仍是 404(I7 挂在原单上)。
  - 这与办理路由一致:席位是依据。列表给了 A 一个办理前的考勤侧入口,并附请假摘要(类型、起止、申请人);阶段 D 验收方案 D2 项预判的正是「A 找不到办理入口」。摘要读面(I7)不变。
- **一单多请求行**:`attendance_requests.approval_instance_id` 无唯一约束。同一原单若对应多行,取 id 最小的一行,与待办中心撤销轮深链的取法相同(`resolveCancelRoundOriginalHrefs`)。每轮只出一项(按 `roundId` 去重)。
- **性能残留**:`attendance_requests.approval_instance_id` 无索引(本切片零 DDL)。批量读是 org 限定下的 `= ANY(...)`,与待办中心深链那条读同形。

### 10.4 接线与守卫(与路由同一提交)

- **端口**:第六个方法 `listSeatedPendingRounds`。
  - 插件在六个方法齐全时才注册全部五条撤销轮路由,缺一个就一条都不注册(fail-closed 不变)。
  - 端口作用域单测改为断言六个方法。
  - UUID 单测 harness 的端口桩补上第六个方法。去掉该桩(harness 回到提交前版本)⇒ 1 红,四条撤销轮路由不注册。
- **动态休眠探针(登记项 L-4)**:新路径含 `cancel-round` token,所以与路由同一提交把白名单扩到**恰好五条** (method, path)。
  - 实跑:注册 1159、打出 963;命中 token 的 5 条全在白名单;白名单外 0、缺失 0;创建路径到达 0,PASS。
  - 正控 `self`:到达 1,PASS。
  - 负控:白名单删去新路由 ⇒ 退出码 2。
- **静态普查**(`createCancelRoundInstance` 恰一个点名调用方)不变:列表只读席位、轮次与请求行,不到达创建路径。普查单测仍绿。
- **CI 接线**:
  - 真库用例都在已接线的 `approval-cancel-round-attendance-entry.db.test.ts` 里,无需改 `plugin-tests.yml`、`vitest.config.ts` exclude、ci-wiring 常量与 s6a pins。
  - 新单测 `approval-cancel-round-entry-port-pending-list.test.ts` 由默认配置收集。
  - coverage-enumeration 与 cancel-round ci-wiring 仍绿;`sealed-export-package-provenance.test.cjs` OK。

### 10.5 测试矩阵与读数(本地真库 + 真 HTTP)

**环境**:
- 一次性库 `ms2_g4c2list_20260929`,`createdb -O ms2testbed`,非超级角色;每次运行前断言 `current_database()`。
- `DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它;approval real-DB step 只用 `DATABASE_URL`。
- 迁移用 `tsx src/db/migrate.ts` + CI 的 `MIGRATION_EXCLUDE`,EXIT 0,419 条。
- PostgreSQL 15.17、Node 20.20.2;工具直调 `node_modules/.bin/*`,未经 pnpm。
- 每条列表用例都用**专属审批人**:只有本用例给他们落座,因此断言可以逐项精确。

| 用例 | 判据 | 读数 |
|---|---|---|
| 守卫 | 员工(仅 `attendance_employee`)⇒ 403 逐字节;**席位持有者**无 `attendance:approve` ⇒ 403 逐字节;有码无席位 ⇒ 200 空列表(逐键 `toEqual`),且办理路由对该人同一轮 ⇒ 403 `APPROVAL_ASSIGNMENT_REQUIRED`;给席位持有者补授 `attendance_approver` 后 ⇒ 列出该轮 | 绿 |
| 有席位审批人 | 两轮(两位员工):`data` 键集恰 `items`/`total`;每项键集恰九个;两项逐键相等(含 `requesterName: null`、`startAt/endAt: null` 与带时间的一项;`launchedAt` 等于库内 `started_at`);新发起的在前;`?pageSize=1` 与 `?page=2&pageSize=1` 各得一项、`total` 仍 2;对 B 轮 reject(带意见)⇒ 200 恰 4 键 `rejected`,列表只剩 A;对 A 轮 approve ⇒ 200 恰 4 键 `applied`,列表为空 | 绿 |
| 会签(`approvalMode: 'all'`,两席) | 撤销轮有效席位 = {P1, P2};两人各列出该轮;P1 approve ⇒ 200 恰 4 键 `pending`;此时轮次仍 `pending`,P1 的指派行仍在但 `is_active = false`;P1 列表为空,P1 再 approve ⇒ 403 `APPROVAL_ASSIGNMENT_REQUIRED`(列表与门一致);P2 仍列出;P2 reject ⇒ 列表为空 | 绿 |
| 委托席位还原 | 原单席位 = D(`delegatedFrom` A),D 批准原单;员工发起 ⇒ 撤销轮有效席位 = A;A 列出,D 列表为空;D 办理 ⇒ 403 `APPROVAL_ASSIGNMENT_REQUIRED`;A 读摘要 ⇒ 404 与不存在同形(记录,不改);A 从列表项经办理路由 approve ⇒ 200 恰 4 键 `applied`,之后 A 列表为空 | 绿 |
| 单据门 + 开关 | 同一审批人两轮;其中一轮的请求行移到别的 org ⇒ 不再列出,`total` 1,办理路由对它 ⇒ 404 与不存在同形;删除开关(OFF)⇒ 已存在轮次仍列出;`finally` 恢复开关 | 绿 |

**单测(新,7 条)** `approval-cancel-round-entry-port-pending-list.test.ts`,覆盖真库在撤销轮上造不出的形状:
- 分发角色声明为空,候选读的参数恰为 `[查看者, ...该常量]`;
- 正控:当前节点的有效人席位 ⇒ 列出,并映射回原单;
- 角色席位 ⇒ 不列出,即使角色 id 与查看者 id 相同,因为分发不带角色声明;
- 席位在实例未停留的节点上、或引擎实例非 pending ⇒ 不列出;
- 并行区内:未完成分支前沿上的席位 ⇒ 列出;已完成分支上的席位 ⇒ 不列出;
- 门不按席位判的实例(无已发布定义 / 非 platform)⇒ 不列出;
- 空白查看者 ⇒ 零查询。

**逐提交读数**:

| 提交 | 内容 | 读数 |
|---|---|---|
| `01d2faae81` | 端口第六方法 + 共享常量 + 单测 | 未提交的插件 / 探针 / 用例改动先移开,即工作树等于该提交:tsc EXIT 0;端口相关 8 个单测文件 165/165;真库整文件(旧用例)42/42 |
| `cafc52ffb8` | 插件路由 + 映射抽取 + 探针白名单 + harness 桩 | 7 个单测文件 524/524(UUID 路由、插件镜像常量、插件角色声明、ci-wiring、coverage-enumeration、休眠普查、端口作用域);真库整文件(旧用例)42/42;探针 self / none PASS、负控退出码 2;s6a OK |
| `3572cc55fc` | 5 条真库用例 | 见下表 |

| 运行 | 读数 |
|---|---|
| 本套件(`EXPECT_DB=1`,两条 URL) | **47/47**(原 42 + C2 5) |
| CI 形(`env -i`,仅 `DATABASE_URL`) | 46 通过 / 1 跳过(EXPECT_DB 哨兵) |
| CI 相邻同序:seed-template-visibility → attendance-entry → template-groups-lifecycle | 87/87 |
| 撤销轮真库尾部(CI 同序)上半:lock-order-census / creation / redemption | 129/129 |
| 下半:seat-guards / attendance-fk-migration / outlet-guards / node-timeout-effect,另加 `approval-can-decide-current-node` | 36/36 |
| `approval-org-writer-w4-s1`(被插件改动触发;其 `run` 行的文件原样) | 15/15 |
| 单测 `tests/unit/approval*.test.ts`(94 文件) | 1763/1763 |
| 单测 `tests/unit/attendance*.test.ts`(96 文件) | 1752/1752 |
| 守卫类单测 5 文件:web-lane manifest 守卫、待办注册表、待办实时、coverage-enumeration、cancel-round ci-wiring | 422/422 |
| `tsc --noEmit -p tsconfig.json`(core-backend) | EXIT 0 |
| 新单测与改动的真库用例的类型检查(临时 tsconfig,继承 core-backend 配置,用后删除;CI 不对测试文件做类型检查) | 0 错误 |
| s6a `sealed-export-package-provenance.test.cjs` | OK(本切片未触碰任何被钉文件) |

**mutation**:
- 每条的步骤:cp 备份 → 精确替换(每处恰匹配一次)→ 核与备份的 numstat → 跑**整个文件** → cp 还原 → `cmp` 逐字节 → `git status` 与改前相同。
- 真库行号按 `3572cc55fc` 的用例文件。

| # | 手术 | numstat | 读数 |
|---|---|---|---|
| L-seat | 端口列表 `if (!canDecide) continue` → `if (false && !canDecide) continue`(去掉共享席位谓词,保留收窄) | 1 1 | 真库 2 次各 1 红,均在 `:2390`(会签 P1 办理后仍列出);单测 4 红(角色席位、非当前节点 / 非 pending、已完成分支、非 seat-gated) |
| L-seat-all | 同上,另把收窄改为 `OR TRUE` | 2 2 | 真库 5 红,五条用例各一:`:2252` 无席位持有者非空、`:2292`、`:2370`、`:2432`、`:2469` |
| L-narrow-off | 只把收窄改为 `OR TRUE` | 1 1 | 真库 47/47、单测 7/7 **全绿**,即收窄不承重 |
| L-gated | `decisionDoorIsSeatGated(instance)` → `true` | 1 1 | 单测 1 红(非 seat-gated 实例被列出);真库造不出(撤销轮恒有已发布定义) |
| L-perm | 列表路由的 `withPermission('attendance:approve', …)` 换成直通包装 | 1 1 | 真库 2 次各 1 红,均在 `:2243`(员工得 200) |
| L-org | 批量读去掉 `ar.org_id = $1` | 1 1 | 真库 1 红 `:2477`(移到他 org 的轮次仍列出) |
| P-list | 探针白名单删去新路由 | — | 退出码 2 |
| H-stub | UUID 单测 harness 回到提交前版本(无第六方法桩) | — | 1 红(四条撤销轮路由不注册) |

### 10.6 P-6′(ii) 管理员通知 —— 延后(对 lock:75 的已知缺口,未满足)

- **owner 2026-09-29 16:5x ① 原文**:「**Defer: weak copy only (Recommended)**」,§0 记录的选项说明:保持员工面弱版中性文案、code 不变;暂不发管理员通知,作为对 lock:75 的已知缺口记录,待 #5746 与通知通道另定;无新代码。
- **现状**:
  - 员工面弱版中性文案在位:两个席位类码(`CANCEL_ROUND_SEAT_INELIGIBLE`、`CANCEL_ROUND_NO_ELIGIBLE_APPROVER`)回不声称原因的中性句,code 不变(§2.2、§9.6)。
  - **管理员通知没有发**,本分支无任何发送代码。
- **已知缺口**:
  - owner 选项说明所称「对 lock:75 的已知缺口」,指 P-6′(ii) 的管理员通知今天**未满足**。owner 此前在 #28 / Q7 选的是「(ii) Reuse approval notices (Recommended)」,选项说明原文为 “Send the existing approval notification to the admin resolved by A0 `process`; ratify §15.6.1 ③ (ii) shape; weaker employee-facing copy until RC (c) lands”。
  - 原因见 §9.6:A0 解析器在 PR #5746,未合并,且其处置不在授权内;main 上也没有可按单据寻址到管理员的既有审批通知出口。
  - 去处:待 #5746 与通知通道另定。本文**不**把它写成已满足。
- **与 C2 的关系**:C2 列表面向**坐在轮次上的审批人**,不是通知,也不面向管理员,不改变这一缺口。席位类码拒绝发生在发起时,那时轮次根本不存在,列表里也就不会有这类项。

### 10.7 残留与 NOT RUN

1. **前端面板**不在本分支(前端 lane)。合同见 §10.1,字段名已与前端 lane 约定。
2. **待办中心仍挂 `approvals:read`**(§9.9 第 4 项),本切片不改。C2 给只持 `attendance_approver` 的审批人提供了考勤侧入口,不依赖该码。
3. **一单多请求行**的取法与**无索引**的批量读(§10.3)。
4. **列表不是快照读**(§10.2):办理时由门在行锁下重判。
5. **NOT RUN**:
   - CI(未推送);CI 所用的 PostgreSQL 16(本地 15.17)。
   - C2 的独立门审;阶段 D 验收。
   - 待办中心真库闸(本切片未改共享待办查询,未被触发)。
   - `attendance-web-guard.yml`(只跑 `apps/web` 的 spec,属前端 lane)。
   - 默认配置全量单测;被 `packages/core-backend/**` 宽匹配触发的其余 lane。
   - 真实钉钉发送。
6. **测试残留**:
   - 同 §8.8 第 7 项。C2 用例写入的 `approval_delegations` 行在 `afterAll` 显式删除,运行后库内 0 行;轮次、实例、请求、用户与角色随既有清理删除。
   - 动态探针对全部路由打请求,会在一次性库留下探针数据,随库 drop。
