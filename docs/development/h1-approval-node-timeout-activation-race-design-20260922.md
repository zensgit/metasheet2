# H-1 — 审批节点超时效果 vs 异步 metrics 激活写入竞态（产品修正候选）

> **状态：PROPOSED（候选，未裁决）。** 本文与配套实现是**提交给 owner 的候选**，不是已批准的合同变更。
> 无 DDL、无迁移、无新错误码、无公开合同变更。合并、undraft、开关变更均未授权。
>
> - 分支：`fix/approval-node-timeout-effect-activation-race`
> - 基线：`origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
> - 私有背景报告：`verify-5853-l6a-red-check-20260920.md`（本文不复述其缺陷细节，只引用其结论与时序）
> - 配套验证：`docs/development/h1-approval-node-timeout-activation-race-verification-20260922.md`
>
> **round-2（本轮）修订摘要** —— 全部来自独立门审 `impl-gate-H1-activation-race-round1-20260922.md`：
> - **P1-1**：`settleMetricsCall` 恢复微任务跳板，**并且**在会再激活同一节点的两条路径上
>   `await` decision 关闭。**只恢复跳板不够**，n=30 实测见 §5.1（这也更正了门审「main 0/12」的数字）。
> - **P2-1**：7 个被 await 的 hook 逐站点 mutation 全部有执行覆盖，见 §4.4 与验证 MD §3.1。
> - **P3-1**：§5 连接池行与 §7 R3 改写（单语句 checkout vs 多语句取锁事务；`connectionTimeoutMillis=10000` /
>   `statement_timeout=30000` 给出有界性）。
> - **P3-2**：§3 表第 1 行归类改写（(b) 关闭的是顺序客户端的**跨请求**窗口）。

---

## 1. 现象与判据

`approval-realdb-l6a-roundscoping` lane 在 262 次运行里 3 次红（≈1.1%），断言逐字为：

```
AssertionError: expected 'skipped_stale' to be 'applied'
tests/integration/approval-dedup-return-round-scoping.db.test.ts:482
```

私有报告把它锁死到 `ApprovalProductService.applyNodeTimeoutEffect` 的 scan→fire 竞态守卫：
被 `safeMetricsCall`（`Promise.resolve().then(fn)`，**无 await**）派发的节点激活 deadline 写，
晚于用例的强制超期 UPDATE 落库、把它冲掉，守卫因此取真并 `ROLLBACK`。

**本文的第一条主张（与报告的措辞有一处分歧，明写在此）**：报告把它归为
「测试夹具的缺陷，不是生产缺陷」。这句话对**该条用例**成立，但对**这两列的所有权语义**不成立。
生产代码自己已经把这个窗口写在注释里 —— `ApprovalProductService.ts:9307`（本轮 head 行号）：

```
// The armed deadline no longer matches the current node's configured effect (e.g. the
// instance advanced and the best-effort re-stamp has not landed yet). Not ours to consume —
// the activation re-stamp owns these columns; next tick sees fresh state.
```

「the best-effort re-stamp has not landed yet」就是本文要关闭的窗口。它在仓内是**已记录的生产事实**，
不是只在测试里才出现的形状。

---

## 2. 为什么这两列不是「可观测性」列

`approval_metrics.current_node_deadline_at` / `current_node_timeout_effect` 同时是：

| 角色 | 读者 | file:line（本分支） |
|---|---|---|
| SLA 扫描器的**待办集合** | `ApprovalMetricsService.scanNodeTimeouts` | `ApprovalMetricsService.ts:481-489` |
| `applyNodeTimeoutEffect` 的**事务内竞态守卫** | `ApprovalProductService.applyNodeTimeoutEffect` | `ApprovalProductService.ts:9261-9267` |
| 超时单发性的**消费标记** | `markNodeTimeoutFired` / `consumeTimeout` | `ApprovalMetricsService.ts:493-499` / `ApprovalProductService.ts:9226-9232` |

即它们是**状态机的 armed state**，被当作判据读回。一个「尽力而为、不知何时落库」的写，
不能承载一个会被当判据读回的状态 —— 这正是 `feedback_persistent_transition_must_not_depend_on_network_call`
与 `feedback_callable_port_is_not_loadbearing_substrate` 的同一族。

---

## 3. 根因时序（T0→T3）

```
T0   approve A 的 HTTP 请求内（COMMIT 之后）
     ├─ 同步取 activatedAt = new Date()
     ├─ 计算 deadline := activatedAt + afterMinutes*60000      ← 恒为「未来」
     └─ safeMetricsCall 派发 detached Promise（无 await）──────────┐
