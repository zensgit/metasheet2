# admin 读端点补管理员门（批次 3）设计 — 2026-09-20

关联：issue #5678（无门 admin 读端点盘点）、PR #5710（批次 1）、PR #5884（批次 2）、PR #5680（admin-routes 写路由结构性守卫，**仍 OPEN**）。

前两批的设计稿：`admin-read-gates-batch1-design-20260914.md`、`admin-read-gates-batch2-design-20260920.md`。

## 为什么还有批次 3

批次 2 收了 5 条（`/shards`、`/shards/:name`、`/queues`、`/health/detailed`、`/health/subsystem/:name`），并在设计稿里把**剩下的 5 条列成显式残余**而不是遗漏。本批处理其中 4 条，第 5 条（`/slo/status`）因为 #5680 还在飞继续留。

批次 2 留 `/ratelimits*` 与 `/health/summary` 的理由是"先定谁在调，避免一次性打断巡检"。这个问题本批当场回答了，答案见下面「谁在调」一节。

## 盘点（行号以本 PR 基线 `origin/main` = `6ea19e2de` 为准）

盘点手法：`grep -n "^router\.get" packages/core-backend/src/routes/admin-routes.ts`（16 条，与全文件 `router.get(` 计数 16 一致，即这一层没有嵌在块里的注册），逐条看首位 handler 是不是 `requireAdminRole()`。

| 端点 | 基线行号 | 本批处理 | 理由 |
| --- | --- | --- | --- |
| `GET /safety/status` | `:79` | **加门** | 工厂 `createSafetyStatusEndpoint()` 只有这一个调用点，门加在挂载处，零影响 |
| `GET /ratelimits` | `:1743` | **加门** | 限流配置本身外泄；"谁在调"已核实为无人 |
| `GET /ratelimits/:key` | `:1805` | **加门** | 跨租户桶读 + `not_tracked` 存在性预言机，本批暴露面最强的一条 |
| `GET /health/summary` | `:1958` | **加门** | 批次 2 关了 `/health/detailed` 却留着同源的摘要，配对不一致 |
| `GET /slo/status` | `:1357` | **不动** | #5680 用它做反向对照（"无门 GET"），开工时 `gh pr view 5680` = `OPEN`；此时加门会把那个 PR 钉红 |
| `GET /plugins/health` `:376`、`/plugins` `:389`、`/plugins/:id` `:463`、`/plugins/:id/config` `:579`、`/yjs/status` `:1377`、`/dlq` `:1407`、`/shards` `:1502`、`/shards/:name` `:1556`、`/queues` `:1612`、`/health/detailed` `:1929`、`/health/subsystem/:name` `:2000` | — | 已有门 | 早前批次或本来就有 |

改完之后 `admin-routes.ts` 里**唯一**没有首位管理员门的 GET 就是 `/slo/status`，这一点由新 spec 的闭世界用例钉住（见「测试」）。

不属于本文件、因此不在本批范围的读面：`router.use('/snapshots', snapshotLabelsRouter)`（`:2131`）与 `router.use('/safety/rules', protectionRulesRouter)`（`:2132`）挂的是别的文件里的子路由；`/safety/rules` 的两条读已由批次 1 收过。

## `/safety/status`：门加在哪一侧

工厂在 `packages/core-backend/src/guards/middleware.ts:180`，返回一个同步 `(req, res) => void`，只读 `safetyGuard.isEnabled()` 与 `getPendingCount()`，不碰任何请求输入。

全树调用点只有一个：`admin-routes.ts:79`（`grep -rn "createSafetyStatusEndpoint"` = 工厂定义 1 处 + `admin-routes.ts` 的 import 与调用各 1 处，别无他处）。因此**门加在挂载处**：

- 对"既有调用方零影响"这条，挂载处与工厂内其实等价（只有一个调用方），但挂载处不改工厂契约；
- 工厂的契约正是 `tests/unit/multitable-sheet-liveness-closure-all-routes.guard.test.ts:951` 那条豁免记录所依赖的事实（`stillTrue` 断言工厂体里不出现 `sheet` / `req.params|query|body`）。把一个 async 守卫折进工厂会改那个事实；
- 扫描器读的是**最后一个** handler 参数（`tests/utils/sheet-liveness-route-scan.ts:550`），前面插中间件不改 `o.handler`，所以那条豁免记录仍然逐字成立——实跑 73 个用例全绿，见验证记录。

## 谁在调（批次 2 留的问题）

全仓 `grep -rn "ratelimits\|health/summary\|safety/status"`（排除 `node_modules` / `.git` / `dist`）：

