# 审批撤销 phase 2(C-2 + 白名单投影)搬到 r9 — 设计(2026-09-25)

**状态:候选(CANDIDATE)。** 私有分支、零 PR;不合并、不 undraft、不 ratify、不应用迁移到任何共享库;不改任何路由的权限守卫或挂载、不改权限目录或 access-presets、不写任何授予。措辞中性:只写机制、裁决与腿,不写可复用的构造步骤;安全机理只在 `reviews/` 私有记录。

## 1. 形状

| 项 | 值 |
|---|---|
| 新分支 | `feat/approval-cancel-round-phase2-on-r9` |
| 建在 | `feat/approval-cancel-round-phase1-r9` 头 `d8e08ac16f258a479588ed8b47b6786ba55387a5`(r9 = r8 + reading-(a) + 第 5 轮 P2-1/P2-2/P3,见同分支 `approval-cancel-stack-r9-design-20260925.md`)|
| 源 | `feat/approval-cancel-round-phase2-history-projection` 相对旧 C-1 头 `b8b71539a6a89e51331e2e4874f994498df15c55` 的全部提交 `b8b71539a..65c1d2cdb`(81 个、零 merge);其中 `7660dcdce` / `616049b71` / `458072454` / `7d27310e0` / `65c1d2cdb` 是白名单投影候选,已过两轮门审(r2 = 0 P1 / 0 P2)|
| 做法 | **(a) 按源顺序逐提交 `git cherry-pick -x`**(与 L-A 的 r9 做法一致),每个提交说明末尾带 `(cherry picked from commit …)`;不按功能重组成新提交,作者归属原样保留(按 owner §3-31 (b),重签在合并窗口做,本分支不改写作者)。提交只用 `-c user.name=zensgit -c user.email=77236085+zensgit@users.noreply.github.com`,所以 committer 全部是 noreply |
| 冲突 | **零**。81 个提交全部干净落下,没有一个提交需要手工解;因此没有「r9 语义 vs C-2 语义二选一」的情形,也没有待 owner 的语义问题(见 §3)|
| 本分支自己的新提交 | 1 个:两条 r9 × phase-2 交互腿(追加到已在 CI run-list 里的 `approval-cancel-round-redemption.db.test.ts`)+ 本设计 / 验证 MD |

源分支、`feat/approval-cancel-round-phase2`、r9、`origin/main` 一律只读,未 force-push 任何既有分支。

## 2. 与 r9 的「差异的差异」

对比 `git diff b8b71539a 65c1d2cdb`(源)与 `git diff d8e08ac16 <新头>`(重放)——18 个文件逐文件、逐块:

- **内容层零差异**:18 个文件的两份 diff 去掉 `index` 与 `@@` 行后逐字节相同;81 对提交的 `git patch-id --stable` 全部相同(81/81)。
- **行号漂移**(只有 `@@` 头不同)出现在 4 个 r9 也改过的文件上:`packages/core-backend/src/index.ts`(1 块,+45 行)、`packages/core-backend/src/services/ApprovalProductService.ts`(13 块,+74 … +528 行)、`plugins/plugin-attendance/index.cjs`(5 块,+58 行)、`docs/development/approval-cancel-round-phase1-design-20260918.md`(0 块漂移:C-2 的那一块落在 r9 追加的 §3.5 之前)。其余 14 个文件 r9 未动,行号也逐字相同。
- 逐块清单与漂移原因见验证 MD §2;r9 的改动一处未回退(`git diff --stat b8b71539a d8e08ac16` 的 397 个文件在新头上全部保留)。

## 3. 语义差:C-2 各块调用到的 C-1 侧函数,在 `b8b71539a..d8e08ac16` 之间变了什么