T0'  HTTP 200 返回；调用方观察到 currentNodeKey='approval_c'        │
T1   任意后续写者（用例的强制超期 UPDATE / 扫描器的 consume /       │  ← 竞争窗口
     下一次激活的 re-stamp）改写这两列并提交                        │
T2   detached UPDATE 终于落库，用 T0 时刻算出的值覆盖 T1 的结果 ←───┘
T3   applyNodeTimeoutEffect：BEGIN → SELECT … FOR UPDATE 读这两列
     → `deadlineMs > Date.now()`（或 NaN / effect 不符）取真
     → ROLLBACK → 'skipped_stale'
```

失败判据：**T1 < T2 < T3**。窗口宽度实测仅 ~3–5ms（报告 §4.1），所以自然发生率低但非零。

**两个族内变体**（报告 §4.2 / §4.3 各自实测过）：

- 变体 A：迟到的写是**有 timeout 的节点**，写入「未来时刻」⇒ 命中 `deadlineMs > Date.now()`；
- 变体 B：迟到的写是**无 timeout 的节点**，写入 NULL ⇒ 命中 `Number.isNaN(deadlineMs)` + `effect !== scannedEffect`。

**生产可达性（本文的第二条主张，按可达性分级，不夸大）**：

| 场景 | 迟到量级 | 结论 |
|---|---|---|
| **顺序客户端的跨请求乱序**：请求 N 的飞行中激活写晚于请求 N+1 的写落库 | 毫秒级 | **今天可达**，而且是 (b) **构造性关闭**的那一个。顺序客户端的第 N+1 次动作只能在第 N 次的响应返回之后发出，所以「第 N 次的飞行中写晚于第 N+1 次的写」在 baseline 上是真实可达的；(b) 让响应返回时已无飞行中的激活写，这条交错随之消失 |
| 激活写晚于 `recordTerminal` 的**无作用域**清空（`ApprovalMetricsService.ts:458-471`） | 毫秒级 | **今天可达**，但**无害**：`scanNodeTimeouts` 带 `terminal_at IS NULL`，残留的 arm 是惰性的。只留脏数据 |
| 激活写晚于扫描器的 consume（60s 后） | 需 ~60s 迟到 | **不现实**，不作为论据 |
| 激活写晚于本用例的强制超期 UPDATE | 毫秒级 | **测试内可达**，即 CI 那 3 次红 |

即：第 1 行是一个真实的生产正确性缺陷，第 4 行是 CI 的红。两者是**同一个窗口**的两个出口。

> **P3-2 勘误（round-2，采纳 r1 门审）**：本表第 1 行原写的是
> 「一次级联内两次激活写乱序（B 合并 → C 激活）……今天可达」。**那条归类是错的**：
> `emitNodeActivationMetric` 在**每条请求路径上只执行一次**（§4.4 的 5 个站点互斥，
> `dispatchAction` 内 handler / return / approve 三个分支各自 `return`），所以
> 「一次级联内两次激活写」在代码里不成立。上表第 1 行已替换成实现真正关闭的那个窗口
> （顺序客户端跨请求），其论证也更强。**真并发**（非顺序客户端）的跨请求乱序仍然开放，见 §7 R1。

---

## 4. 影响面普查（写这两列的全部点位，@ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`）

