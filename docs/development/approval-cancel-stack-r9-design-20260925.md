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
按本门的行为重写,标题带「本栈」,下层的答案留在下层分支历史里。「关闭由席位闸承重」是 **RC 层**的读数(本层 legacy 门直接写终态,
路由席位闸是唯一的闸);栈顶的层依赖见 §4.4 与验证 MD §3.1。两族:

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

## 4. 栈顶 `fix/approval-legacy-approve-settlement-parity-on-r9`(H-5 on r9)

### 4.1 重放与冲突

H-5(`origin/fix/approval-legacy-approve-settlement-parity` = `89f2805c4f…`,相对 RC 的 3 个提交)`cherry-pick -x` 到栈中之上。两处冲突:

| 提交 | 文件 | hunk | 解法 |
|---|---|---|---|
| `7d623d361`(legacy 门走共享结算路径) | `routes/approvals.ts` | legacy `/approve` 与 `/reject` 各一处:栈中放在席位闸之后的 `rejectIfCancelRound` 与 H-5 插在同一位置的「H-5 SETTLEMENT PARITY」块 | **出口守卫在前、结算块在后**:席位闸 → `rejectIfCancelRound` → `if (seat.seatGated) { … dispatchAction … }`。理由:`dispatchAction` 的动作闸对撤销轮实例**放行** `approve` / `reject`(在允许集内),所以有席位的 legacy 调用方必须在交给结算路径之前就被出口守卫拒绝(锁 §14.3 #7/#7′),否则 legacy 门会在撤销轮实例上跑普通 approve |
| `53c42b33e`(版本前置条件钉到共享结算路径) | `services/ApprovalProductService.ts` | `dispatchAction` 事务内、考勤 fail-closed 守卫之后:r8 的 `assertCancelRoundActionAllowed` 与 H-5 的 `expectedVersion` 版本闸 | **F4 (ii),owner 2026-09-25 点名 (b)**:版本闸**先**、`assertCancelRoundActionAllowed` **后** |

v3b §5.2 只列了后者;前者是栈中把 `rejectIfCancelRound` 放在席位闸之后(F4 (i))**引起**的,v3b 的合流树上没有这一格。

### 4.2 F4 (ii) 今天不可观察,由静态守卫钉住(v3b 动作 3,runbook §3b-⑥ 要求)

v3b §5.2.1 实测:`expectedVersion` 只由 legacy 两扇门写入,而两扇门在派发前都用 `rejectIfCancelRound` 拒绝撤销轮实例,
所以「撤销轮实例 ∧ `expectedVersion` 已设」在 `dispatchAction` 内**在今天的两个写入点下不成立**,(a)/(b) 两序行为等价;
由 v3b 动作 3 守卫钉住。**守卫口径**(与其文件头一致,本节不扩写):它钉的是「`packages/core-backend/src` 下所有 `.ts` 里
`dispatchAction` 调用实参中、在同一文件内能静态解析到的对象字面量上名为 `expectedVersion` 的属性」。声明后再赋值
(`let r = {}; r = build(req)`、`Object.assign(r, …)`)、拼接键名(`r['expected' + 'Version'] = …`)、非字面量成员名的调用
(`x[name](…)`)、在别的文件构造后传入的对象**不在口径内**,由代码评审负责;守卫是「已声明的人口 × 已声明的性质」的静态普查,
绿只表示这两者成立。本分支把这件事做成**被测性质**:`tests/unit/approval-legacy-decision-version-precondition-sites.test.ts`:

1. **人口(发现式,不是清单)**:用 TypeScript 编译器 API 解析 `packages/core-backend/src` 下每一个 `.ts`,凡被调用成员名为
   `dispatchAction` 的调用(`x.dispatchAction(…)` 与 `x['dispatchAction'](…)`,任何接收者)即为普查调用点;routes 文件内的
   `settleLegacyDecisionThroughSharedPath(…)` 也是(其 `precondition` 实参就是门的写入点)。人口自证:发现到的调用文件与调用点
   打印并断言 ≥ 下界(下界取今天的读数;读数只记在验证 MD §3.3),且今天已知的三个调用文件必须在其中 —— 新增调用方会被纳入普查
   而不是漏在外面,扫描器什么都没找到即红。
2. **性质**:每个普查调用点的请求实参(以及其它本身是内联对象字面量的实参)按对象字面量读,名为 `expectedVersion` 的属性**与拼写
   无关**(冒号、简写、字符串键、计算属性键、方法名);展开只在同一文件内按**初始值**解析(内联对象字面量 / 对象字面量条件式 /
   `&&` `||` `??` / 同文件作用域链上标识符的声明初始值),解析不到的请求实参或展开(调用结果、成员访问、导入名或参数名、非字面量
   计算键)计为「未判定」并报出 —— 负控断言今天为 0,除非在 `ACCEPTED_UNRESOLVED_SPREADS` 具名登记(今天为空)。第二张网只在
   routes 文件:全文件里 `expectedVersion` 的每一个标识符 / 字符串字面量 mention,除普查到的属性与 helper 自己的两处(形参类型成员、
   `precondition.expectedVersion` 读取)外一律红。结果:handler 内 **恰 2 处**(两扇门传给 helper 的 precondition 对象),`/actions`
   内 **0 处**,handler 外 **恰 1 处**(helper 的转发点),routes 以外的调用文件 **0 处**。口径内的第三写入点即红(复活路径 1);
   守卫自带负控(今天的真实源码树)与正控:在内存里往 `/actions` 拼入简写 / 冒号 / 字符串键 / 计算键 / 同文件 const 展开 / 条件展开
   各一,断言报出;不可解析展开、参数绑定名展开、非字面量计算键、非字面量请求实参各一,断言报「未判定」;往 routes 以外的两个调用
   文件 —— 钉钉卡片包装器 `services/ApprovalCardDeliveryAction.ts`(点号与 `['dispatchAction']` 两种写法)与售后桥
   `services/AfterSalesApprovalBridgeService.ts`(`as` 断言后的字面量)—— 各拼入 `expectedVersion: 1`,断言由普查本身报出;
3. 每扇 legacy 门内三件的**次序**:`resolveLegacyDecisionSeat` < `rejectIfCancelRound` < 写入点(F4 (i) 的静态钉);任一门少了出口
   守卫或把它挪到派发之后即红(复活路径 2);
4. `dispatchAction` 内:`guardAttendanceCentralMutationOrThrow` < `request.expectedVersion` 读取点(恰一行)<
   `assertCancelRoundActionAllowed`(F4 (ii) 的静态钉);对调即红。

三条 mutation(加第三写入点 / 删 `/reject` 的出口守卫 / 对调 F4 (ii) 序)的读数在验证 MD §3;人口 mutation(守卫人口改回单文件 ⇒
人口自证与人口正控红)与磁盘上往 routes 以外的调用文件加写入点的读数在验证 MD §3.3。对调 F4 (ii) 序之后再跑真库四件
(creation / outlet-guards / RC 自带 / H-5 parity)**读数不变** —— 这就是 v3b §5.2.1「今天不可达」的实证,也是为什么裁决落地
只能靠静态守卫承重。

### 4.3 legacy 门在栈顶的行为(对 C-1 腿的影响)

H-5 让 seat-gated 实例上的 legacy 决策走 `dispatchAction`(节点推进、完成事件),不再由路由直接写终态。栈中重写过的
18 条 C-1 腿**读数不变**:它们驱动 legacy 门的位置都是图的最后一个审批节点(单节点 / `approval_a` 末位 / `approval_b` 末位),
共享结算在那里同样落终态;行的 `nodeKey` / `nodeEntryEpoch` 由 `dispatchAction` 写(与栈中 RC 门派生的值相同)。
`approval-revoke-terminal-guard` (a) 已由 H-5 自己改为「终态且 `current_node_key` 清空」。

### 4.4 栈顶的双闸:路由席位闸在栈顶是纵深,F4 (i) 序的 values-free 性质是它唯一可观察的效果

栈中(§3.2)的两格 mutation 读数 —— 席位闸关掉 ⇒ 无席位者被拒族全红、路由归属置空 ⇒ 服务端归属族全红 —— 是 **RC 层**的:
那一层 legacy 门直接写终态,路由席位闸与路由归属是唯一的闸和唯一的写入者。栈顶不同:seat-gated 实例经
`settleLegacyDecisionThroughSharedPath → dispatchAction` 结算,而 `dispatchAction` 自带同码的 403 `APPROVAL_ASSIGNMENT_REQUIRED`
并自写 `nodeKey` / `nodeEntryEpoch`。于是在栈顶:

- 路由席位闸关掉 ⇒ 无席位者仍被 `dispatchAction` 拒(六条「无席位者被拒」腿保持绿);唯一变化是撤销轮实例上无席位者先撞上
  `rejectIfCancelRound` 得 409,与普通实例的 403 不再逐字节相同 —— 只有 `V1(a)` 看得见。这就是 F4 (i)(b)「席位闸先」在栈顶的全部
  可观察内容:一个 values-free 性质(不透露实例种类),由 `V1(a)` 单独钉住;路由闸本身是**纵深**(双闸 fail-closed),不是缺陷。
- 路由归属置空 ⇒ 无腿变红:该行在栈顶只到非 seat-gated 直写路径,那里 `resolveLegacyDecisionSeat` 本就不返回节点(`nodeKey` 恒 `null`),
  是语义空变异;seat-gated 行的归属由 `dispatchAction` 写。
- 非 seat-gated 直写路径上不存在「路由席位闸关掉 ⇒ 红」的腿可补:那条路径的 `allowed` 只取决于 `status === 'pending'`,而两扇门在它之前
  已有 400,闸关掉不改任何可观察行为(验证 MD §3.1 记为 NOT RUN 并注明原因)。

读数在验证 MD §3.1;§3.2 的「关闭由席位闸承重」按上述限定读。

## 5. 本栈依赖的 owner 裁决(逐字见 `reviews/goal-72h-autonomous-window-20260925.md` §0;本文不复述为「已 ratify」)

- §J-13 读法 (a) + 根因 (c);reading-(a) 第 5 轮 P2-1 = 跳过节点不计入;F4 (i)(b) 席位闸先 / (ii)(b) 版本闸先;§3-33 (d)。
- 未裁(本栈不做):合并、undraft、RC 在合并序中的位置、锁增补草案 ratify。
