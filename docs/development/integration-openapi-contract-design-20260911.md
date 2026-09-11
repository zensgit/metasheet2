# G44 — 数据工厂对外契约的第一刀（只读面）· 设计

- 日期：2026-09-11
- 分支：`feat/integration-openapi-contract`，基于 `origin/main` 的 `5f4b32122`
- 范围：**只读**。不加写作用域，不放行任何非 GET，不改 `scripts/ops/stock-preparation-scheduled-pull.mjs`，不改 `plugins/plugin-integration-core/lib/http-routes.cjs`

---

## 1. 起点事实（改动前实读）

| 事实 | 位置 |
| --- | --- |
| `packages/openapi/src/paths/` 17 个文件，0 条 integration | `packages/openapi/src/paths/` |
| `mst_` token 的 6 个 scope 全落在 multitable/comments | `packages/core-backend/src/multitable/api-tokens.ts:24-38`（改前） |
| 全局 JWT 闸门只认一个开关 | `packages/core-backend/src/index.ts:1663` → `isOapiAllowlistRequest` |
| integration 路由由插件注册，不是宿主 router | `plugins/plugin-integration-core/lib/http-routes.cjs:9721-9746`（`context.api.http.addRoute`） |
| 插件路由挂载时机晚于 `setupMiddleware()` | `packages/core-backend/src/index.ts:636`（构造函数里 `setupMiddleware()`）vs `:674` 的 `addRoute` 在插件激活时才跑 |
| integration 面共 122 条路由，其中 54 条 GET，**全部**有 `requireAccess` 门 | 机械扫描 `http-routes.cjs` 的 `ROUTES` 表 + 每个 handler 首个门表达式 |
| `/api/integration` 不在全局闸门豁免表里 | `packages/core-backend/src/auth/api-path-policy.ts:114-164` |

一条**纠正**：差距分析里把 `GET /api/integration/status` 当成可疑点，实读它是有门的（`http-routes.cjs:4613-4614`，`requireAccess(req, 'read')`）。真正没有自带门的是 `GET /api/integration/health`——它在 ROUTES 表**之外**注册（`plugins/plugin-integration-core/index.cjs:463-465`），handler 体里只有 `res.json(buildHealthPayload())`。它今天靠全局 JWT 闸门保护，所以本 PR **不收录它**，理由写在允许表模块头里。

---

## 2. 契约边界：收了哪 24 条，为什么

一条机械规则，一类例外：

> **收录 = ROUTES 表里 method 为 GET 且 handler 首个门恰好是 `requireAccess(req, 'read')` 的全部路由，减去三条会构造 adapter、打到客户自己系统的。**

read 层（`requireAccess(req,'read')`）共 27 条 GET。扣掉三条**出站探测**：

| 扣掉的 | 位置 | 理由 |
| --- | --- | --- |
| `GET /external-systems/:id/objects` | `http-routes.cjs:5250` | 构造 adapter，带凭据打客户源 |
| `GET /external-systems/:id/schema` | `http-routes.cjs:5270` | 同上 |
| `GET /stock-preparation/source-preflight` | `http-routes.cjs:6571` | 同上（它自己的注释也承认这是两条先例之间的一次取舍） |

这三条是只读且是 read 层没错，但"让一个无人值守的机器凭据去**发起**打进客户 PLM/ERP 的流量"和"让它读我们自己的注册表"是两个决定，本 PR 只做后一个。

`requireAccess(req,'admin')` 的 GET 和 stock-prep 词表（`stock-prep:read`/`:operate`）的 GET 全部在外——本允许表**从不放宽任何层级**，只收窄一个 token 能够尝试的路由集合。

收录的 24 条见 `packages/core-backend/src/integration/oapi-integration-read-allowlist.ts:95-144`，逐条带 `expressPath` + `handler`，测试用它和插件 ROUTES 表机械对拍。

---

## 3. 两道门的完整追踪（本节是安全评审的主体）

### 3.0 为什么门不在路由上，而在应用层

multitable 那套的允许表条目是和 `routes/univer-meta.ts` / `routes/comments.ts` 里每条路由自己挂的 `apiTokenAuth` + `requireScope` 一一对应的。integration 面**做不到**：路由是插件通过 `context.api.http.addRoute` 注册的，而 `http-routes.cjs` 被溯源 pin 钉住，本波不碰。

