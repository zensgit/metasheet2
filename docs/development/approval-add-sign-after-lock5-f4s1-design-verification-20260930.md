# 后加签(add_sign `after`)按 Lock-5 实现 — 设计与验证说明(2026-09-30 切片 F4-S1)

切片:F4-S1(审批对标飞书 P4-4)。基线 main `39891dc205`;分支 `feat/approval-add-sign-after-lock5`。
实现提交(按顺序):`f196c25743`(诚实文案,中英)、`b6410ff005`(后端)、`b1a1f006a7`(真库用例)、
`c7a162460c`(前端对话框)、`8157b4cf5a`(浏览器用例)、`18c3cb0646`(真库用例辅助函数更正)、
`f33ba8a085`(路由只在 `after` 时读取 `addSignAggregation`)、`bc7657b22f`(浏览器用例按可见标签选单选项);
本文与执行台账一行随后单独提交。

**切片状态:部分交付。** owner 补裁 Q14-bis (1) 中「依次审批最后一人 ⇒ 照常后加签」这一臂在本基线上不可达,本片没有放宽(见 §5 第一条,需 owner 二选一)。其余各臂与 B-1 / B-3 / B-4 / B-5 已交付并实测。

## 1. 改了什么

| 面 | 改动 |
|---|---|
| B-1 路由门 | `routes/approvals.ts`:`add_sign` 的 `addSignMode` 只收 `before` / `parallel` / `after`;键缺省时仍由服务层取默认 `parallel`;其它任何值 400 `APPROVAL_ADD_SIGN_MODE_INVALID`(原先被压成缺省值)。`addSignAggregation` **只在模式为 `after` 时**读取与转发,此时只收 `all` / `any`,其它值 400 `VALIDATION_ERROR`(不压成缺省值);`before` / `parallel` / 缺省模式下该键既不校验也不转发,与本片之前相同。非 `add_sign` 动作上的这两个键仍被忽略。 |
| B-1 服务门 | `ApprovalProductService.dispatchAction` 自己再校验一次模式(同一 400 码),直调服务的调用方也被拒;两道门各有独立测试钉(§3 变异 M1b / M2)。 |
| B-3 运行时 | `after` 在 `add_sign` 分支里只做校验,然后进入同一次派发里的同意(approve)管线,由引擎既有的「部分表态」分支判定这一票能否完成当前轮:依次审批队列未空、会签还有兄弟席位、门槛未达且还有兄弟席位 ⇒ 抛 409 `APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE`(不带 details),整个事务回滚,不留席位、轮次、版本、审计行。能完成 ⇒ 执行人席位按同意消耗(`approve` 审计行,仍记旧 `nodeEntryEpoch`),节点**不**向前解析:`bumpNodeActivationSeq` 在同一节点铸出新轮次,加签人用既有的 `buildAddSignAssignments` 入座(带 `addSign:true`,减签仍可识别),`current_node_key` / `current_step` 不变,实例保持 `pending`。追加轮不跑自动审批级联。 |
| 追加轮的聚合方式 | 存于 `approval_instances.metadata.addSignAppendedRound = { nodeKey, entryEpoch, aggregation }`(jsonb `\|\|` 合并写入,无 DDL)。同意管线从已加锁读出的实例行上读取,节点与轮次都匹配时用它代替节点配置的审批方式;该节点以后任何一次重新激活(退回、跳转)都会铸新轮次,于是自动回到节点配置的方式,不需要清理。 |
| B-4 | 并行区内 `after` 复用 `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`(`before` 的报错文字不变)。 |
| B-5 | `after` 且加签人两人及以上时 `addSignAggregation` 必填(否则 400 `VALIDATION_ERROR`);一人时可省(缺省记为 `all`,一个席位两种方式结果相同);`before` / `parallel` 不读该键(路由与服务两处都不读)。 |
| 意见必填 | 节点 `commentRequired:'always'` 时,后加签与同意一样需要意见(执行人席位按同意消耗);并加签不受影响(用例内正控)。 |
| 审计 | 同一事务写两行:执行人的 `approve`(`nextNodeKey` = 当前节点、`addSignAfter:true`、`appendedNodeEntryEpoch`)与 `add_sign`(`addSignMode:'after'`、`addedUserIds`、`addSignAggregation`、`nodeEntryEpoch`、`appendedNodeEntryEpoch`)。或签 / 门槛节点上被取消的兄弟席位照旧写一行 `sign`。 |
| 前端 | `addSignHonestyCopy.ts`(单独一个提交 `f196c25743`,便于与 F8-1 locale 接入合并):两种加签方式、聚合方式与新 409 的中英文案。`ApprovalDetailView.vue`:加签对话框「加签方式」单选(并加签默认 / 后加签),后加签显示「同一节点上开始新一轮审批……也不是『当前节点自动通过并流转到新增节点』……多人会签还有人未表态、门槛未达时不可用」;后加签且两人及以上才出现「加签人审批方式」(会签 / 或签)并随请求发送,否则不带该键,并加签请求与之前逐字节相同。`memberActionErrorCopy.ts`:新 409 在对话框内联显示固定文案(中文默认,英文随 `isZh=false`),不关对话框(它不是策略拒绝)。`types/approval.ts` 同步两个字段。 |
| CI 文件 | 只改 `approval-realdb-node-operation-policy.yml`:两处 `paths` 加入新 helper `approval-add-sign-after.ts`,证据步骤的 `gates=` 行补上 B-1 / B-3 / B-4 / B-5;真库用例仍在该独立 lane 的既有文件里。浏览器用例在 `approval-browser-verify.yml` 既有收集范围(`verification/approval-*.spec.ts`)内。前端 spec 只扩写已在必需 web 车道上的 `approval-member-bar-operation-policy.spec.ts` 与 `approval-e2e-lifecycle.spec.ts`,没有新增 spec 文件。未改 `plugin-tests.yml`、s6a pins、必需 web 车道 run-list 与 token manifest。新单测 `tests/unit/approval-add-sign-after.test.ts` 由后端 `vitest.config.ts` 默认 include 收入必需的 `test (20.x)`。 |
| 未改 | `before` / `parallel` 代码路径(原分支体整体移入 `else`,内容不变);撤销轮(C 锁)允许集(`after` 同样 409 `CANCEL_ROUND_OUTLET_FORBIDDEN`,用例已加);Lock-5 D-1 的 `policy_denied` 行;任何开关默认值;DDL;任何锁文正文。 |

