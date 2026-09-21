# protection-rules 限流表无界增长（ADM-18）— 设计

- 日期：2026-09-20（本机 +08:00，`date` 实跑）
- 分支：`fix/protection-rules-ratelimit-bounded`
- 影响面：`packages/core-backend/src/routes/protection-rules.ts` 的进程内限流表（无 DDL、无 env flag、无外部写）

## 1. 问题（实读，非推断）

改前 `packages/core-backend/src/routes/protection-rules.ts`：

- `:44` `const rateLimitStore = new Map<string, number[]>()`；
- `:52` `const key = \`${userId}:${req.method}:${req.path}\``——`req.path` 是调用方可任取的串，`GET /:id` 里的 id 直接进 key；
- 全文件没有 `delete` / `setInterval` / 容量上限；`:56` 的 `filter` 只在**同一个 key 再次被访问**时剪枝数组，key 本身永不删除；
- `:48` 的 `router.use` 在 `requireAdminRole()` 之前跑，这是 #5678 / #5710 **有意为之**（`:31-33` 注释：被拒的调用方仍要计量，且 `scripts/verify-sprint2-staging.sh:155-167` 的第 11 次 429 探测靠它成立）。

合起来：任何**已认证的非管理员**（拿不到 403 以外任何数据）都可以用「每次换一个编造的 id」的 `GET /api/admin/safety/rules/<随机>` 每请求新开一个桶，桶永驻进程内存，直到重启。这是内存增长面，不是权限面——权限由 `requireAdminRole()` 守住，没有被削弱。

## 2. 三处改动

### 2.1 key 收窄到路由形态（只紧不松）

`rateLimitRouteShape(path)` 把 `req.path` 归一成本路由自己的四种形态：

| req.path | 桶 |
| --- | --- |
| `/`（集合） | `/` |
| `/evaluate`（唯一具名动作） | `/evaluate` |
| 单段（`/r1`、`/任意id`） | `/:id` |
| 多段 / 未命中任何路由 | `/:other` |

单个主体的 key 空间从「方法 × 调用方任取的路径」变成「方法 × 4」。

**只紧不松**：以前 `GET /a` 与 `GET /b` 是两个各 10 次的桶，现在共用一个 10 次的桶——通过的请求只会更少，不会更多。所以原先会被限的一律仍被限，`verify-sprint2-staging.sh:155-167`（集合上 11 次快速 GET，判最后一次是否 429）不受影响。同时**没有**退化成 `${userId}:${method}`：`/` 与 `/:id` 仍是两个桶，管理台「列表 → 看详情」不会互相吃配额（该行为由 spec (3b) 钉住）。

### 2.2 惰性清扫（不在模块加载期起定时器）

`sweepExpiredRateLimitKeys(now)` 删掉「最新时间戳已出窗」的整个 key。触发条件二选一，在中间件入口判：

- 距上次清扫 ≥ `RATE_LIMIT_WINDOW_MS`（60s），或
- 距上次清扫已计量 ≥ `RATE_LIMIT_SWEEP_EVERY_WRITES`（512）次请求。

选惰性而不是 `middleware/rate-limiter.ts:45-58` 那种 `setInterval + unref`：`import` 这个 router 是 `admin-routes.ts:2026` 的静态依赖，模块加载即起定时器会把「导入一个路由」变成「起一个后台任务」，测试与短命进程都要为它兜底。惰性方案没有这个副作用，代价是完全静默的进程里最后一批桶留到下一次请求——有界且可接受。

判活口径与原剪枝一致：时间戳 `ts` 活 ⟺ `now - ts < WINDOW`；数组按时间递增追加，故只需看最后一个。

### 2.3 硬上限 `RATE_LIMIT_MAX_KEYS = 10_000` + fail-open

只有**新建桶**才会让 Map 变大，所以上限只在 `store.get(key) === undefined` 的分支上判：满了先清扫，清扫后仍满则**放行**（`next()`）并记一条 values-free 的 warn（每窗至多一条，防日志洪水）。

为什么 fail-open 而不是 fail-closed：**这个限流器不是安全边界，每条路由上的 `requireAdminRole()` 才是**。表满时拒流量、或为腾位驱逐活桶，等于把一个内存上限变成可用性 bug（而且驱逐活桶反而给攻击者重置配额的手段）。已有桶的调用方不受上限影响——上限只挡「再开新桶」。

10_000 个桶 × 每桶最多 10 个 number ≈ 数 MB 量级，够正常管理员规模用，远低于任何内存压力线。

### 2.4 仅测试用视图

仿 `middleware/rate-limiter.ts:75` 的 `get _map()`，导出 `_rateLimitStoreForTests()`（读 `size` / `keys`）与 `_resetRateLimitForTests()`（清表并复位清扫账）。`src/` 内无调用方（全仓 grep：只有新 spec 引用）。中间件本体也提名导出为 `protectionRulesRateLimit`，`router.use(protectionRulesRateLimit)` 用的就是同一个函数引用——测试直接驱动它才能在不开上万个 socket 的前提下打到上限。

## 3. 不动的东西

- 限流器相对 `requireAdminRole()` 的顺序（`router.use` 仍在所有路由之前）——`:31-33` 注释解释的 #5678 决定，本 PR 明确不挪。
- `RATE_LIMIT_MAX = 10` / `RATE_LIMIT_WINDOW_MS = 60_000` / 429 的响应体（`error_code: 'RATE_LIMIT'`）。
- 命中 429 时不写回数组（与改前一致）。
- 身份来源仍只有 `req.user.id`，回退 `req.ip`（#5667）。

## 4. 残余

- 上限是全局的，不是「每主体的桶数」上限：单个主体最多 `方法数 × 4` 个桶（常数），所以先撑到 10_000 的只能是「一万个不同主体/IP」，这已经不是单账号能造的面。
- 未认证请求按 `req.ip` 分桶，IPv6 下一个 /64 仍可枚举出很多桶——由上限兜底后是有界的，不再是无界增长。
- 进程内表，多实例不共享（改前即如此）；要跨实例一致需换 `middleware/rate-limiter.ts` 的 Redis store，不在本刀。
