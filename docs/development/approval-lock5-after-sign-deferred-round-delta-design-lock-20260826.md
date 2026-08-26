# Lock-5B delta — 后加签延迟轮状态机设计锁（2026-08-26）

**Status:** PROPOSED — 等待 owner ratify。本文只授权设计，不授权运行时代码、迁移、
feature flag、UAT、部署或生产开启。

**Baseline:** `origin/main@efbf0a931cd6529703a91c9c0053d4cae8217abe`。

**Parents:**

- `approval-lock5-node-operation-policy-20260817.md`，特别是已记录的 OD-L5-4(b)、
  OD-L5-5(a) 与 gates B-1/B-3/B-4/B-5；
- `node-entry-epoch-threshold-round-scoping-design-lock-20260703.md` 的单活跃轮单 epoch
  不变量；
- `approval-add-sign-honesty.db.test.ts` 中 B-3 的真库反例。

**父锁精确修订：**父锁 B-5/OD-L5-5 把 `addSignAggregation` 同时写给真正的 `before`
与 `after`，但当前 `before` 只是同 epoch 并加签的诚实别名，没有独立的前置轮。本文在真正
before-sign 状态机落地前，把该字段收窄为 **after-only**；`before | parallel` 都必须缺失并
保持当前聚合语义。本文 ratify 后，该点替代父锁 B-5/OD-L5-5，其他父锁条款不变。

本文只闭合 Lock-5B 的**后加签 runtime 半边**。`before` 仍维持已上线的诚实口径：它不是
真正的前置节点；本文不顺带实现前加签、图变异、并行分支内后加签或移动端原生编排。

## 0. 为什么必须有 delta

当前 `add_sign` 仅接受 `before | parallel`，两者都调用
`buildAddSignAssignments`，把新席位插入当前节点的当前 `entry_epoch`。旧 Lock-5 的
OD-L5-4(b) 记录为：消费 actor 席位，然后在同一节点用新的 `nodeEntryEpoch` 激活被加签人。

这个字面在多席位会签/阈值节点不可执行。若只消费 actor，旧轮尚未处理的兄弟席位仍在旧
epoch，而被加签人同时活跃在新 epoch；`currentNodeEntryEpoch` 会正确地以
`APPROVAL_NODE_ENTRY_EPOCH_MIXED` fail closed。真实 DB reproducer 已证明下一位审批人的
真实请求返回 500，实例进入吸收态。

因此本文纠正旧锁中的一句话：**“no graph mutation”仍成立，但“existing machinery”不成立。**
完整后加签需要一个持久化的待激活轮。它不是同轮 assignee mutation；它是同一图节点上的
第二个、延迟激活的审批轮。

## 1. 选择与不变量

### 1.1 选择

采用**延迟轮台账**：后加签请求先把目标人集合持久化为 `pending`，当前轮仍只保留当前
epoch 的活跃席位；只有当前轮完成后，才在同一事务中把台账 CAS 为 `active`、递增
`node_activation_seq` 并插入新轮席位。

以下两个较小方案明确拒绝：

1. 把所有旧轮活跃席位重写到新 epoch：会让 threshold 的已投票记录脱离新 epoch、静默
   重置法定人数，并让旧卡全部失效；
2. 把被加签人留在当前 epoch：那是并加签，不是已 ratify 的后加签。

“多席位节点 409”只保留为 flag-OFF/旧部署的安全退路，不作为最终产品能力替代物。

### 1.2 不变量

**AS-I1 — 单活跃轮单 epoch。** 任一 `(instance_id, node_key)` 的活跃 assignment 在任一
可提交状态下最多只有一个非 NULL `entry_epoch`；不得削弱 `currentNodeEntryEpoch` 的 mixed
拒绝。

**AS-I2 — 冻结图不变。** 不增加 synthetic graph node，不改 published definition；轮次
状态只存在于新台账和 assignment/audit 行中。

**AS-I3 — 旧轮决策不丢。** 后加签 actor 的当前动作是当前轮的一次真实 approve；当前轮
尚未处理的兄弟席位、已写入的旧轮 approve 记录及 threshold 计数均保持原义。
原图缺省或显式 `single` 也必须保持当前 linear first-wins 语义：actor 的一票完成 origin
轮并停用其余活跃兄弟，不能被新的共享 helper 误解释为 `all`。

**AS-I4 — 新轮聚合独立。** 延迟轮的**初始激活集合**只含请求时冻结的被加签人；一人时
规范化为 `all`，两人及以上时请求必须显式给出 `all | any`。不得继承原节点的
`threshold`、`all` 或 `any`。轮激活后的 parallel/before add-sign、transfer、timeout
transfer、reduce-sign、admin reassign/handover 继续遵守既有同节点 mutation 规则；聚合以
当前 epoch 的 live assignments 为准，但这些后续 mutation 不得改写冻结 seat rows 或伪造初始
激活集合。冻结 seat rows 只是初始意图与审计证据，不是之后 live set 的外键。active 轮的
运行时归属由 `(instance_id, node_key, entry_epoch = activation_entry_epoch)` 唯一决定；同轮新建
assignment 必须继承该 epoch，不要求也不得伪造 `deferredRoundId` seat。聚合器在 live set 发生
合法 transfer/reassign/reduce/add-sign 后仍使用轮表的 `aggregation`，但不得要求当前每个
assignment 都与冻结 seat 一一对应。

**AS-I5 — 一次只有一个开放后加签轮。** 同一实例、节点只能有一个 `pending | active`
轮。开放轮存在时再次请求 `after` 返回 values-free 409，不静默合并，也不创建第三轮。

**AS-I6 — 事务原子性。** actor approve、`add_sign` audit、台账写入、assignment 变更、
实例版本、task-created durable enqueue 必须在同一实例 `FOR UPDATE` 事务内提交或回滚。

**AS-I7 — 激活是状态元组 fence-CAS。** helper 在当前 origin epoch 根本没有 matching pending 轮时，
必须以零写入返回 `deferredRoundActivated:false`；这是普通审批完成的正常路径，不是 CAS 失败。
只有已经锁定一条具体 pending 轮后，
一个原子 CTE 同时证明 `(round.status='pending', instance.status='pending',
instance.current_node_key=round.node_key,
instance.node_activation_seq=round.origin_entry_epoch)`，并证明当前 origin live assignments
仍只属于该 epoch，才可 CAS 轮状态、bump epoch 和插入新席位。实例 `FOR UPDATE` 会串行普通请求，
但不能替代这些谓词：悬空 pending 行、已前进节点或已变更 seq 都必须零业务写入并 fail closed。
已锁定具体 pending 轮后 CTE 返回 0 才复读**同一 round id**并验证为已激活的同一轮；其他形状
fail closed。

**AS-I8 — 所有离开路径终结台账。** reject、return、admin jump、timeout jump、terminal
completion 在离开该节点前，必须按 §3.5 把开放轮原子转为 `cancelled` 或 `completed`；
transfer、timeout transfer、reduce-sign、admin reassign/handover 留在同节点，不能取消。

**AS-I9 — values-free。** 错误、日志、metrics 和普通审计摘要只包含状态、节点 key、epoch、
计数和 error code；不得回显目标用户 ID 列表、评论或表单值。

**AS-I10 — flag 是准入门，不是执行 kill switch。** `APPROVAL_AFTER_SIGN_ENABLED` 缺失或
不为精确字面 `true` 时，新的 `after` 请求不得创建台账、消费 actor 或写 audit；其它
add-sign 模式保持当前行为。已经提交的 `pending | active` 轮必须继续按本锁完成、取消或由
管理员恢复，不能因为关 flag 留下开放台账。

**AS-I11 — 目标身份同组织冻结。** `after` 的每个目标必须在请求事务中同时满足：平台用户
活跃、`user_orgs` 对实例规范 `org_id` 的成员关系活跃、未与该实例任一活跃 user seat 重叠。
实例 `org_id` 缺失、目录查询失败、少一人或多一人均 fail closed；候选 picker 不是授权事实。
pending → active 前必须对同一目标集合重做 exact-set，并重新取得匹配 `users/user_orgs` 行的
`FOR SHARE` 锁；只重读谓词而不持锁会在校验与 assignment INSERT 之间留下停用穿透窗。

**AS-I12 — 新轮 timeout 不继承旧 deadline；after-sign 可达时所有 effect 使用同一扫描 fence。** 激活延迟轮必须在同一事务中锁定 metrics 行，
并清除或重算 `approval_metrics.current_node_deadline_at/current_node_timeout_effect` 及四个
calendar deadline 字段。现有 `emitNodeActivationMetric` 是 best-effort，而且同节点已有 open
breakdown 时会 no-op，不能作为这条语义门；旧轮完成后的 post-commit
`emitNodeDecisionMetric` 也必须在“同节点延迟轮已激活”结果上跳过，否则会把新 deadline 清空。
business-calendar 解析继续沿用 T3-2 的 fail-open：provider 缺失、无日历或抛错时用 wall-clock
deadline，不得让同一实例在创建时可运行、后加签激活时却 500。

`scanNodeTimeouts` 对 `remind | transfer | jump` 一律返回不可变快照
`{instanceId,nodeKey,deadlineUtc,effect,activationSeq}`。`deadlineUtc` 必须由扫描 SQL 从
`timestamptz` 直接用
`to_char(deadline AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')` 格式化为固定六位微秒
的规范文本，不能先经过只保留毫秒的 JS `Date`。每个执行路径在实例与 metrics
行锁下只接受
该 exact tuple；不得用回调时的 live deadline/seq 替换扫描快照。旧扫描即使延迟到新轮 deadline
也只能 CAS 0，不能清新 deadline、通知新审批人、transfer 或 jump 新轮。只给 remind 加 fence、
让 transfer/jump 继续接受 `(instanceId,effect)` 是错误实现。

remind 不得用“先清 deadline，再直接通知”的 at-most-once 窗口。exact-tuple CAS 清除与一条
`approval.node_timeout_reminder.v1` durable outbox intent 必须在同一事务提交；事务崩溃时两者
同回滚，提交后 dispatcher 至少一次重试。该事件属于新增的 routing manifest v2，consumer key
固定为 `approval-node-timeout-reminder`。v2 保留 v1 全部既有 route，不重解释 v1 行；worker 必须先
同时支持 v1/v2 并注册新 adapter，producer/current manifest 只能在 worker exact-set 完整后切 v2。

reminder transport 另有默认 OFF、精确字面 `true` 的
`APPROVAL_DURABLE_TIMEOUT_REMINDERS_ENABLED`。disabled 必须保持当前 main：它只可与 after-sign writer
OFF 且开放 deferred round 为 0 的状态共存，此时现有普通节点的 notify-then-mark 路径原样保留。
这是明确披露的 pre-existing compatibility 腿，不作为 exact-tuple 证明；本 delta 不顺带改变 flag-OFF
提醒语义。after-sign 的 runtime gate 使 transport OFF 时不可能创建新 round；回滚也必须先关 writer
并排空 round 才能关 transport。transport 已为 ON 后，global durable、manifest v2、新 consumer、
channel readiness 或本 pod 协议任一丢失时不得退回 legacy 路径，也不得 CAS 清 deadline，只能保留
due row、发 values-free readiness 告警并在后续 tick 重试。reminder producer 禁止调用 flag-OFF 会返回
`null` 的通用
`produceAutomationEvent` facade；专用 seam 在确认完整 readiness 后直接调用事务强制的
`enqueueOutboxEvent(..., ROUTING_MANIFEST_V2)`，任何 null/异常都使 CAS 事务回滚。