新错误码只有一个:**`APPROVAL_ADD_SIGN_AFTER_ROUND_INCOMPLETE`**(409,不带 details,消息不含席位或人员信息)。命名沿用同族 `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED` 的前缀。

## 2. 依据

- **计划切片**:`approval-feishu-p2-p4-slice-plan-20260930.md` §4「F4-S1」:改动面(B-1 放宽为显式三值 + 未知值 400;B-3 席位按同意消耗、同节点新 `nodeEntryEpoch` 轮、轮完成后节点推进;B-4 复用码;B-5 `addSignAggregation`;前端诚实文案)、验收门(Lock-5 §3 的 B-1/B-3/B-4/B-5 正控 / 负控;`parallel` 与 `before` 行为不变;真库 + 浏览器各一条)、风险(撤销轮仍须拒;`policy_denied` 审计行)。文末「第 5 轮复验更正」节对本片无更正。
- **锁**:Lock-5(RATIFIED 2026-08-17)OD-L5-4 (b) 原文:「a deferred same-node round: the actor's seat is consumed as an approval, the addees activate as a fresh nodeEntryEpoch round at the SAME node, and the node advances when it completes — no graph mutation, existing machinery」,同条:「Under (b) or (c) no copy may claim corpus 后加签 semantics (当前节点自动通过并流转至新增节点): the node is not skipped」。OD-L5-5 (a):「`addSignAggregation: 'all'|'any'` supplied at action time, required when ≥2 addees for before/after, ABSENT for parallel」。门原文(§3):B-1「`'after'` reaches the service as `'after'` … an unknown mode is 400 `APPROVAL_ADD_SIGN_MODE_INVALID`; reverting EITHER door alone turns a named test red」/ 正控「`'parallel'` and `'before'` behave exactly as today」;B-3「the appended round activates, the actor's seat is consumed, and the instance does NOT terminate early」/ 正控「the same fixture with `'parallel'` keeps one node and one epoch」;B-4「`'after'` inside a parallel region is refused, reusing `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`」/ 正控「`'after'` on a linear node succeeds」;B-5「`'all'` requires every addee, `'any'` the first」/ 正控「a single addee needs no aggregation choice」。
- **执行台账**:`approval-parity-execution-ledger-20260817.md` 「Lock-5 OD-L5-4(b) / gates B-1..B-5 — OWNER DECISION, four enumerated completions」一行所列四种补全中的 (1):「refuse `'after'` at multi-seat nodes — a values-free 409 at the INV-6 guard site」。
- **owner 裁决**(原话见 goal 文件 §0):2026-10-01 00:0x「按建议执行」⇒ Q14 = (a)(按已 ratify 的 OD-L5-4 (b) 实现,文案如实说明与飞书不同);01:4x「决定的事 按你建议执行」⇒ Q14-bis = (1)(多席位节点上加签人同意不能完成当前轮时拒绝,返回不带值的 409;能完成当前轮时照常后加签)。