机械命令（**全仓**，不只 `src/`；raw SQL 与 query-builder 两种语法一并覆盖 —— 结果显示
这两列在仓内**只有 raw SQL 与 DDL 两种出现形式**，无 kysely/query-builder 写入）：

```
grep -rn --exclude-dir=node_modules --exclude-dir=.git \
  -E "current_node_deadline_at|current_node_timeout_effect" .
```

### 4.1 生产写入点（6 个，全部 raw SQL）

| # | file:line（基线） | 写者 | 本 PR 是否改 | 既有防护 |
|---|---|---|---|---|
| 1 | `ApprovalMetricsService.ts:247` | `recordInstanceStart` INSERT | 否 | `ON CONFLICT (instance_id) DO NOTHING` —— 只插不改 |
| 2 | **`ApprovalMetricsService.ts:317`** | **`recordNodeActivation` 激活重盖** | **是（改调用侧，不改 SQL）** | **无** ← 本案 |
| 3 | `ApprovalMetricsService.ts:440` | `recordNodeDecision` 清空 | 否 | 已有作用域守卫 `AND EXISTS (… i.current_node_key = $2)`，注释自述同族 RACE FIX |
| 4 | `ApprovalMetricsService.ts:468` | `recordTerminal` 清空 | 否 | **无作用域**（见 §7 残留 R2） |
| 5 | `ApprovalMetricsService.ts:496` | `markNodeTimeoutFired` 清空 | 否 | 仅 SLA 调度器调用 |
| 6 | `ApprovalProductService.ts:9197`（基线）→ `:9229`（本轮 head） | `consumeTimeout` 置 NULL | 否 | 在 `applyNodeTimeoutEffect` 自己的事务内 |

### 4.2 生产读取点（2 个）

| file:line（基线） | 读者 |
|---|---|
| `ApprovalMetricsService.ts:481-486` | `scanNodeTimeouts`（扫描器待办集合） |
| `ApprovalProductService.ts:9261-9267`（本轮 head）| `applyNodeTimeoutEffect` 的 `FOR UPDATE` 竞态守卫 |

### 4.3 DDL（只读性确认，本 PR 不动）

`packages/core-backend/src/db/migrations/zzzz20260630100000_add_node_timeout_to_approval_metrics.ts:18-23`
—— 两列 + 一个 `WHERE current_node_deadline_at IS NOT NULL` 的部分索引。**本 PR 零迁移。**

### 4.4 `emitNodeActivationMetric` 的 5 个调用点（全部 POST-COMMIT，逐一核过）

行号为**本轮 head**（round-1 的行号在 `settleMetricsCall` 注释与两个新方法加入后整体下移）。

| 本分支 file:line | 所在方法 | 前置 `await client.query('COMMIT')` | 执行覆盖（round-2 起） |
|---|---|---|---|
| `ApprovalProductService.ts:8478` | 管理员 jump | `:8460` | `H-1 SITE (admin jump)` |
| `ApprovalProductService.ts:9532` | `applyNodeTimeoutEffect` 自己的再激活 | `:9522` | `H-1 SITE (timeout re-activation)`（+ `H-1 P1-1 GATE (timeout jump)`） |
| `ApprovalProductService.ts:10582` | handler 节点分支 | `:10572` | `H-1 SITE (handler branch)` |
| `ApprovalProductService.ts:10690` | `return` 分支 | `:10681` | `H-1 SITE (return branch)` |
| `ApprovalProductService.ts:11264` | 普通 approve/dispatch | `:11241` | `H-1 DISCRIMINATOR` + `H-1 GATE` |

round-2 另加的两个被 await 的**决策关闭**调用点（同样 POST-COMMIT）：

| 本分支 file:line | 所在方法 | 前置 COMMIT | 执行覆盖 |
|---|---|---|---|
| `ApprovalProductService.ts:9530` | `applyNodeTimeoutEffect` | `:9522` | `H-1 P1-1 GATE (timeout jump)` |
| `ApprovalProductService.ts:10688` | `dispatchAction` 的 `return` 分支 | `:10681` | `H-1 P1-1 GATE (return branch)` |

