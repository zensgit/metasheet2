# Lock-5B delta — 后加签延迟轮状态机设计锁（2026-08-26）

**Status:** PROPOSED — 等待 owner ratify。本文只授权设计，不授权运行时代码、迁移、
feature flag、UAT、部署或生产开启。

**Baseline:** `origin/main@2162925cecb30e211affcc58096d8d50ec67e9b8`。

**Parents:**

- `approval-lock5-node-operation-policy-20260817.md`，特别是已记录的 OD-L5-4(b)、
  OD-L5-5(a) 与 gates B-1/B-3/B-4/B-5；
- `node-entry-epoch-threshold-round-scoping-design-lock-20260703.md` 的单活跃轮单 epoch
  不变量；
- `approval-add-sign-honesty.db.test.ts` 中 B-3 的真库反例。

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

**AS-I4 — 新轮聚合独立。** 延迟轮的**初始激活集合**只含请求时冻结的被加签人；一人时
规范化为 `all`，两人及以上时请求必须显式给出 `all | any`。不得继承原节点的
`threshold`、`all` 或 `any`。轮激活后的 parallel/before add-sign、transfer、timeout
transfer、reduce-sign、admin reassign/handover 继续遵守既有同节点 mutation 规则；聚合以
当前 epoch 的 live assignments 为准，但这些后续 mutation 不得改写冻结 seat rows 或伪造初始
激活集合。

**AS-I5 — 一次只有一个开放后加签轮。** 同一实例、节点只能有一个 `pending | active`
轮。开放轮存在时再次请求 `after` 返回 values-free 409，不静默合并，也不创建第三轮。

**AS-I6 — 事务原子性。** actor approve、`add_sign` audit、台账写入、assignment 变更、
实例版本、task-created durable enqueue 必须在同一实例 `FOR UPDATE` 事务内提交或回滚。

**AS-I7 — 激活是 fence-CAS。** helper 在当前 origin epoch 根本没有 matching pending 轮时，
必须以零写入返回 `deferredRoundActivated:false`；这是普通审批完成的正常路径，不是 CAS 失败。
只有已经锁定一条具体 pending 轮后，
`UPDATE ... WHERE id=? AND status='pending' RETURNING ...` 返回一行的执行者可以 bump epoch 和
插入新席位。此时 0 行才复读**同一 round id**并验证为已激活的同一轮；其他形状 fail closed。

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

**AS-I12 — 新轮 timeout 不继承旧 deadline。** 激活延迟轮必须在同一事务中锁定 metrics 行，
并清除或重算 `approval_metrics.current_node_deadline_at/current_node_timeout_effect` 及四个
calendar deadline 字段。现有 `emitNodeActivationMetric` 是 best-effort，而且同节点已有 open
breakdown 时会 no-op，不能作为这条语义门；旧轮完成后的 post-commit
`emitNodeDecisionMetric` 也必须在“同节点延迟轮已激活”结果上跳过，否则会把新 deadline 清空。
business-calendar 解析继续沿用 T3-2 的 fail-open：provider 缺失、无日历或抛错时用 wall-clock
deadline，不得让同一实例在创建时可运行、后加签激活时却 500。remind 扫描后的清除必须把扫描
快照中的 deadline/effect/activation seq 原样传入 CAS；不得在清除前重读 live seq，旧扫描不得
清掉新轮 deadline。

**AS-I13 — pending 目标失效可恢复且不降门槛。** 目标在请求后、激活前失去用户/组织活跃性
时，不得照常激活、静默删人或降低 `all | any` 集合。触发旧轮完成的动作整体回滚并返回统一
409；管理员必须能取消该 pending 轮后让旧席位重试。取消能力是 break-glass，flag OFF 时仍可用。

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

### 2.3 assignment 与 audit

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