## 3. 验收门读数

读数环境:另一台机器(macOS arm64),Node 20.20.2,PostgreSQL 16.15,Playwright 1.57.0(Chromium);依赖为该机上独立工作树里 `pnpm install --frozen-lockfile` 装出的真实 node_modules。真库为本片新建的一次性库(`createdb`,迁移用 `plugin-tests.yml` approval 真库步的 `MIGRATION_EXCLUDE` 原样),`DATABASE_URL` 与 `ATTENDANCE_TEST_DATABASE_URL` 都指向它并以 `select current_database()` 断言;结束后已删库。

| 门 / 检查 | 读数 | 提交 |
|---|---|---|
| B-1 路由门 | 「B-1 (ROUTE door)」过:未知模式 400 `APPROVAL_ADD_SIGN_MODE_INVALID` 且零写入;`after` + 非法聚合 400 `VALIDATION_ERROR` 且零写入;缺省模式 200 记 `parallel`;`parallel` + 非法聚合 200、审计行无 `addSignAggregation` | `f33ba8a085` |
| B-1 服务门 | 「B-1 (SERVICE door)」过:直调服务未知模式 400、`after` 未知聚合 400,零写入 | `f33ba8a085` |
| B-3 | 单席位后加签:执行人席位消耗、加签人在同节点 epoch+1 入座、实例 `pending`、加签人同意后才推进到下一节点、实例经末节点才终结;正控 `parallel` 一轮一 epoch;会签未轮完 409 且席位 / epoch / 版本 / 实例 metadata / 审计全不变(节点仍只有一个 epoch),兄弟席位随后同意 200,执行人成为最后一席后同一后加签成功;或签、门槛(未达 409、达成放行)两条路径 | `f33ba8a085` |
| B-4 | 并行区内 `after` 409 `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`、零写入;正控为 B-3 线性节点成功 | `f33ba8a085` |
| B-5 | 两人及以上缺聚合 400;`all` 需两位加签人都同意才推进;`any` 首位同意即推进并写取消行;单人不需选择 | `f33ba8a085` |
| D-1 / 撤销轮 / 意见必填 | 策略关闭节点上 `after` 409 并只写一行 `policy_denied`;撤销轮上 `after` 409 `CANCEL_ROUND_OUTLET_FORBIDDEN`、行不变;`commentRequired:'always'` 节点上无意见后加签 400 `APPROVAL_COMMENT_REQUIRED`、有意见 200 | `f33ba8a085` |
| 真库套件(锁 5 lane + 撤销轮) | `approval-add-sign-honesty` 16/16、`approval-node-operation-policy` 20/20、`approval-comment-required` 16/16、`approval-cancel-round-outlet-guards` 7/7(4 文件 59/59) | `f33ba8a085` |
| 相邻真库套件 | `approval-sequential-mode` 10、`approval-node-entry-epoch` 6、`approval-wp1-any-mode` 2、`approval-prior-node-approver` 15、`approval-dedup-return-round-scoping` 16(5 文件 49/49) | `f33ba8a085` |
| plugin-tests approval 真库清单全量 | 96 文件 1212/1212(清单从 `plugin-tests.yml` approval 真库步逐字抽取,与该步一致) | `f33ba8a085` |
| 单测 | `tests/unit/approval-add-sign-after.test.ts` 3/3(`vitest.config.ts`) | `f33ba8a085` |
| 后端类型检查 | `tsc --noEmit -p tsconfig.json` exit 0(在无改动的干净树上跑) | `f33ba8a085` |
| 变异(整文件 `approval-add-sign-honesty`,每次恢复后 sha256 与原文件相同、树干净) | M1 路由只把 `after` 压回两值(保留 400):8 红(B-1 路由、B-3 ×4、B-4、B-5、意见必填);**M1b 路由逐字回退旧过滤器且去掉 400**:8 红(含 B-1 路由);**M2 服务门关掉**:1 红(B-1 服务门);M3 删会签分支的 409:1 红(会签未轮完用例);M4 删门槛分支的 409:1 红(门槛用例);M5 同意管线忽略追加轮聚合:1 红(B-5) | `f33ba8a085` |
| 前端类型检查 | `vue-tsc -b` exit 0(`f33ba8a085`,前端源码与最终头相同);`vue-tsc --noEmit -p tsconfig.verification-approval.json` exit 0(`bc7657b22f`) | 见左 |
| 前端 spec | `approval-member-bar-operation-policy.spec.ts` + `approval-e2e-lifecycle.spec.ts` 2 文件 94/94;必需 web 车道 token manifest `--check`:MATCHES(545);`approval-browser-ci-wiring.test.mjs` 3/3 | `f33ba8a085` |
| 前端全量 vitest | `apps/web` 516 文件中 515 过、1 败(`multitable-automation-rule-editor.spec.ts`,与本片无关);该文件单独重跑 185/185 过。`18c3cb0646` 与最终头之间 `apps/web/src`、`apps/web/tests` 零差异 | `18c3cb0646` / 重跑 `bc7657b22f` |
| 浏览器(真 Chromium,本片自起 Vite) | `verification/approval-member-action-dialog.spec.ts` 8/8,其中 F4-S1 用例在 1440×960 与 1024×768 各一次:默认并加签;后加签说明含「同一节点上开始新一轮审批」「不会插入新的审批节点」,飞书语义只以否定句出现,无「前加签」;单人不出现聚合选项;请求体为 `{action:'add_sign', targetUserIds:[…], addSignMode:'after'}`(无聚合键);新 409 内联显示中文固定文案、无「请重试」、无错误 toast、对话框不关、无横向溢出;切回并加签后提交并关闭。该用例里的 409 是 harness 模拟的:它包住 store 的 `executeAction`,对 `after` 请求抛出与服务端该 409 相同形状的错误(`ApprovalApiError`,同 code),不经过真实服务端;真实服务端的 409 由上面的真库行覆盖 | `bc7657b22f` |
| 考勤 DML 普查工具 | `attendance-w4c0-dml-inventory-collector.test.mjs` 60/60 | `bc7657b22f` |
| 公开文本 | 全部提交信息与本片新增 / 改动文本逐提交做公开文本检查,0 命中 | 全部 |

