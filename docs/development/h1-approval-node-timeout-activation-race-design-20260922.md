# H-1 — 审批节点超时效果 vs 异步 metrics 激活写入竞态（产品修正候选）

> **状态：PROPOSED（候选，未裁决）。** 本文与配套实现是**提交给 owner 的候选**，不是已批准的合同变更。
> 无 DDL、无迁移、无新错误码、无公开合同变更。合并、undraft、开关变更均未授权。
>
> - 分支：`fix/approval-node-timeout-effect-activation-race`
> - 基线：`origin/main` @ `cd42eaf7455f03dd99021a02c47c42f1f3db6484`
> - 私有背景报告：`verify-5853-l6a-red-check-20260920.md`（本文不复述其缺陷细节，只引用其结论与时序）
> - 配套验证：`docs/development/h1-approval-node-timeout-activation-race-verification-20260922.md`

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
生产代码自己已经把这个窗口写在注释里 —— `ApprovalProductService.ts:9306`（本分支行号）：

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
| `applyNodeTimeoutEffect` 的**事务内竞态守卫** | `ApprovalProductService.applyNodeTimeoutEffect` | `ApprovalProductService.ts:9259-9265` |
| 超时单发性的**消费标记** | `markNodeTimeoutFired` / `consumeTimeout` | `ApprovalMetricsService.ts:493-499` / `ApprovalProductService.ts:9224-9230` |

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
| 一次级联内两次激活写乱序（B 合并 → C 激活） | 毫秒级 | **今天可达**。结果是 armed 行停在旧节点的 deadline 上；若两节点 effect 相同，`:9306` 所在的 effect 比对挡不住，扫描器会对**当前节点**提前触发一次效果 |
| 激活写晚于 `recordTerminal` 的**无作用域**清空（`ApprovalMetricsService.ts:458-471`） | 毫秒级 | **今天可达**，但**无害**：`scanNodeTimeouts` 带 `terminal_at IS NULL`，残留的 arm 是惰性的。只留脏数据 |
| 激活写晚于扫描器的 consume（60s 后） | 需 ~60s 迟到 | **不现实**，不作为论据 |
| 激活写晚于本用例的强制超期 UPDATE | 毫秒级 | **测试内可达**，即 CI 那 3 次红 |

即：第 1 行是一个真实的生产正确性缺陷（错节点提前超时），第 4 行是 CI 的红。
两者是**同一个窗口**的两个出口。

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
| 6 | `ApprovalProductService.ts:9197`（基线）→ `:9227`（本分支） | `consumeTimeout` 置 NULL | 否 | 在 `applyNodeTimeoutEffect` 自己的事务内 |

### 4.2 生产读取点（2 个）

| file:line（基线） | 读者 |
|---|---|
| `ApprovalMetricsService.ts:481-486` | `scanNodeTimeouts`（扫描器待办集合） |
| `ApprovalProductService.ts:9229-9235` | `applyNodeTimeoutEffect` 的 `FOR UPDATE` 竞态守卫 |

### 4.3 DDL（只读性确认，本 PR 不动）

`packages/core-backend/src/db/migrations/zzzz20260630100000_add_node_timeout_to_approval_metrics.ts:18-23`
—— 两列 + 一个 `WHERE current_node_deadline_at IS NOT NULL` 的部分索引。**本 PR 零迁移。**

### 4.4 `emitNodeActivationMetric` 的 5 个调用点（全部 POST-COMMIT，逐一核过）

| 本分支 file:line | 所在方法 | 前置 `await client.query('COMMIT')` |
|---|---|---|
| `ApprovalProductService.ts:8476` | 管理员 jump | `:8458` |
| `ApprovalProductService.ts:9527` | `applyNodeTimeoutEffect` 自己的再激活 | `:9520` |
| `ApprovalProductService.ts:10577` | handler 节点分支 | `:10567` |
| `ApprovalProductService.ts:10680` | `return` 分支 | `:10676` |
| `ApprovalProductService.ts:11254` | 普通 approve/dispatch | `:11231` |

**这是本修法的锁序判据**：5 处全部在 COMMIT 之后，审批事务持有的行锁已释放，
所以 await 一个需要第二条连接的写**不可能**与自己死锁（`feedback_lock_taking_port_needs_lock_order_census`
点名的 #4899 形状在此不成立）。