CAS 事务从 boot/readiness 注入的**非空、固定闭集 `producerEnabledChannelKeys`** 构造一条 outbox
event/consumer row 每个 channel。该集合必须是所有 worker 报告的
`workerDrainableChannelKeys` 交集的子集；producer 不能向只在部分 worker 上可解释的 channel 写行。
不能把多个 channel 折进一个
`notifyNodeReminder` 调用：该现有聚合器会吞上下文/通道错误并正常 resolve，通用 durable adapter 会
把它误记为 success。专用 consumer 每次只投递 payload 指定的一个 channel：上下文读取失败、channel
缺失、`send` 抛错或返回 `ok:false` 都映射 retryable；零 configured channel 使 producer readiness
失败且不得 CAS。部分成功时成功 channel 的独立行完成，失败 channel 独立重试，不会重发已完成
channel。

intent 携带完整 timeout tuple、channelKey 和稳定 eventId。consumer 在执行前必须同时证明
`instance.status='pending'`、current node 与 activationSeq 均匹配，并从该 epoch 读取非空 active
assignee 集；terminal、reject、return、jump 或空 live set 都终止为 stale。该读取必须在实例锁下
同时取得 §2.3 的 `current_node_target_generation`、严格 live-target tuple 与 targetFingerprint。
合法同 epoch transfer 发生后，通知当前 live owner，不回放冻结 seat。读失败则重试。

eventId 只标识持久化 reminder intent，**不能直接作为外部投递幂等键**。consumer 每次解析当前
live assignees 后，先把排序、去重后的稳定身份元组（至少包含 assignee type 与内部 id）做 canonical
JSON 编码并取 SHA-256 得到 `targetFingerprint`，再计算：

```text
deliverySubject = UTF8(JSON.stringify([eventId, channelKey, targetFingerprint]))
deliveryKey = "approval-node-timeout-reminder-delivery:v1:" + hex(SHA-256(deliverySubject))
```

adapter 同时接收 `eventId + channelKey + deliveryKey`；外部 endpoint 只用 deliveryKey 去重。相同 live
set 的崩溃重放保持同 key，同 epoch transfer/reassign 使目标指纹和 key 改变，因此旧 owner 已成功但
worker 未落 `done` 时，新 owner 仍会收到一次。身份元组与指纹不得进入普通日志、metrics 或错误。
身份元组按其 canonical JSON 字节序排序后再编码；不得依赖数据库返回顺序或 locale collation。
精确 tuple 只能是
`["approval-reminder-live-target.v1", assignmentType, assigneeId]`；禁止加入显示名、email、目录版本、
assignment metadata 或其它可变展示字段。`assignmentType` 严格闭集为 `user | role`；`assigneeId`
必须原值就是无首尾空白的非空字符串。未知 type、空/纯空白/非字符串 id 都是 retryable malformed
assignment，零 send、零 done；不得 `String()` 或 trim 后继续。

send 成功不能走通用裸 `completeConsumer`。该 consumer 的 registry entry 必须提供 mandatory custom
terminal resolver；boot completeness 缺它就不 ready。resolver 按 instance → assignments → consumer
的规范锁序重读 status/node/epoch、target generation 与 live-target fingerprint，并在同一事务内执行
consumer lease+fence CAS：全部仍匹配才写 `done`；generation 或 fingerprint 已变则用原 claim fence
原子 reschedule 并 bump fence，下一次以新 target/key 重发；lease/fence 已失则影响 0 行。不能在外部
send 期间持 DB 锁。因而 transfer 在 read 后、send 前提交时，旧 owner 可能收到一次 stale reminder，
但 terminal resolver 必须拒绝 `done`，当前 owner 随重试必获提醒；本文不虚报 exactly-once recipient。

该 seam 必须落到 dispatcher 的具体 closed-set 接口，不能靠 adapter 闭包自行 `BEGIN`：

```ts
interface DispatchTransactionProvider {
  withTransaction<T>(work: (trx: TransactionalQueryable) => Promise<T>): Promise<T>
}

type ReminderCompletionToken = Readonly<{
  kind: 'approval-reminder-live-target.v1'
  targetGeneration: string
  targetFingerprint: string
}>

type ReminderSuccess = Readonly<{
  outcome: 'success'
  completionToken: ReminderCompletionToken
}>

interface ReminderTerminalResolver {
  resolveSuccess(trx: TransactionalQueryable, row: ClaimedConsumer,
    token: ReminderCompletionToken): Promise<'completed' | 'rescheduled' | 'lostLease'>
  resolvePoison(trx: TransactionalQueryable, row: ClaimedConsumer,
    reason: DeliveryFailureReason): Promise<'poisoned' | 'lostLease'>
}
```

`DispatchTransactionProvider` 必须由 `pg.Pool.connect()` 取得**同一个 client**后执行 BEGIN/work/COMMIT，
异常 ROLLBACK；不得对 Pool 连续发 `BEGIN/query/COMMIT`，也不得把任意 `Queryable` 强转为 transaction。
`TransactionalQueryable` 继续使用现有 `isTransaction` brand。registry 为 reminder key 同时登记
`terminalMode='approval-reminder-target-v1'`、resolver 与 provider；缺一项 boot fail closed。

closed-set verdict parser 在任何 getter/coercion 前验证 `ReminderSuccess` 与 token grammar，并把**验证所得
descriptor value 重建成的新 canonical token 快照**传到 resolver，不得保留或传递 adapter 返回的原 token
引用，也不得由 `normalizeAdapterVerdict` 丢弃。success 对象只允许 own data properties
`outcome | completionToken`，token 只允许 `kind | targetGeneration | targetFingerprint`；两层对象的
prototype 只能是 `Object.prototype | null`，不得有 accessor 或额外 key。`targetGeneration` 必须匹配
`^(0|[1-9][0-9]*)$`，`targetFingerprint` 必须匹配 `^[0-9a-f]{64}$`，全程不转换。实现先在 try/catch
内用 `node:util.types.isProxy()` 拒绝两层任何 Proxy，再以 `Reflect.ownKeys()` 和
`Object.getOwnPropertyDescriptors()` 校验 exact string-key set、拒绝 symbol key 并取得 data-property
value；getter、Proxy（含不抛错的透明 Proxy）、错误 prototype、缺/多 key、非法 grammar 都映射
retryable `adapter_error`，零 terminal resolver 调用。parser 最后只可从这些 descriptor value 创建
`Object.freeze({ kind, targetGeneration, targetFingerprint })`；事务 provider 等待连接、BEGIN 或执行
resolver 的任何异步间隔都只能持有该冻结快照，resolver 不得重新读取 adapter 对象。
`processClaimedRow` 对 success 调
`provider.withTransaction(resolveSuccess)`，对 permanent failure 调
`provider.withTransaction(resolvePoison)`；这两个结果就是最终 disposition，后面**不得再次**调用
generic `completeConsumer/poisonConsumer`。retryable verdict 仍可走现有 fence-CAS reschedule。
`resolvePoison` 在同一 trx 执行 consumer fence-CAS 与 §2.5 control insert；claim-time poison 继续由
claim CTE 原子处理。
无法提供幂等的 adapter 必须诚实标记 at-least-once 可能重复。任何超过 attempt 上限而进入
`dead_letter` 的行都必须产生 required、values-free 告警，并由指定 owner 修复后重放或逐行记录
不可重放 disposition；本文只保证失败不会被静默记成 `done`，不声称外部效果绝不丢失。启用 after-sign 前 durable
dispatcher/manifest-v2/consumer 与 reminder transport 必须已开启并通过真实 crash-injection；该
runtime writer 同样受当前 E1/shared-writer HOLD。

eventId 的**输入 subject** 必须是下列版本化、可注入的 canonical JSON 编码，不得使用
`a + ':' + b` 一类分隔符拼接；最终 SHA-256 是碰撞抗性身份，不宣称数学意义上的可注入：

```text
subject = UTF8(JSON.stringify([
  "approval.node_timeout_reminder.v1",
  instanceId,
  nodeKey,
  deadlineUtc,
  BigInt(activationSeq).toString(10),
  channelKey
]))
eventId = "approval-node-timeout-reminder:v1:" + hex(SHA-256(subject))
```

数组位置就是 schema；字符串由 JSON 转义，deadline 使用上述 DB 生成的 UTC 六位微秒文本，seq 必须
是无前导 `+`/零的十进制表示。相同 canonical subject 重放得到同一 ID；任一成员不同必须先产生不同
subject，再由 SHA-256 提供碰撞抗性标识。当前 `node_activation_seq` 是 PostgreSQL `integer`，真库门
只宣称覆盖其实际边界；`>2^53` 只作为纯 serializer 的未来扩列防退化测试，不虚报成当前端到端路径。
serializer 在任何转换前严格验证六个输入的类型、非空约束、deadline grammar 与 seq decimal grammar；
不得用 `String()`/`Number()` 把畸形 protocol 值转换成可认证 subject。

channel 配置采用双集合生命周期。新增 channel 时先让全部 worker 把 key 加入
`workerDrainableChannelKeys` 并通过 exact-set，再把它加入 `producerEnabledChannelKeys`。删除 channel
时顺序反转：先从 producer 集删除并穿过 §2.3 的事务准入屏障，再证明该 key 的
`pending | in_progress` 为 0、无活 lease、每个 `dead_letter` 已重放或有 owner disposition，最后才能
从 worker 集和 adapter registry 删除。rename 等价于“新增新 key，再退役旧 key”；不得原地解释旧行。

**AS-I13 — pending 目标失效可恢复且不降门槛。** 目标在请求后、激活前失去用户/组织活跃性
时，不得照常激活、静默删人或降低 `all | any` 集合。触发旧轮完成的动作整体回滚并返回统一
409；管理员必须能取消该 pending 轮后让旧席位重试。取消能力是 break-glass，flag OFF 时仍可用。

**AS-I14 — 混合版本不能误执行。** 上线使用 worker-first 的三段门：阶段 A1 先落迁移，并把“可
读取/排空 deferred round、支持 manifest v1/v2 和 reminder adapter、但两个新 flag 均 OFF”的兼容
处理器部署到所有 serving/dispatcher pod。boot completeness 必须对**全部 supported manifests 的
route union**做双向 exact-set：每个 routed key 都有 adapter，每个 adapter 至少被一个 supported
manifest 路由；v1 route 本身仍逐字不可变。`SUPPORTED_MANIFEST_VERSIONS` 不再是无调用常量，claim
SQL 必须只锁其版本集合内的 outbox rows；不支持版本保持 pending 并告警，不能被旧 worker 先 claim
再解释。版本告警不能复用只比较 `consumer_key` 的 unknown-key scanner；dispatcher 必须有独立
`findUnsupportedManifestVersions`（或等价 DB seam）扫描 known consumer key + unsupported
`manifest_version` 的**可回收集合**：`pending`，或 lease 已过期的 `in_progress`；活 lease 不由另一
worker 误报为已停放。scanner 调用 required、values-free observer。阶段 A2 在 worker exact-set
全部就绪后才把 producer/
current manifest 切到 v2、确认全局 durable dispatcher 正在运行，再开启 durable-reminder flag；
阶段 B 才允许打开 after-sign writer flag 和显示 FE 能力。每个 pod readiness 暴露固定
`approvalAfterSignProtocol='v1'`、支持的 manifest exact-set 与 reminder consumer readiness。
未完成任一 exact-set 时合法 `after` 必须保持不可创建；旧处理器会把未知值归一成 `parallel`，
所以不能用单 pod 健康、部署期多数或“flag 已写”代替该门。服务端 after-sign writer 在每次请求
还要验证本 pod 协议、global durable flag、durable-reminder flag、current manifest v2 和 consumer
readiness；任一不满足返回 values-free 409 `APPROVAL_AFTER_SIGN_RUNTIME_NOT_READY`，数据库零变化。