浏览器用例首次在 `f33ba8a085` 上跑时两条红,均已处理:(i)该机端口上已有另一份检出的 Vite 服务,配置在非 CI 下会复用它,测到的是旧代码 ⇒ 以 `CI=1` 重跑,由本片自起服务;(ii)Element Plus 单选的圆点盖住原生 input,`locator.check()` 被拦 ⇒ `bc7657b22f` 改为点可见标签(与成员实际操作一致),仍按无障碍 radio 角色断言选中态。

**「其正控保留」的对应**:原「B-3 DEFERRAL EVIDENCE」用例的正控是「节点只有一个 epoch 时,兄弟席位的同意返回 200」。改写后该正控保留为同一用例里「409 之后兄弟席位同意 200、节点仍为单 epoch」这一步,并新增「执行人成为本轮最后一席后,同一后加签成功」作为按轮次完成与否区分的正控。

## 4. 核查

**下游「前序节点审批人」(`prior_node_approver`)在追加轮下的取值。** `loadPriorNodeApproverDeciders` 按节点取最新一轮(`nodeEntryEpoch` 最大)的 `approve` 记录。后加签后,原轮执行人的同意记在旧轮次,加签人的同意记在追加轮 ⇒ 下游节点解析到的是**追加轮的表态人**,原轮执行人(以及原轮其他已表态的会签人)不在其中;追加轮为或签时只有首个同意的加签人。真库用例「Downstream `prior_node_approver` under an appended round…」钉住:下游节点只给加签人入座。这是沿用既有「最新一轮」规则的结果,本片没有改动该规则;如果 owner 希望下游包括原轮执行人,需要另行裁定。