成员 history/timeline 在轮尚为 `pending` 时也必须可展示被加签人。平台 history 查询只允许把
`metadata->>'deferredRoundId'` 投影为内部 alias，不得投影整块 metadata；服务端用该 alias 读取
seat rows，并用**实例 org-scoped** 的最小显示名查询解析，不得直接调用当前全局
`resolveDirectoryUsersByIds`（它不按 org 限定且返回 id/name/email）。wire DTO 只返回显示名与
目标计数，不返回 user id、email、round id 或 seat id；内部 alias 必须像
`lock9_attachment_ids_raw` 一样在返回前剥离。无法解析的席位使用统一 values-free 占位。FE 不得
等 assignment 激活后才显示姓名，否则 pending 阶段会出现“已后加签但没有对象”的不可解释状态。

后加签请求写两条既有 action vocabulary 的记录：

1. `approve`：表示 actor 在旧轮的真实决定，携带旧 `nodeEntryEpoch` 与该轮
   `aggregateComplete`；
2. `add_sign`：表示创建延迟轮，携带 `deferredRoundId`、`addSignMode:'after'`、
   `addSignAggregation` 和目标数量。普通 timeline 合成展示一次“同意并后加签”，不得显示两条
   看似独立的用户动作。

不新增 `approval_records.action` 枚举成员，因此不重开 CHECK widening 链。

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
   `0` 哨兵或临时 backfill 绕过。非 NULL 时按原节点真实 `approvalMode` 计算“actor 这一票之后
   旧轮是否完成”；
4. 插入 `pending` 轮和 seat rows；
5. 消费 actor assignment，写 `approve` + `add_sign` records；
6. 若旧轮未完成，只 bump instance version 并提交；兄弟席位保持旧 epoch；
7. 若旧轮完成，先按现有 `any`/`threshold` 规则取消未决兄弟，再调用 §3.3 的共享激活 helper；
   helper 必须对刚写入或既有 pending seat 执行相同的第二次 exact-set。返回
   `deferredRoundActivated:true` 时不得调用 `resolveAfterApprove`，实例留在同一图节点；返回
   `false` 说明当前 origin epoch 没有 pending 轮，调用方必须继续既有 `resolveAfterApprove`；
8. enqueue 新激活席位的 task-created durable events，提交后走既有 legacy emit；flag-OFF durable
   语义保持既有路径。

旧轮聚合计算不能复制第二套 `all/any/threshold` 分支。实现必须提取一条共享的“消费一票并
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
   `RETURNING round_id, aggregation, next_epoch`；
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

remind 路径同时收窄：`scanNodeTimeouts` 返回扫描到的 deadline/effect 与实例
`node_activation_seq`；调用方必须把这三个**扫描快照值**传给 `markNodeTimeoutFired`，后者只在
三者仍完全相等时 CAS 清除 deadline/effect，不得在 mark 内重读 live seq。
旧扫描在同节点新轮激活后必须 0 行，不得清空第 8 步的新值。transfer/jump 继续沿用现有实例
`FOR UPDATE` + metrics `FOR UPDATE` 事务，不另造第二条写路径。

### 3.4 active 轮的聚合与完成

新增一个服务层 `effectiveApprovalMode(instanceId, nodeKey, currentEpoch)`：

- 若存在 `status='active' AND activation_entry_epoch=currentEpoch` 的轮，返回其 `all | any`；
- 否则返回 frozen graph 的 `executor.getApprovalMode(nodeKey)`；
- 多行、epoch 不一致或 active 轮找不到 seat/assignment 对应关系均 500 fail closed。

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

1. 两表纯新增，无 backfill；旧实例没有台账，所有读取返回 absent，行为与当前 main 相同。
   仍在 NULL `entry_epoch` 上运行的旧实例只对 `after` 返回 §3.2 的 values-free 409；普通
   approve 与现有 `before | parallel` 不变。
2. migration 必须先于或随镜像上线；镜像回滚后表保留，不执行 destructive down。
3. 新 flag `APPROVAL_AFTER_SIGN_ENABLED` 登记到 global-history flag manifest，默认 OFF，精确
   `'true'` 才开启。
