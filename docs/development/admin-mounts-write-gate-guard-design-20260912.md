# `/api/admin` 挂载点写路由守卫（admin-routes.ts 之外）设计说明 — 2026-09-12

基线：`origin/main` @ `9fb29831c`。本次**只加测试与文档**，零路由代码改动。

守卫本体：`packages/core-backend/tests/unit/admin-mounts-write-gate-guard.test.ts`
盘点来源：`docs/development/admin-mounts-write-gate-inventory-20260912.md`（W4-I，分支 `fix/admin-mounts-write-gate`）
验证记录：`docs/development/admin-mounts-write-gate-guard-verification-20260912.md`

---

## 1. 范围

`/api/admin` 前缀下、**不经 `admin-routes.ts`** 的 router：

| # | router 源文件 | 挂载 (file:line) | 写路由数 |
|---|---|---|---|
| 1 | `routes/admin-users.ts` | 根挂载 `src/index.ts:1898`（路由自带 `/api/admin/**` 绝对路径） | 27 |
| 2 | `routes/admin-directory-org-transfers.ts` | `src/index.ts:1901` | 5 |
| 3 | `routes/admin-directory.ts` | `src/index.ts:1902` | 20 |
| 4 | `routes/admin-directory-local.ts` | `src/index.ts:1905` | 8 |
| 5 | `routes/admin-directory-department-bindings.ts` | `src/index.ts:1906` | 1 |
| 6 | `routes/admin-directory-routing-policy.ts` | `src/index.ts:1907` | 1 |
| 7 | `routes/canary-routes.ts` | `src/index.ts:1912` | 4 |
| （+） | `routes/permissions.ts` 的 `/api/admin/**` 切片 | 根挂载 `src/index.ts:1753` | 1 |

合计 **67** 条写路由（POST/PUT/PATCH/DELETE）。W4-I 说的「7 个 router」指第 1–7 行；第 67 条来自
`permissions.ts`（它同时还有 `/api/permissions/**` 的写路由，那些不在 `/api/admin` 前缀下，属于 W4-I §7
的「邻接管理面」，本守卫不判）。

**不在范围内**：`admin-routes.ts` 整棵树（#5665/#5680）、`protection-rules.ts`（#5677）、
W4-I §7 列出的 `/api/snapshots`、`/api/roles`、`/api/permissions`、`/api/attendance-admin` 等邻接面。

---

## 2. 为什么不能照搬 #5680 的「中间件首位必须是门」判据

67 条里只有 `canary-routes.ts` 的 4 条把门放在中间件位（`r.put('/rules/:topic', requireAdminRole(), …)`，
`routes/canary-routes.ts:39/70/114/136`）。其余 63 条的门在**处理器体内的第一条语句**：

- `ensurePlatformAdmin`（60 条）——两份副本：`routes/admin-directory.ts:222`、`routes/admin-users.ts:455`；
- `ensureRoleDelegationAdmin`（2 条）——`routes/admin-users.ts:1721`；
- `isAdmin` 直调（1 条）——`routes/permissions.ts:358`。

用 `router.stack` 看中间件链，这 63 条只会看到两种形状：
「首位 = `authenticate`（`middleware/auth.ts:11` = `jwtAuthMiddleware`，**只认证不鉴权**）」或
「首位 = 唯一的处理器」。照搬「首位必须是 admin 门」会把 63 条全判红（假红），
进而逼人为了过测试去挪代码（把 60 处 `ensurePlatformAdmin` 改写成中间件是一次真实的行为改动，
不能由一条测试顺手带上）或把断言放宽到没意义。

结论：结构判据在这批 router 上不可用，换成**行为 + 清单**两条断言。

---

## 3. 两条断言各防什么

### (A) 行为断言 —— 防「门被掏空 / 门在副作用之后」

最小 express app 逐个挂载 router（都是零参工厂；`canaryRoutes(router)` 例外，测试自己造 `CanaryRouter`
实例并给其方法挂探针），注入**无任何 legacy admin claim** 的 `req.user`，`isAdmin` 恒 false，逐条写路由断言：

1. 状态码 = 该 router 既有的拒绝码（见 §5 对照表），且**响应体是门自己的那一份**
   （`FORBIDDEN`/`Admin access required` 与 `ADMIN_REQUIRED` 与
   `Only admins can apply permission templates` 三种文案彼此可区分——这比只断 403 更强：
   403 可能来自别的层，特定文案只能来自那道门）；
2. **下游零调用**（见 §6 效果预算）。

再加两组：无身份（`req.user` 缺失）逐条 fail-closed；`isAdmin` 抛错时 fail-closed。

