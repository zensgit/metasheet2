# DLQ `list({ limit: 0 })` 吞成 50 —— 设计与取舍(2026-09-14)

## 缺陷

`packages/core-backend/src/services/DeadLetterQueueService.ts` 的 `list()` 方法(实读定位在 `.limit(options.limit || 50)`,本次实读行号为 170,历史提交中出现过 167/170 两种,以本次实读为准):

```ts
.limit(options.limit || 50)
```

`||` 对 `0` 的处理是"当作没传",于是调用方显式要求 `limit: 0`(只要 `.total`,不要行)时,仍然会真的从 `dead_letter_queue` 拉 50 行全字段(含 `payload`、`metadata`)。

调用方 `packages/core-backend/src/routes/admin-routes.ts` 的 `GET /queues`(1583-1585 行,本次未改动)三次调用:

```ts
const dlqPending = await dlqService.list({ status: 'pending', limit: 0 });
const dlqRetrying = await dlqService.list({ status: 'retrying', limit: 0 });
const dlqResolved = await dlqService.list({ status: 'resolved', limit: 0 });
```

只用了返回值的 `.total`(见 1599-1602 行),却每次都白拉 50 行。

## `total` 计算方式实读结论

实读 `list()` 全文(151-178 行):`total` 来自**独立的 `countQuery`**(`db.fn.count('id')`),与行查询 `query` 是两条分开构建、分开执行的查询链:

```ts
let query = db.selectFrom('dead_letter_queue').selectAll()
let countQuery = db.selectFrom('dead_letter_queue').select(db.fn.count('id').as('count'))
// ...同样的 where 过滤同时套在两条链上...
const totalResult = await countQuery.executeTakeFirst()
const total = Number(totalResult?.count || 0)
const items = await query.orderBy(...).limit(...).offset(...).execute()
```

即 `total` **不是**从 `items.length` 推导的。这意味着"把 `limit: 0` 的语义改成真正的 0 行"不会连带把 `total` 也改错——`total` 已经是一条独立、与 `limit` 无关的 count 查询。

## 方案

不需要新增 `count()` 方法,也不需要把 `||` 换成 `??`(见下"为什么不用 `??`")。在计算完 `total` 之后、构建行查询之前插入短路:

```ts
const totalResult = await countQuery.executeTakeFirst()
const total = Number(totalResult?.count || 0)

// limit: 0 means "count only" — skip the row query entirely so callers
// that only need `.total` (e.g. GET /admin/queues) don't pay for a full
// 50-row/payload fetch just because `options.limit || 50` used to treat
// an explicit 0 as "not provided".
if (options.limit === 0) {
  return { items: [], total }
}

const items = await query
  .orderBy('created_at', 'desc')
  .limit(options.limit || 50)
  .offset(options.offset || 0)
  .execute()
```

`.limit(options.limit || 50)` 这一行**未改动**,因为它对 `limit` 为 `undefined`/`NaN`/负数等既有 falsy 回退行为均不在本次缺陷范围内(见下"其它 limit 取值的既有行为")。

### 为什么不用 `options.limit ?? 50`

如果只是把 `||` 换成 `??`:
- `limit: 0` 会被视为"显式传了 0",正确传给 `.limit(0)`,数据库层面拿到 0 行——这部分是对的。
- 但 `??` 只在 `null`/`undefined` 时回退默认值,`NaN` 会原样传给 `.limit(NaN)`。而现状 `options.limit || 50` 对 `NaN` 是回退到 50 的(`NaN` 是 falsy)。直接替换成 `??` 会静默改变 `NaN` 输入的行为,超出本次缺陷范围,且没有实读到任何调用方依赖或测试覆盖这一变化是否安全。

用"`limit === 0` 时短路成 `count-only` 提前返回"的写法,对所有非 0 输入(含 `undefined`、`NaN`、负数)的行为与改动前逐位一致,只改变了 `limit === 0` 这一个分支,是当前可验证的最小改动。

### 其它 limit 取值的既有行为(不在本次修复范围,已用回归测试锁定)

- `limit` 省略 → 50(`undefined || 50`)。
- `limit: 7` → 7(原样透传)。
- `limit: NaN` → 50(`NaN` 是 falsy,回退默认值)。
- `limit: -5`(负数) → 原样透传给 `.limit(-5)`,不做钳位。这是改动前就存在的行为,本次不改;如需钳位应作为独立缺陷单独处理。

## 调用方核查(全仓 `dlqService.list(` / `.list({`)

```
packages/core-backend/src/services/HealthAggregatorService.ts:385-387  limit: 1(×3,不受影响)
packages/core-backend/src/routes/admin-routes.ts:1403                  limit: limit ? Number(limit) : undefined(GET /dlq,查询串 ?limit=0 时会显式产生 0 —— 修复后行为从"错误返回50行"变为"正确返回空行+对total无影响",更符合语义,未见任何期待 limit:0 返回50行的断言/用法)
packages/core-backend/src/routes/admin-routes.ts:1583-1585              limit: 0(GET /queues,只读 .total —— 本次修复的目标调用方,未改动此文件)
packages/core-backend/src/routes/admin-routes.ts:1632                   limit(请求体 retry-all,默认100,显式传0语义为"不重试任何条目",未见依赖 limit:0 拿50条的用法)
```

结论:没有发现任何调用方期待 `limit: 0` 返回 50 行。`admin-routes.ts` 本次未改动(其改动属于另一支 PR #5710 的范围)。

## 与 #5710 / #5678 批次 2 的关系

- #5710 正在改 `routes/admin-routes.ts`(路由层),本任务的边界明确排除该文件,只改 `services/DeadLetterQueueService.ts` 服务层 + 单测。服务层修复后,`admin-routes.ts` 现有的三处 `limit: 0` 调用(1583-1585 行)无需任何改动即可自动得到正确行为(`total` 正确、不再白拉 50 行),两支 PR 在合并顺序上互不阻塞、互不冲突(未触碰同一文件)。
- #5678 批次 2:本次实读未在当前 worktree 找到与本缺陷直接相关的改动交集;若后续该批次涉及 `DeadLetterQueueService.ts` 或其调用方,需在合并前重新核对本文件改动是否仍适用。

## 改动文件

- `packages/core-backend/src/services/DeadLetterQueueService.ts` — `list()` 增加 `limit === 0` 短路分支。
- `packages/core-backend/tests/unit/DeadLetterQueueService.test.ts` — 新增 `describe('list() limit handling')` 覆盖 `limit: 0` / 省略 / `7` / `NaN` / `-5` 五种取值。

## 未做的事

- 未修改 `routes/admin-routes.ts`(按任务边界要求)。
- 未对负数 `limit` 做钳位(既有行为,超出本次缺陷范围)。
- 未新增独立的 `count()` 方法(实读确认不需要,`total` 已经是独立查询)。