**节点指标在追加轮下的口径。** 追加轮按同一节点的一次新激活记录,与退回到本节点的写法相同:先等待关闭原轮的分解项(`settleNodeDecisionMetric`,记执行人),再为追加轮开一个新分解项(`emitNodeActivationMetric`,同时按节点超时配置从此刻重新计时)。因此同一 `nodeKey` 在 `node_breakdown` 里有两项,各对应一轮;按节点统计的耗时 / 决策次数会把这两轮分别计入,而不是合成一项。真库用例在单席位后加签后断言该节点恰有两项:第一项已关闭且审批人为执行人,第二项未关闭。

**追加轮聚合载体的完整性。** (a)全仓对 `approval_instances.metadata` 的整列改写只有外部来源审批的同步 upsert(`ApprovalBridgeService`,`source_system` 非 platform),平台实例的派发都在 `source_system = 'platform'` 行上加锁,其余写法都是 `||` 合并或删单键,不会冲掉 `addSignAppendedRound`。(b)同意管线之外读节点审批方式的只有自动审批级联(追加轮明确不跑)与发起前路线预览;节点超时效果中 `auto_*` 在运行时不执行,`transfer` 保留本轮 epoch(载体仍匹配),`jump` 不能指向节点自身(离开本节点后载体自然失配)。因此没有别的路径会用节点配置的方式去判定追加轮。

## 5. 偏离、残留与 owner 待知

