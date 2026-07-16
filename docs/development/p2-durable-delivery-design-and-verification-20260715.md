# P2 Durable Delivery — 设计与验证 (Design & Verification)

**状态 (2026-07-15 终版)**：S1 已落 main;**S2-a #4322 已 APPROVE 并合入 main(merge SHA `336732b5f`)**;S2-b #4334 已 retarget main 复绿中,S3→S4-a→S4-b/S5/S7(#4335/#4336/#4337)stacked 依序,S2-b/S3 已获 owner 授权;S6 经分析归零(§5f);动作级幂等 ledger L1+L2=#4340。余量=owner 逐级复审合入 + FWB-1/附件/record-link/FWB-2/FWB-3 + 八场景验收。**flag `AUTOMATION_DURABLE_DELIVERY_ENABLED` 恒 OFF**,当前零 runtime 行为。
**授权口径**:owner 逐切片实审 runtime,**无自合**;FWB / 附件 / flag 开启在完整实现 + 八场景验收前保持 gated。

---

## 1. 为什么 (问题陈述)

自动化「完成 → 投递」链有两个**崩溃丢失窗口**:

1. **commit-then-emit**:业务状态先提交,再往内存 `eventemitter3` 总线 emit。commit 与 emit 之间崩溃 = **事件永久丢失**。
2. **claim-before-execute 墓碑**:终态 claim 先写,执行后崩 = **漏投且不可恢复**。

