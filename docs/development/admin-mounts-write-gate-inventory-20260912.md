# `/api/admin` 挂载点写端点门禁盘点（admin-routes.ts 之外）— 2026-09-12

基线：`origin/main` @ `9fb29831c`。只读盘点，无代码改动。

PR #5680 的结构性守卫只覆盖 `packages/core-backend/src/routes/admin-routes.ts` 这一棵树。本文盘点**其余**挂在
`/api/admin` 前缀下的 router：每条写方法路由（POST/PUT/PATCH/DELETE）的门在哪、判据读什么、有没有零门或只靠
确认层/限流的写端点。

**结论：B — 在下述枚举方法覆盖到的范围内，`/api/admin` 前缀下、不经 `admin-routes.ts` 的写路由共 67 条，
每条都有一道 admin 门，未发现零门、也未发现只靠确认层/限流的写端点。** 但两套（严格说三套）admin 判据并存，
判据**不同源**，且两份 `ensurePlatformAdmin` 副本之间存在一处生产可达的口径差（见 §4）。

---

## 1. 枚举方法与它的盲区

枚举分两步，都在 `packages/core-backend/src` 内实读：

1. `index.ts` 中所有 `this.app.use('/api/admin…', …)` 的挂载（grep `/api/admin` 于 `index.ts`：仅命中
   `index.ts:1884`–`index.ts:1912`，无其它行）。
