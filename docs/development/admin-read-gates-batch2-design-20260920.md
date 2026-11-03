# admin 读侧补门 批次 2（ADM-05 / #5678）— 设计

- 日期：2026-09-20（+08:00）
- 分支：`fix/admin-read-gates-batch2`
- 文件：`packages/core-backend/src/routes/admin-routes.ts`、`packages/core-backend/tests/unit/admin-read-gates-batch2-authz.test.ts`
- 前序：批次 1 = #5710（`188be8500`，已合），给 `GET /api/admin/dlq` 与 protection-rules 两条读端点补门；本批沿用同一修法与同一 spec 骨架。

## 问题

`admin-routes.ts` 上仍有 5 条 GET 完全没有授权中间件：任何**已认证**用户——任意租户、无任何角色——直接读到平台级运维状态。这不是"租户看到别的租户的数据"那一类越权，而是"平台拓扑与运行状态对全体用户开放"。

| 端点 | 改前行号 | 泄漏什么 |
| --- | --- | --- |
| `GET /shards` | :1492 | 每个数据库连接池的名字、状态、总/空闲/等待连接数、最后一次驱动错误字符串，外加 `getMetricsSnapshot()`（`integration/db/connection-pool.ts:302`、`:359`） |
| `GET /shards/:name` | :1538 | 同上、单个池；且 404 与 200 的分叉本身是一个**存在性预言机**，一次一个猜测就能还原分片命名 |
| `GET /queues` | :1584 | MessageBus 队列深度 / 订阅计数 / 在途 RPC 数，加三次 `dlqService.list()` 得到的死信总量——来自与批次 1 同一张**无 tenant_id、无租户谓词**的 `dead_letter_queue`（`services/DeadLetterQueueService.ts:151`），即全平台失败量的聚合 |
| `GET /health/detailed` | :1891 | `HealthAggregatorService.checkHealth()`（`services/HealthAggregatorService.ts:209`）的**完整**逐子系统负载，含原始 `warnings` / `errors` 数组（其中是各子系统产生的失败文本） |
| `GET /health/subsystem/:name` | :1953 | 同上、单个子系统；400 分支还回显合法子系统白名单，等于免费给出本部署跑了哪些子系统 |

（`limit: 0` 在 `/queues` 里不再是全表拉取——已由 #5717 修在 `DeadLetterQueueService.ts:172`，本批不重复处理。）

## 修法

每条路由把 `requireAdminRole()` 插到**首位** handler，与批次 1 完全一致：

```ts
router.get('/shards', requireAdminRole(), async (req, res) => { ... })
```

三态语义（`guards/audit-integration.ts:113`、`rbac/service.ts:20`）：

1. 无 `req.user` 或非管理员 → `403` + `code: ADMIN_REQUIRED`；
2. RBAC 查询抛错 → `503` + `code: RBAC_CHECK_FAILED`，**fail-closed**，不降级放行；
3. 进程没有数据库 pool → `isAdmin()` 在 `rbac/service.ts:20` 直接返回 `false` → 走 `403`，即"读不到角色表"也是关门而不是开门。

"首位"是语义的一部分，不只是风格：门若排在 handler 之后，被拒的调用者虽然拿不到响应体，但查询/健康检查已经跑过了。spec 里对每条路由都钉了 `stack[0]`。

每条路由上方补了英文 SECURITY 注释，格式照 `/dlq`（改前 :1399-1406）：返回什么、为何无门是问题、三态语义。

## 决策：运维只读角色 vs 平台管理员

批次 1 的设计稿（`docs/development/admin-read-gates-batch1-design-20260914.md:49`）把批次 2/3 挂在一个未定的口径上——"这些读该给平台管理员，还是该有一个更窄的运维只读角色"。

按 AI 协作章程的"默认前进 + 24h 异步否决"，本 PR 取推荐值：**统一用 `requireAdminRole()`**，理由是

- 现在的状态是"人人可读"，先收到管理员是严格收紧；引入新角色是扩面，扩面可以稍后在已关门的基础上做，反过来不行；
- 这 5 条与已经要求管理员的写端点（`/dlq/*`、protection-rules 写、safety 确认）是同一批运维面，口径一致比口径细更重要；
- 真要做 `ops-readonly`，改法是给 `requireAdminRole` 加一个"或持某权限码"的旁路，对这 5 条是**加一处**而不是重写。

**Decision: Ratified-by-default-2026-09-20** —— owner 24h 内可否决；否决的落地代价是把这 5 条的门换成新角色守卫，不需要回滚本 PR 的 spec 结构。

## 本批明确不动

以下是本树上 `admin-routes.ts` 里**剩余**的全部无门 GET（实测：`grep -n "^router.get('"` 去掉带守卫的行，得到且只得到这 5 条），各有各的理由，作为残余记录而不是遗漏：

- `GET /slo/status`（:1357）——有在飞改动（#5680）覆盖这条，其反向对照用例把它钉成"无门"，现在加门会与之冲突；等那边落地后单独处理。
- `GET /safety/status`（:79）——由 `createSafetyStatusEndpoint()` 工厂产生，不是本文件里的内联 handler，加门要动工厂的调用契约，属于另一个改动面。
- `GET /ratelimits`（:1743）、`GET /ratelimits/:key`（:1805）、`GET /health/summary`（:1958）——纯计数器/粗粒度摘要，且最可能被现有运维脚本以非管理员身份轮询；先定"谁在调"再关，避免一次性打断巡检。

另外两件**故意没顺手做**的事：

- 不给 `/shards*` 与 `/health/detailed` 回显的错误文本做脱敏（`shard.error` 里可能带驱动原文）。加门之后受众已收敛到管理员，脱敏是独立的取舍点，混进来会让这个 PR 的"只收紧、不改形状"不成立。
- 不动任何写端点、不动挂载点（`src/index.ts`）、不动 `poolManager` / `messageBus` / `HealthAggregatorService` / `dlqService` 的实现。

## 管理员侧零变化

响应体形状、查询参数、路径参数一律原样透传：spec 里每条路由都有一条 `platform-admin -> 200` 用例断言底层 service 被调用的次数与关键字段，防止有人"把返回裁小了"冒充加门。

## 测试

`packages/core-backend/tests/unit/admin-read-gates-batch2-authz.test.ts`，骨架整体抄 `admin-dlq-read-authz.test.ts`：`usePinnedServer()` + `request(pinned.url())`（#4154 tripwire：`tests/unit` 里不许出现 `request(app)`），经真实 express 挂载而非直接调 handler，因此证明的是"门接在中间件链里且在 handler 之前"。

服务替身用 `vi.spyOn` 打在真实单例上，**不**用 `vi.mock` 替换模块：`integration/db/connection-pool` 与 `integration/messaging/message-bus` 被 `src/` 大面积引用（`AuthService`、`db/pg`、`middleware/oapi-scope-guard`、多个 routes…），整模块替换会波及被测路由以外的东西。

覆盖：5 条路由 × {非管理员 403 / 未认证 403 / RBAC 抛错 503 / 管理员 200 / 门在首位} + 3 条跨路由不变量（白名单不可读、存在性预言机不可达、五条全门扫描）= 28 个用例。

验证记录与变异自证见 `admin-read-gates-batch2-verification-20260920.md`。