回滚先在所有 producer/scheduler pod 关闭 after-sign writer 与 reminder **producer admission**，
再执行 §2.3 的数据库排他准入屏障；该屏障必须等待所有已取得共享准入锁的事务提交或回滚，并让
之后的 producer 在写业务状态前看到 DB gate 为 OFF。consumer/dispatcher 必须继续排空；用 serving
exact-set 证明没有旧 producer 后，才读取同一数据库
快照。该快照要求 `pending | active` deferred round 为 0，相关 reminder consumer 行
`pending | in_progress` 为 0、无活 lease，`dead_letter` 为 0 或已有逐行 owner disposition；`done`
历史可保留。有开放轮、未结 consumer、活 lease或未处置 dead_letter 时不得关闭 durable-reminder/
global-durable transport，也只能
回滚到仍能排空 after-sign-v1 与 manifest v2 的兼容版本，不得回到协议之前的 SHA。阶段 A1/A2、
阶段 B 与回滚证据都记录镜像 commit、serving/worker exact-set、开放轮计数、各 consumer status
计数、活 lease 计数、dead-letter disposition 和 flag 状态，values-free。本文不授权实际部署或开关。

## 2. 持久化合同

### 2.1 轮表

新增 Kysely TS migration：

```sql
CREATE TABLE approval_deferred_add_sign_rounds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id text NOT NULL
    REFERENCES approval_instances(id) ON DELETE CASCADE,
  node_key text NOT NULL,
  origin_entry_epoch integer NOT NULL,
  activation_entry_epoch integer,
  status text NOT NULL,
  aggregation text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  terminal_at timestamptz,
  cancel_reason text,
  CONSTRAINT approval_deferred_add_sign_rounds_origin_epoch_nonneg
    CHECK (origin_entry_epoch >= 1),
  CONSTRAINT approval_deferred_add_sign_rounds_activation_epoch_nonneg
    CHECK (activation_entry_epoch IS NULL OR activation_entry_epoch >= 1),
  CONSTRAINT approval_deferred_add_sign_rounds_status_valid
    CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  CONSTRAINT approval_deferred_add_sign_rounds_aggregation_valid
    CHECK (aggregation IN ('all', 'any')),
  CONSTRAINT approval_deferred_add_sign_rounds_node_key_nonblank
    CHECK (node_key ~ '[!-~]'),
  CONSTRAINT approval_deferred_add_sign_rounds_created_by_nonblank
    CHECK (created_by ~ '[!-~]'),
  CONSTRAINT approval_deferred_add_sign_rounds_cancel_reason_valid
    CHECK (
      cancel_reason IS NULL OR cancel_reason IN (
        'rejected', 'returned', 'admin_jump', 'timeout_jump',
        'instance_terminal', 'operator_cancelled'
      )
    ),
  CONSTRAINT approval_deferred_add_sign_rounds_state_paired CHECK (
    (status = 'pending' AND activation_entry_epoch IS NULL
      AND activated_at IS NULL AND terminal_at IS NULL AND cancel_reason IS NULL)
    OR
    (status = 'active' AND activation_entry_epoch IS NOT NULL
      AND activated_at IS NOT NULL AND terminal_at IS NULL AND cancel_reason IS NULL)
    OR
    (status = 'completed' AND activation_entry_epoch IS NOT NULL
      AND activated_at IS NOT NULL AND terminal_at IS NOT NULL AND cancel_reason IS NULL)
    OR
    (status = 'cancelled' AND terminal_at IS NOT NULL AND cancel_reason IS NOT NULL
      AND (
        (activation_entry_epoch IS NULL AND activated_at IS NULL)
        OR
        (activation_entry_epoch IS NOT NULL AND activated_at IS NOT NULL)
      ))
  )
);

CREATE INDEX approval_deferred_add_sign_rounds_origin_lookup
  ON approval_deferred_add_sign_rounds(instance_id, node_key, origin_entry_epoch);

CREATE UNIQUE INDEX approval_deferred_add_sign_rounds_one_open
  ON approval_deferred_add_sign_rounds(instance_id, node_key)
  WHERE status IN ('pending', 'active');
```

`cancel_reason` 是固定闭集 `rejected | returned | admin_jump | timeout_jump |
instance_terminal | operator_cancelled`，由 DB CHECK 和 TS union 同时约束；不能放异常文本或
没有真实写入路径的幽灵枚举。

### 2.2 目标席位表

```sql
CREATE TABLE approval_deferred_add_sign_round_seats (
  round_id uuid NOT NULL
    REFERENCES approval_deferred_add_sign_rounds(id) ON DELETE CASCADE,
  assignee_user_id text NOT NULL,
  ordinal integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (round_id, assignee_user_id),
  CONSTRAINT approval_deferred_add_sign_round_seats_assignee_nonblank
    CHECK (assignee_user_id ~ '[!-~]'),
  CONSTRAINT approval_deferred_add_sign_round_seats_ordinal_nonneg
    CHECK (ordinal >= 0),
  CONSTRAINT approval_deferred_add_sign_round_seats_ordinal_unique
    UNIQUE (round_id, ordinal)
);
```

目标集合在请求事务中写入，后续激活只从该表读取，不从请求、目录或当前模板重新解析。
仅在 `addSignMode:'after'` 已经判定后，route 与 service 才严格验证原始 `targetUserIds` 是非空
数组，且**每个**元素都是去空白后非空的字符串；不得先 `filter(typeof === 'string')` 再计算人数，
因为 `['u1', null, 'u2']` 会被错误收窄并改变 aggregation 合同。去空白后有重复、包含 actor、或
与实例内任一活跃 user seat 重叠均以同一个 values-free 400 拒绝，不能静默去重，也不能等唯一
索引把重叠变成 500。before/parallel 继续当前 main 的过滤/coerce 与冲突行为，不在本 delta
顺带收窄。

现有 participant directory 只提供候选与显示名，当前 `add_sign` 服务端也只做去空白和活跃
assignment 冲突检查；二者都不是目标授权。`after` 必须在持有实例 `FOR UPDATE` 的同一事务中，
以 `approval_instances.org_id` 为唯一组织事实，查询 `users.is_active=TRUE` 且存在同 org 的
`user_orgs.is_active=TRUE` 的精确 ID 集合。返回集合必须与请求集合 exact-set 相等，否则统一
400 `APPROVAL_ADD_SIGN_TARGET_INVALID`，不得揭示哪一个 ID 不存在、停用或跨组织。实例
`org_id` 为 NULL 时返回 409 `APPROVAL_AFTER_SIGN_ORG_SCOPE_UNAVAILABLE`；不得回退到 actor
tenant、`default` 或全局用户表。请求时对命中的 `users/user_orgs` 行加共享锁，使并发停用只能
发生在本事务提交前或提交后，不能在校验与 seat 落库之间穿透。

激活前必须用 seat rows 对同一谓词做第二次 exact-set 校验，并重新对全部匹配
`users/user_orgs` 行加 `FOR SHARE` 锁。若目标已失效，触发旧轮完成的
approve/after-sign 事务整体回滚，旧席位保持 active，返回 409
`APPROVAL_AFTER_SIGN_TARGET_STALE`；不得写出“旧轮已完成但新轮无人”的状态。管理员按 §3.1
取消 pending 轮后，旧席位可重试；可以直接正常前进，也可以用新的合格目标重建一个 pending
轮。轮表不对已取消历史设置 origin-epoch 唯一约束，开放轮唯一性只由 `one_open` 索引保证。
已经 active 的延迟轮使用现有管理员 bulk reassign 做一换一修复；本文不把当前无生产调用方的
`applyApprovalDepartureTransfer` 误报为自动闭环。

### 2.3 live-target generation 与数据库准入屏障

同一 approval runtime migration 为实例增加一个不参与客户端 optimistic version 的内部 ABA fence：

```sql
ALTER TABLE approval_instances
  ADD COLUMN current_node_target_generation bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT approval_instances_target_generation_nonneg
    CHECK (current_node_target_generation >= 0);
```

所有会改变 pending 实例当前节点 live assignment exact-set 的生产写入路径都必须在持有实例
`FOR UPDATE` 的同一事务中 `current_node_target_generation = current_node_target_generation + 1`：新节点
激活/再进入、仍停留当前节点的审批席位消费、manual/timeout transfer、bulk reassign/handover、
departure transfer、parallel/before add-sign、reduce-sign，以及本锁的 deferred round activation。它不替代 `node_activation_seq`：前者
fence 同 epoch target ABA，后者 fence 节点激活。源码 exact-set gate 必须从所有 active-assignment
INSERT、`is_active` UPDATE 与 assignment 删除生产写点反推调用方；发现新增写点未调用统一 bump helper
即 required 红，不能靠手列“已知动作”维持。历史行清理或 terminal 实例清理不作为新提醒的 producer，
但若仍改变 pending/current-node live set 也必须 bump。
该 bigint 与 outbox fence 一样全程以严格十进制字符串跨 JS 边界，不得转成 `number`。
扫描根至少覆盖 `packages/core-backend/src/**` 与仓库根 `plugins/**`，而不是只扫
`ApprovalProductService`；tests/generated/vendor 明确排除。每个生产写点必须调用 bump helper，或附一条
可执行反例证明它无法命中 `source_system='platform'` 的 template-runtime pending/current-node 实例。
AfterSales/PLM bridge 与 attendance plugin 写点必须在首版 census 中逐一归类；只有注释不算排除证明。

同一新增 migration 还创建一个 approval-local singleton；默认值只能拒绝，不能靠部署默认值自行开启：

```sql
CREATE TABLE approval_after_sign_runtime_admission (
  gate_name text PRIMARY KEY,
  after_sign_writer_enabled boolean NOT NULL DEFAULT false,
  reminder_producer_enabled boolean NOT NULL DEFAULT false,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_after_sign_runtime_admission_singleton
    CHECK (gate_name = 'after-sign-v1'),
  CONSTRAINT approval_after_sign_runtime_admission_generation_nonneg
    CHECK (generation >= 0)
);

INSERT INTO approval_after_sign_runtime_admission(gate_name)
VALUES ('after-sign-v1');
```

环境 flag 是外层默认-OFF 门，DB 行是跨 pod 的事务门；两者必须同时为 ON，DB 行不能独立授权功能。
每个 after-sign create 事务和 reminder CAS+enqueue 事务都必须把
`SELECT ... WHERE gate_name='after-sign-v1' FOR SHARE` 作为**第一个有状态 DB 锁**，在持锁期间重查
对应 DB boolean、精确字面环境 flag 与 runtime readiness，并把该共享锁持有到业务事务 commit/
rollback。规范锁序是 admission row → instance `FOR UPDATE` → round/assignment/metrics → authority
rows；任何调用点不得先锁 instance 再倒序取得 admission row。

停止 producer 时，owner 先关闭 serving/scheduler 外层 admission，再以独立事务 `FOR UPDATE` 锁
singleton，把对应 boolean 改为 false、`generation = generation + 1` 后提交。排他锁会等待所有已进入
的共享锁事务终结；其提交后，新旧 pod 即使缓存了旧 readiness，也会在任何业务写前读到 OFF。
只有该 barrier 提交后，开放轮/consumer/lease/dead-letter 的同快照计数才有证明力。consumer drain
不得读取或依赖这两个 producer boolean。

重新开启时顺序相反：先完成 serving/worker exact-set 和所有 readiness，再在 owner-bound 事务中更新
DB gate，最后开启对应外层 admission；`generation` 只用于证据关联，不能被当成 fencing token 绕过
共享锁。本文不授权执行这些更新。

### 2.4 assignment 与 audit

激活后的 assignment 仍写入既有 `approval_assignments`，其 metadata 固定增加：