**round-1 的 P2-1 缺口已关闭**：逐站点 mutation 表见验证 MD §3.1 —— 7 个 `await` 每一个单独
neuter 都至少打红一条用例，不再有「靠读代码断言正确性」的站点。

**这是本修法的锁序判据**：上面两张表共 7 处全部在 COMMIT 之后，审批事务持有的行锁已释放，
所以 await 一个需要第二条连接的写**不可能**与自己死锁（`feedback_lock_taking_port_needs_lock_order_census`
点名的 #4899 形状在此不成立）。连接仍未 `release()`（在 `finally` 里），所以池占用按 §5 表末两行计。

---

## 5. 两种修法对比

任务点名两个候选。逐条按「能否关闭 §3 的窗口」「新增失败模式」「代价」评。

### (a) 激活写改 CAS — `UPDATE … WHERE <期望值>`，失败则丢弃/重读

三种可用的 CAS 键（都是零 DDL，列已存在）：

| CAS 键 | 能否挡住 §3 变体 A（同节点、外部改写） | 能否挡住乱序激活 | 新失败模式 |
|---|---|---|---|
| `approval_instances.current_node_key = $nodeKey`（复刻 `:440` 先例） | **否** —— 实例仍在 `approval_c`，谓词为真，迟到的写照样落 | 是 | 无 |
| `approval_instances.node_activation_seq = $seq`（该列**已存在**，`ApprovalProductService.ts:11961` 的 `bumpNodeActivationSeq`） | **否** —— 同一次激活，代数未变 | 是（更强） | 无 |
| `current_node_deadline_at IS NOT DISTINCT FROM $观测到的前值` | 是 | 部分 | **有**：合法的并发消费者（扫描器 consume）也会让 CAS 失败 ⇒ **新节点的 timeout 永远不被 arm**。「重读」要把它和「更新的激活」区分开，又回到需要代数 |

**判定性事实**：`node_activation_seq` 在报告复现的交错里**没有推进**（同一次激活、同一节点），
`current_node_key` 也**没有变**。因此**任何以激活身份为键的 CAS 都无法让被点名的验收用例转绿** ——
这不是偏好问题，是谓词与场景不匹配。
而以「观测到的前值」为键的 CAS 会引入一个新的丢 arm 路径。

### (b) 生产者 await settle ✅ 选中

把激活 metrics 写从「派发即返回」改成「settle 后再返回」：
`emitNodeActivationMetric` 返回 `Promise<void>`（**永远 resolve**），5 个 POST-COMMIT 调用点 `await` 它。

**它关闭窗口的方式是构造性的，不是概率性的**：`T0'`（响应返回）之后不再存在「在飞行中的激活写」，
所以 §3 的 `T1 < T2` 根本无法构成 —— 对**单请求序列**而言，T2 被提前到 T0' 之前。