---

## 5. 两种修法对比

任务点名两个候选。逐条按「能否关闭 §3 的窗口」「新增失败模式」「代价」评。

### (a) 激活写改 CAS — `UPDATE … WHERE <期望值>`，失败则丢弃/重读

三种可用的 CAS 键（都是零 DDL，列已存在）：

| CAS 键 | 能否挡住 §3 变体 A（同节点、外部改写） | 能否挡住乱序激活 | 新失败模式 |
|---|---|---|---|
| `approval_instances.current_node_key = $nodeKey`（复刻 `:440` 先例） | **否** —— 实例仍在 `approval_c`，谓词为真，迟到的写照样落 | 是 | 无 |
| `approval_instances.node_activation_seq = $seq`（该列**已存在**，`ApprovalProductService.ts:11922` 的 `bumpNodeActivationSeq`） | **否** —— 同一次激活，代数未变 | 是（更强） | 无 |
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
| 关闭 §3 变体 A/B（单请求序列） | **是** |
| 关闭一次级联内两次激活写乱序 | **是**（同一请求内按 emit 顺序串行） |
| 新错误码 / 迁移 / DDL / 公开合同 | **零**（见 §6 的不变量核对） |
| 「metrics 故障不能拖垮审批流」 | **保持**：`settleMetricsCall` 内部 try/catch，promise 永不 reject ⇒ `await` 不可能把 metrics 错误路由进调用点外层那个 `catch { await rollbackQuietly(client); throw error }` |
| 代价 | 响应路径 **+1 个事务（BEGIN / SELECT FOR UPDATE / UPDATE / COMMIT）+ 1 条 UPDATE ≈ 5 次往返**；实测见验证 MD §5 |
| 连接池 | 在仍持有审批连接时取第二条连接 —— **既有模式，不是新类**：`emitApprovalTaskCreatedEventsPostCommit`（定义 `:11847`，走 `pool.query`）与 `supersedeCardDeliveriesPostCommit`（定义 `:11905`）已经在同一位置被 `await`（`:11232` / `:11245`）。`DB_POOL_MAX` 默认 20 |
| 锁竞争 | 被 await 的激活事务与仍是 detached 的 decision 写会在**同一行**上 `FOR UPDATE` 排队 —— 是**串行化**（同一行、同一顺序），不是死锁；表现为延迟，已计入上一行 |

**选 (b) 的理由（一句话）**：只有 (b) 能让被点名的验收场景转绿，且它以**构造性**（消除飞行中的写）
而非**谓词性**（猜哪个写该赢）的方式关闭窗口，因而不引入任何「丢 arm」的新分支。
(a) 的三个键里，两个对该场景无判别力，第三个用一个新缺陷换旧缺陷。

**(a) 与 (b) 是互补而非互斥的**：见 §7 的 R1。

---

## 6. 实现（三处，零 SQL 变更）

`packages/core-backend/src/services/ApprovalProductService.ts`：

1. **`:201` `logMetricsHookFailure`** —— 抽出原来的 warn 文案，避免两个形式各写一遍。
2. **`:210` `safeMetricsCall` —— 行为逐字不变**（仍是 `Promise.resolve().then(fn).catch(...)`）。
   保留微任务跳板：其余 hook（node decision / terminal / instance start）的同步路径不受影响。
   **本 PR 不改任何其它 hook 的派发语义。**
3. **`:231` `settleMetricsCall`** —— 新增的**可 await** 形式，同样的 log-and-swallow 合同。
4. **`:11298` `emitNodeActivationMetric`** —— 返回类型 `void` → `Promise<void>`，体内
   `safeMetricsCall(...)` → `return settleMetricsCall(...)`。**入参、写入的值、SQL 一字未动。**
5. **5 个调用点**（§4.4 表）加 `await`。

未改动且**刻意**未改动的：

- **`recordInstanceStart`（`:8156` 的 `safeMetricsCall`）不在本 PR 范围**。理由不是「范围收窄」，
  而是**没有同请求碰撞**：`:8157` 的注释自述「the FIRST node is activated here (not via
  `emitNodeActivationMetric`)」，该 INSERT 与激活 UPDATE 不在同一请求内，且它带
  `ON CONFLICT DO NOTHING`（§4.1 #1）⇒ 它不能覆盖任何东西。
