# G09 设计:`integration:*` / `data_sources:*` 六码种子化(2026-09-10)

## 1. 为什么

六个权限码长期处于**「门上能拦人、库里授不出去」**的状态:

| 码 | 谁在执行 | 位置 |
|---|---|---|
| `data_sources:read` / `:write` / `:execute` | 核心 `rbacGuard` | `packages/core-backend/src/routes/data-sources.ts`(15 处,`:336`–`:1257`) |
| `integration:read` / `:write` / `:admin` | 插件门 `hasPermission` | `plugins/plugin-integration-core/lib/http-routes.cjs:896-912` |

而 `permissions` 表里**从来没有这六行**。这不是"文档没写全":`role_permissions.permission_code` 与
`user_permissions.permission_code` 都有指向 `permissions(code)` 的**外键**
(`20250924190000_create_rbac_tables.ts:92-115`),所以授予动作不是在门上被拒,而是**被数据库直接拒绝**。
结果:非管理员要走通主旅程,只能有人在生产库上手写 `INSERT INTO permissions` + 建角色 + 开准入。

## 2. 迁移形状

`packages/core-backend/src/db/migrations/zzzz20260910120000_add_integration_permissions.ts`,
形状照搬 `zzzz20260830100000_add_stock_prep_permissions`(`DO $$` 表存在守卫 + `ON CONFLICT (code) DO NOTHING`),
含它那一处**刻意的省略:不写 `role_permissions`**。

- `up()`:一条语句,只 `INSERT INTO permissions (code, name, description)` 六行。
- `down()`:先删 `role_permissions`、再删 `user_permissions`、最后删 `permissions`(FK 顺序)。
  外键本身是 `ON DELETE CASCADE`,所以只删父表也够;显式删子表是为了让影响范围在源码里看得见。
- 导出 `INTEGRATION_PERMISSION_CODES` / `DATA_SOURCES_PERMISSION_CODES` / `INTEGRATION_SEED_PERMISSION_CODES`,
  供测试对账(沿用 `ELEARNING_PERMISSION_CODES` / `STOCK_PREP_PERMISSION_CODES` 的既有约定)。

## 3. 幂等性

`ON CONFLICT (code) DO NOTHING` + `DO $$` 表存在守卫。三种情形都已在无库单测中跑过:
空库跑两遍、已含部分码的库跑一遍、`permissions` 表不存在时整块跳过。
真库重放(fresh db 上 `db:migrate` 跑两遍)是 CI 的 migration-replay 泳道,本机无 PG,不在此处断言。

## 4. 不做什么(每一条都是刻意的)

1. **不给任何人、任何角色发权限。** 六码种子化后持有者为零,也不预绑 `admin` 角色。
   平台管理员不受影响:`rbacGuard` 在查表之前就对 `role:admin` 短路(`src/rbac/rbac.ts:69-72`、`:94-98`),
   插件门同样对 `role:admin`/`integration:admin` 短路。种子一行 `('admin', …)` 不会改变任何调用者的答案,
   却会把「授予」变成迁移做的事——这正是 stock-prep「零自动」口径拒绝的。
   (`zzzz20260824121000_add_elearning_permissions` 确实种了 `('admin', …)`;那是较早的一种形状,
   本次选更严的那一种。)
2. **不动命名空间准入的免准入名单。**
   `NON_NAMESPACED_PERMISSION_RESOURCES`(`src/rbac/namespace-admission.ts:11-38`)是**豁免名单**不是允许名单:
   `isNamespaceAdmissionControlledResource` 对**不在**名单里的资源返回 true(`:133-137`),
   只有受控资源才会被 `filterPermissionCodesByNamespaceAdmission`(`:356-377`)过滤。
   把这两个资源加进去 = **让所有现有及将来的持有者一律绕过 `user_namespace_admissions`**,
   在通向客户库口令与原始 SQL 执行的两个命名空间上属于放宽,故不做。
   附带后果也值得一提:真加进去,`PATCH /api/admin/users/:id/namespaces/:namespace/admission`
   反而会对它们回 `400 NAMESPACE_NOT_SUPPORTED`(`src/routes/admin-users.ts:4325-4327` 只接受受控命名空间),
   等于把运维自己的控制面拆掉。运维正路写在交付说明 §5-6。
