# 审批撤销栈 r9 — 设计(2026-09-25)

**状态:候选(CANDIDATE)。** 三条私有分支、零 PR;不合并、不 undraft、不 ratify、不应用迁移到任何共享库。
本文是**栈级**设计:栈底 `feat/approval-cancel-round-phase1-r9` 写本节,上两层
(`fix/approval-legacy-approve-seat-and-node-attribution-on-r9`、`fix/approval-legacy-approve-settlement-parity-on-r9`)
各在文末追加自己的一节。措辞中性:只写机制、裁决与腿,不写可复用的构造步骤。

## 1. 栈的形状

| 层 | 分支 | 建在 | 内容 |
|---|---|---|---|
| 底 | `feat/approval-cancel-round-phase1-r9` | 窗口基线 `origin/main` = `e046a21c0a0110fbe22ca765852f1e053d90c0cb` | r8(`origin/feat/approval-cancel-round-phase1-r8` 相对其 main merge-base 的 74 个提交)`cherry-pick -x` 重放;reading-a(`origin/feat/approval-cancel-round-phase1-g3-reading-a` 相对 `b8b71539a6…` 的 13 个提交)重放;门审第 5 轮 P2-1 修法、P2-2 构造、P3 普查重算、P1 休眠钉腿 |
| 中 | `fix/approval-legacy-approve-seat-and-node-attribution-on-r9` | 栈底 | RC 候选(`origin/fix/approval-legacy-approve-seat-and-node-attribution` 相对其 main merge-base 的提交)重放;`routes/approvals.ts` 的两处闸序 hunk 按 F4 (i) 解;v3b 动作 1 断言 |
| 顶 | `fix/approval-legacy-approve-settlement-parity-on-r9` | 栈中 | H-5 候选(`origin/fix/approval-legacy-approve-settlement-parity` 相对 RC 的提交)重放;`services/ApprovalProductService.ts` 的 hunk 按 F4 (ii) 解;v3b 动作 3 守卫 |

四条源分支(r8 / reading-a / RC / H-5)**只读**:它们的门审报告绑着各自的 SHA,本栈不 force-push、不改动它们。
重放用 `git cherry-pick -x`,每个新提交的说明末尾带 `(cherry picked from commit …)`,可机械回溯到源提交。

## 2. 栈底(r9)改了什么,没改什么

### 2.1 没改的:r8 与 reading-a 的内容原样

- r8 的 74 个提交重放后的树与 `git merge-tree --write-tree <基线> <r8>` 的树**逐字相同**;
- reading-a 的 13 个提交重放后,`ApprovalProductService.ts` 相对 reading-a 交付 head 只差 r8 那一处注释,
  creation 件逐字相同;唯一冲突在 `approval-cancel-round-phase1-verification-20260918.md`(两支各自在文末追加),
  按两段原样并列解,编号不改(见该文件 Part O9 抬头的说明)。

### 2.2 改的:结算合取对被跳过节点的豁免(门审第 5 轮 P2-1;owner 2026-09-25 裁「跳过节点不计入」)

`createCancelRoundInstance` 的非 user 席位臂有三条合取;第三条(结算)要求「该 actor 持有被委托席位的每个节点
都有一条决定记录」。被管理员跳转或节点超时跳转**跳过**的节点没有任何决定记录,于是零伪造的诚实单据被判成
不可撤销。修法:

- 从 `approval_records` 读 `action = 'jump'` 且 `metadata.adminJump = true`(管理员路由)或
  `metadata.timeoutEffect = true`(超时扫描器)的审计行,取 `metadata.oldAssignees[].nodeKey`
  —— 跳转当刻仍活跃、被跳转停用而没有决定的席位所在节点。它由服务端在跳转时落库,不来自请求体;
- 结算合取的过滤多一项:这些节点不计入「未结算」;其余合取逐字不变;
- 被跳过节点上的原审批主体**不**被还原(那里没有任何人决定,没有可还原的席位);裁决说的是「不计入判定」。
- 不作为跳过证据的两样:`approval_assignments.is_active = FALSE` 且无决定的席位行(`transfer` / `return` 也会
  留下,那些节点最终由别人决定或被跳过,只看 `jump` 行才不会误判);`insertAutoApprovalEvents` 写的
  `action = 'sign'` + `metadata.skipped = true` 行(它记录一次被跳过的**自动审批**,节点本身留给人决定)。

腿:`P30(a)` 管理员跳过、`P32(a)` 超时跳过(两条今天不阻断,席位 `{D, E}`)、`P31(a)` 无跳过孪生(`{A, D, E}`);
`N19(a)`(无决定且无跳过)仍阻断。判别力在验证 MD。

### 2.3 构造的:节点重入(门审第 5 轮 P2-2)

`approval-cancel-round-phase1-design-20260918.md` §3.5.6 第三行由 NOT CONSTRUCTED 改为 CONSTRUCTED:
夹具走 shipped 的 `action: 'return'` 退回角色节点再按一次(端到端,不是夹具级 INSERT)。三条腿:
`P34(a)`(诚实重入孪生)、`N21(a)`(占位容量合取在**已重入**节点上的隔离见证)、`P33(a)`(epoch 2 由别人按时
今天的答案,登记残留)。设计 MD §3.5.5 / §3.5.6 同步更新。

### 2.4 休眠的:门审第 5 轮 P1(r9 不修,随 RC 落地关闭)