| 维度 | 结论 |
|---|---|
| 关闭 §3 变体 A/B（单请求序列 / 顺序客户端跨请求） | **是** |
| 关闭「一次级联内两次激活写乱序」 | **该条不成立，已删**（P3-2：每条请求路径只执行一次 `emitNodeActivationMetric`，§4.4 的 5 个站点互斥） |
| 新错误码 / 迁移 / DDL / 公开合同 | **零**（见 §6 的不变量核对） |
| 「metrics 故障不能拖垮审批流」 | **保持**：`settleMetricsCall` 内部 try/catch，promise 永不 reject ⇒ `await` 不可能把 metrics 错误路由进调用点外层那个 `catch { await rollbackQuietly(client); throw error }` |
| 代价 | 响应路径 **+1 个事务（BEGIN / SELECT FOR UPDATE / UPDATE / COMMIT）+ 1 条 UPDATE ≈ 5 次往返**；**timeout-jump 与 return 两条路径 +2 个**（round-2 起 decision 关闭也被 await，见 §5.1）；实测范围见验证 MD §5 |
| 连接池 | 在仍持有审批连接（C1）时**顺序**再借若干条。**逐个方法数过，不是估**：每个被 await 的 hook 最多**两次**顺序 checkout —— `mutateBreakdown` 的多语句取锁事务（`pool.connect()`）**加上**其后独立的单语句 `this.query(UPDATE …)`（`pool.query()`，`recordNodeActivation` 只在 `added` 为真时发出，`recordNodeDecision` 无条件发出）。于是 approve / 管理员 jump / handler 三条路径最多 **C1 + 2 次顺序 checkout**；timeout-jump 与 return 两条路径（关闭 + 激活两个 hook）最多 **C1 + 4 次顺序 checkout**。全部**顺序**且每次用完即还，不存在同时持有多于两条的时刻。**同族但形状更重，不是「既有模式」逐字复制**：被引作先例的 `emitApprovalTaskCreatedEventsPostCommit`（定义 `:11886`）与 `supersedeCardDeliveriesPostCommit`（定义 `:11944`）都走 `pool.query(sql, params)` —— **借一条连接、跑一条语句、立刻归还**；而本 PR 被 await 的写走 `recordNodeActivation → mutateBreakdown → defaultTransaction`（`ApprovalMetricsService.ts:1019-1040`）：`pool.connect()` + `BEGIN` + `SELECT … FOR UPDATE` + `UPDATE` + `COMMIT`，**跨多条语句持有第二条连接并取行锁**。有界性来自 `connection-pool.ts:248-261` 的 `connectionTimeoutMillis = 10000` 与 `statement_timeout` / `query_timeout = 30000`：最坏情况是**有界**的额外时延 + 一次被吞掉的 metrics 失败，不会把审批响应挂死。`DB_POOL_MAX` 默认 20；「持有 C1 再取 C2」的形状在 baseline 上已存在（`:11255` 的 supersede 无条件执行），所以池耗尽的悬崖是既有的，本 PR 加长了第二条连接的持有时长、并在两条路径上把它变成两条。**并发/池压测仍未做**（§7 R3） |
| 锁竞争 | 被 await 的激活事务与同一请求内的 decision 关闭会在**同一行**上 `FOR UPDATE` 排队。round-1 把这当成「串行化，只是延迟」——**那句话是错的**，排队顺序决定结果正确与否（§5.1）。round-2 让这两条在需要的路径上按代码顺序串行，顺序不再由锁竞争决定 |

### 5.1 round-2 勘误 —— 只恢复派发次序**不足以**关闭同节点再激活的 arm 丢失

r1 门审指出：`settleMetricsCall` 同步调用 `fn()`，使激活写的 `pool.connect()` 发生在同一同步块中
**先派发**的 decision hook 被调用之前，于是当 `resolution.currentNodeKey === currentNodeKey`
（再激活的就是刚被决策的那个节点）时，`recordNodeActivation` 看到该节点的 breakdown 条目仍然打开，
判为重发（`added=false`）而**跳过 deadline UPDATE**；随后落库的 decision 关闭该条目，
且其作用域守卫 `approval_instances.current_node_key = $2` **为真**（实例确实还停在该节点），
于是把两列置 NULL —— 节点重新激活，SLA 永不再 arm，`node_breakdown` 也丢了这次再激活的条目。

**本轮用同一探针把这件事测了 n=30（不是 n=5/n=12）**，结论与 r1 的方向一致但**数值不同，且改变了修法**：

| 生产文件 | 再 arm 成功 | arm 丢失 | n |
|---|---|---|---|
| baseline `cd42eaf74…`（逐字节 `git show` 出来的 blob） | 27 | **3** | 30 |
| round-1 head `ad0a5a75…` | 8 | **22** | 30 |
| 只恢复微任务跳板（`await Promise.resolve().then(fn)`） | 19 | **11** | 30 |
| **本轮实现（跳板 + 在两条路径上 await decision 关闭）** | **30** | **0**（单一交错 `D-enter,D-exit,A-enter,A-exit`） | 30 |

