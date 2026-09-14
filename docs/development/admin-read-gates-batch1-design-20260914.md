# admin 读端点补管理员门（批次 1）设计 — 2026-09-14

关联：issue #5678（无门 admin 读端点盘点）、PR #5677（`/safety/rules` 写端点补门，本分支的父）、PR #5680（admin-routes 写路由结构性守卫）。

## 为什么

三条 admin 读端点在认证之后没有任何授权判断，任意一个已登录用户（任意租户、无任何角色）都能读到平台级数据：

1. `GET /api/admin/dlq`（`packages/core-backend/src/routes/admin-routes.ts:1407`）
   调用 `dlqService.list()`，后者 `db.selectFrom('dead_letter_queue')`（`packages/core-backend/src/services/DeadLetterQueueService.ts:151`）。
   该表**没有 tenant_id 列**，查询也不带任何租户谓词，因此返回的是全平台失败消息，含每条的 `payload`。
   这不是"跨租户读到了别人的行"那类作用域洞——这张表本身就没有租户维度，任何无门的读都等于平台级读。

2. `GET /api/admin/safety/rules`（`packages/core-backend/src/routes/protection-rules.ts:84`）
3. `GET /api/admin/safety/rules/:id`（同文件 `:112`）
   返回每条保护规则的 `rule_name` / `conditions` / `effects`，也就是"哪些破坏性操作被挡、按什么谓词挡"的完整地图。
   #5677 刚把这个路由的四条写端点收成平台管理员；读端点留着，等于把写端点的靶子图纸继续公开——先读规则，再挑一个 `conditions` 不覆盖的形状去做破坏性操作。

## 改了什么

三处，各加一个首位中间件，语义与 #5677 的写端点门完全一致（`requireAdminRole()`，import 自 `src/guards/audit-integration`，admin-routes 走 `src/guards` 桶文件再导出同一个实现）：

| 端点 | 文件:行 | 改动 |
| --- | --- | --- |
| `GET /dlq` | `packages/core-backend/src/routes/admin-routes.ts:1407` | `router.get('/dlq', requireAdminRole(), ...)` |
| `GET /`（safety/rules） | `packages/core-backend/src/routes/protection-rules.ts:84` | `router.get('/', requireAdminRole(), ...)` |
| `GET /:id`（safety/rules） | `packages/core-backend/src/routes/protection-rules.ts:112` | `router.get('/:id', requireAdminRole(), ...)` |

门的语义（`packages/core-backend/src/guards/audit-integration.ts:113`）：

- 无 `req.user.id` → 403 `ADMIN_REQUIRED`
- `isAdmin(userId)` 返回 false → 403 `ADMIN_REQUIRED`
- `isAdmin` 抛异常（含无 pool 以外的 RBAC 故障）→ 503 `RBAC_CHECK_FAILED`，fail-closed
- 无 pool 时 `isAdmin` 返回 false（见 `src/rbac/service.ts`）→ 走 403 分支，不是放行

另外更新了两处注释：
- `protection-rules.ts:17-34` 顶部那段 #5667 注释原文写着"Reads (GET /, GET /:id) are deliberately left as they were"，现在改成覆盖读端点，并写明限流与门的先后关系（见下）。
- `admin-routes.ts:1396-1406` 新增 `GET /dlq` 的安全注释，点名 `dead_letter_queue` 无 tenant_id。

管理员侧行为**零变化**：响应体形状、查询参数（`status`/`topic`/`limit`/`offset`、`target_type`/`is_active`）全部原样透传给 service，测试里有断言钉住这一点，防止有人用"把查询拆了"冒充加门。

### 限流与门的先后

`protection-rules.ts:48` 的内存限流器是 `router.use`，注册在两条 GET 之前，所以**限流先跑、门后跑**：被拒的调用者一样消耗自己的配额，不会拿到一个不计数的探测通道；同时这也意味着第 11 次请求仍然是 429 而不是 403（对下面 ops 脚本的影响判断很关键）。这条顺序有专门的用例钉住。

## 没改什么

- 不动 `/dlq` 的写端点（`POST /dlq/:id/retry`、`DELETE /dlq/:id`、`POST /dlq/retry-all`、`POST /dlq/cleanup`）——它们本来就有 `requireSafetyCheck` / `protectAdminOperation`。
- 不动 #5678 盘点里的批次 2/3（health / shards / queues / ratelimits / safety / slo）——那批要先定"运维只读角色 vs 平台管理员"的口径，不在本 PR。
- 不动 `protection-rules.ts` 的四条写端点（#5677 已做）、限流器实现、身份来源。
- 不动 `src/index.ts`、不动任何挂载点、不动 `dlqService` / `protectionRuleService` 的实现与 SQL。
- 没有为了"让读更宽"而放松任何东西：本 PR 只收紧，三条端点之外的授权面一律未动。

## 与 #5677 / #5678 / #5680 的关系

- **#5677（父分支 `fix/protection-rules-require-admin-and-identity`）**：本分支从它拉出，因为改同一个文件。它的 spec `tests/unit/protection-rules-authz.test.ts` 里原来有一条用例明确钉住"reads are deliberately UNCHANGED —— 非管理员仍可 GET"。那条用例现在由本 PR 的读端点用例**替换**（不是删掉了事）：#5677 当时的口径是"只收写"，#5678 的盘点把读的暴露面摆出来之后口径改了，文件头注释也相应改写，说明是谁在什么依据下改的。
- **#5678**：本 PR 是它的批次 1（"读端点里 payload/规则全文外泄"这一类），批次 2/3 另开。
- **#5680**（叠 #5665 的 admin-routes 结构性守卫 spec）：它只断言**写**路由的守卫形状，给 GET 加门不改任何写路由的中间件栈，因此不冲突。两边都改 `admin-routes.ts`，合并时可能有文本冲突，但不是语义冲突。