```json
{
  "addSign": true,
  "addSignMode": "after",
  "deferredRoundId": "<uuid>",
  "addedBy": "<actor-id>"
}
```

`addedBy`/目标 ID 只存在于权限受控的 assignment 与 seat 数据，不进入错误、metrics 或通用
`approval_records.metadata`。`after` 的 `add_sign` record 不写 `addedUserIds`，也不写单个
`target_user_id`；成员 timeline 需要的显示名从受权目录按 seat 精确解析，未解析者显示
values-free 占位，不回退 raw ID。现有 `before | parallel` 记录形状不在本锁中改变。

成员 history/timeline 在轮尚为 `pending` 时也必须可展示被加签人。分页的
`routes/approval-history.ts` 与 `ApprovalBridgeService.loadLocalHistory` 必须合成同一个公开后加签动作，
但各自保留当前 wire 基线，不能为了共享 helper 而互相扩权：分页 route 当前只投影其已公开的
metadata aliases，它只能新增 `metadata->>'deferredRoundId'` 私有 alias，不能开始返回整块 metadata；
bridge 当前返回完整历史 metadata，它必须保留所有既有非 after key/value，并只在返回前剥离
`deferredRoundId` 及本功能新增的内部 key。本 delta 不得借内部 round id 收窄 bridge，也不得借
bridge 的宽 wire 扩大 route。
服务端用内部 alias 读取 seat rows，并用**实例 org-scoped** 的最小显示名查询解析，不得直接调用当前全局
`resolveDirectoryUsersByIds`（它不按 org 限定且返回 id/name/email）。本功能新增的后加签目标摘要
只返回显示名与目标计数，不返回 user id、email、round id 或 seat id；既有非 after metadata 仍按
当前 wire 合同保留。内部 alias 必须像
`lock9_attachment_ids_raw` 一样在返回前剥离。无法解析的席位使用统一 values-free 占位。FE 不得
等 assignment 激活后才显示姓名，否则 pending 阶段会出现“已后加签但没有对象”的不可解释状态。
分页读取器必须先按内部 round alias 把审计对折成一个逻辑动作，再对逻辑动作执行
`COUNT/LIMIT/OFFSET`；不得先分页再在单页内合成，否则跨页的同一动作会重复显示或改变总数。
共享合成 helper 的 corpus 必须包含无 after 记录的历史页，并分别断言 route 的窄 aliases 与 bridge
的完整 metadata 和当前 main byte-compatible；只测新 after 记录或要求两条 wire 变成相同 metadata
形状都不能证明兼容。

后加签请求写两条既有 action vocabulary 的记录：

1. `approve`：表示 actor 在旧轮的真实决定，携带旧 `nodeEntryEpoch`、该轮
   `aggregateComplete` 与内部 `deferredRoundId`；
2. `add_sign`：表示创建延迟轮，携带 `deferredRoundId`、`addSignMode:'after'`、
   `addSignAggregation` 和目标数量。普通 timeline 合成展示一次“同意并后加签”，不得显示两条
   看似独立的用户动作。

不新增 `approval_records.action` 枚举成员，因此不重开 CHECK widening 链。

### 2.5 reminder dead-letter control

required alert、replay 与 disposition 不能只依赖当前进程内 observer。阶段 A1 的 transport migration
新增 approval-specific 控制表；它只接管本锁的新 consumer，不扩写其它 outbox consumer 的语义：

```sql
CREATE TABLE approval_timeout_reminder_dead_letter_controls (
  outbox_id text NOT NULL,
  consumer_key text NOT NULL,
  dead_letter_fence bigint NOT NULL,
  alert_state text NOT NULL DEFAULT 'pending',
  resolution_state text NOT NULL DEFAULT 'open',
  reason_code text NOT NULL,
  alert_attempts integer NOT NULL DEFAULT 0,
  next_alert_at timestamptz NOT NULL DEFAULT now(),
  alert_lease_expires_at timestamptz,
  alert_fence bigint NOT NULL DEFAULT 0,
  alert_ack_at timestamptz,
  alert_ack_source text,
  acted_by text,
  acted_at timestamptz,
  disposition_code text,
  replayed_consumer_fence bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (outbox_id, consumer_key, dead_letter_fence),
  FOREIGN KEY (outbox_id, consumer_key)
    REFERENCES meta_automation_outbox_consumer(outbox_id, consumer_key)
    ON DELETE CASCADE,
  CONSTRAINT approval_timeout_reminder_dead_letter_consumer_key
    CHECK (consumer_key = 'approval-node-timeout-reminder'),
  CONSTRAINT approval_timeout_reminder_dead_letter_fences_nonneg
    CHECK (
      dead_letter_fence >= 0 AND alert_fence >= 0
      AND (replayed_consumer_fence IS NULL OR replayed_consumer_fence >= 0)
    ),
  CONSTRAINT approval_timeout_reminder_dead_letter_attempts_nonneg
    CHECK (alert_attempts >= 0),
  CONSTRAINT approval_timeout_reminder_dead_letter_alert_state_valid
    CHECK (alert_state IN ('pending','in_progress','acknowledged')),
  CONSTRAINT approval_timeout_reminder_dead_letter_resolution_state_valid
    CHECK (resolution_state IN ('open','replayed','disposed')),
  CONSTRAINT approval_timeout_reminder_dead_letter_reason_code
    CHECK (reason_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CONSTRAINT approval_timeout_reminder_dead_letter_actor_nonblank
    CHECK (acted_by IS NULL OR acted_by ~ '[!-~]'),
  CONSTRAINT approval_timeout_reminder_dead_letter_disposition_code
    CHECK (
      disposition_code IS NULL OR disposition_code IN (
        'external_effect_confirmed',
        'business_obsolete',
        'manual_remediation_completed'
      )
    ),
  CONSTRAINT approval_timeout_reminder_dead_letter_lease_paired
    CHECK ((alert_state = 'in_progress') = (alert_lease_expires_at IS NOT NULL)),
  CONSTRAINT approval_timeout_reminder_dead_letter_ack_paired
    CHECK (
      (alert_state = 'acknowledged' AND alert_ack_at IS NOT NULL
        AND alert_ack_source IN ('observer','owner_action'))
      OR (alert_state IN ('pending','in_progress')
        AND alert_ack_at IS NULL AND alert_ack_source IS NULL)
    ),
  CONSTRAINT approval_timeout_reminder_dead_letter_actor_fields_paired
    CHECK ((acted_by IS NULL) = (acted_at IS NULL)),
  CONSTRAINT approval_timeout_reminder_dead_letter_resolution_actor_paired
    CHECK ((resolution_state IN ('replayed','disposed')) = (acted_by IS NOT NULL)),
  CONSTRAINT approval_timeout_reminder_dead_letter_terminal_acknowledged
    CHECK (resolution_state = 'open' OR alert_state = 'acknowledged'),
  CONSTRAINT approval_timeout_reminder_dead_letter_owner_ack_is_action
    CHECK (
      alert_ack_source IS DISTINCT FROM 'owner_action'
      OR (resolution_state IN ('replayed','disposed') AND acted_by IS NOT NULL)
    ),
  CONSTRAINT approval_timeout_reminder_dead_letter_replay_paired
    CHECK ((resolution_state = 'replayed') = (replayed_consumer_fence IS NOT NULL)),
  CONSTRAINT approval_timeout_reminder_dead_letter_disposition_paired
    CHECK ((resolution_state = 'disposed') = (disposition_code IS NOT NULL))
);

CREATE INDEX approval_timeout_reminder_dead_letter_alert_due
  ON approval_timeout_reminder_dead_letter_controls(next_alert_at, created_at)
  WHERE resolution_state = 'open' AND alert_state = 'pending';

CREATE INDEX approval_timeout_reminder_dead_letter_alert_lease_due
  ON approval_timeout_reminder_dead_letter_controls(alert_lease_expires_at)
  WHERE resolution_state = 'open' AND alert_state = 'in_progress';
```

`disposition_code` 是 values-free 闭集，区分
`external_effect_confirmed | business_obsolete | manual_remediation_completed`；不得存自由文本。
`acted_by` 留在权限受控表和审计，不进入普通证据面。

claim-time poison CTE 与 adapter terminal-poison resolver 必须在**同一数据库事务**中把 consumer
转为 `dead_letter` 并插入 `(outbox_id, consumer_key, resulting fence, alert=pending,
resolution=open)`；observer callback
不是提交条件，也不能替代该行。可重启 reconciler 每轮先用 `INSERT ... SELECT` 补齐任何 reminder
dead-letter 缺失的 matching-fence control，再按 `next_alert_at` 以 `FOR UPDATE SKIP LOCKED` claim，
进入带 lease/fence 的 `alert_state=in_progress`。alert sink 使用该三元主键派生的稳定幂等键；成功后
fence-CAS 为 `acknowledged` 并写 `alert_ack_source='observer'`，失败或 lease 过期回到可重试状态。
alert 本身不设静默 poison 上限：重复告警可以去重，
但不得因为 alert worker 崩溃永久失去观测。sink 成功后、CAS 前崩溃只允许重复告警，不允许漏告警。

owner-bound replay/disposition 事务按 control → consumer 的固定锁序，只接受
`resolution_state='open'`，且 consumer 仍为 `dead_letter`、fence 与 `dead_letter_fence` 相等。有未过期
`alert_state='in_progress'` lease 时拒绝并稍后重试，不能并发覆盖 observer。正常
`acknowledged + observer + open` 明确允许 owner replay/dispose：保留既有 `alert_ack_at/source`，只
原子写 terminal resolution/actor 和 replay 所需 consumer CTE。`pending` 或已过期 lease
允许 owner 操作在同一事务显式写 `alert_state='acknowledged'`、`alert_ack_source='owner_action'` 和
`alert_ack_at`，同时清 alert lease 并 `alert_fence=alert_fence+1`，使任何先前 alert worker 的 terminal
CAS 失效；同一 statement 还必须写 terminal resolution 与 actor，不能先提交
`open + acknowledged/owner_action` 中间态。所以操作本身是持久化 acknowledgement，不会绕过
required observation。

replay 以一条 CTE 把 consumer 改为 `pending`、清 lease/error、attempts 归零并 `fence=fence+1`，同时
把 control 的 `resolution_state` 标成 `replayed`、写 `acted_by/acted_at/replayed_consumer_fence`；任一
CAS 0 整体回滚。第二次 poison 使用新 fence 创建新 control 行。disposition 同样 owner-bound、
fence-CAS，只把 `resolution_state` 标成 `disposed` 并保留 consumer dead-letter；它不能伪装成外部
送达成功。本文不授权 operator endpoint 或实际 replay。

reconciler 的 `batchSize` 限 `1..200`，`leaseMs/retryBaseMs/retryCapMs` 均为 `1000..86_400_000` 的
JS safe integer，且 base 不得大于 cap；全部在任何查询/告警前验证。实现不能依赖 full-table scan，
必须用上述 due/expired partial indexes。

## 3. API 与运行时合同

### 3.1 请求

`ApprovalActionRequest.addSignMode` 与 HTTP route 同时扩为
`'before' | 'parallel' | 'after'`；未知值必须 400
`APPROVAL_ADD_SIGN_MODE_INVALID`，不得继续归一为 parallel。

新增 `addSignAggregation?: 'all' | 'any'`：

- `after` + 一个去重目标：字段可缺失，服务端规范化为 `all`；
- `after` + 两个及以上目标：字段必填；
- `parallel`：字段必须缺失，继续继承当前节点聚合；
- `before`：当前仍是诚实兼容模式，字段必须缺失；
- `after` 位于 parallel region：409
  `APPROVAL_ADD_SIGN_IN_PARALLEL_UNSUPPORTED`。