- `/ratelimits`、`/ratelimits/:key`、`/health/summary`：**除路由定义本身外，只有两份历史清单文档提到**（`TODO_SPRINT7.md:34-37`、`:51`）。没有前端调用、没有 ops 脚本、没有 compose healthcheck、没有 CI 步骤。"现有巡检会被打断"这个担心在本树上没有实例。
- `/safety/status`：有两个真实调用方，都已核过：
  1. `scripts/test-safety-guard-e2e.sh:114` 带 `AUTH_HEADER` 调用，`:118` `assert_status 200`。该脚本自己给 `test-admin` 播种管理员角色（`:52`，`SEED_USER_ID=test-admin npx tsx src/seeds/seed-rbac.ts`），CI 里 `.github/workflows/safety-guard-e2e.yml:103` 也有独立的 "Seed RBAC for test user" 步骤（`SEED_USER_ID: test-admin`）连真实 Postgres；同一个 token 在同一脚本里已经通过了 `POST /safety/confirm`（`:197` 断言 200），而那条端点**早就**有 `requireAdminRole()`（本 PR 后为 `admin-routes.ts:110`）。即：这个调用方现在就是管理员，加门后仍是 200。
  2. `.github/workflows/safety-guard-e2e.yml:179` 的诊断快照 curl **不带任何认证**，加门后会拿到 403。这一步是 `if: always()` 的 diagnostics，命令尾部是 `|| echo "Status check failed"`，不影响任务成败。本 PR 故意不改它：改 workflow 属于另一个面，而且"未认证读不到安全开关"正是本 PR 想要的结果。若日后想让诊断继续有值，正确改法是给那条 curl 带上同一个 e2e token，而不是把门去掉。

## 决策口径

沿用批次 2 的 **`Decision: Ratified-by-default-2026-09-20`**（`admin-read-gates-batch2-design-20260920.md`「决策：运维只读角色 vs 平台管理员」）：读面统一收到 `requireAdminRole()`，而不是先造一个更窄的 `ops-readonly` 角色。本批不新增决策，只是把同一口径套到剩下的 4 条上；owner 若否决那条口径，本批与批次 2 一起换守卫，spec 结构不需要回滚。

批次 1 设计稿里那条"口径待定"（`admin-read-gates-batch1-design-20260914.md:49`）此前没有指向定论的指针（#5884 的反驳者指出的文档断链），本 PR 在该条下补了一行指针。

## 门的语义（三态，与前两批逐字一致）

`packages/core-backend/src/guards/audit-integration.ts:113`：

- 无 `req.user?.id` 或 `isAdmin()` 为假 → `403` `{ code: 'ADMIN_REQUIRED' }`；
- `isAdmin()` 抛错 → `503` `{ code: 'RBAC_CHECK_FAILED' }`（fail-closed，不降级放行）；
- 没有数据库连接池 → `rbac/service.ts:20` 的 `if (runQuery === query && !pool) return false` → 走 403 分支，不是开门。

## 管理员侧零变化

响应体形状、查询参数、路径参数一律原样透传。spec 里每条路由都有一条 `platform-admin -> 200` 用例，断言底层 service 被调用的次数与关键字段（`/ratelimits` 那条把 `config` 四个字段逐个钉住），防止有人"把返回裁小了"冒充加门。

## 本批明确不动

- **不动 `/slo/status`**：理由见盘点表。#5680 合入后的后续是单独一行 PR：给它加门，并把 #5680 里那条反向对照用例改指向别的无门读路由——本 PR 之后 `admin-routes.ts` 里已经一条不剩，所以那条用例应改成正向形式（断言"admin-routes 下再无无门 GET"）。本 PR 的新 spec 里那条闭世界用例正好是现成的形状，可以直接搬。
- **不动任何回显文本的脱敏**：`/ratelimits`、`/ratelimits/:key`、`/health/summary` 的 500 分支都回显 `err.message`（`admin-routes.ts` 对应 catch 块）。加门之后受众已收敛到管理员，脱敏是独立的取舍点，混进来会让本 PR 的"只收紧、不改形状"不成立。批次 2 对 `/shards*`、`/health/detailed` 做了同样的留置。
- **不动 `router.use` 顺序**、不动挂载点（`src/index.ts`）、不动 `SafetyGuard` / `TokenBucketRateLimiter` / `HealthAggregatorService` 的实现。
- **不动 #5680 的豁免表形状**，也不动 `multitable-sheet-liveness-closure-all-routes.guard.test.ts` 的任何条目（实跑证明无需动）。
- **不动 `packages/core-backend/openapi/admin-api.yaml`**：该文件里 `/safety/status`（`:43`）没有 `security`，但**整份 yaml 一个 `securitySchemes` 都没有**（`grep -n security` 空），连早就要求管理员的 `/safety/confirm` 也没写。只给本批四条补 403 会造出新的不一致，属于独立的文档对齐项，记为残余。
- 没有为了"让读更宽"而放松任何东西：本 PR 只收紧。

## 测试

`packages/core-backend/tests/unit/admin-read-gates-batch3-authz.test.ts`，骨架抄批次 2 的 spec：`usePinnedServer()` + `request(pinned.url())`（#4154 tripwire：`tests/unit` 里不许出现 `request(app)`），经真实 express 挂载而非直接调 handler，因此证明的是"门接在中间件链里且在 handler 之前"。

覆盖 = 4 条路由 × {非管理员 403 / 未认证 403 / RBAC 抛错 503 / 管理员 200 / 门在首位（`route.stack[0]` 对非管理员产出 403 且不 `next()`）} + 5 条跨路由用例 = 25 例：