只有 (A) 不够：新增一条没有门的写路由，(A) 一个断言都不会红——它只覆盖登记表里已有的路由。

### (B) 清单双向反查 —— 防「新增写路由悄悄溜进来 / 登记表烂掉」

从每个 router 实例的 `stack` 枚举 `(method, path)`，过滤出写方法、且完整路径以 `/api/admin` 开头的，
与登记表**双向**比对：

- `stack → 登记表`：出现未登记的写路由 → 红，并点名（新增路由必须显式加行 + 补 (A) 的行为断言）；
- `登记表 → stack`：登记表里有 stack 里不存在的条目 → 红，并点名（路由被删/改名/改方法后，登记表不能留死条目）。

附带两条：
- **非 route 层为 0**：一旦有人在这些 router 里写 `router.use(...)` 或挂子 router，这套枚举就会瞎掉，
  所以出现即红；
- **按 `index.ts` 真实顺序挂在同一个 app 上**再打一遍前缀重叠的挂载点
  （`/api/admin/directory/org-transfers` 挂在 `/api/admin/directory` **之前**，`local` /
  `department-bindings` / `routing-policy` 挂在其后）——逐 router 建 app 看不到挂载顺序带来的接管差异。

---

## 4. legacy claim 四形态与两处假绿陷阱

### 4.1 四形态（两份 `hasLegacyAdminClaim` 副本的并集）

| 形态 | `admin-directory.ts:207`–`:215` | `admin-users.ts:440`–`:447` |
|---|---|---|
| `role === 'admin'` | 认 (`:210`) | 认 (`:443`) |
| `roles` 含 `'admin'` | 认 (`:211`) | 认 (`:444`) |
| `permissions` 含 `'*:*'` | **认** (`:212`) | **不看这个字段** |
| `perms` 含 `'*:*'` | 认 (`:213`) | 认 (`:445`) |
| `perms` 含 `'admin:all'` | **不认** | **认** (`:445`) |

注入的非管理员身份必须**四种全不满足**，否则 `hasLegacyAdminClaim || await isRbacAdmin(userId)` 的
短路会让门在根本没问 RBAC 的情况下放行，403 断言就变成了别的东西在拒绝（或者干脆拒绝不了）。
spec 里把四形态写成 `LEGACY_CLAIM_PREDICATES` 谓词表，对 fixture 做自检；fixture 的
`role`/`roles`/`perms`/`permissions` 四个字段**都存在但都不是管理员形态**——故意留着字段，
这样将来有人把某个字段删掉（"不含" 悄悄变成 "没这字段"）时自检先红。

### 4.2 陷阱一：真实的 `authenticate` 会在到达 admin 门之前就 401

`admin-users.ts` / `permissions.ts` 的 28 条路由带路由级 `authenticate`（= `jwtAuthMiddleware`）。
实测：不 mock 它时，这 28 条全部返回 `401 UNAUTHORIZED / "Missing Bearer token"`——
一个「非 2xx」的断言会**全绿**，却一寸也没量到 admin 门。
所以 spec 把 `middleware/auth` mock 成 pass-through，再用 app 级中间件注入 `req.user`，
还原生产上「全局 JWT 闸（`index.ts:1669`–`:1682`，`/api/admin` 不在豁免表内）先填好 `req.user`」那一步。
这不是放宽：认证层另有自己的测试，本文件要量的是**鉴权门**。

### 4.3 陷阱二：`permissions.ts` 的 503 前置

`routes/permissions.ts:349` 的 `if (!pool) return 503` 排在身份/权限判定之前。若按惯例把
`db/pg` 的 `pool` mock 成 `null`（`tests/unit/snapshots-authz.test.ts` 就是这么做的），这条路由在
无 DB 环境里答 503 而不是 403——同样是「非 2xx 全绿」的假绿。spec 把 `pool` mock 成
`{ query: vi.fn() }`（真值）以穿过这道 503，再断 403。

---

## 5. 门族 × 拒绝形态对照表（spec 的断言口径）

| 门族 | 路由数 | 非管理员（有身份） | 无身份 | `isAdmin` 抛错 |
|---|---|---|---|---|
| `ensurePlatformAdmin` | 60 | 403 `{ok:false,error:{code:'FORBIDDEN',message:'Admin access required'}}` | 401 `UNAUTHENTICATED` | **拒绝向上传播、无响应**（见 §7） |
| `ensureRoleDelegationAdmin`（例外） | 2 | 403 `FORBIDDEN` / `'Delegated role-admin access required'` | 401 `UNAUTHENTICATED` | 同上 |
| `requireAdminRole()` | 4 | 403 `ADMIN_REQUIRED` | 403 `ADMIN_REQUIRED` | 503 `RBAC_CHECK_FAILED` |
| `isAdmin` 直调（permissions） | 1 | 403 `'Only admins can apply permission templates'` | 401 `'User ID not found in token'` | 500 |