`after` 的 `targetUserIds` 协议边界是严格数组：先拒绝未知 mode；mode 已确认为 `after` 后，key
缺失、非数组、空数组、任一非字符串元素、任一 trim 后空字符串都返回 400
`APPROVAL_ADD_SIGN_TARGET_INVALID`。route 不得过滤坏元素后继续，service 必须重复验证。严格
验证后才计算一人/多人 aggregation；重复、actor 自选和实例内任一活跃 user assignment 重叠也
使用同码拒绝。before/parallel 保持当前 main 的 target 过滤/coerce 与错误形状，不共享该新门。

flag OFF 时合法 `after` 返回 409 `APPROVAL_AFTER_SIGN_DISABLED`；未知模式仍先按协议边界返回
400，不能因为 flag OFF 又落回 silent coercion。

新增实例作用域管理员恢复端点
`POST /api/approvals/:id/deferred-add-sign-rounds/pending/cancel`，沿用现有 admin jump/reassign 的
`approvals:admin` 守卫，并沿用现有管理动作 body 字段 `version`，经
`normalizeApprovalVersion` 取得 expected version。它不要求管理员先知道不可见的 round ID；事务内
`FOR UPDATE` instance 后，必须在当前节点找到恰好一条 `pending` 轮，CAS 为 `cancelled`、写
`operator_cancelled`、写 values-free `sign` audit 并 bump version。0 条返回 404，多条或 active/
completed 形状 409/500 fail closed。该端点在 after-sign flag OFF 时仍可用；普通成员不可见
round/seat 原始 ID。取消表示放弃本次后加签并恢复 origin 轮继续处理，不代表自动重建目标；旧席位
可直接重试完成，也可重新选择合格目标再发起 `after`。

### 3.2 后加签请求的事务顺序

在既有 `dispatchAction` 的实例 `FOR UPDATE` 事务中：

1. 完成 actor seat、card binding 与 nodeOperationPolicy 等现有门。当前 comment gate 位于
   `add_sign` 早返回之后，因此实现必须只为 `after` 显式执行与普通 approve 相同的
   `commentRequired:'always'` 检查；不得把这次收窄扩到现有 before/parallel；
2. 校验 mode、目标闭集、aggregation、非 parallel region、无开放延迟轮，并执行 §2.2 的
   活跃用户 + 实例同组织 exact-set 硬门；
3. 读取当前唯一 epoch。若返回 NULL（迁移前旧 assignment 轮），409
   `APPROVAL_AFTER_SIGN_LEGACY_EPOCH_UNSUPPORTED`，actor/台账/audit/version 零变化；不得用
   `0` 哨兵或临时 backfill 绕过。非 NULL 时按原节点真实 `approvalMode`（含缺省规范化的
   `single`）计算“actor 这一票之后旧轮是否完成”；
4. 插入 `pending` 轮和 seat rows；
5. 消费 actor assignment，写 `approve` + `add_sign` records；
6. 若旧轮未完成，只 bump instance version 并提交；兄弟席位保持旧 epoch；
7. 若旧轮完成，先按现有 `single`/`any`/`threshold` 规则停用或审计取消未决兄弟，再调用 §3.3
   的共享激活 helper；`single` 必须保留 linear 路径当前的 blanket-deactivate first-wins 语义；
   helper 必须对刚写入或既有 pending seat 执行相同的第二次 exact-set。返回
   `deferredRoundActivated:true` 时不得调用 `resolveAfterApprove`，实例留在同一图节点；返回
   `false` 说明当前 origin epoch 没有 pending 轮，调用方必须继续既有 `resolveAfterApprove`；
8. enqueue 新激活席位的 task-created durable events，提交后走既有 legacy emit；flag-OFF durable
   语义保持既有路径。

旧轮聚合计算不能复制第二套 `single/all/any/threshold` 分支。实现必须提取一条共享的“消费一票并
判断当前轮是否完成”内部路径，让普通 approve 与 after-sign 的旧轮消费共同调用；删除任一调用点
应由接线测试变红。

### 3.3 pending → active 激活

当 after-sign 自身或任一后续普通 approve 使旧轮完成时，在图前进前调用唯一共享激活 helper。
调用方已持有实例 `FOR UPDATE`，并把当前完成的 origin epoch 传入。helper 顺序固定为：

1. 查询并锁定同节点、同 origin epoch 的 pending round。0 行是普通无后加签审批的正常路径：
   立即以零写入返回 `deferredRoundActivated:false`，不得锁 metrics、bump seq 或检查历史
   completed/cancelled round；多行 500 fail closed；
2. 若恰有一行，锁定全部 seat rows，按 §2.2 的用户活跃 + 实例同组织谓词重取匹配
   `users/user_orgs` 的 `FOR SHARE` 锁并执行第二次 exact-set。失败抛
   `APPROVAL_AFTER_SIGN_TARGET_STALE`，使触发旧轮完成的整个事务回滚；不能 subset-activate；
3. 锁定该实例恰好一条 `approval_metrics` 行并计算新 timeout/calendar deadline。business
   calendar 按既有 T3-2 语义 fail-open 到 wall-clock；只有 metrics 缺行、多行、六列 UPDATE
   结果不是一行或其它事务写失败才回滚；
4. 用一条数据修改 CTE 锁定 pending round 与实例，计算 `next_epoch =
   node_activation_seq + 1`，在同一 statement 内同时把轮改为 `active`、写入
   `activation_entry_epoch/activated_at`，并把实例 seq 更新到 `next_epoch`；最终
   `RETURNING round_id, aggregation, next_epoch`。CTE 的 candidate 必须同时包含并校验
   `round.status='pending'`、`instance.status='pending'`、当前 node 与 round node 相同、当前
   `node_activation_seq=origin_entry_epoch`；任一谓词不满足都不得 bump seq；
5. 已选定具体 round id 后 CTE candidate 为空时，轮与 seq 均不得变化；复读发现同一 round id
   已经 active/completed 时，只有
   seat exact-set、activation epoch 和 assignment exact-set 全部吻合才可视为幂等重放，否则
   500 fail closed；
6. 非幂等候选的 CTE 最终未返回一行、seq CAS 未命中或返回多行时必须抛错并回滚整个事务；
7. 从 seat 表创建新 assignment，全部使用新 epoch；
8. 直接更新已锁定 metrics 行的六列：`current_node_deadline_at`、
   `current_node_timeout_effect`、`sla_due_at`、`sla_timezone`、`sla_calendar_org_id`、`sla_unit`。
   节点无 timeout 时六列全部清空；wall-clock/business timeout 分别写完整新值；UPDATE 必须恰好
   一行。保留既有 `node_breakdown` 的同节点 open entry，不伪造一次图节点重入；不得调用会因
   open entry 而 no-op 的 `emitNodeActivationMetric` 充当此门；
9. 保持 `approval_instances.current_node_key/current_step/status` 不变，只更新 version；事务结果
   明确返回 `deferredRoundActivated:true`，post-commit 层据此跳过旧轮的
   `emitNodeDecisionMetric`；
10. task-created events 在同事务 durable enqueue；旧轮卡片依赖 assignment+epoch 绑定自然失效，
   新轮卡片由新 task events 产生。

为满足 AS-I7 和 `state_paired` CHECK，禁止先单独提交 `status='active'` 再补 epoch。CTE、
assignment、SLA、outbox 任一步失败都必须回滚，所以任何可观察提交态都不得出现
`status='active' AND activation_entry_epoch IS NULL`，也不得出现 active 台账无对应 active
assignments。并发测试必须证明 candidate 为空时不会先空增一次 seq。

timeout 路径同时收窄：`scanNodeTimeouts` join 实例后返回 deadline/effect/node/activationSeq
扫描快照。`transfer/jump` 把完整 tuple 传入现有 `applyNodeTimeoutEffect` 事务，锁实例和 metrics
后逐字段相等才可消费/执行；传 `(instanceId,effect)` 的旧签名必须删除。`remind` 的 transport
选择发生在任何 CAS 前：durable-reminder runtime ready 时调用
`consumeAndEnqueueNodeReminder`，同样锁行并 exact-tuple CAS 清 deadline/effect，在同一事务通过
manifest v2 专用 seam 写 outbox；它不直接调用通知器。transport OFF 且实例无开放 deferred round
时才走当前 notify-then-mark 兼容路径；存在开放轮或 readiness 不完整时保持 deadline 不变并重试。
专用 enqueue 返回 null 或 consumer readiness 丢失都按事务失败处理，不能读成“无需提醒”。consumer
按 AS-I12 复核 pending status、node/epoch 与非空 live assignee set，再用稳定 eventId 调 adapter。
任一路径 CAS 0 都不得解析收件人或产生外部效果。旧扫描在同节点新轮激活后必须 0 行，不得通知、
transfer、jump 新轮，也不得清空第 8 步的新值。

### 3.4 active 轮的聚合与完成

新增一个服务层 `effectiveApprovalMode(instanceId, nodeKey, currentEpoch)`：

- 若存在 `status='active' AND activation_entry_epoch=currentEpoch` 的轮，返回其 `all | any`；
- 否则返回 frozen graph 的 `executor.getApprovalMode(nodeKey)`；
- 多行、epoch 不一致或 active 轮找不到同 epoch 的 live assignment 均 500 fail closed；
- active 轮的冻结 seat 只需证明激活时的初始 assignment exact-set。合法同轮 mutation 后，当前
  live assignment 与 seat 不再一一对应是预期状态，不能因此 500；新增行的 round 归属由
  `entry_epoch=currentEpoch` 证明。

所有真实 approve 入口仍统一经过 `dispatchAction`，所以聚合只在这一处取 effective mode。
active 延迟轮完成时，先 CAS `active → completed`，再调用图的正常
`resolveAfterApprove(currentNodeKey)`；audit 的 `approvalMode` 使用 effective mode，而不是图上原值。
Lock-1 OD-L1-3 已 ratify `prior_node_approver` 只读取 latest epoch；延迟轮的新 epoch 因而成为该
节点的 latest round，后续节点只解析延迟轮真实 deciders，不与 origin round 取 union。本文保持
这项已 ratify 语义并用回归测试钉住；若产品要跨轮 union，须另立 Lock-1 delta。

### 3.5 取消矩阵

| 事件 | pending | active |
|---|---|---|
| reject | cancelled，同事务 | cancelled，同事务 |
| return | cancelled，同事务 | cancelled，同事务 |
| admin jump | cancelled，同事务 | cancelled，同事务 |
| timeout jump | cancelled，同事务 | cancelled，同事务 |
| instance terminal/cleanup | cancelled，同事务 | 正常轮完成先 completed；外部提前终止则 cancelled |
| 管理员取消 pending round | cancelled，旧轮继续 | 不允许，409 |
| transfer / timeout transfer | 保留 | 保留，epoch 不变 |
| admin reassign / handover | 保留 | 保留，epoch 不变 |
| reduce-sign | 保留；不能命中尚未激活 seat | 保留；禁止移除自己的最后一个活跃 seat |
| parallel/before add-sign | 保留 | 作为当前 active 轮的同轮 mutation，保留 epoch |
| second after-sign | 409，不变 | 409，不变 |

每个“离开节点”调用点必须调用同一 `settleOpenDeferredAddSignRound`，不能散落手写状态更新。
源码 exact-set gate 列举这些调用点；从真实 dispatcher 删除任一调用时，对应真库测试必须变红。

## 4. 兼容、迁移与启用