2. 挂在根路径（`this.app.use(xxxRouter())`，无前缀）但自身注册 `/api/admin…` 绝对路径的 router：
   grep 路径字面量 `'/api/admin`、`"/api/admin`、`` `/api/admin `` 于全部 `src/**/*.ts`（排除 `__tests__`）。
   命中且是真实路由注册的只有 `routes/admin-users.ts` 与 `routes/permissions.ts`；
   `routes/metrics-demo.ts:49,172,184` 命中的是常量与 `fetch` 目标，不是路由注册。

这个方法**覆盖不到**的情形（盲区，如实登记）：

- 路径由变量/模板拼接而成的路由注册。已 grep 反引号形式，`src` 内非测试文件零命中；但拼接自常量的写法
  （例如 `r.post(BASE + '/x')`）不会被抓到。
- 通过父前缀落到 `/api/admin` 的注册（例如挂在 `'/api'` 的 router 内部写 `router.post('/admin/…')`）。
  已 grep `\.(get|post|put|patch|delete|use)\(\s*['\`]/admin`，全 `src` 零命中。
- 插件/运行期动态挂载。`this.app.use(` 只在 `index.ts` 出现（其它文件的 `app.use` 命中全是注释）；
  `plugins/` 下 grep `/api/admin` 零命中。
- `router.route(...)` / `router.all(...)` 形式的注册。已在本文涉及的 7 个 router 内 grep，零命中。

---

## 2. 挂载点清单（`index.ts`）

| # | 挂载 | file:line | router 源文件 | 写路由数 | 门的形态 |
|---|---|---|---|---|---|
| 1 | `/api/admin` → `initAdminRoutes(...)` | `packages/core-backend/src/index.ts:1884` | `routes/admin-routes.ts` | — | **本文范围外**（#5680/#5665 覆盖） |
| 2 | 根挂载 `adminUsersRouter()`（路由自带 `/api/admin/**` 绝对路径） | `packages/core-backend/src/index.ts:1898` | `routes/admin-users.ts` | 27 | 逐路由中间件首位 `authenticate`（仅认证），门在处理器体内第一条语句：`ensurePlatformAdmin` × 25 / `ensureRoleDelegationAdmin` × 2 |
| 3 | `/api/admin/directory/org-transfers` | `packages/core-backend/src/index.ts:1901` | `routes/admin-directory-org-transfers.ts` | 5 | 无路由级中间件；处理器体内第一条语句 `ensurePlatformAdmin` |
| 4 | `/api/admin/directory` | `packages/core-backend/src/index.ts:1902` | `routes/admin-directory.ts` | 20 | 同上（3 条经共享 helper，helper 第一条语句即门） |
| 5 | `/api/admin/directory/local` | `packages/core-backend/src/index.ts:1905` | `routes/admin-directory-local.ts` | 8 | 同上 |
| 6 | `/api/admin/directory/department-bindings` | `packages/core-backend/src/index.ts:1906` | `routes/admin-directory-department-bindings.ts` | 1 | 同上 |
| 7 | `/api/admin/directory/routing-policy` | `packages/core-backend/src/index.ts:1907` | `routes/admin-directory-routing-policy.ts` | 1 | 同上 |
| 8 | `/api/admin/canary` | `packages/core-backend/src/index.ts:1912` | `routes/canary-routes.ts` | 4 | **中间件首位 `requireAdminRole()`**（唯一一组与 #5680 同形的） |
| 9 | 根挂载 `permissionsRouter()`（其中两条是 `/api/admin/permission-templates*`） | `packages/core-backend/src/index.ts:1753` | `routes/permissions.ts` | 1 | 中间件首位 `authenticate`；门在处理器体内 `isAdmin(...)` 直调 |

合计写路由 67 条。

### 前置：全局会话闸

`index.ts:1669`–`index.ts:1682` 对 `/api/**` 统一挂了全局 JWT 闸（`jwtAuthMiddleware`），
`/api/admin` 前缀**不在**豁免表内——豁免表 `GLOBAL_GATE_EXCEPTIONS`（`auth/api-path-policy.ts:114`–`:163`）
逐条实读，无任何 `/api/admin` 条目；OAPI token 白名单（`multitable/oapi-read-allowlist.ts`，读写两张表）
也无 `/api/admin` 条目。所以上表第 3–8 项虽然没有路由级 `authenticate`，`req.user` 仍由全局闸填充；
缺 `req.user` 时 `ensurePlatformAdmin` 返回 401、`requireAdminRole` 返回 403，两者都是 fail-closed。

---

## 3. 逐条写路由 + 门（file:line）

### 3.1 `routes/admin-users.ts`（根挂载，绝对路径 `/api/admin/**`）

中间件链首位一律是 `authenticate`（= `jwtAuthMiddleware`，`middleware/auth.ts:11`），**不是** admin 门；
门是处理器体内的第一条语句。下表「门」列给出门所在行。

| 方法 | 路径 | 注册 file:line | 门 file:line | 门 |
|---|---|---|---|---|
| POST | `/api/admin/role-delegation/member-groups` | `routes/admin-users.ts:2202` | `:2203` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/scope-templates` | `:2281` | `:2282` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/scope-templates/:templateId/departments/:action` | `:2343` | `:2344` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/scope-templates/:templateId/member-groups/:action` | `:2421` | `:2422` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/users/:userId/scopes/:action` | `:2527` | `:2528` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/users/:userId/scope-groups/:action` | `:2613` | `:2614` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/users/:userId/member-groups/:action` | `:2691` | `:2692` | `ensurePlatformAdmin` |
| POST | `/api/admin/role-delegation/users/:userId/scope-templates/apply` | `:2756` | `:2757` | `ensurePlatformAdmin` |
| PATCH | `/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission` | `:2982` | `:2983` | **`ensureRoleDelegationAdmin`**（委派管理员亦可） |
| POST | `/api/admin/role-delegation/users/:userId/roles/:action` | `:3060` | `:3061` | **`ensureRoleDelegationAdmin`**（委派管理员亦可） |
| POST | `/api/admin/invites/:inviteId/revoke` | `:3367` | `:3368` | `ensurePlatformAdmin` |
| POST | `/api/admin/invites/:inviteId/resend` | `:3421` | `:3422` | `ensurePlatformAdmin` |
| POST | `/api/admin/users` | `:3534` | `:3535` | `ensurePlatformAdmin` |
| PATCH | `/api/admin/users/:userId/profile` | `:4002` | `:4003` | `ensurePlatformAdmin` |
| PATCH | `/api/admin/users/:userId/namespaces/:namespace/admission` | `:4314` | `:4315` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/namespaces/:namespace/admission/bulk` | `:4365` | `:4366` | `ensurePlatformAdmin` |
| PATCH | `/api/admin/users/:userId/dingtalk-grant` | `:4430` | `:4431` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/dingtalk-grants/bulk` | `:4477` | `:4478` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/:userId/roles/assign` | `:4530` | `:4531` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/:userId/roles/unassign` | `:4580` | `:4581` | `ensurePlatformAdmin` |
| PATCH | `/api/admin/users/:userId/status` | `:4631` | `:4632` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/:userId/reset-password` | `:4719` | `:4720` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/:userId/revoke-sessions` | `:4775` | `:4776` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/:userId/sessions/:sessionId/revoke` | `:5045` | `:5046` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/activate/bulk` | `:5189` | `:5190` | `ensurePlatformAdmin` |
| POST | `/api/admin/users/:id/activate` | `:5272` | `:5273` | `ensurePlatformAdmin` |
| POST | `/api/admin/login-aliases/backfill` | `:5298` | `:5299` | `ensurePlatformAdmin` |

27/27 有门；门均为处理器第一条语句，其后紧跟 `if (!adminUserId) return`（或 `if (!delegation) return`），
门之前无任何 service 调用。

### 3.2 `routes/admin-directory.ts`（挂在 `/api/admin/directory`）

无路由级中间件；门 = `ensurePlatformAdmin`（本文件 `:222` 定义），位置为处理器第一条语句。

| 方法 | 路径（相对挂载点） | 注册 file:line | 门 file:line |
|---|---|---|---|
| POST | `/dingtalk/work-notification/test` | `routes/admin-directory.ts:253` | `:254` |
| PUT | `/dingtalk/work-notification` | `:281` | `:282` |
| POST | `/integrations` | `:320` | `:321` |
| PUT | `/integrations/:integrationId` | `:353` | `:354` |
| POST | `/integrations/:integrationId/approval-card-config/secret/generate` | `:453` | `:454` |
| PUT | `/integrations/:integrationId/approval-card-config` | `:482` | `:483` |
| POST | `/integrations/test` | `:517` | `:518` |
| POST | `/integrations/:integrationId/sync` | `:529` | `:530` |
| POST | `/integrations/:integrationId/sync/preview` | `:621` | `:622` |
| POST | `/accounts/:accountId/bind` | `:869` | `:870` |
| POST | `/accounts/:accountId/admit-user` | `:919` | `:920` |
| POST | `/accounts/batch-bind` | `:1007` | `:1008` |
| POST | `/accounts/batch-admit-users` | `:1073` | `:1074` |
| POST | `/accounts/:accountId/unbind` | `:1181` | `:1182` |
| POST | `/accounts/batch-unbind` | `:1222` | `:1223` |
| POST | `/alerts/:alertId/ack` | `:1279` | `:1280` |
| POST | `/deprovision/events/:eventId/restore` | `:1687` | `:1690`（非法 mode 分支）/ `:1456`（经 `restoreDeprovisionEventForRequest`） |
| POST | `/deprovision-events/:eventId/reactivate` | `:1703` | `:1456`（helper `restoreDeprovisionEventForRequest` 第一条语句） |
| POST | `/deprovision-events/:eventId/force-reactivate` | `:1710` | `:1456`（同上） |
| POST | `/deprovision-events/:eventId/compensate-orphan-deny` | `:1717` | `:1556`（helper `compensateSupersededDenyGrantForRequest` 第一条语句） |

`:1687` 的写法值得单独记一笔：它先跑纯解析函数 `readCompatibilityRestoreMode(req.body?.mode)`（`:1340`，
无 IO、无副作用），再分两路——mode 非法走 `:1690` 的门然后 400，mode 合法走 helper（门在 helper 第一条）。
两条路径都在任何副作用之前过门，但它是本批里唯一一条「门不在处理器第一条语句」的写路由，
对任何基于「首位」的结构性断言都是个需要显式登记的形状。

### 3.3 `routes/admin-directory-local.ts`（`/api/admin/directory/local`）

门均为 `ensurePlatformAdmin`（从 `./admin-directory` import，`:5`），处理器第一条语句。

| 方法 | 路径 | 注册 | 门 |
|---|---|---|---|
| POST | `/departments` | `routes/admin-directory-local.ts:152` | `:153` |
| PATCH | `/departments/:departmentId` | `:188` | `:189` |
| POST | `/departments/:departmentId/archive` | `:234` | `:235` |
| POST | `/accounts` | `:263` | `:264` |
| PATCH | `/accounts/:accountId` | `:301` | `:302` |
| POST | `/accounts/:accountId/archive` | `:342` | `:343` |
| POST | `/memberships` | `:371` | `:372` |
| PATCH | `/memberships/:membershipId` | `:405` | `:406` |

### 3.4 `routes/admin-directory-department-bindings.ts`（`/api/admin/directory/department-bindings`）

| 方法 | 路径 | 注册 | 门 |
|---|---|---|---|
| POST | `/sweep` | `routes/admin-directory-department-bindings.ts:85` | `:86` `ensurePlatformAdmin` |

### 3.5 `routes/admin-directory-routing-policy.ts`（`/api/admin/directory/routing-policy`）

| 方法 | 路径 | 注册 | 门 |
|---|---|---|---|
| PATCH | `/:purpose` | `routes/admin-directory-routing-policy.ts:130` | `:131` `ensurePlatformAdmin` |

### 3.6 `routes/admin-directory-org-transfers.ts`（`/api/admin/directory/org-transfers`）

| 方法 | 路径 | 注册 | 门 |
|---|---|---|---|
| POST | `/` | `routes/admin-directory-org-transfers.ts:141` | `:142` `ensurePlatformAdmin` |
| POST | `/:transferId/scan` | `:195` | `:196` |
| POST | `/:transferId/apply` | `:218` | `:219` |
| POST | `/:transferId/cancel` | `:256` | `:257` |
| PATCH | `/:transferId/source-sync-freeze` | `:279` | `:280` |

### 3.7 `routes/canary-routes.ts`（`/api/admin/canary`）

唯一一组把门放在**中间件首位**的 router。

| 方法 | 路径 | 注册 file:line | 门 |
|---|---|---|---|
| PUT | `/rules/:topic` | `routes/canary-routes.ts:39` | 首位 `requireAdminRole()` |
| DELETE | `/rules/:topic` | `:70` | 首位 `requireAdminRole()` |
| POST | `/promote/:topic` | `:114` | 首位 `requireAdminRole()` |
| POST | `/rollback/:topic` | `:136` | 首位 `requireAdminRole()` |

### 3.8 `routes/permissions.ts`（根挂载中的 `/api/admin/**` 两条）

| 方法 | 路径 | 注册 file:line | 门 file:line | 门 |
|---|---|---|---|---|
| POST | `/api/admin/permission-templates/apply` | `routes/permissions.ts:347` | `:358`（身份）+ `:359`（`isAdmin`）→ `:361` 403 | 中间件首位 `authenticate`；处理器内 `isAdmin` 直调 |

（同文件 `:323` 的 GET `/api/admin/permission-templates` 是读端点，门形一致，列此备查。）
注意 `:349` 的 `if (!pool) return 503` 排在身份/权限判定之前：DB 不可用时非管理员拿到的是 503 而不是 403。
这不构成越权（无副作用即返回），但会让「非管理员一律 403」这类断言在无 DB 环境下失真。

---

## 4. 两套（实为三套）admin 判据：是否同源？

**不同源。** 实读结果：

### 4.1 `requireAdminRole()` — `packages/core-backend/src/guards/audit-integration.ts:113`

- 判据：`req.user?.id` 存在 → `isAdmin(user.id)`（`packages/core-backend/src/rbac/service.ts:19`）
  → `SELECT 1 FROM user_roles WHERE user_id=$1 AND role_id='admin' LIMIT 1`。
- 只认 `user_roles` 这一张表，不看任何 token/`users` 列。
- 失败面：无 `req.user.id` → 403 `ADMIN_REQUIRED`；`isAdmin` 抛错 → 503 `RBAC_CHECK_FAILED`（`:192`）；
  `pool` 为空时 `isAdmin` 直接返回 false（`rbac/service.ts:20`）→ 403。三条都是拒绝，fail-closed。
- 同族包装：`protectAdminOperation()`（`guards/audit-integration.ts:260`）= `[requireAdminRole(), auditSafetyOperation(...)]`。

### 4.2 `ensurePlatformAdmin` — 两份副本

| | `routes/admin-directory.ts:222`（`hasLegacyAdminClaim` 在 `:207`） | `routes/admin-users.ts:455`（`hasLegacyAdminClaim` 在 `:440`） |
|---|---|---|
| 无 userId | 401 `UNAUTHENTICATED` | 401 `UNAUTHENTICATED` |
| `req.user.role === 'admin'` | 放行 | 放行 |
| `req.user.roles` 含 `'admin'` | 放行 | 放行 |
| `req.user.permissions` 含 `'*:*'` | **放行**（`:212`） | **不看这个字段** |
| `req.user.perms` 含 `'*:*'` | 放行（`:213`） | 放行（`:445`） |
| `req.user.perms` 含 `'admin:all'` | **不认** | **放行**（`:445`） |
| 兜底 | `isAdmin(userId)`（同 §4.1 的 `user_roles`） | `isAdmin(userId)`（同） |
| 拒绝 | 403 `FORBIDDEN` | 403 `FORBIDDEN` |

两份副本的**兜底**与 `requireAdminRole` 同源（都落到 `rbac/service.ts:19` 的 `user_roles`），
但两份副本各自多出的「legacy claim」分支既与 `requireAdminRole` 不同源，彼此也不一致。

`req.user` 的来源（决定 legacy claim 读到什么）：

- 生产路径：全局闸 → `authService.verifyToken`（`auth/AuthService.ts:249`）→ `getUserById`（`:565`）读
  `users` 表（`USER_AUTH_SELECT` 含 `role, permissions`，`:52`）→ `resolveRbacProfile`（`:732`）：
  先用 `users.role` 列作 fallback，`isRbacAdmin(userId)` 为真才升级成 `'admin'`；
  `permissions` 用 `listUserPermissions(userId)` 覆盖。**注意 `:740`–`:745`：`isRbacAdmin` 抛错时只记一条 warn，
  `role` 保留 `users.role` 原值。** 所以 `users.role='admin'` 而 `user_roles` 无 admin 行的账号，
  在 `ensurePlatformAdmin` 下是管理员，在 `requireAdminRole` 下不是。
- 开发路径：`buildTrustedTokenUser`（`auth/AuthService.ts:203`）只在 `NODE_ENV !== 'production'` 且
  `RBAC_TOKEN_TRUST=true|1` 时生效（`:170`–`:176`），此时 `roles`/`perms` **直接来自 token claim**，
  且这是唯一给 `req.user.perms` 赋值的地方（grep `perms:` 于 `auth/`、`rbac/`：仅 `AuthService.ts:242`）。
  换言之：`perms` 分支在生产不可达，`permissions` 分支在生产可达。
- 另有非生产降级：`getUserById` 在 DB 查询失败且 `NODE_ENV !== 'production'` 时返回
  `role: 'admin', permissions: ['*:*']` 的 mock 用户（`auth/AuthService.ts:600`–`:617`）。

**由此得到一条生产可达的口径差**：持有权限码 `*:*` 但 `user_roles` 无 admin 行、`users.role` 也不是 `admin`
的账号，能过 `/api/admin/directory/**` 的门（`admin-directory.ts:212`），过不了 `/api/admin/users/**` 的门
（`admin-users.ts:440`–`:447` 不看 `permissions`），也过不了 `/api/admin/canary/**` 的门。
这不是「零门」，是**两道门宽度不同**。收紧方向（不放松）是删掉 `admin-directory.ts:212` 那一行，
让 directory 侧与 users 侧一致、并更靠近 `requireAdminRole`；是否收紧需 owner 裁决（会影响现网靠 `*:*`
操作目录页的账号），本文只登记，不擅改。

### 4.3 `ensureRoleDelegationAdmin` — `routes/admin-users.ts:1721`（第三套）

`hasLegacyAdminClaim || isAdmin` 为真 → 平台管理员；否则读 `fetchUserRoleIds(actorId)`
（`:481`，查 `user_roles`）→ `deriveDelegableNamespaces`（`:900`），命名空间非空才放行，空则 403。
只用在 §3.1 表里那两条 `role-delegation` 写路由上，是**有意的委派管理员口径**，不是漏门。
任何「所有 /api/admin 写路由必须平台管理员」的断言都必须把这两条显式登记为例外，否则会把设计当 bug。

---

## 5. 为什么判 B（以及 B 的边界）

- 67 条写路由逐条实读，每条在任何 service 调用之前都要过一道 admin 门（§3 的 file:line 即证据）。
- 没有「只靠确认层/限流」的写端点：`requireSafetyCheck`/`auditSafetyOperation` 在本批 router 里
  一次都没单独出现——`/api/admin/canary` 用的是 `requireAdminRole()`，其余用的是处理器内的 `ensure*`。
  （确认层 + 限流的组合出现在 `admin-routes.ts` 树与 `/api/snapshots`，均在本文范围外。）
- 未发现门在 service 调用之后的排序错误。
- B 的边界：本结论的效力止于 §1 列出的枚举方法。它证明的是「这 67 条注册点各自有门」，
  不证明「门的判据足够严」（§4 已记一处宽度差），也不覆盖 `admin-routes.ts` 树与 §7 的邻接管理面。

---

## 6. 建议：把 #5680 的守卫扩到这些 router

#5680 的结构性 spec 在本基线（`9fb29831c`）上尚未落地，以下按「中间件首位必须是 admin 门」的形状来提建议。

### 6.1 直接照搬会失败，原因是门的形态不同

本批 7 个 router 里只有 `canary-routes.ts` 把门放在中间件位置。其余 60 条写路由的门在**处理器体内**，
用 `router.stack` 走中间件链只会看到「首位 = `authenticate`」或「首位 = 唯一的 handler」，
照搬「首位必须是 admin 门」会把 60 条全判红（假红），进而逼人为了过测试去挪代码或放宽断言。
所以第二段必须换一种判据。

### 6.2 建议把第二段写成「行为 + 清单反查」两条断言

放在同一 spec 文件的第二个 `describe`（或独立文件
`packages/core-backend/tests/unit/admin-mounts-write-gate.structure.test.ts`），两条都要有：

**断言 A（行为，逐条写路由）**：用 supertest 把这些 router 挂到最小 app，`vi.mock('../../src/rbac/service')`
让 `isAdmin` 恒 false，注入一个无任何 legacy claim 的 `req.user`（`role: 'user'`、`permissions: []`），
对表里每条 `(method, path)` 断言 **403（`ensure*` 家族）或 403（`requireAdminRole`）**，
且被 mock 的下游 service **零调用**（`expect(svc.xxx).not.toHaveBeenCalled()`）。
再补一组 fail-closed：`isAdmin` 抛错时 `requireAdminRole` → 503、`ensurePlatformAdmin` → 非 2xx，都不得放行。
现成的挂载/mock 范式可直接抄 `packages/core-backend/tests/unit/snapshots-authz.test.ts`
（`vi.mock` rbac/service + `pool: null` + `usePinnedServer`）与 `tests/unit/change-management-authz.test.ts`。

**断言 B（清单反查，防漏登记）**：从每个 router 工厂拿到 `Router` 实例，遍历 `router.stack` 枚举出所有
`(method, path)`，过滤出写方法，与断言 A 的表做**双向**比对：表里有而 stack 里没有 → 红（路由被删/改名）；
stack 里有而表里没有 → 红（新增写路由没登记，必须显式加行并加行为断言）。这条才是真正的「守卫」——
没有它，将来新加的写路由不会让任何测试变红。

**例外白名单**必须显式、带理由：
`PATCH /api/admin/role-delegation/users/:userId/namespaces/:namespace/admission`（`admin-users.ts:2982`）
与 `POST /api/admin/role-delegation/users/:userId/roles/:action`（`:3060`）走委派管理员口径，
对它们断言「非平台管理员且无委派命名空间 → 403」，而不是「非平台管理员 → 403」。

### 6.3 把这些 router 引入测试的具体方式

- 第 3–8 项都是零参工厂（`adminDirectoryRouter()` 等），直接 import 即可挂载，无需构造 injector。
- 第 2、9 项（`adminUsersRouter()`、`permissionsRouter()`）注册的是绝对路径，挂到 app 根即可
  （`app.use(adminUsersRouter())`），路径就是 `/api/admin/...`。
- `admin-users.ts` 的门是 `hasLegacyAdminClaim || isAdmin`，所以测试里注入的 `req.user` 必须同时
  不含 `role:'admin'`、`roles`、`perms`、`permissions:['*:*']` 四种 claim，否则会假绿。
  建议把这四种 claim 各做一个「宽度」用例，顺便把 §4 的口径差**钉成测试**：
  `permissions:['*:*']` 对 directory 放行、对 users 拒绝——这是当前真实行为，钉下来后，
  将来任何一侧被改动都会变红，逼人显式裁决而不是悄悄漂移。
- 变异证据（去掉守卫测试就红）：把任一处 `ensurePlatformAdmin(req, res)` 的返回改成恒定字符串、
  或把 `requireAdminRole()` 换成 pass-through，断言 A 必须由绿转红；断言 B 的证据是删掉表里任意一行或
  给 router 临时加一条未登记的写路由，必须由绿转红。两类变异都可用 `vi.mock` 内存级完成，不必落盘。

---

## 7. `/api/admin` 前缀之外、语义上属于管理面的挂载（只列不判）

不在本次判定范围内，仅登记位置与门的形态，供后续决定要不要纳入同一守卫：

| 挂载 | file:line | 写路由与首位门 |
|---|---|---|
| `snapshotsRouter()` → `/api/snapshots/**` | `packages/core-backend/src/index.ts:1762` | `routes/snapshots.ts:107/139/173/229/385` 首位 `requireAdminRole()`；`:274`（restore）、`:349`（delete）、`:448`（cleanup）首位 `...protectAdminOperation(...)` 后接 `requireSafetyCheck(...)` |
| `rolesRouter()` → `/api/roles/**` | `packages/core-backend/src/index.ts:1752` | `routes/roles.ts:29/55/80` 首位 `rbacGuard('roles','write')` |
| `permissionsRouter()` → `/api/permissions/**` | `packages/core-backend/src/index.ts:1753` | `routes/permissions.ts:133`（grant）、`:214`（revoke）首位 `authenticate`，门在处理器内 |
| `attendanceAdminRouter()` → `/api/attendance-admin/**` | `packages/core-backend/src/index.ts:1754` | 首位无中间件；门在处理器内，且**各路由口径不同**：`routes/attendance-admin.ts:988` 用组织成员口径 `canReadAttendanceDirectoryReadiness`（`:1033`），`:1682` 用 `ensurePlatformAdmin`（从 `./admin-users` import，`:10`）。未逐条盘点 |
| `auditLogsRouter()` | `packages/core-backend/src/index.ts:1744` | 未盘 |
| `apiTokensRouter()` | `packages/core-backend/src/index.ts:1835` | 未盘 |
| `dataSourcesRouter()` | `packages/core-backend/src/index.ts:1850` | 未盘 |
| `internalRouter` → `/internal/**` | `packages/core-backend/src/index.ts:1856` | 未盘（dev/staging） |
| `/api/cache-test` | `packages/core-backend/src/index.ts:1869` | 全局闸豁免前缀（`api-path-policy.ts:149`），dev-only |

补一条事实更正：**没有 `/api/safety` 这个挂载**。grep `'/api/safety` 于 `src` 零命中；
安全确认面在 `/api/admin/safety/**`，由 `admin-routes.ts:2022`（`router.use('/safety/rules', protectionRulesRouter)`）
挂在 `admin-routes.ts` 树内部，属于 #5677/#5680 的范围，不属于本文的「另挂 router」。

---

## 8. 不确定项

1. `users.role` 列与 `user_roles` 表的一致性是运行期事实，本盘点只做了代码实读，没有连库核对
   「存在 `users.role='admin'` 但 `user_roles` 无 admin 行」的账号数量。若为 0，§4 的差异只是理论面；
   若非 0，`ensurePlatformAdmin` 与 `requireAdminRole` 的宽度差就是现网可达的。
2. 持有 `*:*` 权限码的账号是否存在、是否有非管理员持有，同样未连库核对。
3. #5680 的 spec 本体不在本基线上，§6 是按「中间件首位」的形状推的；若该 spec 实际用的是别的判据
   （例如源码级 AST），§6.2 的接法需要相应调整。
4. `listUserPermissions` 受命名空间准入过滤（`rbac/namespace-admission.ts:127` 对 `*:*` 有特判），
   `*:*` 在准入过滤后是否仍出现在 `req.user.permissions` 中，本次只读到特判返回 `null`（视为不受限），
   未逐层追到底。这会影响 §4 那条口径差的实际可达性。
