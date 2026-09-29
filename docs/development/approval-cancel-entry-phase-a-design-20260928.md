# 请假撤销 —— 产品入口 阶段 A(只后端)设计与验证记录 —— **草稿**

| 项 | 值 |
|---|---|
| 状态 | 草稿(实现 + 本地真库验证已完成;未推送、未开 PR、未经门审、**合并未被授权**) |
| 分支 | `feat/approval-cancel-entry-phase-a-read-launch` |
| 基线 | `main @ 68a703038e`(撤销轮 C-1 #5851 `44770107f`、C-2 #5856 `2594ca6e2` 已在其中) |
| 权威锁 | 撤销锁 v5.9(RATIFIED 2026-09-18)及其抬头「**RATIFY 追记 —— 产品入口增补 v2(P-1…P-11)**」(2026-09-28) |
| DDL | **零**(未新增、未修改任何迁移) |
| 实现模型 | Claude Opus 5.5(Fable 回退) |

---

## 0. 范围

**本阶段做的**(全部在后端):

1. `GET /api/attendance/requests/:id/cancel-round` —— 撤销轮摘要(P-4,承载 P-3 (iii) 的返还结果)。
2. `POST /api/attendance/requests/:id/cancel-round` —— 发起撤销轮(P-1)。
3. 两个端点背后的宿主→插件端口 `approvalCancelRoundEntry`(只注入 plugin-attendance)。
4. 接线日守卫升级(登记项 L-4,见 §3.6)与 CI 接线。

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
**授权边界**:撤销入口切片的交付 = 分支 + 测试 + PR;**这些 PR 的合并未被点名,完成后单独请示**。登记项 L-1…L-6 **未 ratify**;L-4 在本阶段按任务要求落地(§3.6),不作为 ratify 条款引用。

---

## 2. 端点合同

### 2.1 `GET /api/attendance/requests/:id/cancel-round`

- 守卫:`withPermission('attendance:read')`(插件既有守卫,读 `user_roles` / `user_permissions`)。
- `:id` = 考勤请求 id(UUID;非法 ⇒ 400 `VALIDATION_ERROR`「id must be a UUID」,与兄弟路由同形)。
- 可见谓词:见 §3.1。不可见 ⇒ **404,与不存在的 id 逐字节同形**:`{"ok":false,"error":{"code":"NOT_FOUND","message":"Request not found"}}`。
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
- **超出 P-4 字段表的两项**(均由 P-2 推出,点名而非默默加):`status`(P-2「每一个用户可见状态必须带主语」的机器形态)与 `closeReason`(P-2「该判据必须到达前端」:锁 lock:131 的专用 reason)。
- **不进 DTO**:`policy_snapshot_at_create/_at_decision`(P-4)、任何席位 / 审批人数据(P-6)、`cancelRoundBlockDetail`(P-7)。
- 量纲:`reversed` / `unrecoverableExpired` 为**分钟**(与 C-2 既有测试钉住的生产者一致;FE 呈现用 `formatLeaveBalanceMinutes` 属阶段 B)。

### 2.2 `POST /api/attendance/requests/:id/cancel-round`

- 守卫:`withPermission('attendance:write')`。
- 请求体:`{ "reason"?: string (≤2000) | null }`;非法 ⇒ 400 `VALIDATION_ERROR`(插件 `validationErrorBody` 同形)。
- 顺序与响应:

| # | 判据 | 不满足时 |
|---|---|---|
| 0 | UUID / 可见谓词(§3.1) | 400 / **404 与不存在同形** |
| 1 | P-1 (a) `attendance_requests.status === 'approved'` | 409 `CANCEL_ROUND_DOCUMENT_NOT_APPROVED` |
| 2 | P-1 (b) 当前用户 = 该请假的 `user_id`(lock:157 仅原 requester) | 403 `CANCEL_ROUND_REQUESTER_ONLY` |
| 3 | P-1 (c) 无在途轮(I3) | 409 `CANCEL_ROUND_ALREADY_PENDING` |
| 4 | 专用创建路径 `createCancelRoundInstance` 在原实例行锁下复核(404 / NOT_APPROVED / REQUESTER_ONLY / SUITE_UNKNOWN / WINDOW_OUT_OF_RANGE / SUITE_FORBIDDEN / ALREADY_PENDING / SEAT_INELIGIBLE / NO_ELIGIBLE_APPROVER / CREATE_FAILED) | 原样透传 `(status, code, message)`,**丢弃 `details`** |
| — | 成功 | **201**,`data` 与 GET 同形(含新轮) |

- 1–3 的 message 与创建路径同码的 message 逐字相同。
- 发起**只**经 `ApprovalProductService.createCancelRoundInstance`(锁 §14.1 专用路径);**不**经公开 `createApproval`。本路由不写 `attendance_requests`,因而与迁移 `zzzz20260918110000` 的 `approval_workflow_key <> 'approval.cancel-round'` CHECK 无交集。
- 其它异常:500 `{"ok":false,"error":{"code":"INTERNAL_ERROR","message":"Failed to start cancellation"}}`(插件既有通用形状);表缺失 503 `DB_NOT_READY`(同兄弟路由)。

### 2.3 错误码(P-8)

本阶段用到的码**全部**已在 `ApprovalProductService.ts` / `ApprovalBridgeService.ts` 登记(C-1/C-2 已合入 main):`CANCEL_ROUND_DOCUMENT_NOT_APPROVED`、`CANCEL_ROUND_REQUESTER_ONLY`、`CANCEL_ROUND_SUITE_FORBIDDEN`、`CANCEL_ROUND_ALREADY_PENDING`、`CANCEL_ROUND_NO_ELIGIBLE_APPROVER`、`CANCEL_ROUND_SEAT_INELIGIBLE`、`CANCEL_ROUND_SUITE_UNKNOWN`、`CANCEL_ROUND_WINDOW_OUT_OF_RANGE`、`CANCEL_ROUND_CREATE_FAILED`(①类,创建期);`CANCEL_ROUND_OUTLET_FORBIDDEN` 与 ③类可重试码不在发起 / 读路径上出现。**零新码**:端口缺失时不注册路由(§3.4),因此也没有「端口不可用」码。

---

## 3. 谓词与守卫

### 3.1 可见谓词 = I7,挂原单实例

`SELECT … FROM attendance_requests WHERE id = $1 AND org_id = $2`(org 解析与兄弟路由 `GET /api/attendance/requests/:id` 同一函数)→ 取 `approval_instance_id` → `canReadApprovalInstance(pool, viewer, 原实例 id)`(`services/approval-instance-readability.ts`,五臂:requester / 席位 / 历史 actor / 抄送 / DB 管理员)。**不自造「已到达」谓词**(lock:153)。

三种情形同一 404 体:id 不存在;请求无 `approval_instance_id`(I7 无对象可判);viewer 不满足 I7。本端点按 P-4「非参与者 404」,不可见与不存在逐字节同形。

### 3.2 发起前置在两层各判一次

路由层用**考勤请求行**判 P-1 (a)(b)(c);创建路径用**原审批实例**在 `FOR UPDATE` 下复核(实例 `status`、`requester_snapshot.id`、套件闸、在途轮、席位资格)。两层数据不同,各有独占的反例:
- 仅路由层能拒:请求行未批准而实例已批准;请假 `user_id` ≠ 实例 `requester_snapshot.id`(代理提交:代提交人是实例 requester,但不是请假本人 —— lock:157「代理发起另案」)。
- 仅创建路径能拒:套件 / 窗口 / 席位资格 / 并发下的 I3。

### 3.3 `canWithdraw` 在服务端解析

读与引擎撤回分支**相同的输入、相同的顺序**:已发布定义 `runtime_graph.policy.allowRevoke / revokeBeforeNodeKeys`、撤销轮实例 `requester_snapshot.id` / `status` / `current_node_key`、当前节点已处理记录数。给出的否定原因即引擎会回的码。测试双向钉住(§5 T-WD)。

### 3.4 端口与最小特权

- `PluginServices.approvalCancelRoundEntry`:`canReadDocument` / `readRoundSummary` / `launch` 三个方法;`src/index.ts` 只对 `plugin-attendance` 注入(与 `approvalAssigneeResolver` 同姿态),其它插件得 `undefined`。
- 插件在激活时检查端口三方法齐全才注册两个路由;缺失 ⇒ 不注册(无入口,而不是半接线)。
- 插件从不 import core,也不拼写创建方法名。

### 3.5 结果投影:一个投影器,三个读面

`cancellationOutcome` / `closeReason` 只经 `readCancelRoundDurableProjectionV1`(C-2 已有的逐键白名单投影器,两个 `getApproval` 实现同用)读出,本端口不写自己的 SQL。

### 3.6 接线日守卫(登记项 L-4,与调用方同提交)

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

**环境**:一次性库 `ms2_g4cancela_r2_20260929`(owner `ms2testbed`,非超级;`select current_database()` 每次运行前断言);`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它;迁移用仓内入口 `tsx src/db/migrate.ts`(EXIT 0);本机 PostgreSQL 15.17;工具直接调用 `node_modules/.bin/*`,未经 pnpm。

**新套件** `tests/integration/approval-cancel-round-attendance-entry.db.test.ts`:**20/20 通过**(含 EXPECT_DB 哨兵)。服务端 `pluginDirs=[plugins/plugin-attendance]`,`RBAC_BYPASS='false'` 设置并断言;员工面令牌一律经**真实登录路由**签发;唯一替身是 C-1 考勤取消执行提供方(经生产注册表保存/恢复),用于确定性地产生三值分类。运行后库内零残留(用户 / 角色 / 请求 / 实例 / 轮次计数均为 0)。

| 用例 | 判据 | 读数 |
|---|---|---|
| harness | 授权真开;路由已注册(未知 id 404 体、非法 id 400) | 绿 |
| T-P10 员工 | 仅 `attendance_employee` 的真令牌;同令牌 `GET /api/approvals/:id` = 403 `{"error":"Insufficient permissions"}`;读 200(round null)→ 发起 201 → 读 200 同轮;重复发起 409 ALREADY_PENDING,轮数仍 1 | 绿 |
| T-P3 ×3 | `cancelled` / `cancelled_with_unrecoverable_expired` / `cancelled_reversal_unreported`(显式 `"reversal":null`);各读两次逐字节相同(刷新后仍可查);与 `GET /api/approvals/<轮实例>` 的 `cancellationOutcome` 深等 | 3 绿 |
| T-V3 | 审批人驳回 ⇒ `cancellation_rejected`、`closedBySystem=false`;同单可再发起(撤销不限次) | 绿 |
| T-V5 | 锚点老化 200 天 ⇒ `cancellation_window_closed`、`closedBySystem=true`、`closeReason=round_expired` | 绿 |
| T-V6 | 业务拒绝 ⇒ `cancellation_blocked`、`blockCode` 为裸码;响应不含适配器自由文本 | 绿 |
| T-WD | `canWithdraw` 与引擎撤回分支双向一致:管理员视角 false / `APPROVAL_REVOKE_FORBIDDEN` ⇒ 引擎撤回同码 403;请求人 true ⇒ 引擎撤回成功 ⇒ `cancellation_withdrawn` | 绿 |
| T-I7 | 外人 GET/POST 与不存在 id 逐字节同形 404;本人但无审批实例的请求 404 同形 | 绿 |
| T-P1b 参与者 | 审批人可读(200,round null)、发起 403 REQUESTER_ONLY,零轮次 | 绿 |
| T-P1b 代理 | 代提交人发起 403 REQUESTER_ONLY(**仅路由层能拒的夹具**);请假本人读 404(I7 后果) | 绿 |
| T-P1a | 请求行 `pending`(实例已批准)⇒ 409 NOT_APPROVED,零轮次 | 绿 |
| T-P8 | SUITE_FORBIDDEN 409、SEAT_INELIGIBLE 409 只含 `{code,message}`,不含 `details` 与审批人 id | 绿 |
| T-P10 管理员正控 | 管理员真令牌:本人假读 200 → 发起 201 → 读 200;他人单读 200(I7 管理员臂)、发起 403 | 绿 |
| T-P10 (c) | 仅 `attendance:read`(角色承载 + 考勤命名空间准入)的真令牌:读 200、发起 = 插件守卫 403 逐字节 `{"ok":false,"error":{"code":"FORBIDDEN","message":"Insufficient permissions"}}`,零轮次;无 `attendance:read` 的主体读同形 403;二者角色集合与夹具写入一致 | 绿 |
| P-9 腿 A | 管理员 HTTP:不带申请人选择 ⇒ 422 `APPROVAL_REQUESTER_CHOICE_REQUIRED`;带上 ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`(事务内 DB 可见性);零实例、零轮次 | 绿 |
| P-9 腿 B | 员工 HTTP ⇒ 403 `{"error":"Insufficient permissions"}`(`rbacGuard('approvals','write')`,在模板查找之前) | 绿 |
| P-9 腿 C | 普通 actor 进程内 `createApproval` ⇒ 404 `APPROVAL_TEMPLATE_NOT_FOUND`,与不存在模板同码;零实例、零轮次 | 绿 |

**mutation(每次测后还原,`git diff` 为空)**:

| mutation | 读数 |
|---|---|
| M1 去掉投影(`cancellationOutcome` 恒 null) | **3 failed / 17 passed**(T-P3 三条) |
| M2 去掉路由层 requester 检查 | **1 failed / 19 passed**(代理夹具得 201) |
| M3 去掉 POST 的 `withPermission` | **1 failed / 19 passed**(无写权主体得 201 而非 403) |

**回归与守卫**:

| 项 | 读数 |
|---|---|
| `tsc --noEmit`(core-backend) | 0 |
| 静态普查 dormancy-unreachable | 18/18(升级前版本对新代码 2 红) |
| `attendance-uuid-validation-routes`(新增两条路由键) | 101/101 |
| `approval-cancel-round-ci-wiring` / `approval-ci-coverage-enumeration` / `required-web-lane-token-manifest-guard` | 6/6、369/369、29/29 |
| `attendance-advanced-scheduling-scope` / `attendance-import-permission` / `approval-cancel-round-plugin-mirror-constant` | 7/7、4/4、9/9 |
| 读 `plugin-tests.yml` 的 `scripts/ops/*.test.mjs`(48 文件,排除三个打包类) | 981/981 |
| `sealed-export-package-provenance.test.cjs` | OK |
| s6a 全量 66 键重算 diff | 仅 `pluginTestsWorkflow` 变化 |
| 既有真库:seed-template-visibility + outlet-guards + seat-guards / redemption / creation | 17/17、36/36、66/66 |
| 动态探针(真服务端,1156 条路由、打 960 条) | PASS:白名单外 0、缺失 0、到达 0;正控 self 到达 1 |

---

## 6. 残留与 NOT RUN

0. **⚠️ 合并 / 部署顺序风险(请 owner 裁决;本 PR 不得被描述为「休眠」或「无行为变化」)**。本阶段让 C-1/C-2 的撤销轮在 API 面**可达**,且**无开关**:合入并部署后,持 `attendance:write` 的员工(在 platform / attendance 产品模式下,`attendance_employee` 是自助注册默认授予的角色)即可发起撤销轮,创建路径照常入队审批任务创建事件。而撤销轮的**审批人动作**与**请求人撤回**今天走的是:
   - 本仓 HTTP 审批动作路由 `POST /api/approvals/:id/actions`、legacy `POST /api/approvals/:id/approve` / `reject`、`POST /api/approval-card-deliveries/:deliveryId/actions` —— 均挂 `rbacGuard('approvals','act')`,本仓迁移目录**无** `approvals:act` 行 ⇒ 非管理员无产品路径可获该码(管理员经 admin bypass 可操作);
   - 唯一不经该闸的审批人通道是钉钉 Stream 互动卡片回调(`integrations/dingtalk/interactive-card-callback.ts` → `ApprovalCardDeliveryAction`),以钉钉卡片投递已配置为前提;**撤销轮任务是否会产生卡片,本阶段 UNVERIFIED**。
   后果:在上述条件下轮次可能长期停在 `pending`,并按 I3 阻止同单再次发起。另 P-8 条款写明「入口不得在登记完成前上线」(码 + 用户文案 + FE 钉点属阶段 B)。**建议**(不是授权):阶段 A 不先于审批人 / 撤回通道与阶段 B 合并或部署;或由 owner 指定顺序 / 加开关。
1. **P-3 三个读面**:`/history` 与两个 `getApproval` 的 `cancellationOutcome` 投影已随 #5856 在 main;本阶段按 owner 所选 (iii) 再加摘要端点。P-3 条款写「不得同批」,本 PR 只加 (iii),字面成立;摘要端点复用同一投影器且有一致性用例。**请 owner 知悉:同一事实现有三个读面、一个投影规则**;员工只能到达 (iii)(P-10)。
2. **员工撤回本轮无考勤侧端点**:`canWithdraw` 已服务端给出,但撤回动作在审批侧 `approvals:act` 闸后(见 0);阶段 B 需考勤侧撤回端点或另行裁决。
3. **代理提交的请假**:请假本人不是原实例参与者时,摘要对其 404、发起不可达(I7 与 lock:157 的直接后果)。
4. **无审批实例的考勤请求**:返回与不存在同形的 404,不另给码。
5. **「无写权」主体的测试构造**:夹具角色承载授予 + 考勤命名空间准入(见私有记录)。
6. **测试夹具在共享库留下目录行**:共享帮助函数为创建原单插入 `approvals:write` 目录行(与 redemption 套件同一既有做法);本套件删除自己的授予行,但不删目录行。
7. **L-4 不是 ratify 条款**:按任务要求落地;静态普查与探针的新形状待门审确认。
8. **NOT RUN**:前端(阶段 B);P-5 投递状态、P-11(阶段 C);P-6′ 管理员通知(阶段 B);经新路由到真实 W4 边界的端到端(本套件用提供方替身;真实边界端到端由 redemption 套件覆盖,本次重跑 36/36);撤销轮任务的钉钉卡片投递;CI(未推送);`attendance-plugin.test.ts` 全量、lock-order-census / fk-migration / node-timeout 三个真库套件未重跑;CI 所用 PostgreSQL 版本未在本地复现(本地 15.17);独立对抗门审未做。