## 谁会被打断

仓库内对这三条端点的调用方，逐个查过：

- `apps/web/src`：**零调用**（`admin/dlq`、`safety/rules` 在 web 源码里没有任何匹配）。前端不受影响。
- `GET /api/admin/dlq`：全仓无任何运行时调用方，只有文档（`ROADMAP_V2.md`、`SPRINT4_COMPLETION_REPORT.md`、`TODO_SPRINT4.md`、`TODO_SPRINT7.md`）提到过。
- `scripts/verify-sprint2-staging.sh:155-167`：**唯一**对 `GET /api/admin/safety/rules` 的调用——连打 11 次做限流探测，断言最后一次是 429。详见下一节。
- `scripts/preflight-staging.sh:35-44`：只打 `POST /api/admin/safety/rules` 与 `POST .../evaluate`，是写端点，**已经**被 #5677 收成管理员，本 PR 不再改变它的行为。
- `scripts/staging-latency-smoke.sh:32`：探的是 `/api/v2/admin/protection-rules`，另一个路径（在 `packages/` 里没有实现），不是本路由。
- `.github/workflows/safety-guard-e2e.yml`：`paths:` 触发器里含 `packages/core-backend/src/routes/admin-routes.ts`，所以本 PR 会**触发**这条 E2E。但 `scripts/test-safety-guard-e2e.sh` 对 `dlq`、`safety/rules` 的匹配数是 **0**（它只打 `/api/admin/safety/status` 与 snapshots/confirm 系列），三条被加门的读端点它一条都不碰。

### 对 `verify-sprint2-staging.sh` 的具体影响与建议

该脚本的身份来自命令行传入的 `API_TOKEN`（`auth()` 在 `:31`）。分两种情形：

- **管理员 token**：11 次 GET 的前 10 次仍是 200、第 11 次仍是 429。脚本行为**完全不变**。
- **非管理员 token**：前 10 次从 200 变 403；第 11 次**仍然是 429**——因为限流器注册在门之前（见上）。脚本唯一的断言是 `last_code -eq 429`，因此**仍然 PASS**；变化只体现在证据文件 `rate-limit-$TS.txt` 里前十行的状态码上。
  另外要注意：这种 token 下脚本更早的 `Rule create status 200/201` 断言在 #5677 之后就已经 FAIL 了，不是本 PR 引入的。

**建议（本 PR 不改脚本）**：不需要改。若维护者想让证据更自解释，可以在脚本 usage 那行注明"`API_TOKEN` 必须是平台管理员"，或把限流断言从"最后一次 429"改成"序列里出现 429 且非 429 的码同为 200 或同为 403"。这两项都属于 ops 脚本口径，留给脚本 owner 决定，本 PR 不代为修改。

## 风险

- 若生产上存在未在仓库内登记的外部调用方（自建看板、curl 巡检）用非管理员 token 读这三条端点，它们会开始收到 403。仓库内已穷尽查证为零调用方，仓库外无法证伪——上线公告里应带一句。
- `isAdmin` 在 RBAC 故障时抛异常 → 503。这是 fail-closed，与 #5677 的写端点保持一致：DLQ 看板在 RBAC 挂掉时会读不到，属有意选择。

## 复核登记（缩水版对抗复核 · 查找者，2026-09-14）

- **[已修] CI 触发面**：本 PR 原 base 为 #5677 分支，`.github/workflows/plugin-tests.yml:17-18` 只对 `pull_request: branches: [main, develop]` 触发，core-backend 单测（`:842-844`）在叠加 PR 上**不跑**（rollup 10 条、无 `test (18.x/20.x)`）。已把 base 改为 main：diff = #5677 + 本批次，与合并后内容一致，CI 才真正执行两个新 spec。教训：叠加 PR 的保证只有本地证据，要么改 base 要么进组合树。
- **[登记，批次 2] `GET /queues`**（`admin-routes.ts:1583`）无门，内部三次 `dlqService.list({limit:0})`，而 `DeadLetterQueueService.ts:167` 是 `.limit(options.limit || 50)`——`0` 被 falsy 吞成 50，每次未鉴权请求真取 50 行全字段（含 payload），只回 `.total`。外泄的是全平台 DLQ 计数不是 payload；与 `/dlq` 同数据面，建议随批次 2 一并加门，并把 `limit:0` 改成显式 `count` 路径。
- **[登记，#5667 遗留] 限流键含 `:id` 且在门之前**（`protection-rules.ts:48-62`）：key = `${userId}:${method}:${path}`，`GET /:id` 时随机 id 进 key，module 级 Map 只在同 key 复访时剪枝 → 未认证方可让其无界增长；且每次 403 都写一条 audit（`guards/audit-integration.ts:120-145`）。本 PR 未加剧（改前那些请求回的是真数据），但「限流先跑」不只是优点。
- **口径降调**：`verify-sprint2-staging.sh:167` 对非 429 只 `[WARN]` 不计 fail，且建/删规则本就需管理员 token（#5677），所以本 PR 对该脚本结果**零影响**；正文原来把「第 11 次仍 429」当载荷性理由略夸大。
- 查找者核过未发现反例：假件背书（spec 只 mock `isAdmin`，`requireAdminRole` 本体真跑，放行用例经真门）、守卫没接线（`/dlq` 全仓唯一读路由，`/safety/rules` 唯一挂载点，无 v2 别名）、逐套绿整链红（#5680 结构 spec 明写读侧不管，反例控制用 `GET /slo/status`）。残留弱点：protection-rules spec 直挂 router 而非经 `initAdminRoutes()`（继承 #5667）。

