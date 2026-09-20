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
| 全局 JWT 闸门只认一个开关 | `packages/core-backend/src/index.ts:1666` → `isOapiAllowlistRequest` |
| integration 路由由插件注册，不是宿主 router | `plugins/plugin-integration-core/lib/http-routes.cjs:9721-9746`（`context.api.http.addRoute`） |
| 插件路由挂载时机晚于 `setupMiddleware()` | `packages/core-backend/src/index.ts:637`（构造函数里 `setupMiddleware()`）vs `:675` 的 `addRoute` / `:1278` 的 `registerPluginRoute` 在插件激活时才跑；`loadPlugins()` 在 `start()` 里（`:4088`）。**这条已由测试钉住**，见 §3.6 |
| integration 面共 122 条路由，其中 54 条 GET，**全部有门**；52 条是 `requireAccess`，2 条走 `requireTableActionAccess(req, actionId, 'read', …)` | 机械扫描 `http-routes.cjs` 的 `ROUTES` 表 + 每个 handler 首个门表达式；两条例外是 `tableActionLargeBomExpansionJobGet`（`:6234`）与 `tableActionLargeBomApplyJobGet`（`:6401`），其准入集 = read 层 **∪** 一线操作员（`requireTableActionAccess` 定义在 `:993-1020`，含 `operatorMayRunStockPrepPull` 析取），**不是** read 层的同义词，所以正确地不入本刀 |
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

收录的 24 条见 `packages/core-backend/src/integration/oapi-integration-read-allowlist.ts:95-142`，逐条带 `expressPath` + `handler`，测试用它和插件 ROUTES 表机械对拍。

---

## 3. 两道门的完整追踪（本节是安全评审的主体）

### 3.0 为什么门不在路由上，而在应用层

multitable 那套的允许表条目是和 `routes/univer-meta.ts` / `routes/comments.ts` 里每条路由自己挂的 `apiTokenAuth` + `requireScope` 一一对应的。integration 面**做不到**：路由是插件通过 `context.api.http.addRoute` 注册的，而 `http-routes.cjs` 被溯源 pin 钉住，本波不碰。

所以门挂一次，挂在整棵 `/api/integration` 子树上：

- `packages/core-backend/src/middleware/integration-api-token-gate.ts:146` `createIntegrationApiTokenGate()`
- 挂载点 `packages/core-backend/src/index.ts:1680`，紧跟在全局 JWT 闸门（`:1657-1672`）之后、`correlationContextEnrichmentMiddleware`（`:1684`）和租户 ALS 中间件之前。

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

token 身份 `user.tenantId` 为空 → 拒绝。**具体拒绝码分两支**（改后实读复验，不是转述）：请求里既没有 `?tenantId=`、也没有 `params.tenantId`，`firstString` 四路皆空，先在 `http-routes.cjs:1032` 抛 **400 `TENANT_REQUIRED`**；只有调用方自带 tenantId 时才走到 `:1039` 的 **403 `TENANT_CONTEXT_REQUIRED`**。本轮用插件导出的 `__internals.resolveTenantId` 跑了这两支，输入是本门装配的身份 `{id, apiToken:true, permissions:['integration:read']}`：

```
no tenantId anywhere         => 400 TENANT_REQUIRED "tenantId is required"
caller supplies ?tenantId=t9 => 403 TENANT_CONTEXT_REQUIRED "tenant context is required"
```

两支都是 fail-closed，差别只在码名。契约 yml 写的是 400 `TENANT_REQUIRED`，与代码一致；先前本文档和门的注释只写了 403，已改。

### 3.2 门的实际实现，逐行

`integration-api-token-gate.ts`：

（行号为本轮返修后的 `integration-api-token-gate.ts`。握手体被抽成局部 `authorize()`（`:158`），目的只有一个：让 `next()` 留在 try/catch **之外**，下游层的失败永远不会被报成本门的 503。）