第 5 轮 P1 的形状(多成员角色节点上,一条 legacy 路由写下的行让历史被委托人多拿一席)在 r9 单独时**不关闭**:
合取 (2) 的两个输入都无法把一条 legacy 行与一条决定区分开,而 owner 裁的根因修法 (c)(legacy 路由自写节点归属、
剥掉请求体的 `nodeKey` / `nodeEntryEpoch`,并在写入前做席位闸)属于 RC 候选,**不复制进 C-1**。
r9 上按门审 §1.6 (a) 的要求钉一对腿:`P29(a)` 钉今天的答案(不阻断、多一席)、`P28(a)` HONEST6 做门槛参照物。
RC 栈上 `P29(a)` / `P33(a)` 改写成关闭后的答案(legacy 写入在席位闸处被拒,伪造行根本写不出来)。

**r9 休眠条件不变**(r8 的两件守卫照旧):`createCancelRoundInstance` 零生产调用方;种子模板对普通用户不可见。

### 2.5 普查重算(门审第 5 轮 P3)

验证 MD §O7.4 的 token 表对 `a85f33d194…` 之后的 head 不再成立;§O9.5 按本 head 现算(含新锚点
`delegated_seat_nodes` / `nodesSkippedByJump`),§O7.4 原句按求值标记读,不整节作废。

## 3. 栈中 `fix/approval-legacy-approve-seat-and-node-attribution-on-r9`(RC on r9)

### 3.1 重放与冲突

RC(`origin/fix/approval-legacy-approve-seat-and-node-attribution` = `09d0275726…`,相对其 main merge-base
`5edf4c3e17…` 的 4 个提交)`cherry-pick -x` 到栈底之上。冲突只在 `packages/core-backend/src/routes/approvals.ts`,三个 hunk:

| hunk | 位置 | 解法 |
|---|---|---|
| 1 | `ApprovalInstance` 可选列声明 | 并集(r8 的 `workflow_key` + RC 的 `published_definition_id` / `current_node_key` / `metadata`),无判断 |
| 2 | legacy `POST /:id/approve` | **F4 (i),owner 2026-09-25 点名 (b)**:席位闸(`resolveLegacyDecisionSeat` + 403)**先**,`rejectIfCancelRound(instance, 'legacy POST /:id/approve')` **后**(紧接 403 块之后、轮次归属解析之前) |
| 3 | legacy `POST /:id/reject` | 同上 |

v3b §5.1 的 hunk 2(`publishApprovalCountsForUsers` 重复声明)在本基线上**不出现**:它由 B-2 的
`approval-todo-counts-dual-publish-wiring.test.ts` 机械强制,而该文件不在 `e046a21c0` 上。

**可观察后果(F4 (i)(b))**:无席位者对撤销轮实例调 legacy `/approve` / `/reject` 得到与普通实例**逐字节相同**的
403 `APPROVAL_ASSIGNMENT_REQUIRED`(values-free,不透露实例种类);席位持有人得到 409 `CANCEL_ROUND_OUTLET_FORBIDDEN`。
两格都钉成腿(`V1(a)` / `V2(a)`,= v3b 动作 1)。

### 3.2 C-1 腿在本栈上的答案(裁决 (c) 的机械后果,不是新的语义选择)

RC 让 legacy 决策门(i)只放行在当前节点持有**活跃席位**的人,(ii)把行归属到**服务端派生**的 `nodeKey` /
`nodeEntryEpoch`(请求体里的两个键被丢弃)。栈底 creation 件里 18 条驱动 legacy 门的腿因此改答案;每条腿在本分支上
按本门的行为重写,标题带「本栈」,下层的答案留在下层分支历史里。两族:

| 族 | 腿 | 本栈答案 |
|---|---|---|
| 无席位者的写入被拒(403,零行,values-free) | `P27(a)` `N13(a)` `N20(a)` `P29(a)` `N21(a)` `P33(a)` | 夹具断言拒绝,随后由真正的审批人诚实结掉;撤销轮答诚实答案(`P29(a)` = `{A, E}`,与 HONEST6 `P28(a)` 逐字相同 —— 门审第 5 轮 P1 在此关闭) |
| 有席位者的行被服务端归属 | `P12(a)` `N7(a)` `N8(a)` `P13(a)` `N9(a)` `P19(a)` `N11(a)` `P21(a)` `N14(a)` `N15(a)` `N18(a)` `N19(a)` | 行落在席位所在节点,还原按裁决第一句进行:席位回 A(`N19(a)` = 门审 FORGERY3 的「还原到 A」臂,`{A, E}`);A 已停权 ⇒ 阻断且 reason = `inactive`(`N7(a)` / `N8(a)`);`P21(a)` 的会签 2 → 1 残留关闭(`{A, D}`) |

不改动的:`createCancelRoundInstance` 的三条合取与 r9 的跳过豁免逐字不变;RC 的 legacy 服务端写入**没有**复制进 C-1
代码(它只属于 RC 的提交)。

### 3.3 v3b 动作 1(runbook §3b-⑥ 要求)

`V1(a)`:无席位者 × 撤销轮实例 × legacy `/approve` 与 `/reject` ⇒ 403,回应体与同一人在普通待办实例上的拒绝逐字节相同,
撤销轮零行、status / version 不变。`V2(a)`:撤销轮席位持有人 A ⇒ 409 `CANCEL_ROUND_OUTLET_FORBIDDEN`,零行。
把 `/approve` 门的两道闸对调的 mutation 让 `V1(a)` 红(无席位者得 409)。

## 4. 栈顶(H-5 on r9)—— 本节由该分支追加

## 5. 本栈依赖的 owner 裁决(逐字见 `reviews/goal-72h-autonomous-window-20260925.md` §0;本文不复述为「已 ratify」)

- §J-13 读法 (a) + 根因 (c);reading-(a) 第 5 轮 P2-1 = 跳过节点不计入;F4 (i)(b) 席位闸先 / (ii)(b) 版本闸先;§3-33 (d)。
- 未裁(本栈不做):合并、undraft、RC 在合并序中的位置、锁增补草案 ratify。