两条必须写下来的更正：

1. **baseline 本身就会丢 arm（3/30）**。r1 门审写的「main 上 0/12 出错」是小样本造成的，
   本条缺陷**不是纯粹由 round-1 引入的回归**，round-1 只是把发生率从 ~10% 推到 ~73%。
   因此本 PR 的说法**不是**「恢复 main 的形状」，而是**关闭一个 baseline 从未关闭的窗口**。
2. **只恢复跳板仍然丢 11/30**，比 baseline 更差。跳板只把 decision 的派发提前**一个微任务**，
   两条事务随后仍各自在独立连接上竞争同一行的 `SELECT … FOR UPDATE`；谁先拿到锁不是跳板能决定的。
   所以「判据是结果」这条门的要求，跳板单独做不到。

**因此本轮的修法是「跳板 + 在会再激活同一节点的两条路径上 `await` decision 关闭」**，
两者都保留：跳板恢复全局派发次序（其余 hook 对不变），`await` 让这两条路径上的先后成为代码事实而非锁竞争结果。
这同时使验收用例**双向确定**：把 decision 关闭注入固定延迟后，round-1 实现与「只有跳板」的实现都**确定性红**，
本轮实现**确定性绿**（验证 MD §3）。

**选 (b) 的理由（一句话）**：只有 (b) 能让被点名的验收场景转绿，且它以**构造性**（消除飞行中的写）
而非**谓词性**（猜哪个写该赢）的方式关闭窗口，因而不引入任何「丢 arm」的新分支。
(a) 的三个键里，两个对该场景无判别力，第三个用一个新缺陷换旧缺陷。

**(a) 与 (b) 是互补而非互斥的**：见 §7 的 R1。

---

## 6. 实现（三处，零 SQL 变更）

`packages/core-backend/src/services/ApprovalProductService.ts`（行号为**本轮 head**）：

1. **`:201` `logMetricsHookFailure`** —— 抽出原来的 warn 文案，避免两个形式各写一遍。
2. **`:210` `safeMetricsCall` —— 行为逐字不变**（仍是 `Promise.resolve().then(fn).catch(...)`）。
3. **`:231` `settleMetricsCall`** —— 新增的**可 await** 形式，同样的 log-and-swallow 合同，
   **并且保留 `Promise.resolve().then(fn)` 微任务跳板**（round-2：round-1 写成 `await fn()`，
   那会让本 hook 的事务抢在同一同步块中更早派发的 hook 之前发出，见 §5.1）。
4. **`:11337` `emitNodeActivationMetric`** —— 返回类型 `void` → `Promise<void>`，体内
   `safeMetricsCall(...)` → `return settleMetricsCall(...)`。**入参、写入的值、SQL 一字未动。**
5. **5 个激活调用点**（§4.4 表）加 `await`。
6. **round-2 新增 `:11311` `settleNodeDecisionMetric`** —— `emitNodeDecisionMetric` 的**可 await 兄弟**：
   同一次写、同一套 log-and-swallow 合同，只是调用方等待落库。写体抽成
   `:11316 nodeDecisionMetricWrite`（`decidedAt` 仍在 hook **运行时**取），两个形式共用，无重复字面量。
7. **两个决策调用点改 `await this.settleNodeDecisionMetric(...)`**：`:9530`（`applyNodeTimeoutEffect`
   的再激活路径）与 `:10688`（`dispatchAction` 的 `return` 分支）。**其余 3 个 `emitNodeDecisionMetric`
   调用点逐字未动**（`:10738` reject、`:10808` sequential 队首推进、`:11259` approve）：前两者之后不发出
   任何激活写；approve 的激活写被 `resolution.currentNodeKey !== currentNodeKey` 挡住，
   于是它的关闭与它的激活针对**不同节点**，关闭的作用域守卫无论谁先落库都为假。