- `ApprovalMetricsService.ts` **一行未改**（所以本 PR 不触发以该文件为 `paths:` 的 lane；
  触发的是以 `ApprovalProductService.ts` 为 `paths:` 的 lane，含 l6a —— 见验证 MD §6）。
- `:9306` 那条注释保留原文：它描述的是**跨请求**的窗口（R1），本 PR 没有关闭它，
  改写它会把一个仍然成立的事实写成已解决。

### 公开合同不变量核对

| 不变量 | 核对 |
|---|---|
| HTTP 状态码 / 响应体 | 未改（`emitNodeActivationMetric` 不参与响应构造） |
| 错误码 | 新增 0 个；`APPROVAL_ERROR_CODES` 未改 |
| `ApprovalNodeTimeoutEffectOutcome` 取值集合 | 未改 |
| DB schema / 迁移 | 0 个迁移，0 个 DDL |
| 特性开关 | 未新增、未翻转 |
| 「metrics 故障不能失败审批流」 | 保持（§5 表第 5 行） |
| `safeMetricsCall` 其余调用者的语义 | 逐字未变 |

---

## 7. 已披露的残留（本 PR **不**修，明写为 NOT FIXED）

**R1 —— 真并发的跨请求乱序仍然开放。**
请求 1 在 t1 提交并开始它被 await 的激活写；请求 2 拿到行锁、在 t2>t1 提交并开始它的激活写；
写 1 仍可能晚于写 2 完成。(b) 关闭的是**响应前**的窗口，关闭不了这一条。
`node_activation_seq` 的代数守卫（§5 的 (a) 第二行）恰好关闭 R1 而关闭不了本 PR 关闭的那个窗口 ——
**两者互补**。是否叠加是 owner 决策；本 PR 刻意不叠（任务要求选一，且第二套机制会把审查面翻倍）。

**R2 —— `recordTerminal` 的清空无作用域，且本 PR 让这条边**方向上变差**。**
`ApprovalMetricsService.ts:468` 的清空没有 `recordNodeDecision` 那样的
`AND EXISTS (… current_node_key = $2)` 守卫，且它（`ApprovalProductService.ts:11252` / `:10574` 的 `emitTerminalMetric`）仍是 fire-and-forget；激活写现在被 await 了，
所以在两者都会触发的路径上（`ApprovalProductService.ts:10574-10583`：`emitTerminalMetric` 之后
紧跟 `emitNodeActivationMetric`），激活 stamp 更容易**存活在一个终态行上**。
**危害有界**：`scanNodeTimeouts` 带 `terminal_at IS NULL`，残留的 arm 不会被扫描到，是惰性脏数据。
未修。

**R3 —— 延迟回归的上界未做负载测试。**
本 PR 只测了单请求延迟（验证 MD §5）。高并发下「持有审批连接的同时取第二条连接」的
池压力**没有**做压测。既有的两个同位置 await（§5 表第 6 行）承担同样的压力，
所以这是**既有形状的边际增量**，不是新类 —— 但「边际」二字没有实测数字支撑，如实记。

**R4 —— PG 主版本轴。** 本地验证跑在 PostgreSQL 15（Homebrew）。l6a lane 的 CI 容器是
`postgres:16`。本 PR 不含 SQL 变更，理由上与版本无关，但**未在 16 上本地跑过**。

---

## 8. 未做 / 不声称（NOT RUN 清单见验证 MD §7）

- 未合并、未 undraft、未改任何锁文正文、未翻任何开关。
- **不声称「这条竞态没有了」** —— R1 仍在。可声称的是 §5 表第 1/2 行那两条，
  以及验证 MD §3 的 mutation 双向判别力。
- 不声称 CI 那 3 次红的**具体**析取支（报告 §1.7 已说明 CI 日志不携带该信息）。
- 本 PR 不修测试夹具 `forceDeadlineOverdue` 的稳定性轮询（报告给 owner 的选项 (b)）：
  修生产后该夹具在本序列上已无判别力缺口；是否另行加固由 owner 决定。