1. 新增四表，并给 `approval_instances.current_node_target_generation` 加 `DEFAULT 0`；除该确定性列
   回填外无业务状态 backfill。admission singleton 默认双 OFF，旧实例没有轮台账，所有读取返回 absent，
   行为与当前 main 相同。
   仍在 NULL `entry_epoch` 上运行的旧实例只对 `after` 返回 §3.2 的 values-free 409；普通
   approve 与现有 `before | parallel` 不变。
2. migration 先于阶段 A1 兼容镜像；镜像回滚后表保留，不执行 destructive down。阶段 A1 的每个
   serving/dispatcher pod 都能读取、激活、完成、取消既存 deferred round，dispatch v1/v2 rows，
   注册 `approval-node-timeout-reminder` adapter，并暴露 `approvalAfterSignProtocol='v1'`，但
   durable-reminder 与 after-sign writer flags 均为 OFF，current producer manifest 仍是 v1。boot
   completeness 使用 supported-manifest route union，claim SQL 实际过滤 supported version；只声明
   `SUPPORTED_MANIFEST_VERSIONS` 而不进入 claim 路径不算支持。
3. 阶段 A2 先证明 worker exact-set 全部支持 `{1,2}` 与新 consumer，再把 producer/current manifest
   切 v2；随后证明 `AUTOMATION_DURABLE_DELIVERY_ENABLED=true`、dispatcher/consumer readiness
   完整、旧 v1 行仍可排空，才允许打开 `APPROVAL_DURABLE_TIMEOUT_REMINDERS_ENABLED`。任何 pod
   只支持 v1、adapter 缺失、dispatcher OFF 或 enqueue facade 返回 null 都停止，且不得清 deadline。
   `producerEnabledChannelKeys` 必须是全 worker `workerDrainableChannelKeys` 交集的子集；channel 增删/
   改名必须执行 AS-I12 的 worker-first/producer-first drain 顺序，不能把配置热改当成无状态操作。
4. 阶段 B 激活 after-sign 前还必须同时满足：serving pod 协议 exact-set 全为 v1、四表与 constraints
   在位、migration pending=0、durable-reminder 已真运行、required + real-DB + rolling-version gate
   全绿。少一个或无法枚举全部 serving/worker pod 都停止。
5. 新 flags `APPROVAL_DURABLE_TIMEOUT_REMINDERS_ENABLED` 与 `APPROVAL_AFTER_SIGN_ENABLED` 都登记到
   global-history flag manifest，默认 OFF，精确 `'true'` 才开启；前者必须先于后者。该 manifest、
   routing manifest v2、outbox writer 和 `users/user_orgs` authority reads 都属于当前
   Time Machine E1/shared-surface HOLD；即使本文 ratify，也必须等 ownership、writer/lease census
   与独立对抗测试另行放行后才能实现或合并相应 runtime delta。
6. FE 只有在 capability/flag read 为 true 且服务端协议 v1 时显示“后加签”；服务端永远是新请求的权威门。
   flag 从 ON 改为 OFF 后，既有 pending/active 轮仍由常驻状态机继续排空；不得以 flag 跳过
   §3.3 或取消矩阵。
7. 回滚必须先把 after-sign writer 与 reminder producer admission 在所有 pod 关闭，再按 §2.3
   取得 singleton 排他锁、把对应 DB gates 置 OFF 并递增 generation；只有排他事务提交才证明此前
   已准入 producer 全部终结。consumer 继续运行。随后同一数据库事务快照证明 `pending | active` 开放轮
   为 0，相关 consumer `pending | in_progress` 为 0、无活 lease，且每个 `dead_letter` 已修复重放或
   有 owner 逐行豁免。计数后仍能并发 enqueue、活 lease/backoff in-progress 或未处置 dead-letter
   任一存在都禁止关闭 reminder/global durable transport，也禁止回到 v1/manifest-v2 兼容处理器
   之前；不得以“关闭 flag”代替排空证明，也不得让旧 pod 在 writer 开启时重新加入 serving set。
8. UI 选择两个以上目标时显示“会签/或签”；单目标不显示无意义选项。
9. disabled 模式不创建表外写入、不更改 before/parallel 的 assignment、版本、audit 或 copy。
10. 实现不得压成一张跨域大 PR：先以独立 E1/shared-writer 切片交付 manifest v2、supported-version
    claim、per-channel reminder consumer、dead-letter control/reconciler 与 transport gates；再以
    approval runtime 切片交付轮表、seat、admission singleton、状态机
    和 `users/user_orgs` 锁序；最后才是 FE exposure。每片分别提交 exact head/base、迁移、flags、
    writer/lease/authority census 与对抗证据给 merge coordinator，前片未落 main 不开始后片激活。

## 5. 判别性验证门

所有 DB 门在 PostgreSQL 15 真库运行，`EXPECT_DB=1` 时不得 skip；新 FE spec 同时进入
`approval-web-guard.yml` 与 `run-required-web-tests.sh`。

**AS-G1 协议双门。** route 与 service 都接受 `after`；未知值 400。分别回退任一门，指定测试红。

**AS-G2 单席位立即激活。** actor 后加签一个人：actor approve 与 add_sign audit 同事务，
旧 seat inactive，新 seat 在新 epoch active，seq 恰好 +1，节点不前进；新 seat approve 后才前进。

**AS-G2a 无 pending 的普通完成。** 不创建任何 deferred round，普通 all/any/threshold 的最后一票
仍返回 200 并按既有图前进；共享 helper 返回 `deferredRoundActivated:false`，metrics、seq、台账、
outbox 不产生额外写入。把“0 pending”改回异常或在 no-op 前锁 metrics/bump seq 时测试红。

**AS-G2b origin single。** 原节点有两个及以上活跃席位，分别以缺省 `approvalMode` 和显式
`single` 建立真库正控；actor 执行 after-sign 后 origin 轮立即完成、其余 origin 席位全部 inactive、
延迟轮激活且节点不前进。把共享消费路径中的 `single` 删除、改成 `all`，或绕回仅
`all/any/threshold` 的分支时指定测试红。

**AS-G3 多席位 all。** actor 后加签后，兄弟仍可 200 approve，期间 active epoch distinct 始终
为 1；最后兄弟完成时激活新轮，绝不出现 MIXED；新轮全员完成后前进。

**AS-G4 原节点 any。** actor 的后加签动作完成旧 any 轮、按既有 audit 取消兄弟并立即激活
新轮；兄弟旧卡不能再行动，新轮卡可行动。

**AS-G5 原节点 threshold。** threshold 未达时 pending；达到时只计 origin epoch 的旧票并激活。
旧 epoch 票不得满足新轮，新轮 aggregation 不得误用原 threshold。

**AS-G6 新轮 all/any。** 两个目标分别验证 all 需两票、any 第一票完成并审计取消兄弟；删
`effectiveApprovalMode` 覆盖时两者至少一项变红。

**AS-G7 并行拒绝。** parallel region 的 after 409，线性同配置成功；错误 values-free。

**AS-G8 第二轮拒绝。** pending 与 active 各自再发 after 均 409，台账、seat、version 零变化。

**AS-G8a 目标身份。** 对 `after`，inactive user、无同 org membership、inactive membership、
跨 org user、非数组、数组中的 null/number/object、trim 后空字符串、重复 target、actor 自选、
实例内已有活跃 user seat 各自 400 且响应同码同形；不得先过滤坏元素再用剩余人数决定
aggregation；同 org 活跃用户正控成功。相同脏数组送给 before/parallel 时保持当前 main 的过滤/
coerce 行为，证明新严格门没有上移到共享 route。
删除 users 门、org join、exact-set 比较或 overlap 门时，各自指定测试红。实例 org NULL 单独
409 且不能用 actor tenant/default 放行。

**AS-G8b pending 目标漂移与恢复。** 创建 pending 后停用 user 或同 org membership；最后旧席位
approve 返回统一 stale 409，且该席位仍 active、轮仍 pending、audit/version/seq 零变化。管理员
激活校验开始后并发停用同一 user/membership 必须等待其 `FOR SHARE` 锁；停用先提交则 exact-set
返回 stale。取消端点以 body `version` 成功后，该席位可直接重试前进，也可替换为合格目标重新发起 after；
成员调用 403、无 pending 轮 404、active round 409。flag OFF 时管理员仍可取消。删除共享激活
helper 的第二次 exact-set、激活时共享锁、事务回滚或 admin guard 时各自指定测试红。

**AS-G9 事务失败注入。** 在 admission 共享锁后、actor consume 后、CAS 后、epoch/target-generation
bump 后、assignment insert 后、outbox enqueue 后分别注入失败；每处都必须回滚到无半轮、无孤儿 seat、无 version
漂移，且共享准入锁随事务释放。删除任一 producer 调用点的 admission-first 获取或把它移到实例锁
之后时，锁序/行为门必须变红。

**AS-G10 fence 与陈旧元组。** 两个完成旧轮的并发请求只能一方激活；seq 只 +1、assignment
每人一行、task-created 每人一个 durable intent。该并发正控只能证明实例锁的串行化，不能单独
证明 CTE predicate 承重。另用直接真库 fixture 逐一构造：round 已非 pending 但实例/node/seq/live
set 全匹配、轮仍 pending 但实例已前进到另一节点、实例 seq 已离开 `origin_entry_epoch`、实例已
terminal、origin live assignment 混入另一 epoch；每个 fixture 只改变对应一个谓词字段，其余
前提保持正控形状，并都必须零 round/seq/assignment/outbox 写入且 fail closed。分别删除
`round.status='pending'`、`instance.status='pending'`、node equality、seq equality 或 origin epoch
exact-set 任一谓词时，只有对应 fixture 变红；candidate 为空的重放不得空增 seq。只在实例
`FOR UPDATE` 下跑两个请求、却不直接击中每个 predicate，不算本门通过。

**AS-G11 取消矩阵。** reject/return/admin jump/timeout jump 各有一条 pending 或 active 真库
路径；pending 实例 terminal 只能 cancelled，active 正常完成先 completed、外部提前终止则
cancelled。离开节点后无 open 轮、无该轮 active assignment。从任一真实调用点删除 settle
调用，对应测试红。`revoke` 不列入本门：after-sign 已写真实 approve，现有 revoke window 会关闭。

**AS-G12 同节点 mutation。** 初始 activation set 与 seat rows 保持冻结；transfer、timeout
transfer、reassign、handover 保持 active 轮 epoch，不取消、不 bump。parallel/before add-sign
进入 active 后加签轮仍保持 epoch并按 live assignment 数参与该轮聚合；不得据此改写 seat 表。
上述每个 live-set mutation 与 reduce-sign、departure transfer 都必须在同一事务恰好 bump 一次
`current_node_target_generation`；源码 writer census 删除任一真实调用点的 bump 时 required 红。
分别在 backend service、AfterSales/PLM bridge 与根 attendance plugin 放置可回滚 canary 写点，守卫都
必须发现；被排除的非 platform/source-system 写点用可执行 fixture 证明不命中，而不是扩大 ignore。
每一种 mutation 后都必须继续提交下一票并走到真实完成判断：`all` 只在当前 epoch 的全部 live
assignment 完成后前进，`any` 在第一票后前进并停用其余 live assignment；冻结 seat 与 live set
不再一一对应不得触发 500。只断言 epoch/seat 未变而不执行下一票，不算证明聚合器已按 live set
工作。

**AS-G13 卡片、SLA 与 timeout delivery。** 旧 epoch 卡在激活后 fail closed，新轮卡成功；新轮
deadline 从激活时重新计算；无 timeout 节点会清空旧 deadline，有 wall-clock/business timeout
的节点各自取得完整新时限；calendar provider unbound/返回 null/抛错时与 T3-2 一样 fail-open
到 wall-clock，不得 500。metrics 行缺失/更新失败必须回滚激活；删除事务内六列 reset、恢复
`emitNodeActivationMetric` 或恢复旧轮 post-commit `emitNodeDecisionMetric` 时，各自时间控制测试红。