所以门挂一次，挂在整棵 `/api/integration` 子树上：

- `packages/core-backend/src/middleware/integration-api-token-gate.ts:123` `createIntegrationApiTokenGate()`
- 挂载点 `packages/core-backend/src/index.ts:1680`，紧跟在全局 JWT 闸门（`:1656-1674`）之后、`correlationContextEnrichmentMiddleware`（`:1687`）和租户 ALS 中间件之前。

这个位置是承重的：**在全局闸门之后**，所以它看到的每个请求都已经被 `isOapiAllowlistRequest` 分过类；**在关联/租户中间件之前**，所以它建出来的身份就是下游（日志、`tenantContext`、插件自己的 `requireAccess`/`resolveTenantId`）看到的那一个。

顺带消掉了 multitable 允许表文档里警告的那类风险："有条目但没挂守卫 = 静默无鉴权绕过"——这里不可能因为"忘了挂"而发生，因为门覆盖整棵子树。允许表在这里控制的是**爆炸半径**。

### 3.1 请求到达 integration 路由之前，租户是怎么定的

先把**坏消息**摆出来，这是本次追踪最要紧的一条：

`apiTokenAuth`（`packages/core-backend/src/middleware/api-token-auth.ts:80-83`）给 token 请求挂的是

```
req.user = { id: result.token.createdBy, apiToken: true }
```

**没有 `permissions`、没有 `role`/`roles`、没有 `tenantId`**。

后果链条（全部实读）：

1. 插件 `listUserPermissions(user)`（`http-routes.cjs:886-892`）→ `[]`
2. `hasPermission(user,'read')`（`:896-913`）→ `permissions.includes('integration:read') || permissions.includes('integration:write')` → **false**
3. `requireAccess(req,'read')`（`:925-934`）→ 抛 403 FORBIDDEN

也就是说：**只把 `integration:read` 加进 scope 和允许表、不做别的，结果是每个 token 一律 403**。安全上没问题（是拒绝不是放行），但功能上等于没做。

再往下一步，`resolveTenantId`（`:1028-1057`）：

- `firstString(input.tenantId, req.query.tenantId, req.params.tenantId, user.tenantId)`
- 若 `user` 存在且**不是** tenantless 平台管理员（`isTenantlessPlatformAdmin` 要求 `role:admin` 且 `user.tenantId` 为空，`:920-924`），则要求 `user.tenantId` 非空且与请求里的 tenant 相等，否则 403 `TENANT_CONTEXT_REQUIRED` / `TENANT_MISMATCH`

token 身份 `user.tenantId` 为空 → 403 `TENANT_CONTEXT_REQUIRED`。同样是拒绝。

### 3.2 门的实际实现，逐行

`integration-api-token-gate.ts`：

| 行 | 做什么 | 失败结果 |
| --- | --- | --- |
| `:132` | 不是 `Bearer mst_` → `next()` | 会话/JWT 流量零改动 |
| `:134` | 不在 `/api/integration` 子树 → `next()` | multitable token 流量零改动 |
| `:137-145` | 不在 24 条允许表里 → **401**，且**不去校验 token** | 纵深防御：子树有唯一拒绝点，不依赖上面闸门的顺序 |
| `:148-151` | 跑真实 `apiTokenAuth`；它自己已答 401 就停 | 撤销/过期/未知 token → 401 |
| `:153-155` | `req.apiTokenScopes` 不是数组 → **401** | **不继承 `requireScope` 的 fail-open**（`api-token-auth.ts:96-99` 在无 scope 时放行） |
| `:156-159` | scope 里没有 `integration:read` → **403 INSUFFICIENT_SCOPE** | 门 1 |
| `:163-166` | creator id 缺失/空白 → **401** | |
| `:168-171` | `userHasPermission(creatorId,'integration:read')` 为假 → **403 FORBIDDEN** | 门 2 |
| `:175-179` | `authService.resolveSessionTenantId(creatorId)`，**不传任何请求输入** | 解析不出 → 无租户 |
| `:181-188` | 装配身份 | 见 3.4 |

### 3.3 `integration:read` 是怎么校验的（门 2 的实读）

用的是 `rbacGuard` 自己在 `req.user` 没有已解析权限时回落的那个函数：`packages/core-backend/src/rbac/service.ts:36-72` `userHasPermission(userId, code)`。它：