- **【需 owner 裁定】依次审批节点上的后加签(Q14-bis (1) 的一臂未交付)**:`sequential` 节点上的任何加签(三种模式)都被既有规则拒绝——`approval-effective-node-operations.ts` 的 `isOperationAllowedAtNode` 对 `sequential` 关闭 `allowAddSign` / `allowReduceSign`(#5451 起;派发闸与前端镜像共用这一谓词),拒绝时写一行 `policy_denied`。所以「依次审批最后一人 ⇒ 照常后加签」在本基线上不可达;真库用例「DISCLOSED RESIDUAL (pinned, not widened)」把现状钉住。本片没有放宽:该谓词不区分模式,放宽要么改变 `before` / `parallel` 在该类节点上的行为,要么在共享谓词里开模式例外(连带前端镜像),都超出本片。请 owner 二选一:① 另开一片,只对 `after` 做按模式放宽(派发闸与前端镜像同改,并补依次审批「最后一人」正例与「队列未空」409);② 接受现状,把这一臂记为不做。服务层依次审批分支里仍保留同样的 409,规则放开时不会产生跨轮次状态;该分支目前不可达,因此没有变异覆盖。
- **拒绝点位置(相对台账「INV-6 守卫处」)**:409 不在 `add_sign` 分支的 INV-6 位置抛出,而在同意管线里引擎自己的三个部分表态分支里抛出。原因:任务要求「判定能否完成当前轮必须复用引擎既有的轮次完成判定,不另写一套」,而在 INV-6 位置该判定尚未发生;在分支内抛出并整体回滚,对外效果相同(不带值的 409、零持久化,§3 用例逐项断言)。副作用:同意侧在此之前的闸门先生效(例如 `commentRequired:'always'` 时无意见先得 400)。
- **新增持久状态**:追加轮的聚合方式放在 `approval_instances.metadata` 的一个新 jsonb 键里(见 §1),无 DDL、不改运行图、不延迟任何一轮。它不是台账补全 (2)「deferred-round ledger」:(1) 之下从不需要把一轮推迟到兄弟席位表态之后。放在席位 `metadata` 上,就要求每一条改写或新增本轮席位的路径(转交、各类改派、轮内并加签)都带上该标记,轮内并加签新增的席位现在就不带;按轮次键在实例上则不依赖这些路径(同轮转交保留轮次,标记自然仍然匹配)。
- **多人会签未轮完时前端不预判**:对话框不根据详情数据预先禁用「后加签」(那等于在前端另写一套轮次完成判定),而是在说明文字里写明「不能完成本轮时不可用」,服务端 409 时在对话框内联给出固定中英文案、保留对话框以便改用并加签。
- **语言**:`memberActionFailure` 新增可选参数 `isZh`,缺省为中文;对话框里的文案取 `ADD_SIGN_PLACEMENT_COPY.zh`。F8-1 locale 接入时按键选语言即可。本片没有做其它本地化。
- **两行审计的意见**:执行人的意见同时写在 `approve` 与 `add_sign` 两行上(与并加签把意见写在 `add_sign` 行一致),时间线上会出现两次。
- **【偏离已 ratify 文本,须 owner 知悉】`addSignAggregation` 只在 `after` 模式读取**:Lock-5 OD-L5-5 (a) 原文要求两人及以上的加签在 `before` / `after` 两种模式下都在动作时提供 `all | any`;本片只在 `after` 模式读取该键,`before` 与 `parallel` 不读。理由:任务要求 `before` 与 `parallel` 行为逐字节不变,且 B-2 已钉住 `before` 当前与 `parallel` 行为相同(前加签尚无独立运行时)。若以后实现前加签的独立运行时,应同时按 OD-L5-5 (a) 读取该键。
- **服务门 400 的 details**:服务层的 `APPROVAL_ADD_SIGN_MODE_INVALID` 带 `{ nodeKey, operation }`(与同文件其它按节点的拒绝同形,不含人员或取值);路由门的同码 400 不带 details。

## 6. 未跑项

- GitHub 上的必需检查与独立 lane(本片未 push、未开 PR;由主会话在门审后处理)。
- 必需 web 车道脚本 `run-required-web-tests.sh` 本身没有整条跑;跑的是 `apps/web` 全量 vitest(在 `18c3cb0646`,前端源码与最终头相同)与两份扩写 spec(在 `f33ba8a085`),以及 token manifest `--check`。
- Lock-5 X-3(三视口真浏览器)不因本片成立:F4-S1 浏览器用例只覆盖桌面与平板两档;手机视口下加签入口本就隐藏(既有 P5-C 用例「mobile keeps only supported actions」钉住,本片未改)。
- 钉钉卡片通道只有同意 / 拒绝两种决定(`ApprovalCardDecision`),没有加签动作,未涉及。
- 依次审批「最后一人」后加签正例(见 §5 第一条,不可达)。