修法(#4203 Layer 1 已 ratify):**事务性 outbox** —— outbox 行与源状态变更**同事务**落盘,再由 durable dispatcher **直接 `await`** 具名 consumer adapter 投递。传输层 **at-least-once**;净效果恰好一次由 **sink 侧幂等**保证(不是传输层保证)。

---

## 2. 设计不变量 (每片都必须守住)

| # | 不变量 | 强制点 |
|---|---|---|
| I1 | **无卡死吸收态**:每个非终态可回收,每个终态被消费方接受 | 状态机 = `pending\|in_progress\|done\|dead_letter`;**无持久 `failed`**;终态集 = `RESOLVE_PERMITTING_STATUSES` |
| I2 | **lease ⟺ in_progress**(双向) | DB `CHECK ((lease_expires_at IS NOT NULL) = (status = 'in_progress'))`。反向不是防 reclaim 扫描(该扫描按状态收窄),而是保证所有权状态唯一:lease 非空 ⟺ in_progress。注意 reschedule 后 lease 也是 **backoff/reclaim-not-before 标记**——此时并无活 worker 持有新 fence;终态/回收/重排转换必须原子更新 lease |
| I3 | **fence 单写者**:僵尸(活着但租约过期)写 0 行 | 每次 resolve 走 fence-CAS `WHERE fence = <claimed> AND status='in_progress'`;`fence` = `bigint`,TS 侧 **`string`**(2^53) |
| I4 | **有界 attempts,非无限 reclaim**,且**崩溃安全** | **poison 在 claim 内执行**:`attempts >= maxAttempts` 直接 `dead_letter`,只依赖持久化的 attempts,**不需要活着的 worker** |
| I5 | **重试 = 租约到期后 reclaim**,绝非立即重投 | `reschedule` 保持 `in_progress` 并把 lease 推后 backoff;**同时原子 `fence++`** 使旧 token 失效 |
| I6 | **未知 consumer_key = 保持 pending + 告警,绝不误判终态** | `consumerKeys` **必填非空**(registry allow-list);未知 key 永不被 claim;`findUnknownConsumerKeys` = 告警缝。**必须在第一个 dispatcher 版本落地**(#4203 §246) |
| I7 | **稳定原始事件身份** | `event_id` NOT NULL 且**非空白**(`[!-~]`,至少一个可打印 ASCII 非空格);**故意不 UNIQUE**(§cutover 容忍切换期双投,在 sink 去重) |
| I8 | **审计面 values-free** | `last_error` 只收**类型化 `DeliveryFailureReason`** 闭集码,运行期强制;原始报错(可能含 secret 形 URL/token)绝不入库 |
| I9 | **数值边界** | 全部 **safe integer + 显式上下界**(batch 1..10⁴,lease/delay 1..86_400_000,attempts 1..10⁴),不让小数/超大值穿到 SQL cast |

---

## 3. 切片与状态

| 切片 | 内容 | 状态 |
|---|---|---|
| **S1** | outbox 两表 schema + 默认 OFF flag + 行类型 | 🏁 **已落 main** `f07e7fc38` (#4303) |
| **S2-a** | claim 引擎:claim(含 claim 内 poison)/ complete / reschedule / poison / 未知 key 告警缝 | 📋 **PR #4322 `935a9b909` 全绿待复审** |
| **S2-b** | dispatch 循环:registry(重复注册=启动错误)+ tick(告警→claim→直接 await adapter→fence-CAS resolve)+ 确定性指数 backoff + flag-off 拒启 | 📋 **PR #4334 全绿待复审**(stacked) |
| **S3** | 版本化路由 manifest(锁 §283-291 全集,frozen)+ **双向**完整性断言 + `SUPPORTED_MANIFEST_VERSIONS` 滚动部署锚 | 📋 **PR #4335 待复审**(stacked) |
| **S4-a** | producer 原子入队 helper:`enqueueOutboxEvent(trx, event)` 同事务落 outbox+全 fan-out;未路由/空白身份=硬错 | 📋 **PR #4336 待复审**(stacked) |
| **S4-b/S5** | 激活缝 `automation-durable-activation.ts`:`produceAutomationEvent`(flag ON=事务内入队/OFF=null 零写)+ 六 adapter 工厂(注入真实 service handler,结构性替换匿名订阅)+ `bootDurableDelivery`(完整性断言先于任何 claim) | 📋 **PR #4337 待复审**(stacked) |
| **S7** | 崩溃注入 V 系列:V1 提交前崩=零行零投;V2 提交后崩=行持久、重启即投;V3 claim 后崩=reclaim 重投且 eventId 跨 fence 不变;V4 僵尸+reclaimer 双达 send=幂等 seed(`eventId::consumer_key`,无 fence)完全相同+僵尸终态写 0 行 | 📋 **同 PR #4337**(9 测含 V1-V4) |
| **S6** | 升级 backfill:**经分析归零**——outbox 表全新,无历史持久态可回填;切换窗双投已由 sink 幂等承接(锁的迁移安全论证)。落 runbook 项,非代码。 | ✅ 归零(§5f) |
| **后续** | FWB-1 / 附件 / FWB-2 / FWB-3 → **八场景全链验收** | 🔒 gated |

---

## 4. S1 已落地面 (`f07e7fc38`)

- `meta_automation_outbox`:`event_id` NOT NULL + 非空白 CHECK(I7);`manifest_version >= 1`;`automation_depth >= 0`。
- `meta_automation_outbox_consumer`:四态 CHECK(I1);**lease 双向 CHECK**(I2);`fence bigint`(I3);`attempts`;FK CASCADE。
- 全部 CHECK **具名**,每条配**断言具体约束名**的反例(删掉某条约束 → 恰好它的测试转红)。

**验证**:真库 14 测(CI `test (20.x)` 真库道实跑),含 >2^53 fence 字符串往返、lease 四角、Unicode 空白 event_id 拒收。migration replay 幂等。

## 5. S2-a 待复审面 (`935a9b909`)

`claimDueConsumers` / `completeConsumer` / `rescheduleConsumer` / `poisonConsumer` / `findUnknownConsumerKeys` / 纯 `resolveDisposition`。
镜像已验证的 `AttendanceNotificationDeliveryWorker` claim/CAS 范式(`FOR UPDATE SKIP LOCKED` + 「只有租约持有者可写终态」)。

**验证(真库 13 测;真正的并发交错为 SKIP-LOCKED 与 zombie fence 两项,poison/unknown-key/reschedule 为确定性状态序列验证)**:

| 守卫 | 构造 | 变异证明 load-bearing |
|---|---|---|
| fence-CAS(I3) | claim(fence N) → 租约过期 → reclaim(N+1) → 僵尸以 N complete | 把 fence 条件改恒真 → `expected true to be false` 🔴 |
| SKIP LOCKED | 事务 A 持锁不提交,B 必须**跳过并领另一行**(tx 内 `SET LOCAL lock_timeout`) | 去掉 SKIP LOCKED → `canceling statement due to lock timeout` 🔴 |
| 崩溃安全 poison(I4) | claim→过期 ×max(永不 resolve)→ 下一次 claim 直接 dead_letter | 抬高上限 → `length 0 but got 1`(被派发而非 poison)🔴 |
| 未知 key(I6) | N-1 用自己的 keys 连claim 10 次 → 目标行仍 `pending`/attempts=0;告警缝列出该 key;N 正常处理 | 过滤器改恒真 → N-1 领走 → `expected {…} to be falsy` 🔴 |
| reschedule 撤销 token(I5) | reschedule 后以旧 fence complete | 去掉 `fence++` → fence 停在 1 🔴 |

**空转防线**:两点接线(plugin-tests.yml 白名单 + vitest.config.ts exclude)⇒ 不能 skip-green;CI 日志实证 `✓ …dispatcher-claim-realdb.test.ts (13 tests)`。

## 5b. S2-b dispatch 循环 (PR #4334)

真库 12 测:成功/可重试(backoff 随 attempts 递增)/永久三路;adapter **抛异常**(带 secret 形消息)→ values-free `adapter_error`、原文永不入库;**逐行隔离**(A 抛不挡 B done);未知 key 告警且行原样 `pending`;告警回调抛异常不打死 tick;纯 backoff 数学(cap/clamp/防溢出);flag-off 拒启 + flag-on 真排空 + stop()。
**变异证明**:throw→poison 映射变异 → THROW 测试红;抑制未知 key 探测 → rolling-deploy 测试红。

## 5c. S3 manifest (PR #4335)

v1 = 锁 §283-291 全集(approval.{approved,rejected,revoked,cancelled}→bridge/trigger/projection;task_created→task-trigger;record.*→record-trigger+webhook-bridge;comment.created→webhook-bridge;form.submitted→record-trigger),frozen。**双向**断言以 registry 为唯一枚举源:漏 adapter(行永久 park)与多 adapter(死配置)都点名精确 key 抛错。单测 7/7(跑在 required 无-DB 道 = 它的真实 CI 道);去掉方向 2 → 恰好其测试红。
锁第三方向(匿名 `eventBus.subscribe` 闭包不可枚举)在 S5 用「替换订阅站点为注册 adapter」结构性关闭。

## 5d. S4-a producer 原子入队 (PR #4336)

`enqueueOutboxEvent(trx, event)`:调用方事务内落 outbox 行 + 每 manifest key 一条 pending 行;REJECT/ROLLBACK 路径**构造性**零投递;未路由事件族/空白身份/非法深度=边界硬错;打 `manifest_version` 戳。
真库 6 测:**原子性证明**(事务内可见,ROLLBACK 后两表零行)、COMMIT 后精确 3-consumer fan-out、端到端 enqueue→tick **逐 consumer 独立**(bridge 暂败,trigger/projection 照常 done)。变异:只入队第一个 key → fan-out 断言红。**四规格同库回归 45/45**。

## 5e. S4-b/S5 激活缝 + S7 崩溃注入 (PR #4337)

激活缝是生产代码唯一触点;三个入口在 flag OFF 时全为 no-op/拒启(**变异证明**:去掉 produce 的 flag 门 → byte-neutral 测试红)。六 adapter 把注入 handler 包成 outcome 映射(`PermanentDeliveryFailure`→poison;其余 throw→retryable,原文不入库);boot 在任何 claim 之前跑双向完整性断言。
真库 9 测:flag-OFF 零写零启;缺 handler 启动即抛;flag-ON 端到端排空(bridge 永久拒→dead_letter,trigger/projection→done,eventId 稳定);V1-V4 崩溃注入全过。**五规格同库总回归 54/54**。
**最终接线核对项(复审时)**:handler 实参须为真实 service 方法(`handleApprovalCompletionResume`/`...Trigger`/projection/task/record/webhook-bridge),站点传**自己的事务客户端**给 `produceAutomationEvent`。

## 5f. S6 归零论证

「升级迁移 backfill」的对象是**遗留持久投递状态**——但 outbox 两表是本线新建,启用前不存在任何历史行;旧 `claimEventDelivery` 墓碑(`meta_automation_event_fires`)在切换后**继续原样承担 sink 级去重**,无需迁移。切换窗内旧总线与 durable 双投的净一次由 sink 幂等承接(#4203 §316-325 的迁移安全论证)。⇒ S6 无代码;唯一残留是 **cutover runbook 项**:启用 flag 前确认 producer/worker 全 N-aware(§243 对称性)+ 观察窗内监控 `event_fires` 去重命中率。

---

## 6. 验证方法论 (本线standing)

1. **真库,非 mock**:每片本地 `initdb` 全新 PG15 → 按 CI 的 `MIGRATION_EXCLUDE` 跑 `db:migrate` → 跑**真实 vitest spec**(warm-store `pnpm install --offline` 4s 即可)。
2. **构造交错,不做顺序论证**:竞态守卫只有被它必须挺过的交错证明才算数(僵尸/SKIP LOCKED/崩溃循环)。
3. **变异必须先证落地**:变异要**干净**——`$N` 被孤立会变成 SQL 类型错误(红得不是地方);要保留参数引用(恒真/抬上限/去掉某个 SET)才是行为级证明。
4. **triggered ≠ verified**:CI 绿后再从日志确认 spec **真跑**且**测试数与本地一致**(stale checkout 会显示旧数)。
5. **head-scoped**:verdict 绑 SHA。审阅行号/符号对不上当前 head ⇒ 查 `original_commit_id`,勿在幻影上重修。

---

## 7. 待办 / 风险

- **余量全在 owner 面**:自底向上复审 #4322→#4334→#4335→#4336→#4337(逐级 retarget→CI 重门→合);最终站点实参接线核对(§5e);八场景验收;之后才是 FWB-1/附件/FWB-2/FWB-3 与 flag 开启。
- **S3 的滚动部署对称性**:#4203 §243 要求**双侧对称**(producer 全 N-aware 才可展开只有 N 认识的路由)——I6 只解决 worker 侧;**producer 侧漏写 = 该事件对 K 永远没有行,告警看不到**(无行可 park),必须靠激活门槛而非运行期防线。
- **外发净一次**依赖 endpoint 幂等键绑稳定事件/动作 identity、跨 fence 不变;端点不支持 ⇒ `outcome_unknown` 不自动重发(#4203 §340)。属 S5。
- **八场景验收**是 FWB/附件/flag 开启的硬前置。


---

## 8. 月计划全车道交付台账 (2026-07-15 收官)

| 车道 | PR | 内容 | 验证 |
|---|---|---|---|
| P2 S1/S2-a | 已落 main (`336732b5f`) | outbox schema + claim 引擎 | 真库 14+13 测,CI 实证 |
| P2 S2-b→S5/S7 | #4334→#4335→#4336→#4337 | loop/manifest/入队/激活缝+崩溃注入 V1-V4 | 各 12/7/6/9 测+变异,总回归 54/54 |
| 动作级幂等 | #4340 | `meta_automation_action_applied` L1 迁移 + L2(action_key 派生/Class-A 同事务 claim/Class-B outcome_unknown) | 真库 10/10 含双连接竞态 |
| FWB-1 ①②③ | #4341 | 映射核心(fail-closed all-or-nothing)+§11 Q6 四闸+`write_approval_form_values` 同事务执行器 | 4/4+4/4+真库 4 测(rollback 三者同灭) |
| record-link/FWB-2 | #4343 | submit 读检查(无存在性 oracle)+执行期三查+更新式执行器 | 2/2 全 fail-closed 腿 |
| FWB-3 | #4344 | `freezeDecisionValues` 不可变 (node_key,entry_epoch) 快照+节点域写回执行器 | 2/2 含不可变性证明 |
| 附件① | #4342 | 20/10/50 限额+v1 MIME 白名单(PDF/JPEG/PNG/TXT/CSV)+ext⇄MIME 交叉校验 | 4/4 reject-by-default |
| S6 | 归零 | outbox 全新无可回填;cutover runbook 项 | §5f 论证 |

**不可先建余量(硬依赖序)**:FWB-1 slice④ dispatchAction 终接线+配置 UI(需 S4/S5 落 main);附件②+(存储 provider/表/路由/前端);**八场景真库/并发/崩溃矩阵(需全链合入后在合并态上跑)**;钉钉 U1-U13 UAT 与 flag 翻转 = owner 门。所有 PR 待 owner 自底向上复审;全部 flags OFF;无自合。

---

## 9. ④-b / flag 接线 — apply-ready 补丁规格 (合并后即落)

### 9.1 FWB-1 ④-b(automation-actions.ts + automation-service.ts,单 PR)
1. `automation-actions.ts`:`AutomationActionType` 联合与 `ALL_ACTION_TYPES` 增 `'write_approval_form_values'`;新增 `WriteApprovalFormValuesConfig { targetSheetId: string; mappings: FwbFieldMapping[] }` + 进 `validateActionConfig` 的 per-type 校验(复用 `validateFwbMappingConfig` 语义:未知字段/非 v1 类型/select 无选项/重复目标/空配置=拒)。
2. `automation-service.ts` 执行器 switch 增一 case,委派预演分支已验证的 `FwbActionDispatcher.dispatch(trx, ruleCtx, config)`(136cfd639,3/3+八场景回归):
   - `trx` = 该规则执行已持有的事务客户端(与 approval 状态写同事务,D9);
   - `ruleCtx.structuralPath` = #4196-C4 结构化步径(执行器遍历时已有 index 路径);
   - `ruleCtx.formValues` = approval-completion 事件携带的表单快照;
   - `configurerUserId/sourceTemplateId` 取自规则行;`eventId` = 原始事件 id;`automationDepth` 照传。
   - 构造器 flag-off 抛错 ⇒ case 必须包在 `isDurableDeliveryEnabled()` 检查内(OFF 时该 action 校验期即拒,不进执行器)。
3. 验证:预演分支 `multitable-fwb-dispatch-wiring-realdb.test.ts` 原样迁入 + 一条穿真实 switch 的端到端(approval.completed → 规则 → 记录+账本+outbox 同事务)。

### 9.2 附件 flag 接线(单 PR)
1. index.ts 启动:`createApprovalAttachmentRouter({db, store: LocalFsApprovalAttachmentStore(root), authChecks, viewerId})` 非 null 时 `app.use(...)`(工厂 OFF 返 null=零休眠路由,已验)。
2. `ApprovalNewView.vue:382-393` B2-28 诚实禁用桩 → flag ON 时渲染上传控件(绑 `attachmentUpload.ts`,已验);提交路径接 `bindAttachmentsOnSubmit`(提交事务内,已验)。
3. GC/reconciler 定时器挂启动(flag-gated),`prefillFromSnapshot.ts:55` 的 attachment-skip 注释同步更新。

### 9.3 合并态正式验收
10 PR 落齐后:`multitable-p2-fwb-eight-scenario-matrix.test.ts` 已在两点接线内 ⇒ 合并态 CI 每 PR 自动重跑 = 正式验收即持续生效;另跑一次 fresh-PG 全量(§6 方法论)存证。

### 9.4 ④-b 对码校准(2026-07-16,读 automation-executor.ts 后修正规格)

审阅真实执行器后,§9.1 的两处措辞需按代码修正——**避免在合并态盲写时踩事务模型的坑**:

1. **执行器有干净的 dispatch switch**:`automation-executor.ts:1690` `executeSingleAction(action, context)` 的 `switch (action.type)`,`case 'create_record'` 在 `:1702`。④-b 加一个 `case 'write_approval_form_values'` 即可,**不需要重铺 structuralPath 递归**——`stepIndex` 已由生命周期钩子(`onStart(stepIndex, action)` 等)提供,`structuralPath = 'actions[' + stepIndex + ']'`(条件/并行分支的嵌套路径由现有 `branchCursor` 簿记给出)。
2. **事务模型 = 每动作自开事务,非跨审批状态写共享**:`executeCreateRecord` 用 `await this.withTransaction(async (query) => { INSERT meta_records ...; recordRecordRevision('create', ...) })`(`:2534` 起,D-1c slice③ 已把 INSERT+revision 收进一个 txn)。`ExecutionContext`(`:734`)**不带**共享事务句柄。
   ⇒ **修正 D9 的落法**:FWB 的"claim+record+revision+outbox 同事务"指的是**④-b case 内单个 `withTransaction` 的那一个 `query` 客户端**——把它作为 `trx` 传给 `executeWriteApprovalFormValues`,四写即原子。**跨投递的 net-once 不依赖与审批状态写同事务**,而由账本 `claimActionApplied` 的 UNIQUE 键独立提供(僵尸重投撞键回滚)。这与既有执行器模型天然兼容,无需改动审批完成写路径。
3. **record-service 缝的真实实现** = 照抄 `executeCreateRecord` 的 `INSERT meta_records (id,sheet_id,data,version) VALUES (...,1)` + `recordRecordRevision(query, {action:'create', recordId, ...})` + `sanitizeRichLongTextInWritePayload` + `evaluateCrossBaseWrite` 门(FWB 目标表可能跨 base)。即 `FwbWireDeps.createRecordWithRevision(query, sheetId, values)` 内联这一段。
4. **flag 门**:`case` 体首行 `if (!isDurableDeliveryEnabled(env)) return { status:'skipped', ... }`;且 `validateActionConfig` 对该 type 的校验在 flag OFF 时直接拒(与 `FwbActionDispatcher` 构造器拒启一致,双保险)。

⇒ 结论:④-b 是**一个中等 hot-file PR**(automation-actions.ts 增 3 处 + automation-executor.ts 增 1 case + 1 私有方法),风险点仅在「照抄 executeCreateRecord 的 revision/gate/sanitize 三件」——已逐条定位到行号。**必须基于合并后 main 作独立可评审 PR**(本会话在预演分支上盲改这个巨型热文件会产出不可评审 diff,且本线已有 11 个并发/事务缺陷证明盲写风险)。④-a 的 `FwbActionDispatcher`(136cfd639,3/3+八场景 11/11)已是该 PR 的承重内核,届时直接复用。