| 行 | 做什么 | 失败结果 |
| --- | --- | --- |
| `:238` | 不是 `Bearer mst_` → `next()` | 会话/JWT 流量零改动 |
| `:240` | 不在 `/api/integration` 子树 → `next()` | multitable token 流量零改动 |
| `:243-250` | 不在 24 条允许表里 → **401**，且**不去校验 token** | 纵深防御：子树有唯一拒绝点，不依赖上面闸门的顺序 |
| `:161-162` | 跑真实 `apiTokenAuth`；它自己已答 401 就停 | 撤销/过期/未知 token → 401 |
| `:166-169` | `req.apiTokenScopes` 不是数组 → **401** | **不继承 `requireScope` 的 fail-open**（`api-token-auth.ts:96-99` 在无 scope 时放行） |
| `:170-174` | scope 里没有 `integration:read` → **403 INSUFFICIENT_SCOPE** | 门 1b |
| `:188-200` | token 带 base/sheet 围栏（`apiTokenBaseIds`/`apiTokenSheetIds` 任一非空）→ **403 OUT_OF_SCOPE** | 门 1c，见 §3.3a |
| `:201-205` | creator id 缺失/空白 → **401** | |
| `:209-212` | `userHasPermission(creatorId,'integration:read')` 为假 → **403 FORBIDDEN** | 门 2 |
| `:217-221` | `authService.resolveSessionTenantId(creatorId)`，**不传任何请求输入** | 解析不出 → 无租户 |
| `:223-230` | 装配身份 | 见 3.4 |
| `:255-278` | 任一 await 抛错 → 记日志 + **503 `AUTHZ_UNAVAILABLE`**（静态文案） | 见 §3.3b |

### 3.3 `integration:read` 是怎么校验的（门 2 的实读）

用的是 `rbacGuard` 自己在 `req.user` 没有已解析权限时回落的那个函数：`packages/core-backend/src/rbac/service.ts:36-72` `userHasPermission(userId, code)`。它：

- `:37` 没有 pool → 返回 `false`（**无库即拒绝**，不是放行）
- `:39-41` 先过 `isPermissionAllowedByNamespaceAdmission(userId, code)`。`integration` **不在** `NON_NAMESPACED_PERMISSION_RESOURCES`（`rbac/namespace-admission.ts:11-36`）里，所以 `integration:read` 是受命名空间准入管辖的——和备料那次"直接 user_permissions 授予被命名空间过滤成 403"是同一条闸门，这里一视同仁
- `:44-45` 直接 `user_permissions`
- `:47-55` 经 `user_roles` × `role_permissions`
- `:57-61` legacy `users.permissions` 数组（含 `integration:*` / `*:*`）

**所以答案是：如果作用域 token 的身份在 RBAC 面没有 `integration:read` 权限码，结果是 403 FORBIDDEN，不是放行。** 有效权限 = min(token scope, creator RBAC)，和 `comments.ts` 用 `requireScope` ∘ `rbacGuard` 拿到的是同一个合成。测试 `integration-api-token-gate.test.ts` 的 "scope present but creator lacks the integration:read permission code → 403 FORBIDDEN" 钉住这条，变异 M3 证明它是承重的。

注意本仓库 `packages/core-backend/scripts/seed-rbac.ts` 里**没有** `integration:read` 的种子（grep 无命中）；按派活说明该权限码由上一波 PR #5611 在别处种下。本 PR 不依赖种子存在——种不下就是 403，fail-closed。

### 3.3a 门 1c —— OAPI-4a 的 base/sheet 围栏，本面一律拒

`apiTokenAuth` 会把 token 的 per-base/sheet 白名单挂到请求上（`api-token-auth.ts:76-77`，`req.apiTokenBaseIds` / `req.apiTokenSheetIds`）。全仓**只有两处**碰这两个字段：那处写、以及 `oapi-scope-guard.ts:86-87` 读（`grep` 全仓，含 `apps/`、`plugins/`，无第三处）。也就是说 integration 子树上没有任何一层看它。

已批准的设计锁对这条不变量写得没有余地：