未改动且**刻意**未改动的：

- **`recordInstanceStart`（`:8158` 的 `safeMetricsCall`）不在本 PR 范围**。理由不是「范围收窄」，
  而是**没有同请求碰撞**：`:8159` 的注释自述「the FIRST node is activated here (not via
  `emitNodeActivationMetric`)」，该 INSERT 与激活 UPDATE 不在同一请求内，且它带
  `ON CONFLICT DO NOTHING`（§4.1 #1）⇒ 它不能覆盖任何东西。
- `ApprovalMetricsService.ts` **一行未改**（所以本 PR 不触发以该文件为 `paths:` 的 lane；
  触发的是以 `ApprovalProductService.ts` 为 `paths:` 的 lane，含 l6a —— 见验证 MD §6）。
- `:9307` 那条注释保留原文：它描述的是**跨请求**的窗口（R1），本 PR 没有关闭它，
  改写它会把一个仍然成立的事实写成已解决。

### 公开合同不变量核对

| 不变量 | 核对 |
|---|---|
| HTTP 状态码 / 响应体 | 未改（`emitNodeActivationMetric` 不参与响应构造） |
| 错误码 | 新增 0 个；`APPROVAL_ERROR_CODES` 未改 |
| `ApprovalNodeTimeoutEffectOutcome` 取值集合 | 未改 |
| DB schema / 迁移 | 0 个迁移，0 个 DDL |
| 特性开关 | 未新增、未翻转 |
| 「metrics 故障不能失败审批流」 | 保持（§5 表第 4 行） |
| `safeMetricsCall` 其余调用者的语义 | **不变，但措辞已更正（round-2）**：`emitNodeDecisionMetric` 的**函数体**不再是内联对象字面量，而是转调 `nodeDecisionMetricWrite(...)`；它仍然走 `safeMetricsCall`，写入的字段、`decidedAt` 的取值时机、错误处理逐一相同。「逐字未变」对 `recordTerminal` / `recordInstanceStart` 两个调用点成立，对 `emitNodeDecisionMetric` 只能说「语义未变、写法已重构」 |

---

## 7. 已披露的残留（本 PR **不**修，明写为 NOT FIXED）

**R1 —— 真并发的跨请求乱序仍然开放。**
请求 1 在 t1 提交并开始它被 await 的激活写；请求 2 拿到行锁、在 t2>t1 提交并开始它的激活写；
写 1 仍可能晚于写 2 完成。(b) 关闭的是**响应前**的窗口，关闭不了这一条。
`node_activation_seq` 的代数守卫（§5 的 (a) 第二行）恰好关闭 R1 而关闭不了本 PR 关闭的那个窗口 ——
**两者互补**。是否叠加是 owner 决策；本 PR 刻意不叠（任务要求选一，且第二套机制会把审查面翻倍）。

**R2 —— `recordTerminal` 的清空无作用域，且本 PR 让这条边**方向上变差**。**
`ApprovalMetricsService.ts:468` 的清空没有 `recordNodeDecision` 那样的
`AND EXISTS (… current_node_key = $2)` 守卫，且它（`ApprovalProductService.ts:11262` / `:10579` 的 `emitTerminalMetric`）仍是 fire-and-forget；激活写现在被 await 了，
所以在两者都会触发的路径上（`ApprovalProductService.ts:10579-10582`：`emitTerminalMetric` 之后
紧跟 `emitNodeActivationMetric`），激活 stamp 更容易**存活在一个终态行上**。
**危害有界**：`scanNodeTimeouts` 带 `terminal_at IS NULL`，残留的 arm 不会被扫描到，是惰性脏数据。
未修。