4. FE 只有在 capability/flag read 为 true 时显示“后加签”；服务端永远是新请求的权威门。
   flag 从 ON 改为 OFF 后，既有 pending/active 轮仍由常驻状态机继续排空；不得以 flag 跳过
   §3.3 或取消矩阵。
5. UI 选择两个以上目标时显示“会签/或签”；单目标不显示无意义选项。
6. disabled 模式不创建表外写入、不更改 before/parallel 的 assignment、版本、audit 或 copy。

## 5. 判别性验证门

所有 DB 门在 PostgreSQL 15 真库运行，`EXPECT_DB=1` 时不得 skip；新 FE spec 同时进入
`approval-web-guard.yml` 与 `run-required-web-tests.sh`。

**AS-G1 协议双门。** route 与 service 都接受 `after`；未知值 400。分别回退任一门，指定测试红。

**AS-G2 单席位立即激活。** actor 后加签一个人：actor approve 与 add_sign audit 同事务，
旧 seat inactive，新 seat 在新 epoch active，seq 恰好 +1，节点不前进；新 seat approve 后才前进。

**AS-G2a 无 pending 的普通完成。** 不创建任何 deferred round，普通 all/any/threshold 的最后一票
仍返回 200 并按既有图前进；共享 helper 返回 `deferredRoundActivated:false`，metrics、seq、台账、
outbox 不产生额外写入。把“0 pending”改回异常或在 no-op 前锁 metrics/bump seq 时测试红。

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

**AS-G9 事务失败注入。** 在 actor consume 后、CAS 后、epoch bump 后、assignment insert 后、
outbox enqueue 后分别注入失败；每处都必须回滚到无半轮、无孤儿 seat、无 version 漂移。

**AS-G10 fence 并发。** 两个完成旧轮的并发请求只能一方激活；seq 只 +1、assignment 每人一行、
task-created 每人一个 durable intent。中和 CAS predicate 时测试红；candidate 为空的重放不得
空增 seq。

**AS-G11 取消矩阵。** reject/return/admin jump/timeout jump 各有一条 pending 或 active 真库
路径；pending 实例 terminal 只能 cancelled，active 正常完成先 completed、外部提前终止则
cancelled。离开节点后无 open 轮、无该轮 active assignment。从任一真实调用点删除 settle
调用，对应测试红。`revoke` 不列入本门：after-sign 已写真实 approve，现有 revoke window 会关闭。

**AS-G12 同节点 mutation。** 初始 activation set 与 seat rows 保持冻结；transfer、timeout
transfer、reassign、handover 保持 active 轮 epoch，不取消、不 bump。parallel/before add-sign
进入 active 后加签轮仍保持 epoch并按 live assignment 数参与该轮聚合；不得据此改写 seat 表。

**AS-G13 卡片与 SLA。** 旧 epoch 卡在激活后 fail closed，新轮卡成功；新轮 deadline 从激活时
重新计算；无 timeout 节点会清空旧 deadline，有 wall-clock/business timeout 的节点各自取得完整
新时限；calendar provider unbound/返回 null/抛错时与 T3-2 一样 fail-open 到 wall-clock，不得
500。metrics 行缺失/更新失败必须回滚激活；删除事务内六列 reset、恢复
`emitNodeActivationMetric`、恢复旧轮 post-commit `emitNodeDecisionMetric`，或让旧 remind scan
无 CAS 地清除时，各自时间控制测试红。旧 remind fixture 必须把扫描到的
deadline/effect/activation seq 传入 mark；若 mark 改为重读 live seq，旧扫描会命中新轮并使测试红。

**AS-G14 comment policy。** `commentRequired:'always'` 的 after-sign 无评论被拒；普通 optional
配置成功。before/parallel 在同一模板下保持当前 main 响应，不得把新门扩到旧模式。不得因动作名
是 add_sign 绕过“消费 approve”的政策。

**AS-G15 flag 准入与排空。** OFF 时新的合法 after 409 且数据库零变化；before/parallel 与当前
main 的全响应和状态快照相同。先在 ON 创建 pending，再切 OFF，最后旧兄弟 approve 必须仍按
§3.3 激活并最终完成；不能留 open round，也不能静默取消。管理员 pending-cancel 在 OFF 仍可用。