> `docs/development/multitable-oapi4-scoped-tokens-designlock-20260629.md:120` — "A scoped token can NEVER act outside its `base_ids`/`sheet_ids`, on any route, read or write."
> 同文 `:121` — "Scoping only **tightens**: it never grants access the creator's RBAC or the capability scope wouldn't already allow (it's an additional AND-constraint, never an OR-widen)."

本 PR 是该锁生效后新增的第一族路由。如果放行，一枚**主动做了最小权限动作**（填了 `sheetIds`）的 token 在这棵子树里会变回 creator-wide —— 失效方向是"用户以为收紧、系统静默没收紧"，是最坏的一类。

integration 路由没有可解析的 sheet/base 目标，所以门**无法校验**围栏。无法校验时唯一与上面两句自洽的组合是**拒绝**，不是放行：`integration-api-token-gate.ts:188-200` 在 scope 检查之后、RBAC 之前答 403 `OUT_OF_SCOPE`，并把 `req.oapiAuditReason` 置成和 `oapiScopeGuard` 同一个值 `out_of_base_sheet_scope`（`oapi-scope-guard.ts:27`），使两个面对这一类拒绝共用一套审计词表。

- **未加围栏的 token 不受影响**：两个白名单都空/缺席 = legacy creator-wide，正是 `oapiScopeGuard:92-95` 也放行的形状。
- **门 1b 的优先级不变**：scope 和围栏都不对时仍答 `INSUFFICIENT_SCOPE`（变异 M-X2d 证明这条是承重的）。
- 回归面：受影响的只有"同时带 `sheetIds`/`baseIds` 且带 `integration:read`"的 token，而 `integration:read` 本 PR 才诞生，所以今天几乎必然为零。
- 本刀**不**在创建侧加互斥校验（`api-token-service.ts` 那边 scopes 与 baseIds/sheetIds 正交）。创建侧对存量 token 不生效，门侧才是必需项；创建侧作为可发现性补充留给后续。

### 3.3b 授权后端自身失败时答什么

门体的三个 await（token 校验 / RBAC / 租户解析）全部包在一个 try/catch 里，catch 记日志后答 **503 `AUTHZ_UNAVAILABLE`**，文案是静态串——驱动/DB 的原文不回显给一个尚未通过鉴权的调用方（和 #5586 在数据源面定的家法同向）。

为什么必须显式答而不是把异常交出去：Express 4 **不会**把 async 中间件的 rejection 送进 error handler。用 core-backend 自己的 `express@4.21.2` / node v25.9.0 实测（脚本在 scratchpad，跑完即弃，仓库无落盘）：

| 中间件形状 | error handler 到达 | 客户端拿到 | 进程 |
| --- | --- | --- | --- |
| `app.use(async () => { throw })` | **否** | **1200ms 内无任何应答** | `unhandledRejection: db down` |
| 同上 + try/catch → `res.status(503)` | 否（也不需要） | `503 {"ok":false,"error":{"code":"AUTHZ_UNAVAILABLE"}}` | 干净 |
| 同上但 `next(err)` | 是 | `500` via error handler | 干净 |

第三行说明 `next(err)` 其实可行；选 `deny` 是因为它自证——不依赖末端确实挂了 error handler。顺带纠正终审里一处过强的表述："Express 4 不会把错误交给 error handler"要限定成"**async 中间件的 rejection** 不会"；显式 `next(err)` 会，实测就是第三行。

还有一处要收窄：终审说门里"三处 await 都可能 reject"。实际只有**两处**——`resolveCreatorTenantId` 的生产默认实现 `AuthService.resolveSessionTenantId` 自带 try/catch 返回 `undefined`（`AuthService.ts:422-425`），不会把异常抛出来。真正的抛出源是 DOOR 1a（`validateToken` 的三次裸 DB 调用，`api-token-service.ts:230/249/270`）和 DOOR 2（`userHasPermission` 对非 schema 错误 rethrow，`rbac/service.ts:70`）。测试仍然把第三处也覆盖了，因为它是可注入 seam、将来换实现就可能抛。