3. **不改任何 RBAC 判定逻辑**,不改既有权限/角色行。
4. **`data_sources:*` 不进插件清单。** 它是核心资源(核心 `rbacGuard` 把守),不归 plugin-integration-core 声明。
5. **不碰 `/data-sources` 路由 meta 与导航谓词的错配**——那属于在飞的 #5587(已把 `/data-sources` 改成重定向),
   合并后自动消失。

## 5. 插件清单:为什么 `integration:*` 没有进 `permissions` 数组

原计划是把 `integration:read/write/admin` 追加进 `app.manifest.json` 的 `permissions`。**追查调用链后改了做法**:
那个数组不是"插件会检查的码的清单",而是**「备料这个应用自己的权限词表」**,并且被交付 UI 当作
**"该给一线角色勾哪些码"**直接渲染——
`installPlan.ts:228` 取 `manifest.permissions` → `permissions.codes`,由
`StockPreparationInstallView.vue:194`「装好之后谁能做什么」与
`StockPreparationGettingStarted.vue:751-756` 第⑤步「谁能用」列出;
配套文案 `STOCK_PREP_NO_AUTOMATIC_HOLDERS` 还写死了**「这三项权限」**。

把平台层的 `integration:*` 混进去会同时造成两件事:**把「一线该拿哪些码」讲错**(诱导客户管理员给一线
`integration:write`,是一次实打实的授权面放宽),以及**页面列 6 项、文案说「这三项」**的自相矛盾。

因此改为新增顶层键 **`platformPermissions`**(`codes` / `enforcedBy` / `seededBy` / `automaticHolders` / `note`),
与应用自身词表分开。该键不被 `PlatformAppManifestSchema` 收录(顶层非 `.strict()`,未知键被 zod 丢弃),
所以对运行时零影响;它的价值在于被 `__tests__/app-manifest.test.cjs` 强制对账:
`platformPermissions.codes` 必须**逐字等于**从 `lib/http-routes.cjs` 解析出的门字面量,
且 `seededBy` 指向的迁移必须真的种了每一个码。

**这道对账的射程要说清楚**(它是已知门上的绊线,不是"所有门"的证明):只有**以引号字面量
(`'` / `"` / 反引号)写在 `lib/http-routes.cjs` 或 `routes/data-sources.ts` 之内**的门会被看见。
以下四种写法可以无声绕过:双引号/模板串以外的**运行时拼接**(变量、字符串相加、插值)、
**单参形式** `rbacGuard('data_sources:purge')`(`src/rbac/rbac.ts:56-57` 支持,仓库已有多处先例;
解析器现已同时匹配单参与双参,但仍限于上述两个文件)、以及**写在这两个文件之外**的任何门
(例如另起一个 router 挂 `rbacGuard('data_sources:purge')`)。要真正封死需要对全仓 `rbacGuard`
调用点做一次横扫,那超出本迁移套件的范围——见验证文档 §4 的后续单。

`app.manifest.json` **不在** sealed-export 溯源 pin 覆盖内
(`lib/sealed-export/vectors/s6a-package-provenance-pins.json` 全文不含 `app.manifest`),故无需重打 pin;
已跑 `sealed-export-package-provenance` 复核通过。

## 6. 角色模板

交付说明 §5-6 新增「三类角色 = 哪些码」:实施工程师 / 顾问 / 一线。要点:
**一线需要的 `integration:*` 与 `data_sources:*` 码为零**(备料路由由 `stock-prep:*` 独占判定,
一线拉取读源走归属戳委派);`integration:admin` 约等于插件内管理员,只给实施工程师;
`data_sources:execute` 是原始 SQL 执行,默认不给;有码也不等于看得见某个源(还有一层属主判定)。
必须**经角色**授予,并**逐个**开 `integration` / `data_sources` / `stock-prep` 三个命名空间的准入。