| C-2 调用到的 C-1 侧函数 / 文件 | r9 相对 `b8b71539a` 的改动 | C-2 对它的假设是否仍成立 |
|---|---|---|
| **席位推导** `ApprovalProductService.createCancelRoundInstance`(`:8617-9366`)| **改**(+466/−12):reading-(a) 把席位从「approve 审计行的 actor」改为「该行 actor 所占席位的原审批主体」(`node_actor_user_seats` / `node_actor_role_seat_count` / `delegated_seat_nodes` / `instance_delegators` 四个子查询);无法归属者进 `unseatable` 走同一处 `CANCEL_ROUND_SEAT_INELIGIBLE` 出口;P2-1 加 `nodesSkippedByJump`(只读 `action='jump'` 且 `adminJump` / `timeoutEffect` 的审计行)豁免结算合取。**席位写入方式未变**:仍经 `requesterChoices[cancel_approval] = approverIds` → `ApprovalAssigneeResolver` 的 `requester_choice` 臂 → `pushResolved('user', …)` | **成立**。C-2 只在该函数内部加 2 行注释(单一 `deriveCancelRoundRoundPolicy` 派生),不依赖席位是谁;C-2 的 `redeemCancelRoundInTxn` / `evaluateCancelRoundFinalInLock` / `closeCancelRoundSystemTerminalInTxn` 都是追加在该函数之后的新方法,读的是 `approval_rounds` 与实例,不读席位来源。席位仍是 user 臂(§6 D-4(a))|
| **席位资格重验** `assertCancelRoundSeatsEligibleInTxn`(`:556-625`)| **改**(+47/−30):多一个 `unseatable` 参数(默认空),`approverIds.length === 0` 不再早返回;错误信息按原因类分两句 | **成立**。C-2 不调用它;C-2 的 redemption 夹具走 `createCancelRoundInstance` 进程内调用,资格重验对 C-2 的输入(全部由 dev-token 铸出并有 `users` 行的审批人)行为不变(创建件 64/64、redemption 34/34 在新头上绿)|
| **策略 / 窗口推导** `deriveCancelRoundRoundPolicy`(`:383-418`)| **未变**(函数体逐字相同;r9 的相邻 hunk 从 `:443` 起,在它之后)| 成立 |
| **撤销结算** `dispatchAction`(`:10724-12505`)、`getApproval`(`:12587-12679`)、`insertApprovalRecord`、`deactivateAllActiveAssignments`、`assertCancelRoundActionAllowed`、`adminJump`、`applyNodeTimeoutEffect` | **未变**(函数体逐字相同,只有行号位移)| 成立。C-2 在 `dispatchAction` 内插入的 判据 II / IV 块、在 `getApproval` 末尾插入的投影块,上下文行在 b8b7 与 r9 上逐字相同 |
| **返还 / 冲正 helper** `plugins/plugin-attendance/index.cjs` 的 `reverseLeaveBalanceDeduction`、取消适配器 `prepareRequestCancel` / `executeRequestCancel` | **未变**(三个函数体逐字相同;r9 在该文件的 17 个 hunk 全在考勤组管理 `userManagesAttendanceGroup` / `assertAttendanceGroupInActorOrg` / `withAttendanceGroupMemberAccess` 与薪资周期导出区,与 C-2 的 6 个 hunk 不相交)| 成立 |
| **W4 边界 / 端口** `attendance/w4c3b-request-operation-boundary.ts`、`attendance/w4c3b-central-approval-hooks.ts`、`core/attendance-cancellation-execution-port.ts` | **未变**(r9 零改动)| 成立 |
| **读面** `routes/approval-history.ts`、`services/ApprovalBridgeService.ts`、`services/approval-bridge-types.ts`、`services/approval-instance-readability.ts`、`rbac/rbac.ts`、`ApprovalAssigneeResolver.ts` | **未变**(r9 零改动)| 成立 |
| **种子模板可见性** `db/seeds/approval-cancel-round-published-definition.ts` 及其迁移 `db/migrations/zzzz20260918100000_seed_approval_cancel_round_published_definition.ts`(round 2 补记,门审 NIT-3)| **改**(seed 模块 +64;seed 迁移 +21/−2:`INSERT … approval_templates` 显式写 `visibility_scope` 列,`verifySeedRowsMatchExpected` 回读该列并按 `canonicalJson` 做幂等核对;逐块与原因见验证 MD §3):`CANCEL_ROUND_TEMPLATE_VISIBILITY_SCOPE = { type: 'user', ids: ['__approval_cancel_round_system_only__'] }`(哨兵;普通用户不可见)| **成立且不相关**:可见性闸只在公开 `createApproval` 路径(`templateVisibleAtCreateBoundary`)生效;`createCancelRoundInstance` 不查模板可见性(该区段只有一处注释提到它),C-2 的全部夹具经进程内调用创建撤销轮,`seed-template-visibility` 7/7 在新头上绿 |
| `packages/core-backend/src/index.ts` | **改**(+59/−2,method-override 中间件与 `retireExpiredRecoveryAttachmentStage`)| 成立:C-2 只加 2 个 import 与考勤插件 `activate` 上下文里的两个注册钩子(`registerCancelRoundExecutionBoundary` / `registerCancelRoundCancelledEventDelivery`),与 r9 的 hunk 不相交 |

