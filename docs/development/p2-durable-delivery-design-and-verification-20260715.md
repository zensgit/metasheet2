# P2 Durable Delivery — 设计与验证 (Design & Verification)

**状态 (2026-07-15 傍晚)**：S1 已落 main;S2-a→S2-b→S3→S4-a 四级 stacked PR 链全绿待复审(#4322←#4334←#4335←#4336);S4-b/S5/S6/S7 为余量。**flag `AUTOMATION_DURABLE_DELIVERY_ENABLED` 恒 OFF**,当前零 runtime 行为。
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
| I2 | **lease ⟺ in_progress**(双向) | DB `CHECK ((lease_expires_at IS NOT NULL) = (status = 'in_progress'))`。反向不是防 reclaim 扫描(该扫描按状态收窄),而是让 lease **恰好**表示「被活着的 in_progress worker 持有」,终态/回收转换必须原子清 lease |
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
| **S4-b** | 把真实 produce 站点(审批完成/record 写/表单提交/评论)接到 enqueue,flag 双路 | ⬜ 余量(热文件,须 S2-a 链定稿后) |
| **S5** | 真 adapter 替换匿名总线订阅(结构性关闭不可枚举方向)+ 外发幂等键 + poison-terminal 接线 | ⬜ 余量 |
| **S6/S7** | 升级迁移 backfill;崩溃注入 V 系列 | ⬜ |
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

**验证(真库 13 测,全部构造真实交错,非顺序论证)**:

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

---

## 6. 验证方法论 (本线standing)

1. **真库,非 mock**:每片本地 `initdb` 全新 PG15 → 按 CI 的 `MIGRATION_EXCLUDE` 跑 `db:migrate` → 跑**真实 vitest spec**(warm-store `pnpm install --offline` 4s 即可)。
2. **构造交错,不做顺序论证**:竞态守卫只有被它必须挺过的交错证明才算数(僵尸/SKIP LOCKED/崩溃循环)。
3. **变异必须先证落地**:变异要**干净**——`$N` 被孤立会变成 SQL 类型错误(红得不是地方);要保留参数引用(恒真/抬上限/去掉某个 SET)才是行为级证明。
4. **triggered ≠ verified**:CI 绿后再从日志确认 spec **真跑**且**测试数与本地一致**(stale checkout 会显示旧数)。
5. **head-scoped**:verdict 绑 SHA。审阅行号/符号对不上当前 head ⇒ 查 `original_commit_id`,勿在幻影上重修。

---

## 7. 待办 / 风险

- **S4-b/S5 前置 = owner 复审整条 stack**(S2-a API 已在评审中两改;在未定稿基座上把热文件 automation-service.ts 接进来会放大返工)。S4-b 每站点传**自己的事务客户端**,S7 崩溃注入逐站点证原子性。
- **S3 的滚动部署对称性**:#4203 §243 要求**双侧对称**(producer 全 N-aware 才可展开只有 N 认识的路由)——I6 只解决 worker 侧;**producer 侧漏写 = 该事件对 K 永远没有行,告警看不到**(无行可 park),必须靠激活门槛而非运行期防线。
- **外发净一次**依赖 endpoint 幂等键绑稳定事件/动作 identity、跨 fence 不变;端点不支持 ⇒ `outcome_unknown` 不自动重发(#4203 §340)。属 S5。
- **八场景验收**是 FWB/附件/flag 开启的硬前置。