授权方向在修复前后都是 fail-closed（`next()` 从未被调用、身份从未装配），这一条修的是**可用性**面，不是授权面。旧测试 `tests/unit/integration-api-token-gate.test.ts` 里那条名为 "…surfaced to the error handler" 的用例把一个 Express 5 的行为当成本仓行为钉住了，已按实测改成断言 503 + `next` 未被调用。

### 3.4 身份为什么只带一个权限码

```
req.user = {
  id: creatorId,
  apiToken: true,
  permissions: ['integration:read'],   // integration-api-token-gate.ts:226
  ...(tenantId ? { tenantId } : {}),
}
```

不是 creator 的完整权限集，是**恰好一个码**。三个后果都是刻意的：

1. 插件 `isAdmin(user)`（`http-routes.cjs:915-918`，找 `role:admin` / `integration:admin`）→ false。具体影响：`deadLettersList`（`:9677`）只对 `isAdmin` 放开未脱敏 payload，token 永远拿脱敏行。
2. `isTenantlessPlatformAdmin(user)`（`:920-924`，要 `role:admin`）→ false，于是 `resolveTenantId` 里那条**接受请求携带 `?tenantId=` 跨租户**的分支对 token **不可达**。平台管理员签出的 token 也被关在一个租户里，比它的 creator 自己用 JWT 更紧。
3. 不写 `role`、不写 `roles`——写任何一个都会把上面两条重新打开。变异 M6（加 `role:'admin'`）红 4 条。

### 3.5 租户只有一个来源

`resolveCreatorTenantId` 默认实现是 `authService.resolveSessionTenantId(creatorId)`，**不传 requestedTenantId**（`integration-api-token-gate.ts:149-150`、`:217`）。

`AuthService.ts:387-425` 的该函数在不传 requested 时：查 `user_orgs uo JOIN users u` 且 `uo.is_active AND u.is_active`，`LIMIT 2`，**只有恰好一条**活跃成员关系时才返回，否则 `undefined`。这正是 token 需要的 fail-closed 形状，而且和该用户自己登录拿到的租户是同一个函数、同一个答案。

`x-tenant-id` 请求头**从不被读**。`auth/jwt-middleware.ts:107-109` 在 token 无租户声明时会把该请求头拷到 `user.tenantId`——那是既有的洞（备料值回读/导出中招的那个）。本门不跑那段中间件，也不复制它的行为。`req.authenticatedTenantId` 同样只从服务端推导值来（`:229-230`），并在无租户时**清掉**旧值，让插件的 `assertVerifiedTenantClaim` 看到的声明确实是服务端来的。

解析不出租户时不报错，而是让下游 `resolveTenantId` 去拒绝——无 `?tenantId=` 时 **400 `TENANT_REQUIRED`**（`http-routes.cjs:1032`），调用方自带 tenantId 时 **403 `TENANT_CONTEXT_REQUIRED`**（`:1039`），实测见 §3.1；只有 4 条不解析租户的目录型读（`status` / `adapters` / `templates/references` / `staging/descriptors`）还能用。这是 fail-closed 的降级，不是放宽。

变异 M5（无租户时回落到请求头）红 1 条，M11（请求头优先）红 2 条。

### 3.6 挂载序：本设计的承重假设，现在有测试钉住

门只有在**先于**插件路由进 Express 栈时才起作用。今天成立的链条是：

1. `this.app.use(createIntegrationApiTokenGate())` 在 `index.ts:1680`，位于 `setupMiddleware()`（`:1546-1995`）内；
2. `setupMiddleware()` 由**构造函数**调用（`:637`，构造函数体 `:599-641`）；
3. 构造函数体里既不 `loadPlugins`、也不 `registerPluginRoute`、也不往 `this.app` 上挂任何 `/api/integration` 路由；
4. 插件路由只能经 `addRoute`（`:675`）/ `registerPluginRoute`（`:1278`，实际 `this.app[method](path, …)` 在 `:1297`）注册，而这条路径要等 `start()` 里的 `await this.pluginLoader.loadPlugins()`（`:4088`，`start()` 体 `:3588-4565`）；
5. Express 按注册序派发，所以门必先跑。