- 每键桶预言机对非管理员不可达（两个键的响应逐字相等，且不含 `not_tracked`）；
- 限流配置不可读（403 体里不含 `tokensPerSecond` / `bucketIdleTimeoutMs`）；
- `/health/summary` 的 `hasWarnings` / `hasErrors` 不可轮询；
- 四条全门扫描；
- **闭世界扫描**：遍历 router 上每个 GET layer，对非管理员跑其 `stack[0]`，断言"没能产出 403 的"恰好等于 `['/slo/status']`。这条用例同时是 #5680 的接力棒——#5680 合入并给 `/slo/status` 加门的那天，红的就是它，后续不会被静默忘掉。

服务替身用 `vi.spyOn` 打在真实单例上，**不**用 `vi.mock` 替换模块（限流器 / SafetyGuard / 健康聚合器被 `src/` 大面积引用）。一个本批特有的坑写在 spec 头：`initAdminRoutes()` 内部会调 `initSafetyGuard()`，它 **destroy 并替换** SafetyGuard 单例（`admin-routes.ts:2146`），所以 SafetyGuard 的 spy 必须在建完 app 之后装——spec 里统一走 `mountApp()` 而不是直接 `pinned.setApp()`。

验证记录与变异自证见 `admin-read-gates-batch3-verification-20260920.md`。

## 残余已清零（追加于 2026-09-20，基线 `origin/main` = `1a6663a41`）

上文「本批明确不动」里唯一被留置的读端点 `GET /slo/status` 已在同日由 `fix/admin-slo-status-gate` 补门，`admin-routes.ts` 下的无门 GET 归零。留置的理由在补门时被重新核了一遍，结论是它从一开始就比实际情况保守：

- 留置写的是「#5680 合入后再动，否则把那个 PR 钉红」。实际情况是 #5680 的分支基于 #5665 而不是 main，它的 CI 跑在自己的分支树上；main 上给 `/slo/status` 加门不会进入 #5680 的任何一次检查。真正的后果只有一个：#5680 那条以「存在一条首位无门的 GET」为素材的反向对照不再有素材可指，必须改成正向形式。触发点不是「等它 rebase」——#5665 一旦合并、分支被删，GitHub 会自动把 #5680 的 base 改指 main，当场变红。
- 因此接力棒的方向也反了过来：原来是「#5680 合入 → 本批闭世界用例变红 → 提醒补门」；现在是「闭世界用例钉死空列表 → #5680 的 base 改指 main 那一刻，它必须自己把反向对照改成正向」。这一点写进了 `admin-read-gates-batch3-authz.test.ts` 的文件头。

补门后的形状与本批其余四条逐字一致：`requireAdminRole()` 作为 `/slo/status` 的首位 handler，三态语义不变（见「门的语义」一节），管理员侧响应体零变化。暴露面的描述见 `admin-routes.ts` 该路由上方的 `SECURITY` 注释：`sloService.getSLOStatus()`（`SLOService.ts:122`）聚合的是进程级 prom-client registry，全程没有任何租户谓词，所以加门前任何租户的任何已认证用户都能按需轮询平台自身的错误预算余量与 `healthy / at_risk / violated` 判定。

### 盘点口径修正：本批漏了一条子路由读（同日补上）

「归零」的第一版声明只对 `admin-routes.ts` **本体**注册的 GET 成立，被反驳轮证伪：`admin-routes.ts:2142` 的 `router.use('/snapshots', snapshotLabelsRouter)` 挂进来的 `snapshot-labels.ts:145` `router.get('/')` 自落地起就没有门（同文件三条写端点 `:40/:74/:109` 都有），而本批的闭世界扫描只遍历带 `layer.route` 的顶层层，`router.use()` 产生的层整层被跳过，所以扫描报的零是「看不见 → 报零」，不是「没有 → 报零」。

这一条的暴露面比本批原先要关的五条都重：`SnapshotService.ts:1169 / :1197 / :1220` 三条查询都是 `selectFrom('snapshots').selectAll()`，谓词只有 tag / protection_level / release_channel，零租户谓词 —— 加门前任意租户的任意已认证用户可读全平台快照行。

口径本身不是新定的：#5678 的盘点原文就把 `router.use` 挂进来的子路由 GET 算在内（点名 `protection-rules.ts` 的 `GET /` 与 `GET /:id`），只是漏登记了 `snapshot-labels.ts`。因此同一个 PR 里做了三件事而不是收窄措辞：① 给 `snapshot-labels.ts:145` 补 `requireAdminRole()`；② 把闭世界扫描改成**递归**下钻 `router.use()` 子路由、路径按挂载前缀拼接；③ 新增一条反盲区用例，直接断言扫描确实看得见 `/snapshots`、`/safety/rules`、`/safety/rules/:id`（零断言必须先证明镜头能看见目标）。

补门只收窄受众，不改查询：`snapshots` 三条查询缺租户谓词这一条**仍是未清零残余**，登记在验证稿的「残余」一节。

本批其余残余（`openapi/admin-api.yaml` 全文件缺 `securitySchemes`、500 分支回显 `err.message`）不在该 PR 范围内，仍然是残余。

验证记录与变异自证见 `admin-slo-status-gate-verification-20260920.md`。