对 `remind | transfer | jump` 各自构造“旧扫描完成后、新轮激活后才执行”的交错。执行器必须携带
扫描到的完整 `{nodeKey,deadlineUtc,effect,activationSeq}`，exact-tuple CAS 返回 0，且收件人解析、
outbox、通知、transfer、jump 调用次数均为零；改回 `(instanceId,effect)`、重读 live tuple、忽略
affected-row 或删任一 tuple predicate 时，其对应 effect fixture 变红。

remind 另做三点 crash-injection：exact-tuple CAS 前崩溃时 deadline 与 intent 都不变；CAS 后、
enqueue 前失败时同事务整体回滚；事务提交后、dispatcher 前崩溃时 intent 仍可被重放。adapter
失败保持可重试；相同 live assignee exact-set 的重复 dispatch 使用同一 deliveryKey，幂等 endpoint
只产生一次外部效果。精确 target tuple 的测试证明只改显示名/email/metadata 时 fingerprint/key 不变，
type、internal id 或成员集合变化时 key 改变。unknown assignment type、空/纯空白/非字符串 id 分别
零 send、零 done；用 `String()` 或 trim 后继续的 mutation 必须红。

另构造三条交错：A 发送成功后 worker 在写 done 前崩溃、随后同 epoch transfer A→B；worker 解析
A 后、send 前 transfer A→B；worker send A 成功后、terminal CAS 前 transfer A→B。三例都必须因
generation/fingerprint mismatch 不写 done、以新 deliveryKey 向 B 产生一次效果，B 的再次重放被去重；
中和 mutation writer 的 generation bump、post-send 重读、fingerprint 比较或 mandatory custom resolver，
各自使对应测试红。若仍直接用 eventId 去重或走通用 `completeConsumer`，测试必须红。
另分别中和 transaction provider 的 single-client 保证、删除 completion token 传递、把 custom success
或 poison 接回 generic terminal fallback；对应真库门必须红，且 adapter 完成后只能出现一次 terminal
resolver 调用。success/poison resolver 各自返回 `lostLease` 时必须进入现有同名计数，不得造第二套
disposition。token 的 generation 前导零/负号/空串、非 64 位或大写 fingerprint、getter、throwing
Proxy、透明 Proxy、字符串额外 key、symbol extra-key、继承 key、错误 prototype 各自映射 retryable，
且 terminal resolver 调用为零；删除每个 descriptor/grammar/Proxy/exact-own-key 门时对应测试红。
另在 parser 返回后暂停 transaction provider，修改 adapter 原 token 为当前 live target；resolver 必须
仍收到 `Object.isFrozen(token) === true` 的原 descriptor-value 快照，因 mismatch 返回 `rescheduled`，
不得错误写 `done`。把 resolver 参数改回原 token 引用或删除 `Object.freeze()` 时，该交错测试必须红。
不支持幂等的 endpoint 明确验证可能重复。enqueue 后、dispatch 前分别让实例完成、reject、
return、jump：consumer 都以 terminal-stale 完成且零通知；同 epoch transfer 后的正控通知新的
非空 live owner，而不是冻结 seat。恢复“清 deadline 后直接 notify”、把 enqueue 移出事务、在
CAS 前解析收件人、漏 `instance.status='pending'`/node/epoch/live-set 任一 consumer predicate，或
让 stale intent 通知当前轮时，各自指定测试红。

transport 另有三条判别：global durable OFF、durable-reminder OFF、consumer/manifest readiness
不完整或专用 enqueue 被 mutation 成 `null` 时，开放 deferred round 的 deadline 保持且无 intent；
无开放轮、after-sign writer 也 OFF 且 durable-reminder OFF 时，旧 remind 仍走当前 main 的
notify-then-mark 字节兼容正控，同时 after-sign 请求必须 runtime-not-ready，证明 legacy 腿不能与
deferred round 共存。普通节点 legacy reminder 的既有 stale-scan ABA 不由本 delta 虚报为已修，
见 §6。manifest v1 worker 与 v2 producer 的混合部署不得开启 transport；v1+v2 worker exact-set、
v2 producer 与 consumer ready 的正控才可提交 intent。只测部署文档、不实跑这些状态，不算本门通过。

每个 configured channel 产生独立 eventId/outbox row。eventId subject 必须按 AS-I12 做 canonical
JSON；固定 SHA-256 vectors 至少覆盖包含分隔符/转义字符的不同 tuple 产生不同 subject/hash、等价
时区输入规范化到同一个 DB UTC 微秒文本后同 ID、channel 不同则不同 ID、同一 tuple 重放同 ID。
真库覆盖 `integer` 实际边界和微秒 deadline 往返；seq 超过 `2^53` 明确只在纯 serializer 测试中
证明十进制字符串不经 JS number。PostgreSQL 固定 vector 至少钉住
`2026-08-26 12:34:56.123456+08` → `2026-08-26T04:34:56.123456Z`；更换 SQL format mask 时该门必须红。
零 channel、上下文读取失败、channel 缺失、
`send` throw、`ok:false` 分别保持其 consumer retryable；两个 channel 一成一败时成功行 `done`、失败
行仍可重试，重试不再次调用成功 channel。把专用 single-channel handler 换回 always-resolve 的
`notifyNodeReminder`，或把多个 channel 折回一个 consumer row 时，其判别测试变红。readiness 至少
要求一个合法 channel key；未知 key fail closed 且不回显配置值。

channel 生命周期另做真实行交错：A 已加入 worker drain 集与 producer 集并写出 intent 后，把 producer
配置切到 B。只要 A 的 pending/in-progress/dead-letter disposition 未清，A 必须继续留在每个 worker
drain 集并可完成；删除/rename 不能让 A 被 unknown-key 停住或误由 B adapter 解释。新增 B 时若任一
worker 尚未 drainable，producer 不得写 B；分别中和 producer-subset、producer-first removal、A drain
计数或 worker-last removal，指定测试红。

dead-letter 做独立状态机门：claim-time poison 与 adapter poison 各自证明 consumer transition 和
§2.5 `alert_state=pending/resolution_state=open` 同事务；分别在 transition 提交后、observer 前杀进程，重启 reconciler 仍必须
claim 并告警。alert callback throw、alert worker 在 sink 成功后/CAS 前崩溃、alert lease 过期、重复
reconcile 都不得留下无后续行；同一三元键的 alert sink 最多一个幂等效果。owner replay 只在 matching
consumer fence 下原子恢复 pending 并 bump fence；旧 fence/zombie/第二次 replay 影响 0 行。未过期
`alert_state=in_progress` lease 下 replay/disposition 均拒绝；pending 或过期 lease 的 owner 操作必须
在同事务写 `acknowledged/owner_action`，不能只改 resolution。replay 后再次 poison 创建新 fence
control；disposition 保持 consumer dead-letter 并写固定 code。分别只填 `acted_by`、只填 `acted_at`
都由 DB CHECK 拒绝。中和任一 poison-side insert、missing-control reconciler、alert lease/fence、
ack pairing、actor-field pairing、resolution actor pairing、replay fence-CAS 或 disposition pairing
时，指定测试红。owner 接管 expired alert lease 后，旧 alert worker 的 terminal CAS 必须因
alert-fence bump 影响 0 行；删除该 bump 时测试红。删除 due/expired partial index 或绕过 numeric
bounds 的结构门也必须红。只断言 observer 被调用不算通过。

跨轴 DB 负例必须逐条拒绝：`replayed + alert pending`、`disposed + alert in_progress`、以及
`open + acknowledged/owner_action`；删除 terminal→acknowledged 或 owner-action→terminal/actor 任一
CHECK 时，只让对应 fixture 变红。observer acknowledgement 后保持 `resolution=open` 是正控；owner
action 则必须在同一 statement 同时 acknowledgement 与 terminal resolution。
并发门另覆盖：observer 先提交 `acknowledged/observer/open` 后 owner replay 与 disposition 分别成功
且保留原 ack；owner 接管 expired lease 后旧 observer fence-CAS 为 0；未过期 live lease 下 owner
仍拒绝。删除 acknowledged-owner 分支时 observer-first 测试必须红。

**AS-G14 comment policy。** `commentRequired:'always'` 的 after-sign 无评论被拒；普通 optional
配置成功。before/parallel 在同一模板下保持当前 main 响应，不得把新门扩到旧模式。不得因动作名
是 add_sign 绕过“消费 approve”的政策。

**AS-G15 flag 准入与排空。** after-sign OFF 时新的合法 after 409 且数据库零变化；before/parallel
与当前 main 的全响应和状态快照相同。即使 after-sign flag ON，global durable、durable-reminder、
manifest v2、本 pod protocol 或 consumer readiness 任一不满足也返回 runtime-not-ready 409，零写入。
先在全部门 ON 创建 pending，再只切 after-sign writer OFF，最后旧兄弟 approve 必须仍按 §3.3
激活并最终完成；不能留 open round，也不能静默取消。开放轮或 reminder intent 非零时关闭
durable-reminder/global durable，调度器必须保留 deadline/intent 并 fail loud，不能退回 legacy
direct notify。producer admission OFF 后 consumer 必须继续排空；管理员 pending-cancel 在 writer
OFF 时仍可用。DB singleton 任一 producer boolean 为 OFF 时，即使对应环境 flag 与缓存 readiness
仍为 ON，新事务也必须在实例锁/业务写之前拒绝；DB boolean 为 ON 而外层 flag OFF 时同样拒绝，证明
singleton 不能独立授权。

**AS-G16 DB constraints。** 非法 status/aggregation/cancel reason、负 epoch/target generation、空白 node/creator/
assignee、状态字段错配（含 cancelled 半配 activation 字段）、重复 open round、重复 seat、重复
ordinal，以及 dead-letter control 的错误 consumer key、负 fence/attempt、非法 alert/resolution state
或 reason、lease/
actor/replay/disposition 半配，均由具名 constraint 或 index 拒绝；迁移重放幂等。

**AS-G16a 旧 epoch。** NULL epoch 旧实例请求 after 返回指定 409，actor seat、audit、台账、
version 均不变；普通 approve 的 legacy fallback 与 before/parallel 回归保持当前 main。

**AS-G17 timeline。** 一次 after-sign 在成员 timeline 合成为一个动作，但内部两条审计均存在；
轮仍 pending、尚无 assignment 时就能显示 seat 对应的授权目录名称与计数。分页 route 继续只
返回当前已公开的窄 metadata aliases，bridge 继续返回当前完整 metadata；两者各自另取内部 round
alias，不能互相扩大或收窄。org-scoped 显示查询不调用全局 directory helper，内部 alias 在 wire
前剥离，wire 不返回
deferred round/seat/user id/email；无法解析者只显示 values-free 占位。权限受限查看者不看到 raw
target IDs。分页 route 与 `ApprovalBridgeService.loadLocalHistory` 必须产生同一个合成动作形状；用
page size 1 让 `approve`/`add_sign` 原始行跨页，仍只能得到一个逻辑动作、正确 total 且任一页不泄漏
内部 alias，证明合成发生在 `COUNT/LIMIT/OFFSET` 之前。非 after 历史的 byte-compat corpus 覆盖
两读取链当前各自已返回的 metadata key/value，升级前后逐字段一致；route 不新增整块 metadata，
bridge 合成器只能删除本功能新增的内部 round alias，不得把既有 metadata 收窄为 allowlist。
下一节点的 `prior_node_approver` 继续只读取
latest epoch，延迟轮完成后不得把 origin round deciders 重新 union 进来。