- `:37` 没有 pool → 返回 `false`（**无库即拒绝**，不是放行）
- `:39-41` 先过 `isPermissionAllowedByNamespaceAdmission(userId, code)`。`integration` **不在** `NON_NAMESPACED_PERMISSION_RESOURCES`（`rbac/namespace-admission.ts:11-36`）里，所以 `integration:read` 是受命名空间准入管辖的——和备料那次"直接 user_permissions 授予被命名空间过滤成 403"是同一条闸门，这里一视同仁
- `:44-45` 直接 `user_permissions`
- `:47-55` 经 `user_roles` × `role_permissions`
- `:57-61` legacy `users.permissions` 数组（含 `integration:*` / `*:*`）

**所以答案是：如果作用域 token 的身份在 RBAC 面没有 `integration:read` 权限码，结果是 403 FORBIDDEN，不是放行。** 有效权限 = min(token scope, creator RBAC)，和 `comments.ts` 用 `requireScope` ∘ `rbacGuard` 拿到的是同一个合成。测试 `integration-api-token-gate.test.ts` 的 "scope present but creator lacks the integration:read permission code → 403 FORBIDDEN" 钉住这条，变异 M3 证明它是承重的。

注意本仓库 `packages/core-backend/scripts/seed-rbac.ts` 里**没有** `integration:read` 的种子（grep 无命中）；按派活说明该权限码由上一波 PR #5611 在别处种下。本 PR 不依赖种子存在——种不下就是 403，fail-closed。

### 3.4 身份为什么只带一个权限码

```
req.user = {
  id: creatorId,
  apiToken: true,
  permissions: ['integration:read'],   // integration-api-token-gate.ts:184
  ...(tenantId ? { tenantId } : {}),
}
```

不是 creator 的完整权限集，是**恰好一个码**。三个后果都是刻意的：

1. 插件 `isAdmin(user)`（`http-routes.cjs:915-918`，找 `role:admin` / `integration:admin`）→ false。具体影响：`deadLettersList`（`:9677`）只对 `isAdmin` 放开未脱敏 payload，token 永远拿脱敏行。
2. `isTenantlessPlatformAdmin(user)`（`:920-924`，要 `role:admin`）→ false，于是 `resolveTenantId` 里那条**接受请求携带 `?tenantId=` 跨租户**的分支对 token **不可达**。平台管理员签出的 token 也被关在一个租户里，比它的 creator 自己用 JWT 更紧。
3. 不写 `role`、不写 `roles`——写任何一个都会把上面两条重新打开。变异 M6（加 `role:'admin'`）红 4 条。

### 3.5 租户只有一个来源

`resolveCreatorTenantId` 默认实现是 `authService.resolveSessionTenantId(creatorId)`，**不传 requestedTenantId**（`integration-api-token-gate.ts:120-121`、`:175`）。

`AuthService.ts:387-425` 的该函数在不传 requested 时：查 `user_orgs uo JOIN users u` 且 `uo.is_active AND u.is_active`，`LIMIT 2`，**只有恰好一条**活跃成员关系时才返回，否则 `undefined`。这正是 token 需要的 fail-closed 形状，而且和该用户自己登录拿到的租户是同一个函数、同一个答案。

`x-tenant-id` 请求头**从不被读**。`auth/jwt-middleware.ts:107-109` 在 token 无租户声明时会把该请求头拷到 `user.tenantId`——那是既有的洞（备料值回读/导出中招的那个）。本门不跑那段中间件，也不复制它的行为。`req.authenticatedTenantId` 同样只从服务端推导值来（`:187-188`），并在无租户时**清掉**旧值，让插件的 `assertVerifiedTenantClaim` 看到的声明确实是服务端来的。

解析不出租户时不报错，而是让下游 `resolveTenantId` 去拒绝（403 `TENANT_CONTEXT_REQUIRED`）；只有 4 条不解析租户的目录型读（`status` / `adapters` / `templates/references` / `staging/descriptors`）还能用。这是 fail-closed 的降级，不是放宽。

变异 M5（无租户时回落到请求头）红 1 条，M11（请求头优先）红 2 条。

---

## 4. 路径匹配的形状，以及"更窄"为什么是对的方向

`oapi-integration-read-allowlist.ts` 里有**两类**路径判断，方向相反，这是刻意的：