### 例外表：两条委派管理员口径的路由

| 方法 | 路径 | 注册 | 门 |
|---|---|---|---|
| PATCH | `/api/admin/role-delegation/users/:userId/namespaces/:namespace/admission` | `routes/admin-users.ts:2982` | `:2983` `ensureRoleDelegationAdmin` |
| POST | `/api/admin/role-delegation/users/:userId/roles/:action(assign\|unassign)` | `routes/admin-users.ts:3060` | `:3061` `ensureRoleDelegationAdmin` |

这两条**有意**允许「非平台管理员、但持有委派命名空间」的调用者
（`admin-users.ts:1740`–`:1745`：读 `user_roles` → `deriveDelegableNamespaces` → 非空才放行）。
所以断言口径是「既不是平台管理员、`user_roles` 也读不出任何委派命名空间的调用者 → 403」，
**不是**「非平台管理员 → 403」；后者会把设计当 bug 钉死。spec 另加一条反向用例：
`user_roles` 返回 `attendance_admin` 时，这两条路由**不**答 401/403——证明这道门确实是委派口径，
也证明上面的 403 不是「这条路由怎么都会 403」的假象。

---

## 6. 「下游零调用」是怎么量的（效果预算）

探针是**模块级绊线**：对每个 router 直接依赖的 service 模块，用 `vi.mock(path, importOriginal)` 把
**函数**导出换成「记录调用名、返回 undefined」的桩，类导出（错误类，`instanceof` 依赖构造函数身份）、
常量、对象导出原样保留。被绊的模块（22 个）覆盖了这 67 条路由过门之后要碰的第一层：
`directory-sync` / `deprovision-evidence-api` / `local-directory-org` / `org-transfer-service` /
`department-binding-reconciliation` / `ApprovalDirectoryOrg` / `dingtalk-*` / `permission-templates` /
`role-assignment` / `namespace-admission` / `session-*` / `login-alias-service` / `user-activate` /
`invite-*` / `access-presets` / `access-graph-mutex` / `audit` 等；DB 层
（`db/pg` 的 `query` / `transaction` / `pool.query`）单独计。

两个 `keep`（不打桩）：
- `access-presets.listAccessPresets`——`admin-users.ts:369` 在**模块作用域**就调用它，打桩会让模块加载即炸；
- `namespace-admission.deriveDelegatedAdminNamespace`——委派口径要用真身把 `user_roles` 行推成命名空间。

被拒绝时允许留下的痕迹（除此之外任何下游调用都算越过门）：

| 门族 | 允许的痕迹 | 理由 |
|---|---|---|
| `ensurePlatformAdmin` / `isAdmin` 直调 | 无 | 门是第一条语句，之后什么都不该发生 |
| `ensureRoleDelegationAdmin` | 恰好 1 条只读 `SELECT role_id …`（`admin-users.ts:481` 的 `fetchUserRoleIds`） | 委派口径本来就要先读角色才知道有没有委派命名空间；写与审计仍然零 |
| `requireAdminRole()` | 恰好 1 条 `INSERT INTO operation_audit_logs`（`guards/audit-integration.ts:131`/`:161` → `logSafetyOperation` 走 `pool.query`） | 这条 INSERT 本身就是门开火的证据，不是越权写 |

---

## 7. 本次顺带查实的一个行为事实（未改代码）

`isAdmin` 抛错（RBAC 库不可用）时：

- `requireAdminRole()` 有自己的 try/catch → **503 `RBAC_CHECK_FAILED`**，干净的 fail-closed；
- `permissions.ts` 的处理器整体包在 try/catch 里 → **500**；
- `ensurePlatformAdmin` / `ensureRoleDelegationAdmin` 族：门是处理器 try **之外**的第一条语句，
  拒绝会从 async handler 里向上传播；**express 4 不接管 async 拒绝**，于是
  **请求没有任何响应**（客户端侧表现为挂住直到超时），进程侧是一条 unhandled rejection。

就「写」而言这仍是 fail-closed（门之前没有任何 service / DB / 审计调用，spec 逐条验证了这一点），
但 HTTP 契约上它是「挂住」而不是 503。spec 因此对这一族用**直调终端处理器**的方式断言
「拒绝传播 + 响应未被写过 + 下游零调用」，而不是走 HTTP（走 HTTP 会把套件挂住）。
是否要给这批 router 补一层 async 错误兜底，是一条**独立**的代码改动，本次不做，只如实登记。