之前**没有任何测试钉住它**：97 条用例全都直接调 `createIntegrationApiTokenGate()`，不经 app 栈——把插件加载提前到构造函数、或把门挪走，整扇门会静默失效而全绿。现在 `tests/unit/integration-api-token-gate.test.ts` 末尾的 "the MOUNT-ORDER assumption" 分两半钉：

- **A（Express 语义，实测）**：用真实 express 建应用，先 `app.use(gate)` 再按 24 条 `expressPath` 注册 `app.get`，断言 `app._router.stack` 里门的 index 小于**每一条** integration layer 的 index，并真发一次 `GET /api/integration/pipelines` 证明 handler 没跑、拿到门的 401；再用**反序对照**证明这两条不是空过（反序时 handler 确实跑了、200）。
- **B（本仓接线，源码扫描）**：断言上面 1–4 每一条，且扫描把注释行排除（第一版没排除，变异"把 mount 注释掉"居然是绿的——这是本轮变异自己抓出来的漏洞，已修）。

本波**不改结构**。终审提出的更稳形状——在 `registerPluginRoute`（`index.ts:675`/`:2076`）里对 `/api/integration` 前缀自动前置门，把"全子树一把"降成真 per-route、不再依赖初始化时序——记入"后续单"，不在这一刀里做。

---

## 4. 路径匹配的形状，以及"更窄"为什么是对的方向

`oapi-integration-read-allowlist.ts` 里有**两类**路径判断，方向相反，这是刻意的：

**(a) 子树判断** `isIntegrationApiPath`（`:168-170`，未改动）→ 直接调共享策略 `apiPathHasPrefix(path, '/api/integration')`（`auth/api-path-policy.ts:73-77`）。它大小写不敏感、容忍尾斜杠、按 segment 锚定。

问的是"这个门**有没有资格**对这个请求发表意见"，必须和 Express 路由器一致。第一版我写了自己的大小写敏感正则，结果 `GET /API/INTEGRATION/PIPELINES` **穿过**了门（`next()`），把拒绝完全交给上面全局闸门的顺序——这正是我给自己加的兜底想消除的依赖。测试直接抓到了（见验证文档 §2）。放宽这个判断只能产生**更多拒绝**，因为放行仍然要求下面大小写敏感的路由正则命中。

**(b) 路由身份判断** 24 条 `^…$` 锚定、**大小写敏感**、不容忍尾斜杠、不解码（`:95-142`）。问的是"这是不是**恰好**某一条已声明的读路由"，比路由器窄是安全方向：漏匹配 → 回落 JWT 闸门 → token 401（无害）；过匹配才是绕过。