**(a) 子树判断** `isIntegrationApiPath`（`:168-170`）→ 直接调共享策略 `apiPathHasPrefix(path, '/api/integration')`（`auth/api-path-policy.ts:73-77`）。它大小写不敏感、容忍尾斜杠、按 segment 锚定。

问的是"这个门**有没有资格**对这个请求发表意见"，必须和 Express 路由器一致。第一版我写了自己的大小写敏感正则，结果 `GET /API/INTEGRATION/PIPELINES` **穿过**了门（`next()`），把拒绝完全交给上面全局闸门的顺序——这正是我给自己加的兜底想消除的依赖。测试直接抓到了（见验证文档 §2）。放宽这个判断只能产生**更多拒绝**，因为放行仍然要求下面大小写敏感的路由正则命中。

**(b) 路由身份判断** 24 条 `^…$` 锚定、**大小写敏感**、不容忍尾斜杠、不解码（`:95-144`）。问的是"这是不是**恰好**某一条已声明的读路由"，比路由器窄是安全方向：漏匹配 → 回落 JWT 闸门 → token 401（无害）；过匹配才是绕过。

因为这一类正则是"是不是那条路由"而不是"是不是 API 路径"，我在 `tests/unit/api-path-policy.guard.test.ts` 里按该守卫自己的要求补了一条**具名豁免**，理由写清它只覆盖路由身份、子树那问已经走共享策略。

### 用真实 Express 实测出来的对齐关系

用 core-backend 自己的 express 起了探针（证据见验证文档 §3）：

| 请求路径 | Express 派给谁 | 匹配器 | 判定 |
| --- | --- | --- | --- |
| `/api/integration/pipelines/` | `pipelinesList` 200 | 拒 | 欠匹配 → token 401，fail-closed |
| `/API/INTEGRATION/PIPELINES` | `pipelinesList` 200 | 拒 | 同上 |
| `HEAD /api/integration/pipelines` | GET handler 200 | 拒 | 同上 |
| `/api/integration/pipelines/../table-actions` | **404**（Express 不折叠 `..`） | 拒 | 两层都拒 |
| `/api/integration//pipelines` | **404** | 拒 | 两层都拒 |
| `/api/integration/pipelines;a=b` | **404** | 拒 | 两层都拒 |
| `/api/integration/pipelines?x=1` | `pipelinesList`，`req.path` 不含 query | 按无 query 判 | query 无法参与匹配 |
| `/api/integration/pipelines/p1%2frun` | `pipelinesGet`，`id='p1/run'` | **放行** | 两层一致：`%2f` 对**双方**都不是分隔符，落点仍是已声明的 GET；`POST .../run` 依然不可达 |
| `/api/integration/pipelines/%2E%2E` | `pipelinesGet`，`id='..'` | **放行** | 同上，`..` 只是个不透明 id 串，没有任何路径语义消费它 |

最后两行是我原本写成"必须拒绝"的用例，实测后改成"放行且可证明安全"。诚实记一笔：这不是绕过，因为**绕过的定义是"匹配器放行了一个 Express 会派给已声明集合之外 handler 的请求"**，而不是"匹配器匹配了个奇怪字符串"。

于是防绕过被写成一条**性质**而不是一串猜测，用真实路由器（按插件 ROUTES 表建的 122 条注册）验证：

> 匹配器放行 (method, path) ⟹ Express 把它派给一个**已声明的 GET handler**

反方向刻意不断言（匹配器本就更窄）。见 `tests/unit/integration-oapi-read-allowlist.test.ts` 的 "EVERY admitted (method, path) dispatches to a DECLARED GET handler"。

### 两处已知的方法冲突（不是洞）

- `/api/integration/external-systems` 既是已声明 GET list，又是 POST upsert → GET 放行、POST 拒绝
- `POST /api/integration/templates/preview` 与 `GET /api/integration/templates/:id` 同路径 → GET 落到 `templatesGet(id='preview')`，一次查不到的查询

两者都到不了写 handler，因为方法仍是 GET。完整清单在测试里逐条钉死，**变长**必须是一次被评审的改动。

---

## 5. 契约文件

`packages/openapi/src/paths/integration.yml`，24 条 path，全部只有 `get`。