⇒ 没有一个 C-2 块的前提被 r9 改掉;唯一真正变化的输入是「撤销轮席位是谁」,而 C-2 对席位只有一个假设——「席位持有人经 `/actions` 通过后走 redemption」——由 §7 的两条交互腿在真库上验证。

## 4. §J-19 在新头上的复核

| 项 | 新头状态 | 证据 |
|---|---|---|
| **M-1 逐 key-path 白名单投影** | 完好 | `routes/approval-history.ts:233-235` platform SELECT 恰 3 条 key path(`metadata->'attachmentIds'` / `metadata->'cancellationOutcome'` / `metadata->>'cancelRoundCloseReason'`),WHERE 里 `metadata->>'commentId'`(`:206` / `:239`)只进过滤不进投影;`:284-293` 逐字段重建 `metadata`,无键则不发 `metadata`;共享 reader `core/attendance-cancellation-execution-port.ts:419-424` 恰 2 条 key path;两个 `getApproval` 调用点 `ApprovalBridgeService.ts:1051` 与 `ApprovalProductService.ts:13536`。全仓 `cancelRoundBlockDetail` 只有写入点 `ApprovalProductService.ts:9801`,**零投影点**(自由文本不投)|
| **M-5 两处过强声明更正** | 在,措辞为记录式更正(保留原句 + CORRECTED)| `approval-bridge-types.ts:103-117`(「carried verbatim by `UnifiedApprovalHistoryDTO.metadata`」— MEASURED FALSE on the HTTP surface;DTO 只在 `plm:` 分支构造;platform 面是逐 key-path 白名单)与 `ApprovalProductService.ts:13186-13197`(同一句的第二副本)、`:13339-13345`(`getApproval` 不投的旧句)|
| **M-2**(详情 DTO 新 `cancelRound` 字段)| **未做,只登记**(不在 §J-19 裁决范围;是新合同,须先进锁)| — |
| **M-3**(服务端 `systemClose` 可渲染标识)| **未做,只登记**(同上)| — |
| **M-4**(前端 snake/camel 漂移)| **未做,只登记**(同上;`apps/web` 零改动)| — |
| **§J-9 / 9a** | 按 C-2 分支现有实现与默认值,零改动 | `unrecoverableExpired` 呈现默认值(`daa027485` 的 flagged default)原样重放 |

## 5. 谁能经 HTTP 读到撤销结果(按本 head 实测;owner-open,不是本 lane 要修的缺陷)