**AS-G16 DB constraints。** 非法 status/aggregation/cancel reason、负 epoch、空白 node/creator/
assignee、状态字段错配（含 cancelled 半配 activation 字段）、重复 open round、重复 seat、重复
ordinal 均由具名 constraint 或 index 拒绝；迁移重放幂等。

**AS-G16a 旧 epoch。** NULL epoch 旧实例请求 after 返回指定 409，actor seat、audit、台账、
version 均不变；普通 approve 的 legacy fallback 与 before/parallel 回归保持当前 main。

**AS-G17 timeline。** 一次 after-sign 在成员 timeline 合成为一个动作，但内部两条审计均存在；
轮仍 pending、尚无 assignment 时就能显示 seat 对应的授权目录名称与计数。history SQL 不投影整块
metadata，org-scoped 显示查询不调用全局 directory helper，内部 alias 在 wire 前剥离，wire 不返回
deferred round/seat/user id/email；无法解析者只显示 values-free 占位。权限受限查看者不看到 raw
target IDs。下一节点的 `prior_node_approver` 继续只读取 latest epoch，延迟轮完成后不得把 origin
round deciders 重新 union 进来。

**AS-G18 crash replay。** durable delivery ON 时，在事务提交后、adapter 前崩溃并重启：新轮 task
仍被派发且 sink 幂等；不得因重放创建第二台账或第二 assignment。

## 6. 明确不做

- 不修改 frozen graph，不创建 synthetic node；
- 不在 parallel region 内支持 after-sign；
- 不实现真正的 before-sign；
- 不允许多个排队的 after-sign 轮；
- 不改变 node-entry mixed fail-closed 不变量；
- 不把目标 IDs、评论、表单值写入错误、metrics 或通用日志；
- 不开启 staging/production flag，不代替 owner UAT。

## 7. Owner 裁决块

```text
Decision: PENDING
Owner:
Date:
Baseline: origin/main@2162925cecb30e211affcc58096d8d50ec67e9b8

OD-AS-1 runtime shape:
  (a) [RECOMMENDED] deferred-round ledger (§2-§3), complete multi-seat parity
  (b) single-seat-only; multi-seat 409 (safe but incomplete product outcome)
  (c) keep after-sign deferred

OD-AS-2 second after-sign while one round is open:
  (a) [RECOMMENDED] values-free 409
  (b) append to pending round (aggregation/idempotency contract expands)
  (c) queue another round (multi-round scheduler expands)

OD-AS-3 rollout:
  (a) [RECOMMENDED] APPROVAL_AFTER_SIGN_ENABLED default OFF, staging UAT then production
  (b) unflagged release

Recorded decision: NONE
Runtime authorization: NONE until this block is ratified.
```

## 8. Review provenance

- Codex：从 exact baseline 追踪 route → `dispatchAction` → assignment/epoch/tally/advance/cancel
  各路径，并起草本文；
- Kimi K3：只读架构反例复核，独立确认“重刷 epoch”会重置 threshold 计数，“当前 epoch”会
  退化为并加签，延迟轮是完整语义的唯一结构方案；其建议的“先做单席位拒绝”未被本文采纳为
  最终产品替代物，只保留为 owner 选项；
- Grok：对 exact baseline 做四轮只读 refute-first 审阅。除确认延迟轮方向外，先后促成：共享
  helper 的 no-pending 零写入分支与第二次身份 exact-set/`FOR SHARE`、同节点 metrics 六列事务
  重置与旧扫描快照 CAS、实例作用域 pending 恢复、flag-OFF 在途排空、after-only 协议/评论门、
  严格目标基数、终结矩阵、pending timeline 的 org-scoped 显示投影及 Lock-1 latest-epoch 兼容。
  最终复核对当前文本结论为 0 P1/0 P2。运行时代码、flag 与 UAT 仍未授权。