- 路径/方法/参数/状态码全部**从代码实读**：query 参数来自各 handler 的 `requestQuery(req)` 取值，加上凡走 `scopedInput` 的路由都会被 `resolveTenantId`/`resolveWorkspaceId` 读到的可选 `tenantId`/`workspaceId`（`http-routes.cjs:1028-1057, 1248-1258`）；limit/offset 上限 500/10000 来自 `MAX_LIST_LIMIT`/`MAX_LIST_OFFSET`（`:1436-1437`）
- 响应体信封是实的：`sendOk` → `{ok:true,data}`（`:732`），`sendError` → `{ok:false,error:{code,message,details?}}`（`:736`）
- **`data` 刻意不给 schema**。每个 handler 返回的是各自 registry/store 的形状，照着读者的印象写 schema 就是编造。信封钉死、状态码钉死、描述说清 payload 讲的是什么，`data` 的类型化留给以后从 store 生成的那一刀
- 每个 operation 带 `x-api-token-scope: integration:read`，这是"哪些 integration operation 接受 `mst_` token"的完整清单，和允许表由测试机械对拍

---

## 6. 明确不做

1. **不加任何写作用域**。`ApiTokenScope` 只多了 `integration:read`（`api-tokens.ts:41,50`），没有 `integration:write`/`:admin`。
2. **不放行 POST/PUT/PATCH/DELETE**，包括 `POST /pipelines/:id/run` 和全部 dry-run / apply / ensure / persist / install。匹配器 GET-only（`oapi-integration-read-allowlist.ts:174`），插件 122 条路由里 60+ 条写路由逐条被测试钉为不可达。
3. **不改 `scripts/ops/stock-preparation-scheduled-pull.mjs`** 的鉴权方式，它继续持 admin Bearer。
4. **不改 `plugins/plugin-integration-core/lib/http-routes.cjs`**（溯源 pin）。也确认过 pin 清单 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 共 57 项，**不覆盖**本 PR 触碰的任何文件，因此无需重打 pin。
5. **不收 `GET /api/integration/health`**（无自带门）、不收三条出站探测、不收 admin 层、不收 stock-prep 词表。
6. **不动前端**。`apps/web/src/multitable/components/MetaApiTokenManager.vue:491` 的 `availableScopes` 是硬编码六项，不含 `integration:read`，所以 UI 暂时选不出这个作用域（后端 `routes/api-tokens.ts:42` 的 zod enum 走 `ALL_API_TOKEN_SCOPES`，API 可以创建）。`apps/web/src/multitable/utils/meta-api-token-labels.ts:252-259` 的标签表是 `Record<string, …>` 且有原样回落，不会因此报错或崩，只会把作用域显示成原字符串。这是已知的前端缺口，不是破坏。
7. **不加读侧限流**。写路由有 `apiTokenWriteRateLimit`，multitable 的读路由本来也没有 per-token 读限流，本 PR 不在这一刀里改这个既有形状。

---

## 7. 我不确定的地方

1. **creator 停用后 token 仍可读四条免租户目录**。`userHasPermission` 不看 `users.is_active`；`resolveSessionTenantId` 看（所以所有租户内数据会 403），但 `status`/`adapters`/`templates/references`/`staging/descriptors` 不解析租户，仍可读。这与既有 `apiTokenAuth` 在 multitable 面的行为一致（那边也不查 creator 是否停用），所以我没有在这一刀里单方面收紧；要收紧应当两面一起收。
2. **`bridge-agent-checklists/:id` 是否该进第一刀**。它按机械规则该进（read 层、不出站、纯读已存 checklist），但它同时是 BA-APPLY 的审批门本身。我按规则收了并在契约里写明了它的性质，如果 owner 认为机器凭据不该读审批门，删掉一条即可（允许表 + yml 同删，测试会强制两边同步）。
3. **`/api/integration/status` 会吐出完整路由清单**（含全部写路由的 method/path）。任何 read 层 JWT 用户今天就能看到，min(scope, creator RBAC) 成立；但如果把"路由面清单"视为不该给机器凭据的情报，这一条应当移出。
4. **命名空间准入的实际部署状态未验证**。`integration` 是受管命名空间，`userHasPermission` 会过准入；我没有在 222 或任何真库上跑过端到端，不知道目标部署的 `integration` 命名空间是否已启用。未启用的话结果是 403（fail-closed），不是放行。
5. **没有跑集成/端到端测试**。本波只跑了 unit 层（含用真实 Express 路由器的派发探针）。真实 `apiTokenAuth` → 真库 → 插件 handler 的整链没跑过。