- 两个持久读面 `GET /api/approvals/:id/history`(`routes/approval-history.ts:138`)与 `GET /api/approvals/:id`(`routes/approvals.ts:3204`)都挂 `authenticate` + `rbacGuard('approvals', 'read')`;通过守卫后再过每实例参与者围栏 `canReadApprovalInstance`(非参与者 404)。本 lane **未改**任何守卫、挂载、目录行或授予。
- 本 head 的权限目录(一次性库跑完全部迁移后)`permissions.code LIKE 'approvals:%'` = `approvals:admin` / `approvals:admin-data` / `approvals:admin-templates` / `approvals:analytics` / `approvals:write`——**没有 `approvals:read`**(登记它的 #5901 未合),`user_permissions` 里 `approvals:read` 授予行 **0**(零默认授予);因此今天连「授予」这个动作在目录层都不可能。
- 真 HTTP 实测(验证 MD §5):以 `roles=member`、零 `perms` 的令牌,**申请人 / 审批人 / 陌生人对已兑现轮与已过期轮的两个面全部 `403 {"error":"Insufficient permissions"}`**;以 rbac 旁路身份(dev-token `roles=admin`)且是该实例参与者的申请人,`/history` 的 approve 行带且只带 `"metadata":{"cancellationOutcome":{…}}`,已过期轮的系统收口行带且只带 `"metadata":{"cancelRoundCloseReason":"round_expired"}`,详情 DTO 相应带 `cancellationOutcome` / `cancelRoundCloseReason`;旁路身份但非该实例参与者 → `404 APPROVAL_NOT_FOUND`。
- ⇒ 本 lane 修的是投影本身(有读权者拿到的字段正确且只含白名单)。「未授予的申请人今天读不到」取决于两件 owner 未裁 / 未授权的事:撤销入口端点挂载侧(回执表 §3-22 第 22 项)与 `approvals:read` 的授予对象(§J-14/18 零默认授予)。本文**不**写「申请人刷新后可查」。

## 6. 与撤销入口对账件的两条交叉(D-4)

**(a) 「席位按构造 = user 臂」在新头上重读**:`ApprovalProductService.ts:9392-9394`(注释:`requesterChoices[CANCEL_ROUND_APPROVAL_NODE_KEY]` is the `requester_choice` assignee source's ONLY input)→ `:9399` `requesterChoices: { [CANCEL_ROUND_APPROVAL_NODE_KEY]: approverIds }` → `ApprovalAssigneeResolver.ts:366` `case 'requester_choice'` → `:384` `pushResolved('user', chosenId, …)`。reading-(a) 改的是 `approverIds` **怎么算出来**(原审批主体而非行 actor;跳过节点不计),**没有改席位怎么写入**,所以「撤销轮席位只可能是 `user` 臂」仍成立——并且不再只是源码文本推导:§7 两条腿在真库上读 `approval_assignments.assignment_type`,还原出的 A、以及 D / E 的席位行都是 `'user'`。

**(b) 跨 lane 合同分叉预警(只写事实与后果,不替 owner 选)**:本分支的 M-1 = 在历史端点 platform SELECT 逐 key-path 投影 `cancellationOutcome` / `cancelRoundCloseReason`,这正是撤销入口草案 P-3 的 **(i)** 方案;草案 P-3 的建议值是 **(iii)**(轮次摘要端点),且草案明写三方案「不得同批,否则同一事实两处投影」。⇒ **若本分支合入,P-3 日后不得再在 (iii) 的轮次摘要端点承载同一字段,或需 owner 明说改选 (i)。** 本分支不裁。

## 7. r9 × phase-2 交互腿(追加在 `approval-cancel-round-redemption.db.test.ts` 末尾;文件已在 `plugin-tests.yml` 必需 run-list,无需改 workflow、无需 s6a 重钉)

| 腿 | r9 半边 | phase-2 半边 |
|---|---|---|
| **reading (a) 席位回原主体** | 原单由代理 D 在 A 的席位上通过 ⇒ 撤销轮席位 = A(`assignment_type='user'`),历史代理 D 对撤销轮 `approve` → 403、零兑现、轮仍 pending | A 通过 ⇒ 经外部事务入口兑现恰一次,轮 `applied`;`/history` 恰一条 approve 行(actor A)带 `metadata.cancellationOutcome`,详情 DTO 带同值;历史面无 `nodeKey`,两面无 `delegatedFrom` / 禁止 token(按读面分列见表下「两面的 `nodeKey`」)|
| **跳过节点不计入** | D 决角色节点、管理员跳过 D 的被委托节点(`jump` 审计行 `adminJump=true`)、E 结第三节点 ⇒ 撤销轮席位 = {D, E}(都是 `user` 臂,被跳过的 A 不在) | D 通过后仍 pending(会签),E 通过 ⇒ 兑现恰一次,轮 `applied`;两条 approve 行只有兑现那条带 `cancellationOutcome`;详情 DTO 同值 |

**两面的 `nodeKey`(round 2 按读面分别写实,以代码为准;门审 NIT-1)**:

- 历史面 `GET /api/approvals/:id/history`:**不带** `nodeKey`。`routes/approval-history.ts:221-241` 的 platform SELECT 列表是 `id … from_version, to_version` 加三个别名表达式(`metadata->'attachmentIds'` / `metadata->'cancellationOutcome'` / `metadata->>'cancelRoundCloseReason'`),既无 `metadata` 列也无 `node_key` 列;`:284-293` 逐 key 重建 `metadata`,只可能出现 `cancellationOutcome` / `cancelRoundCloseReason` / `attachmentIds`。腿在历史面断三者不出:禁止 token、`"nodeKey"`、`delegatedFrom`(`approval-cancel-round-redemption.db.test.ts:4357-4359`)。
- 详情面 `GET /api/approvals/:id`:**合法带** `nodeKey`。路由走 `ApprovalBridgeService.getApproval`(`:909`),`:934` 调 `toUnifiedDTO`(`:328`),其 `:364` 发 `currentNodeKey: row.current_node_key`、`:371` 发 `assignments[].nodeKey: assignment.node_key`(DTO 类型 `approval-bridge-types.ts:37` / `:169`)。腿在详情面只断 `delegatedFrom` 与禁止 token 不出(`:4363-4364`),**不**断 `nodeKey`;门审探针亦读到两轮详情含 `"nodeKey"` 与 `currentNodeKey`。

⇒ 可断言的全部是「历史面无 `nodeKey`;两面无 `delegatedFrom` / 禁止 token」。round 1 写的「两面无 `nodeKey`」按字面对详情面为假,此处更正;结论(内部键不泄漏、投影只含白名单)不变。

判别力(验证 MD §6):把席位还原改回「行 actor 本人」⇒ 只有第一条腿红;把跳过豁免去掉 ⇒ 只有第二条腿红;去掉历史端点的 `cancellationOutcome` key path ⇒ 两条都红;去掉 `ApprovalBridgeService.getApproval` 的投影块 ⇒ 两条都红;去掉 `ApprovalProductService.getApproval` 的投影块 ⇒ 两条都绿(详情路由走 bridge 实现;该块由既有 P2-1 腿在 expired/blocked 动作响应上钉住,与门审 r1/r2 的读法一致)。

## 8. 本分支依赖的 owner 裁决(逐字见 `reviews/goal-72h-autonomous-window-20260925.md` §0;本文不复述为「已 ratify」)

- §J-19(C-2 待更正项随 C-1 后 rebase 一并修,逐 key-path 白名单投影 M-1,不单开 PR);§J-9(含 9a 呈现默认值);§J-13 读法 (a);reading-(a) 第 5 轮 P2-1(跳过节点不计入)。
- 未授权、本分支不做:合并、undraft、开 PR、ratify、授予 `approvals:read` 给任何人、撤销入口端点挂载侧(§3-22 第 22 项)。

## 9. 登记(未做,不在本分支范围)

- M-2 / M-3 / M-4(§4)。
- 投影候选门审 r1 P3-2:`isPlmId` 守卫在 bridge 侧有、product 侧无——注释保留两选项 (a)/(b) 给 owner,本分支原样重放。
- 投影候选门审 r1 P3-3:`ApprovalBridgeService.loadLocalHistory` 的 `plm:` 分支仍逐字带 `metadata`,归平台 / PLM 线,本分支未扩大它。
- 投影候选门审 r2 P3-A / P3-B / P3-C(NIT-1 生产者普查测试:`readFileSync` 无 try/catch、匹配式两个假阴性口子、该文件不在 CI gate)与 P3-D(pre-amend 对象在公开仓仍可取,RESIDUAL OPEN):本分支原样重放,未硬化。
- 对账件 D-5:`attendance-cancellation-execution-port.ts` 的 `reversed` / `unrecoverableExpired` 量纲(分钟)doc comment,记录级,本分支未加。
- 前端 `apps/web` 零改动,`vue-tsc` 与 web 测试因此 NOT RUN。