**(c) 两者 AND 组合（本轮新增的一行硬化）** `isIntegrationOapiReadPath`（`:185-189`）在 method 检查之后先问 (a)，再问 (b)。原因是结构性的：表里每行带**两个互相独立**的路径串——`expressPath`（LOCKSTEP A/B 拿它跟插件 ROUTES 表机械对拍）和手写的 `pattern`（真正决定放行的那个）。没有任何机制强制两者一致。一条 `expressPath` 合法、`pattern` 却手写成子树外分支的条目，能通过现有**全部**断言；而门只拦子树（`integration-api-token-gate.ts:240`），于是这条路径会被全局闸门（`multitable/oapi-read-allowlist.ts:129`）放行到一条**身后没有任何 token 守卫**的路由上。这一行把"今天恰好没人写错"变成"写错也不生效"。它只能收窄：`isIntegrationApiPath` 是更宽的（大小写不敏感、容忍尾斜杠）判断，锚定 pattern 已匹配的路径必然满足它。测试用**注入一条坏行再还原**的方式钉住（变异 M-SUB：去掉这一行 → 红 4 条）。

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
2. **不放行 POST/PUT/PATCH/DELETE**，包括 `POST /pipelines/:id/run` 和全部 dry-run / apply / ensure / persist / install。匹配器 GET-only（`oapi-integration-read-allowlist.ts:186`），插件 122 条路由里 60+ 条写路由逐条被测试钉为不可达。
3. **不改 `scripts/ops/stock-preparation-scheduled-pull.mjs`** 的鉴权方式，它继续持 admin Bearer。
4. **不改 `plugins/plugin-integration-core/lib/http-routes.cjs`**（溯源 pin）。也确认过 pin 清单 `plugins/plugin-integration-core/lib/sealed-export/vectors/s6a-package-provenance-pins.json` 共 57 项，**不覆盖**本 PR 触碰的任何文件，因此无需重打 pin。
5. **不收 `GET /api/integration/health`**（无自带门）、不收三条出站探测、不收 admin 层、不收 stock-prep 词表。
6. **不动前端逻辑**。`apps/web/src/multitable/components/MetaApiTokenManager.vue` 的 `availableScopes` 仍是硬编码六项，不含 `integration:read`，所以 UI 暂时选不出这个作用域（后端 `routes/api-tokens.ts:42` 的 zod enum 走 `ALL_API_TOKEN_SCOPES`，API 可以创建）。`apps/web/src/multitable/utils/meta-api-token-labels.ts:252-259` 的标签表是 `Record<string, …>` 且有原样回落，不会因此报错或崩，只会把作用域显示成原字符串。这是已知的前端缺口，不是破坏。
   **本轮只改了该文件上方那段注释**：它原文写着 `availableScopes` "Must match the backend enum ALL_API_TOKEN_SCOPES"，而后端枚举现在是 7 项、这里是 6 项——注释自己变成了假陈述，且这句注释当初正是因为同类漂移（`['read','write','admin']` 被服务端 400）才写下的。改后的措辞把关系写准：这里是后端枚举的一个**声明子集**，每一项必须在枚举里（这一向仍成立），反向不成立，`integration:read` 是本刀刻意不在 UI 暴露的那一项。逻辑、标签表、`errorCodeLabels.ts` 一律没碰。parity 测试留给真正给 integration 做 UI 铸币入口的那一刀。
7. **不加读侧限流**。写路由有 `apiTokenWriteRateLimit`，multitable 的读路由本来也没有 per-token 读限流，本 PR 不在这一刀里改这个既有形状。

---

## 7. 我不确定的地方

前三条在对抗复核终审里已有裁决，移到 §8；下面只留仍然不确定的。

1. **命名空间准入的实际部署状态未验证**。`integration` 是受管命名空间，`userHasPermission` 会过准入；我没有在 222 或任何真库上跑过端到端，不知道目标部署的 `integration` 命名空间是否已启用。未启用的话结果是 403（fail-closed），不是放行。
2. **没有跑集成/端到端测试**。本波只跑了 unit 层（含用真实 Express 路由器的派发探针）。真实 `apiTokenAuth` → 真库 → 插件 handler 的整链没跑过。
3. **24 条 GET 的出站字段面没有逐字段过**。终审抽查了最敏感的一条（`rowToPublicExternalSystem`，`plugins/plugin-integration-core/lib/external-systems.cjs:145-173` 按 kind 删私有 config、凭据只出 `hasCredentials` 与指纹）结论安全；但 `hub/overview` / `provenance` / `runs` 的字段面无人逐条看过。建议下一刀补一条"出站无值面"的机械断言。本轮没做。
4. **门 1c 只做在门侧，没做创建侧**。`api-token-service.ts` 对 scopes 与 baseIds/sheetIds 完全正交，仍然能建出 `{scopes:['integration:read'], sheetIds:[...]}` 这种组合——只是它在本面一律被拒。创建侧的 400 互斥校验能提前把话说明白，但对存量 token 无效，所以不是替代品，只是可发现性补充。

---

## 8. 终审裁决：三条"为什么不收"的依据

这三条在 32 代理对抗复核里被反复提出过，裁决是**不改**。理由记在这里，免得下一轮重新问一遍。

### 8.1 `GET /api/integration/status` 吐全量路由表 —— 留着不改

该表是**编译期静态**的（`http-routes.cjs:13-274` 的 `ROUTES` 常量，122 条 = GET 54 / 非 GET 68；顺带纠正一个曾经流传的数字："260+" 是行数不是条数），各部署完全相同，不含任何租户/实例数据。