---

## 8. 与 W4-I 盘点的差异（实读核对结果）

67 条的注册行、门所在行逐条核对，与 W4-I §3 一致，仅一处行号更正：

- W4-I §3.8 把 `permissions.ts` 的门记成「`:358`（身份）+ `:359`（`isAdmin`）→ `:361` 403」；
  实读为 **`:353`（身份）/ `:355`（401）/ `:358`（`isAdmin`）/ `:360`（403）**。
  本守卫的登记表按实读写（`gate: 'routes/permissions.ts:358 isAdmin 直调 → :360 403'`）。

另：W4-I §3.2 给三条 helper 路由记的门 `:1456` / `:1556`（helper 体内第一条语句）已核对无误；
spec 的登记表把「注册行」与「helper 门行」都写上，避免只看注册行时误以为门缺失。

---

## 9. 宽度差：不钉成用例，裁决后怎么加

`admin-directory.ts:212` 认 `permissions` 含 `'*:*'`，`admin-users.ts:440`–`:447` **不认**；
反过来 `admin-users.ts:445` 认 `perms` 含 `'admin:all'`，`admin-directory.ts` 不认。
即：同一个持 `*:*` 权限码、`user_roles` 无 admin 行的账号，能过 `/api/admin/directory/**` 的门、
过不了 `/api/admin/users/**` 与 `/api/admin/canary/**` 的门。

**本守卫刻意不把这个差异钉成现状用例**——钉下来等于给「两道门宽度不同」发一张长期居留证，
而是否收紧（删掉 `admin-directory.ts:212`，让 directory 侧向 users 侧和 `requireAdminRole` 靠拢）
需要 owner 裁决：现网可能有账号正靠 `*:*` 操作目录页。

裁决之后怎么加用例（两种结果各一条路）：

- **裁决 = 收紧**（删掉 `admin-directory.ts:212`）：在 spec 的控制组里加一条
  「`permissions: ['*:*']` 且 `isAdmin=false` → directory 侧写路由 403」，
  与现有的 `admin-users` 侧断言合成一条「两份副本口径一致」的用例；
  同时把 `LEGACY_CLAIM_PREDICATES` 里 `permissions 含 '*:*'` 那条标记为「已收紧，仅用于 fixture 自检」。
- **裁决 = 保持现状**：把差异钉成**一对**用例（同一身份，directory 放行 / users 拒绝），
  并在用例注释里写明这是 owner 裁决保留的差异、附裁决出处；此后任何一侧被改动都会红，
  逼人显式再裁一次，而不是悄悄漂移。

在裁决落地之前，spec 只保留一条**现状控制组**：`role: 'admin'`（两份副本都认的形态）
在 `isAdmin=false` 时仍放行。如果日后 owner 决定把 legacy claim 整体删掉，这条会红——
那时应当**更新**它，而不是把它当成「不能收紧」的理由（注释里写明了这一点）。

---

## 10. 盲区（这套守卫看不见什么）

1. **只看这 8 个 router 的 `stack`**。别处新挂一个 `/api/admin/**` 的 router（`index.ts` 新增
   `this.app.use('/api/admin/xxx', …)`），本守卫不会红——它不扫 `index.ts`。
   W4-I §1 的枚举方法同理。要堵这个口，得另写一条「`index.ts` 里 `/api/admin` 挂载点集合」的守卫
   （与 `MOUNTS` 表双向比对），本次未做。
2. **`router.use` / 子 router**：出现即红（非 route 层断言），但那只是「让你知道枚举瞎了」，
   不会自动把子 router 里的写路由纳入。
3. **不证明门的判据足够严**：`isAdmin` 是 mock 的，`user_roles` 的真实 SQL、命名空间准入过滤
   （`rbac/namespace-admission.ts:127` 对 `*:*` 的特判）都不在本守卫的量程内；§9 的宽度差也刻意未钉。
4. **不覆盖读路由**：W4-I 的读端点暴露面盘点另有其人（W4-C）。
5. **路径参数是 fixture 值**：`:eventId` 之类的 UUID 形状校验在门之后，本守卫的请求全部止于门，
   所以参数值只要能路由到就够；一旦将来有路由把校验挪到门之前，(A) 会因为拿到 400 而红——
   这是想要的（门被挪到副作用/校验之后就该红）。
6. **`permissions.ts` 的 `/api/permissions/**` 写路由不在范围内**（grant/revoke，
   `routes/permissions.ts:133`/`:214`，门也在处理器体内）。它们属于 W4-I §7 的邻接面，
   要纳入就得扩 `MOUNTS` 的过滤前缀，并把 W4-I §7 先盘完。