**R3 —— 连接形状比先例更重，且并发/池压测未做（round-2 改写，采纳 r1 门审 P3-1）。**
被引作先例的两处同位置 await 走 `pool.query` —— 单语句 checkout 后立即归还；本 PR 被 await 的每个 hook
里**头一次 checkout 是多语句取行锁事务**（`pool.connect()` + `BEGIN` + `SELECT … FOR UPDATE` + `UPDATE` + `COMMIT`），
其后还有**第二次独立 checkout**（单语句 `UPDATE`）。数出来的上界是：
approve / 管理员 jump / handler 三条路径 **C1 + 2 次顺序 checkout**；
timeout-jump 与 return 两条路径 **C1 + 4 次顺序 checkout**（关闭 2 次 + 激活 2 次）。
**有界性有依据，但按 checkout 逐次计**：`connection-pool.ts:248-261` 的
`connectionTimeoutMillis = 10000` 与 `statement_timeout` / `query_timeout = 30000`
是**每次 checkout / 每条语句**的上界，不是整条路径的上界 —— 所以最坏情况是
「有界，但可能是若干个这样的上界之和」，仍不会把审批响应永久挂死。
**没有做的是**：高并发下的池压力实测。
`DB_POOL_MAX` 默认 20，「持有 C1 再借第二条」的悬崖是既有的（`:11255` 无条件执行），
本 PR 加长了持有时长、并把那两条路径的 checkout 次数翻倍 —— **「边际」二字仍无实测数字支撑，如实记。**

**R5 —— 被 await 的 hook 把 metrics 侧的停顿引入审批响应时延**与**完成事件的发出时刻**（round-2 新增）。**
每一次 checkout 最坏可增加 `connectionTimeoutMillis`（10s，取不到连接）或
`statement_timeout`（30s，语句被别的事务挡住）；按 §5 表的计数，timeout-jump 与 return 路径上
最多 4 次这样的 checkout。错误仍然被吞（promise 永不 reject，审批流不失败、不回滚），
**代价体现在时延而不是正确性**。
**另一处必须写明**：`:9530` 的被 await 关闭排在 `emitApprovalCompletionEvent(completionEvent)`
**之前**，所以 metrics 侧的停顿不只是拖慢 HTTP 响应，它按同一个上界**推迟完成事件的发出**
（下游 bridge / trigger 因此也被推迟）。这条不影响事件的内容或是否发出，只影响时刻。
这是选择「结果确定」所付的价；若 owner 认为该上界不可接受，替代方向是把这两条 hook 合并成
**一个**事务（需要改 `ApprovalMetricsService` 的公开方法，本 PR 刻意不做）。

**R4 —— PG 主版本轴。** 本地验证跑在 PostgreSQL 15（Homebrew）。l6a lane 的 CI 容器是
`postgres:16`。本 PR 不含 SQL 变更，理由上与版本无关，但**未在 16 上本地跑过**。

---

## 8. 未做 / 不声称（NOT RUN 清单见验证 MD §7）

- 未合并、未 undraft、未改任何锁文正文、未翻任何开关。
- **不声称「这条竞态没有了」** —— R1（真并发跨请求）仍在。可声称的是 §5 表第 1 行那一条、
  §5.1 的同节点再激活（n=30 单一交错），以及验证 MD §3 的三向判别力与 §3.1 的逐站点 mutation。
- **不声称本轮把 CI 那 1.1% 的自然发生率降到 0** —— 见验证 MD §7。
- **本轮新增的两条 `await`（decision 关闭）是修法的一部分，不是「叠加的结构性收口」**：
  §5.1 的 n=30 表明只恢复跳板仍丢 11/30（比 baseline 的 3/30 更差），
  所以门审「判据是结果」的那条要求，跳板单独达不到。是否接受 R5 的时延上界仍由 owner 裁。
- 不声称 CI 那 3 次红的**具体**析取支（报告 §1.7 已说明 CI 日志不携带该信息）。
- 本 PR 不修测试夹具 `forceDeadlineOverdue` 的稳定性轮询（报告给 owner 的选项 (b)）：
  修生产后该夹具在本序列上已无判别力缺口；是否另行加固由 owner 决定。