更要紧的是：同一份攻击面图**已经在无鉴权的前端产物里给得更全**。`apps/web/src/services/integration/stockPreparation/workbenchAccess.ts:85-138` 把每条路由连同它的 legacyGate 档位一起写死，而 `docker/nginx.conf` 的 `location ^~ /assets/ { try_files $uri =404; }` 对 `/assets/` 零鉴权下发（只有 `/api/` 走 proxy）。也就是说"哪些写路由存在"这件事今天对匿名访客就是公开的。

而门是按 **method + path 锚定白名单**判定的：知不知道写面存在，`POST /api/integration/pipelines/:id/run` 一样被拒（测试 `REFUSES 401 and never validates the token: POST …` 逐条钉死）。要收这一条只能改被 pin 钉住的 `http-routes.cjs:4613-4618`，代价与收益不成比例。

### 8.2 `bridge-agent-checklists/:id` —— 留着

它是 `requireAccess(req,'read')` 的**纯读**（`http-routes.cjs:5217-5224` → `getForApply`）。审批**动作**是另外两条：`bridgeAgentChecklistsApprove`（`:5226`）/ `bridgeAgentChecklistsRetire`（`:5239`），都是 **POST + `'write'`**。

在方法轴上它们被两重挡死：白名单 GET-only（`oapi-integration-read-allowlist.ts:186`），以及仓内**没有** method-override 机制（`method-override` / `X-HTTP-Method-Override` / `_method` 在 `package.json` 与 `src/` 全零命中）——所以 GET 判定不会在门后被改写成 POST。

机器凭据读到的是审批**证据**，不是审批**权力**，且与 creator 自己的 JWT 同面。

### 8.3 "creator 停用后 token 仍可读" —— 前提不成立

这条前提在实读后被推翻：DOOR 1a 先于 RBAC 就已 fail-closed。

- `multitable/api-token-service.ts:248-267`：`validateToken` 在检查 revoked/expired 之后、返回 token 之前，查 creator 的 `is_active` / `role` / `activation_status` / `local_password_set` 并过 `evaluateUserAuthenticationGate`；
- `auth/user-activation.ts:77`：`role === 'disabled' || is_active === false` → 拒；
- 租户侧再兜一次：`AuthService.ts:401` 与 `:414` 两条 SQL 各带一次 `u.is_active = true`；
- 已有测试：`tests/unit/api-token-webhook.test.ts:241` `validateToken fails when creator is inactive`。

`userHasPermission` 确实不看 `is_active`，但它永远排在这两道之后。

唯一的真实缺口是**本门的测试把 `authenticateToken` 当 seam 打了桩**，所以这条保证在 G44 套件里没有自己的锚。本轮补了一条**接线断言**（`G44 gate — the default seams are the real implementations`）：三个 seam 的默认值必须是真实实现，且 `api-token-service.ts` 里那道 creator 账号状态门仍在。这是接线级的，不是端到端级的——端到端仍未跑，记在 §7。

---

## 9. 后续单（本波明确不做）

1. **把门从子树中间件改成 per-route**。终审指出更稳的形状：宿主的 `registerPluginRoute`（`index.ts:675` / `:2076` → `:1278`）**没有**被 pin 钉住，可以在那里对 `/api/integration` 前缀的注册自动前置门，把"全子树一把"降级为真正的 per-route，且顺序不再依赖初始化时序。本波不改结构，改为先加挂载序守卫测试（§3.6）。
2. **创建侧 `integration:read` 与 baseIds/sheetIds 互斥校验**（§7.4）。
3. **24 条 GET 的出站字段面机械断言**（§7.3）。
4. **前端 parity 测试 + UI 铸币入口**（§6.6）。
5. **统一治理 `apiTokenAuth` 的裸挂点**。同形状的"Express 4 + 无 try/catch 的 async 中间件"在 main 上已成规模（`routes/comments.ts:183`、`routes/univer-meta.ts:12185` 等），本 PR 只管住自己新开的这一处，不替整仓还历史债。