**AS-G18 crash replay。** durable delivery ON 时，在事务提交后、adapter 前崩溃并重启：新轮 task
仍被派发且 sink 幂等；不得因重放创建第二台账或第二 assignment。

**AS-G19 滚动版本与回滚。** 阶段 A1 的 worker exact-set 中只要存在一个不支持 manifest `{1,2}`、
未注册 reminder consumer 或未报告 `approvalAfterSignProtocol='v1'` 的 pod，producer 保持 v1，两个
新 flag 均保持 OFF。A2 先证明 v1 row 可被新 worker 排空，再切 producer/current manifest v2；
global durable/consumer 未 ready 或任何 enqueue 返回 null 时 reminder flag 仍不能开。全 worker
v1+v2、全 producer v2、dispatcher 与 consumer ready 才是开启 reminder transport 的正控；在此
基础上 serving protocol exact-set 全 v1 才允许 after-sign writer ON。writer 已经创建开放轮后，
尝试把任一 pod 降到 v1/manifest-v2 之前必须被发布门拒绝；先关 writer但开放轮或 pending reminder
intent 非零也仍拒绝。A1 boot 对 supported manifest route union 做双向 exact-set；claim fixture
同时放入 v1、v2、未知 v3 rows，worker 只 claim `{1,2}`，v3 保持 pending 并告警；另放 known key +
unsupported v3 + expired `in_progress` lease，claim 仍为 0 而 scanner 必须告警；相同 v3 活 lease 正控
不得被当成可回收停放行。删除 version filter
时 v3 被 claim，测试红。另保持 claim filter 完整、只中和 unsupported-version scanner 或 required
observer 接线，v3 仍 pending 但告警判别必须单独变红，证明“停放”不会静默。回滚负例逐一覆盖：
producer admission 关闭后仍能并发 enqueue、活 lease、
backoff `in_progress`、未处置 `dead_letter`；任一存在都拒绝降级。producer quiescence 必须用两条
构造交错证明，而不是“关 flag 后立刻数 0”：一条 after-sign create 事务在取得 admission `FOR SHARE`
后暂停；一条 reminder 事务在取得共享锁、CAS/enqueue commit 前暂停。rollback 的 singleton
`FOR UPDATE` 在两例中都必须等待；暂停事务 commit/rollback 后排他更新才可提交，随后新 producer
必须在业务写前被 DB gate 拒绝，之后取得的 zero/drain snapshot 才有效。删除共享锁、提前释放锁、
把 DB gate 只读一次缓存、或只检查 env flag 时，对应 interleaving 变红。中和 worker-first、
route-union completeness、claim-version filter、DB admission barrier、runtime readiness、协议版本、
开放轮或各 consumer-state 门时，对应 fixture 变红。

## 6. 明确不做

- 不修改 frozen graph，不创建 synthetic node；
- 不在 parallel region 内支持 after-sign；
- 不实现真正的 before-sign；
- 不允许多个排队的 after-sign 轮；
- 不改变 node-entry mixed fail-closed 不变量；
- 不虚报修复 durable-reminder flag OFF 时普通节点既有的 notify-then-mark stale-scan ABA；该 legacy
  路径只在 after-sign writer OFF 且开放轮为 0 时保留以满足 disabled byte-compat，通用修复须另立
  SLA reminder transport 锁；
- 不把目标 IDs、评论、表单值写入错误、metrics 或通用日志；
- 不开启 staging/production flag，不代替 owner UAT。

## 7. Owner 裁决块

```text
Decision: PENDING
Owner:
Date:
Baseline: origin/main@efbf0a931cd6529703a91c9c0053d4cae8217abe

OD-AS-1 runtime shape:
  (a) [RECOMMENDED] deferred-round ledger (§2-§3), complete multi-seat parity
  (b) single-seat-only; multi-seat 409 (safe but incomplete product outcome)
  (c) keep after-sign deferred

OD-AS-2 second after-sign while one round is open:
  (a) [RECOMMENDED] values-free 409
  (b) append to pending round (aggregation/idempotency contract expands)
  (c) queue another round (multi-round scheduler expands)

OD-AS-3 rollout:
  (a) [RECOMMENDED] worker-first A1 (v1+v2 + consumer, both flags OFF), producer/transport A2,
      then after-sign writer B; exact serving/worker-set gates, staging UAT then production
  (b) unflagged release

OD-AS-4 parent aggregation wording:
  (a) [RECOMMENDED] this delta supersedes parent B-5/OD-L5-5 only for aggregation:
      addSignAggregation is after-only until a true before-sign state machine exists
  (b) keep the parent before/after wording (claims a before runtime that does not exist)

OD-AS-5 reminder delivery:
  (a) [RECOMMENDED] dedicated default-OFF durable-reminder transport, manifest v2 worker-first,
      one canonical-JSON/SHA-256 event id per required channel, exact-tuple CAS plus all channel intents
      in one transaction; external delivery key additionally binds the current live-assignee fingerprint;
      every live-set writer bumps target generation and a custom post-send resolver revalidates
      generation/fingerprint before terminal CAS;
      strict single-channel outcomes; worker-drainable/producer-enabled lifecycle; persistent crash-safe
      dead-letter alert control and fence-CAS owner replay/disposition; an open deferred round never falls back to direct notify
  (b) direct notify after clearing deadline, explicitly accepting permanent loss on crash

OD-AS-6 rollback floor:
  (a) [RECOMMENDED] stop outer producer admission, then close the DB singleton gates under FOR UPDATE
      so all in-flight FOR SHARE producer transactions drain before the zero snapshot; no pod below
      after-sign-v1/manifest-v2 while any pending/active round, pending/in_progress reminder row,
      live lease, or undisposed dead-letter exists
  (b) permit rollback with open rounds (old pods can coerce after to parallel or strand ledger rows)

OD-AS-7 disabled reminder compatibility:
  (a) [RECOMMENDED] while both new flags are OFF and open rounds are zero, preserve current reminder
      behavior byte-for-byte; enable durable reminder transport before after-sign and track the ordinary-node
      legacy stale-scan ABA as a separate SLA lock
  (b) suppress all reminders while durable transport is OFF (safer scan semantics but a disabled-mode regression)

Recorded decision: NONE
Runtime authorization: NONE until this block is ratified.
```

## 8. Review provenance

- Codex：从 exact baseline 追踪 route → `dispatchAction` → assignment/epoch/tally/advance/cancel
  各路径，并起草本文；
- Kimi K3：只读架构反例复核，独立确认“重刷 epoch”会重置 threshold 计数，“当前 epoch”会
  退化为并加签，延迟轮是完整语义的唯一结构方案；其建议的“先做单席位拒绝”未被本文采纳为
  最终产品替代物，只保留为 owner 选项；
- Grok：前四轮对 exact baseline 做只读 refute-first 审阅。除确认延迟轮方向外，先后促成：共享
  helper 的 no-pending 零写入分支与第二次身份 exact-set/`FOR SHARE`、同节点 metrics 六列事务
  重置与旧扫描快照 CAS、实例作用域 pending 恢复、flag-OFF 在途排空、after-only 协议/评论门、
  严格目标基数、终结矩阵、pending timeline 的 org-scoped 显示投影及 Lock-1 latest-epoch 兼容。
  后续第五轮重新对执行分支和读取器做反例审阅，发现并由本文收口三项 P2：缺省/显式 `single`
  origin first-wins、两条成员 history 读取链的分页前合成、以及 remind 必须先以扫描快照 CAS 再
  解析/通知。运行时代码、flag 与 UAT 仍未授权；不得沿用第五轮前的 0 P1/0 P2 结论。
- GPT-5.6-sol xhigh：对本轮修订做独立 read-only 攻击，指出五项承重缺口并由本文收口：所有 timeout
  effect 共用完整扫描 tuple、remind 事务内 durable intent、CTE predicate 必须用直接陈旧状态反例
  而非只靠实例锁并发、合法同 epoch mutation 后按 live set 聚合、历史 metadata byte-compat，另补
  mixed-version rollout 与开放轮回滚下限。第二轮继续击穿“有 outbox 即可靠”的过早结论：当前
  durable facade/dispatcher 默认 OFF 会让 CAS 后无 intent，新 consumer 需要 manifest v2 worker-first；
  consumer 还必须校验 pending 状态与非空 live set。本文据此加入独立 reminder transport、A1/A2/B
  运行门、null/readiness 判别和 route/bridge 各自 wire-compat 基线。第三轮再发现聚合 notifier
  never-throw 会把失败渠道误记成功、A1 新 adapter 与 current-v1 双向门冲突、回滚漏算
  in-progress/lease/dead-letter 且未先停 producer；本文改为 per-channel intents、supported-manifest
  route union、claim-version 真过滤和 producer-quiescent 排空矩阵。第四轮继续指出 flag/exact-set
  加零快照不能排除在途事务、eventId 只说稳定却未规定可注入编码、channel key 缺少退役协议，以及
  dead-letter 存在时“绝不丢失”属于过度声明；本文据此加入 DB singleton 共享/排他准入屏障、
  canonical JSON tuple + SHA-256 身份、worker-drainable/producer-enabled 双集合生命周期和 required
  poison alert/replay/disposition。第五轮又构造“旧 owner 已发送后崩溃、同 epoch transfer、新 owner
  被旧 eventId 去重”的真实漏送交错，并证明当前 observer 在 dead-letter 提交后崩溃时不可靠；另指出
  unknown-key scanner 不会发现 known-key/unsupported-version 行。本文因此拆分 intent eventId 与
  live-target deliveryKey，加入持久化 dead-letter control/reconciler/fence-CAS replay，并为 unsupported
  manifest 增加独立 scanner/observer 判别门，同时收紧 SHA 碰撞与 PostgreSQL 微秒/seq 边界口径。
  第六轮继续构造同一次 dispatch 内 read-target→transfer→send→done 的 TOCTOU，指出 alert 与 resolution
  共用单一 state 可让 owner 绕过 acknowledgement、actor CHECK 可接受半配，并补出 expired
  in-progress unsupported-version 与 target fingerprint 域不闭合。本文据此新增实例级 target
  generation、所有 assignment writer census 与 post-send custom resolver；把 dead-letter 拆成正交
  alert/resolution 状态和显式 owner acknowledgement；扩大 version scanner 到可回收集合，并把 target
  tuple 与 PostgreSQL 微秒 SQL 表达式锁成精确版本。
  第七轮没有新增 P1，但指出正交列仍缺跨轴 CHECK，且“custom resolver”未落到当前 dispatcher 可实现
  的 transaction/token/terminal API；本文补 terminal→acknowledged 与 owner-action→terminal/actor
  约束，定义 Pool-backed `DispatchTransactionProvider`、严格 completion token、custom success/poison
  resolver 及 generic fallback 禁令，并把 assignment writer census 根扩到 backend 与根 plugins，补
  malformed live-target 协议门。
  第八轮只剩一项 P2：正常 observer acknowledgement 后的 open control 未被明确允许进入 owner
  replay/disposition；本文补 observer-first 路径、保留 ack 的原子 terminal 规则与三种并发 golden。
  同轮 P3 一并收口：resolver disposition 对齐现有 `lostLease`，completion token 固定为 exact own-data
  object、规范十进制 generation、64 位小写 hex fingerprint，并拒绝 accessor/extra key/prototype/Proxy
  异常且零 resolver 调用。
  第九轮构造 parser 校验后、transaction provider 取得连接前修改原 token 的交错，证明 `Readonly`
  不能阻止运行时 TOCTOU；本文改为从 descriptor value 重建并冻结 canonical token，resolver 永不接触
  原对象，同时以 `node:util.types.isProxy()` 和 `Reflect.ownKeys()` 明确拒绝透明 Proxy 与 symbol extra-key。
  运行时代码仍未授权。
