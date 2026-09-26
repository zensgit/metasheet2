# 备料定时试拉 `CONNECTION_CANONICAL_UNAVAILABLE` 诊断（2026-09-25）

> values-free：本文只写表名、列名、条件、文件行号，不含主机、口令、令牌、连接 id、属主 id。
> 演示服务器统称「演示机」。
>
> **基线**：所有 `path:line` 在 `4189aa096`（本分支的 merge-base）上成立。下列文件在演示机当前版本 r59
> （`05461c739`）与 `4189aa096` 之间 `git diff --stat` 为空，因此本文的调用链同样适用于演示机上跑的代码：
> `connection-resolver.cjs`、`external-systems.cjs`、`http-routes.cjs`、`stock-preparation-table-actions.cjs`、
> `stock-preparation-source-binding-store.cjs`、插件 `index.cjs`、`data-source-plugin-facade.ts`、
> `DataSourceManager.ts`、`routes/data-sources.ts`、`routes/admin-routes.ts`、core `index.ts`、
> `scripts/ops/stock-preparation-scheduled-pull.mjs`、`db/migration-provider.ts`、`migrations/040_data_sources.sql`、
> `ecosystem.config.cjs`。
>
> origin/main 在 `4189aa096` 之后又前进了。截至 `b736c7f5c`，上列文件里只有 core `index.ts` 有改动：在文中引用的
> 各行之前共插入 6 行，所以文中 `index.ts` 的行号在该版本上都要加 6，其余文件的行号不变。合并前按基线纪律 rebase 后重核。
>
> 背景：交接文档 `handoff-r59-two-machine-20260924.md:16` 记录「备料定时试拉报
> `CONNECTION_CANONICAL_UNAVAILABLE`（r58 日志末尾已出现）」，定性为已知、非 r59 引入。本文是对这条记录的代码侧诊断。

## 0. 结论

1. **全仓只有一个抛出点**：`plugins/plugin-integration-core/lib/connection-resolver.cjs:178-183`，即
   `resolveCanonical` 里的 `catch`。其余命中是一处注释、测试和文档（见 §1.1 的 grep）。
2. **能走到这个抛出点，说明被加载的那一行外接系统是 canonical 形态**，即 `integration_external_systems.connection_id` 非空。
   这由 `connection-resolver.cjs:270-279` 的分派决定。`connection_id IS NULL` 的 legacy 行进 `resolveLegacy`
   （`:205-267`），报的是 `CONNECTION_LEGACY_*` 等别的码，不会是这个码。
3. **这个码的含义只有一句：主机侧 facade 的 `resolveConnectionRegistration` 抛了异常**，原因不限。原因在
   `connection-resolver.cjs:178` 的 `catch {}` 处被丢弃。facade 自己也按设计把「没加载 / 不是属主 / 租户不符」
   几种拒绝都归成同一个 not-found（`data-source-plugin-facade.ts:507-525`）。所以不管从 HTTP 响应、服务端日志还是前端，
   都看不出命中的是哪一种（§5 R1–R3）。
4. **定时试拉路径上，能触发它的状态有 9 种数据状态、1 种进程状态，外加 2 种部署状态**（§2）。进程状态是 S6：
   内存里的数据源注册表只在后端启动时从库装载一次，之后只随本进程经 `DataSourceManager` 写方法的修改更新
   （`/api/data-sources` 路由）。启动后经 SQL、恢复，或者经管理员批量接口 `PUT /api/admin/data/bulk`（它直接改表，
   不经过 `DataSourceManager`）改了 `data_sources`，试拉仍按启动时的快照判，而 §4 的 SQL 读的是当前的库，两边就对不上。
   本机一次性 PG（合成数据）上逐一复现过，9 种数据状态和 S6 都实测报这个码（§6）。
5. **PR #5933 合入并在演示机执行后，不会消除这个错误**（§3）。#5933 只改 `connection_id IS NULL` 的行；
   报这个码的行按第 2 条一定是 `connection_id` 非空的行，两者不相交。#5933 反而可能新增这个码：
   它会把「源已停用（`is_active=false`）」一类 legacy 行提升成 canonical，这些行原来报 `CONNECTION_LEGACY_FALLBACK_DENIED`，
   提升后改报 `CONNECTION_CANONICAL_UNAVAILABLE`。本机一次性 PG（合成数据）实测：消除 0 个，新增 1 个。这两个数
   只反映合成夹具，不代表演示机；「不会消除」由代码直接得出，不依赖这两个数。
6. 演示机实际属于哪种状态，**只能上机判定**。§4 给出只读 SQL 与日志检查清单，SQL 的判定列已在本机一次性 PG 上用 17 个
   合成用例对照实际运行结果（17/17 一致），9 个变异各至少让 1 个用例不一致；试拉行的认定已对照真实的绑定表取行逻辑
   （7 种绑定形态 7/7 一致，§6）。SQL 只能读库，所以它只适用于**最近一次重启之后**的报错，并且要先按 §4.6 排除 S6。
   R60 升级本身会重启后端，r58/r59 日志里的历史报错，要等重启后的下一次试拉复现了，才能拿 Q3 判。

## 1. 调用链：定时试拉入口 → 连接解析 → 抛错

### 1.1 抛出点（全仓 grep）

```
git grep -n "CONNECTION_CANONICAL_UNAVAILABLE" origin/main -- .
```

非文档命中共 7 处（5 个文件）：`connection-resolver.cjs:180`（唯一的 `throw`）、`http-routes.cjs:4493`（注释）、
`__tests__/connection-resolver.test.cjs:219`、`__tests__/external-systems.test.cjs:1192,1208`、
`__tests__/stock-preparation-operator-pull-gate.test.cjs:418,687`（测试桩与注释）。`apps/web/src` 零命中。

### 1.2 逐步调用链

| # | 步骤 | 位置 |
|---|---|---|
| 1 | 操作系统计划任务 `metasheet-stock-prep-scheduled-dry-run`（每日 06:00，只试算）调 ops 脚本。上机包装脚本里的「定时试拉」一步不入库（交接 §3 第 4 步），按交付说明的验证方法，它触发的是同一个计划任务（此点未在库内代码中核实） | `customer-delivery-guide-20260904.md:232-234`；`handoff-r59-two-machine-20260924.md:38` |
| 2 | 脚本按 `MS_PROJECT_NOS` 逐个项目**顺序**执行，每个项目只发一次 dry-run POST，失败不重试 | `scripts/ops/stock-preparation-scheduled-pull.mjs:675-692`、`:502-526` |
| 3 | 动作 id 固定为 `plm.stock-preparation.pull-bom.v1`；租户取 `MS_TENANT_ID`（缺省 `default`），同时放进 `?tenantId=` 和 `x-tenant-id` | `…scheduled-pull.mjs:122`、`:236`、`:368-370`、`:436-440` |
| 4 | 路由表 → 统一包装：抛错一律进 `sendError`；非 `HttpRouteError` 的只打一行 `route failed: <method> <path>` | `plugins/plugin-integration-core/lib/http-routes.cjs:63`、`:10091-10099` |
| 5 | `tableActionDryRun`：鉴权 → 取动作 → 解析租户 → B2a 门 → **加载源适配器** | `http-routes.cjs:5869-5931`（加载在 `:5931`） |
| 5a | 取动作时按 `(tenant, workspace, action)` 查 `integration_stock_prep_source_binding` 覆盖 `source.externalSystemId`；查不到就用部署默认值 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` | `stock-preparation-table-actions.cjs:918-927`、`:888-907`；`stock-preparation-source-binding-store.cjs:44`；`migrations/079_…sql` 表注释 |
| 5b | B2a 门用的是**不解析连接**的访问器，这一步不会产生本错误码 | `http-routes.cjs:4291-4294` → `external-systems.cjs:1007-1025` |
| 6 | `loadTableActionSourceAdapter`：先确定读身份，再加载一次 | `http-routes.cjs:4614-4673` |
| 6a | 读身份：动作 id 等于冻结 id 时，取外接系统行上服务端写入的 `config.dataSourceOwnerId`（归属戳）；没有戳就用请求者本人（令牌用户的 `user.id`，没有 id 时取 `user.email`） | `http-routes.cjs:4506-4519`（等值比较在 `:4512`，冻结 id 定义在 `stock-preparation-workbench-access.cjs:243`）；peek 失败时回落为请求者 `:4535-4547`；`requestPrincipal` `:892-895` |
| 6b | 以该身份、`runAs: 'user'` 加载 | `http-routes.cjs:4639-4645`；`scopedAdapterInput` `:1272-1278` |
| 7 | `getExternalSystemForAdapter`：按 `(tenant_id, workspace_id, id)` 取行（无 workspace 提示时不放宽）；`data-source:sql-readonly` 走连接解析器；解析器抛的 `code` 原样放进 `ExternalSystemValidationError.details.code`，并被提升为 `.code` | `external-systems.cjs:1027-1058`；`selectScopedRow` `:970-976`；行映射 `:290-311`（`connectionId` `:294`）；错误类 `:92-99` |
| 8 | 解析器：非 `sql-readonly` 直接放行；`connectionId` 非空进 `resolveCanonical`，为 NULL 进 `resolveLegacy` | `connection-resolver.cjs:368-378`、`:269-289`（分派 `:270-279`） |
| 9 | `resolveCanonical`：先校验执行租户（不在 try 内，失败报 `CONNECTION_TENANT_MISMATCH`），再在 try 里调 facade；**任何异常都改写成 `CONNECTION_CANONICAL_UNAVAILABLE`**，包括 facade 缺失 | `connection-resolver.cjs:166-184`（`requireFacade` 在 try 内：`:172` → `:55-63`） |
| 10 | facade 由 core 只注入给名为 `plugin-integration-core` 的插件；插件把它交给解析器 | `packages/core-backend/src/index.ts:2514-2520`；`plugins/plugin-integration-core/plugin.json:3`；插件 `index.cjs:305-314` |
| 11 | `resolveConnectionRegistration` → `resolveRegistration`：principal / 租户 / runAs 校验 → `assertAccess` + `getScope` + `getDataSource` → 租户与作用域校验。**不连数据库**（没有 `connectDataSource`） | `data-source-plugin-facade.ts:580-588`、`:491-527` |
| 12 | `assertAccess`：内存注册表里没有这个 id，或 principal 不等于 `owner_id`，都抛同一句 not found；facade 传入的是裸字符串 principal，**平台管理员没有旁路** | `DataSourceManager.ts:621-631`、`:85-89`；`getDataSource` `:1148-1154` |
| 13 | 回到 HTTP：`inferErrorCode` 取 `error.code`；`name` 含 `Validation` → **400** | `http-routes.cjs:745-757`、`:848-852`、`:875` |
| 14 | 脚本把 `error.code` 记进该项目的 JSON 行（`error: "CONNECTION_CANONICAL_UNAVAILABLE"`, `dryRunHttpStatus: 400`, `failed: true`），整轮以退出码 1 结束 | `…scheduled-pull.mjs:473-477`、`:517-525`、`:696` |

补充几点：

- **内存注册表的来源**：进程启动时 `startOnce()`（`index.ts:3787`）在 `:4020-4028` 先 await
  `initializeDataSourceManager` → `loadFromDatabase`，之后才在 `:4397` 装插件、在 `:4861` listen。所以这不是
  「重启后立刻试拉、数据源还没加载」的启动竞态。
- **注册表启动后不再从库刷新**：`loadFromDatabase` 只经 `initialize`（`DataSourceManager.ts:305-309`）调用，core 里
  唯一的调用在启动时（`index.ts:4024` → `routes/data-sources.ts:224-228`）。构造器的 `autoLoadFromDb`（`:295-299`）
  没有调用方使用（`src` 里唯一的 `new DataSourceManager(` 在 `routes/data-sources.ts:210`，不带参数）。内存的写入只有
  三处：启动装载 `:337`、`addDataSource` `:511`、`updateDataSource` `:592`（适配器表在 `addDataSourceInternal` `:861`
  写入，也只由这三处调用：`:335`、`:510`、`:591`）。从内存移除的只有 `removeDataSource` `:1133-1135`（`dispose()` `:1637-1644` 会整体清空，但 `src` 里没有调用方）；`updateDataSource`
  在 `:588-589` 先删、`:591` 再加回，属于替换。这几个写方法在 `src` 里只由 `/api/data-sources` 路由调用
  （`routes/data-sources.ts:545`、`:715`、`:809`、`:905`）。
- **绕过注册表写 `data_sources` 的应用内途径**：管理员批量接口 `PUT /api/admin/data/bulk` 与 `DELETE /api/admin/data/bulk`
  （`routes/admin-routes.ts:1500-1625`、`:1381-1494`，挂在 `index.ts:1984`）。两者的表名白名单都含 `data_sources`
  （`:1528-1532`、`:1408-1412`），直接执行 `db.updateTable(table).set(updates)`（`:1583`）或 `db.deleteFrom(table)`
  （`:1449`），`updates` 不限列。这个文件只从 `DataSourceManager` 引入了一个错误码常量和一个外键判别函数
  （`:39-42`），不碰注册表。按全仓 grep，应用运行时代码（不含迁移）里直接写这张表的只有 `DataSourceManager` 自己和这两个接口；
  `DataSourceManager` 的 `updateStatus`（`:922-946`）只写连接状态列和 `updated_at`，不影响装载与判定。
  批量删除先做引用预检，目标源仍被 canonical 行引用就拒绝（`:1434-1445`，§6 实测 409）；预检查询本身失败时退到外键兜底
  （`:1478-1486`），外键只护活的源（`live_id`）。所以批量删除删不掉试拉行所指的活源；最多删掉一个已软删、本来就没装载的源，
  删后内存和库里都没有它，两边仍一致。对试拉行所指的源，能造成 S6 的是批量更新：它只在设置非空 `deleted_at` 时才做引用
  预检（`:1564-1579`），改 `is_active`、`owner_id`、`tenant_id`、`scope_kind`、`type` 或清空 `deleted_at` 都不做预检，直接执行。
  所以后端运行期间，经这两个接口、SQL 直改、备份恢复、迁移或 ops SQL 对 `data_sources` 的改动，要到下次重启才进入
  注册表（§2 的 S6）。
- **每次请求都读库的表**：与内存注册表不同，`integration_external_systems` 和绑定表都是每次请求读库
  （`external-systems.cjs:970-976`；绑定表见 `http-routes.cjs:3695-3700` 的说明），改了立即生效。
- **加载阶段的过滤**：`DataSourceManager.ts:314-363` 只装载 `is_active = true AND deleted_at IS NULL` 的行（`:324-325`）。
  类型不在注册表里的行跳过（`:331-333`，注册表见 `:193-200`）。凭据解密失败的行也跳过（`recordToConfig` `:417` →
  `decryptCredentials` `:401-403`），逐行 `catch` 并打日志（`:352-354`）。汇总日志在 `:358`，整体查询失败在 `:359-362`。

## 2. 能触发它的状态（定时试拉路径）

前提 P0：试拉用的那一行外接系统 `kind = 'data-source:sql-readonly'`、`connection_id` 非空且非空白。不满足时报别的码。

「读身份」下文记作 R，按 §1.2 第 6a 步取值：有归属戳就是戳，没有就是令牌用户。

| 编号 | 状态 | 为什么抛（path:line） | 备注 |
|---|---|---|---|
| **S1** | facade 没注入（插件名不是 `plugin-integration-core`） | `connection-resolver.cjs:172` 在 try 内调 `requireFacade` → `:55-63` 抛 → `:178-183` 改写 | 部署状态，不是数据状态。标准包里插件名与注入条件一致（`plugin.json:3` 对 `index.ts:2514`），实际上不可达 |
| **S2a** | 源行已软删（`data_sources.deleted_at IS NOT NULL`） | 加载时被过滤（`DataSourceManager.ts:325`）→ `assertAccess` not found（`:623-624`） | #5896 之后，给仍被 canonical 行引用的源做软删会被数据库拒绝（`zzzz20260920120000_…:31-37`）；外键是 `NOT VALID`（`:39-45`），**存量**悬空行仍被容忍 |
| **S2b** | 源行未启用（`data_sources.is_active = false`） | 加载时被过滤（`:324`）→ `:623-624` | |
| **S2c** | 源类型不在注册表（`lower(type)` 不属于 postgresql/postgres/http/sqlserver/mysql/plm） | 加载时跳过（`:331-333`）→ `:623-624` | |
| **S2d** | 源凭据解密失败（加密密钥与写入时不同） | `recordToConfig` 抛（`:417` → `:401-403`），逐行 `catch` 跳过（`:352-354`）→ `:623-624` | **SQL 看不出来**，只能看日志（§4.6） |
| **S2e** | 整个注册表没装载（初始化失败，或查询 `data_sources` 失败） | `index.ts:4026-4028` 降级继续运行；或 `DataSourceManager.ts:359-362` → 所有 id 都 not found | 部署状态。特征：**所有** canonical 行都报这个码，包括 SQL 判定为正常的行 |
| **S2f** | 源行不存在（被硬删） | `:623-624` | 引用中的**活**源不能硬删（`ON DELETE RESTRICT`）；已软删的源可以硬删（`zzzz20260920120000_…:47-52`），硬删后留下的悬空行进入本态 |
| **S3a** | 外接系统行**没有**归属戳，且令牌用户 ≠ `data_sources.owner_id` | R = 令牌用户（`http-routes.cjs:4510`、`:4518`）→ `DataSourceManager.ts:628-629` | 即 2026-09-05/06 的历史状态（`customer-delivery-guide-20260904.md:308-313`）。应用代码里写这张表 `config` 的只有 `external-systems.cjs` 的 upsert（`:891`、`:935`；同文件另有删行 `:1369`）；迁移和 ops 脚本（如 `scripts/ops/live-id-fk-validate-20260920/02-remediate.sql`）属于 API 之外的写入。cutover 迁移只回填「戳 = 属主」的行（`zzzz20260902120000_…:97-106`），回填出的行本来就带戳。#5505 起，经 API 新建或重绑的 canonical 行都会写戳（`:916-923`、`:875-883`），不重绑的更新沿用已存的戳。#5452 的代码则相反：新建时不写戳（`external-systems.cjs@4da258c78:581`），经 upsert 更新标记非 TRUE 的 canonical 行时，不论改的是什么都会删掉戳（同版本 `:549-550`）。所以没戳的 canonical 行，只能来自 #5452 与 #5505 之间经 API 新建或更新过的行，或 API 之外的直写/恢复 |
| **S3b** | 有归属戳，但戳 ≠ 当前 `data_sources.owner_id` | R = 戳 → `:628-629` | 戳只写被 facade 证明过的属主（`external-systems.cjs:553-567`）；编辑数据源时保留原属主（`routes/data-sources.ts:712-718`）。但**同 id 重建会改属主**：`POST /api/data-sources` 的 id 由客户端给（`routes/data-sources.ts:84`），`addDataSource` 只查内存（`DataSourceManager.ts:481-483`），落库是按 id upsert，会覆盖 `owner_id`/`tenant_id` 并清空 `deleted_at`（`:895-915`）。所以一个已软删或未装载的源，被另一个人用同一个 id 重建后，原有的戳就进入本态（租户不同时还会同时进入 S4）。另一个来源是库级直改或恢复，以及管理员批量接口改了 `owner_id`（§1.2 补充） |
| **S4** | 源有租户，且 ≠ 试拉租户 | `data-source-plugin-facade.ts:517-519` | 试拉租户 = `MS_TENANT_ID`，经过 `resolveTenantId` 核对（`http-routes.cjs:1037-1061`；令牌不带租户声明的平台管理员不做这项比对，`:1045`）。外接系统行本身就是按这个租户取的（`external-systems.cjs:971`）。经 API 新建的源，租户取自建源者令牌的租户声明（`routes/data-sources.ts:533-549`） |
| **S5** | 源无租户（`tenant_id` 为 NULL），且 `scope_kind` ≠ `legacy_private` | `data-source-plugin-facade.ts:520-522` | 同样是无租户，`scope_kind = 'legacy_private'` 在 `runAs: 'user'` 下可以通过（`:523` 只拦 service；解析器侧放行在 `connection-resolver.cjs:185-193`、`:113-118`） |
| **S6** | 内存注册表与库不一致：后端这次启动之后，`data_sources` 经 `DataSourceManager` 以外的途径被改过，改的是 `is_active` / `deleted_at` / `type` / `owner_id` / `tenant_id` / `scope_kind`，或新插入了行。途径包括：管理员批量接口 `PUT /api/admin/data/bulk`（`table` 为 `data_sources`，`routes/admin-routes.ts:1500-1625`）、SQL 直改、备份恢复、后端运行期间执行的迁移或 ops SQL | 注册表只在启动时装载一次，之后只随本进程经 `DataSourceManager` 写方法的修改更新（`/api/data-sources` 路由）；批量接口直接改表，不经过它（§1.2 补充）。`assertAccess`（`DataSourceManager.ts:621-631`）和 facade 的租户、作用域校验（`data-source-plugin-facade.ts:507-525`）都只读内存。所以试拉按**启动时的快照**判，§4 的 SQL 按**当前的库**判 | 进程状态，不是数据状态。**SQL 看不出来**：Q3 可能给出 `DATA_OK`，也可能给出一个 S 态，但它和内存里的实际原因不同（§6 实测：一个源启动时停用、没装载，之后被 SQL 启用并改了属主，Q3 判 `S3b`，内存里的原因却是没装载）。经批量接口的「修复」同样不生效：§6 实测把停用源启用、把属主改成戳、把租户改成试拉租户、把软删源恢复，四例落库后 Q3 都判 `DATA_OK`，同一进程里仍然报本码，重启后才 OK。装载日志只在启动时打，看不出本态；批量接口会留日志行，见 §4.6。重启后注册表按当前库重新装载，S6 随之消失，或者变成库里真实对应的那一态。判定见 §4.6「S6 的判定」。内存每个进程各有一份：多个后端进程并存时，一个进程经 `DataSourceManager` 的写入，也进不了另一个进程的内存。仓库里的 pm2 配置是单实例 fork（`ecosystem.config.cjs:60-61`） |

**在这条路径上不可达、已排除的分支**（亲读代码）：

- principal 为空（`data-source-plugin-facade.ts:495` → `:271-282`）：R 要么是非空的戳，要么是已认证用户；路由先鉴权（`http-routes.cjs:5873`）。
- 租户为空（`:496-499`）：`resolveTenantId` 在更早处就抛 `TENANT_REQUIRED`（`http-routes.cjs:1040-1042`）。
- runAs 非法或为 service（`:500-503`、`:523-525`）：本路径固定 `runAs: 'user'`（`http-routes.cjs:1276`）。

**看起来像、但不是这个码的相邻状态**：出现下列码时，就不在本文 S1–S6 的范围内。

| 码 | 条件 | 位置 |
|---|---|---|
| `CONNECTION_LEGACY_FALLBACK_DENIED` / `_UNAVAILABLE` / `_POINTER_REQUIRED` | `connection_id IS NULL` 的 legacy 行 | `connection-resolver.cjs:205-257` |
| `CONNECTION_ID_REQUIRED` | `connection_id` 是空白串 | `:270-287` |
| `CONNECTION_TENANT_MISMATCH` | 注册信息的租户不符（facade 已放行之后） | `:113-124` |
| `CONNECTION_TYPE_UNSUPPORTED` | 源能加载（例如 `plm`/`http`），但不是 SQL 类型 | `:125-132` |
| `CONNECTION_BINDING_MISMATCH` | canonical 行还留着一个**不同**的 legacy 指针 | `:194-201` |
| `SOURCE_UNAVAILABLE`（503） | 解析通过之后，真正连库失败 | `DataSourceManager.ts:118-120`；facade 解析阶段不连库（`data-source-plugin-facade.ts:491-527`） |

因此：**PLM 网络不通、账号口令错误都不会表现为本错误码**。它们要到解析通过之后的连库阶段才会出现。

**不是原因，但容易误判的两点**：

- 给服务账号加管理员角色（`48h-autonomous-run-record-20260906.md:32` 曾记录「复制 admin 的 `user_roles` 行」这条修法）：
  按当前代码，这对本路径**不起作用**。facade 向 `assertAccess` 传的是裸字符串 principal
  （`data-source-plugin-facade.ts:508`），`normalizeActor` 不会给出 `platformAdmin`（`DataSourceManager.ts:85-89`），
  所以只做属主等值比较（`:627-629`）。后来真正生效的修法是归属戳委派（`customer-delivery-guide-20260904.md:308-315`）。
- 令牌过期或缺租户声明：前者即使主机鉴权放行到了处理器，请求上也没有用户，`requireTableActionAccess` 会先报 401
  `UNAUTHENTICATED`（`http-routes.cjs:1002-1006`，在加载之前的 `:5873`）。后者在没传 `--allow-tenantless` 时脚本自己拒绝运行
  （`…scheduled-pull.mjs:640-651`）；传了则只告警、照常发请求（`:652-656`），租户由 `resolveTenantId`（`http-routes.cjs:1037-1061`）
  核对，不通过时报的是 `TENANT_CONTEXT_REQUIRED`、`TENANT_MISMATCH` 等租户类的码（`:1047-1052`、`:1059`）。令牌过期、缺租户声明本身都不会变成这个码。

## 3. PR #5933（legacy 行 `connection_id` 回填）能消除什么

依据：PR #5933 head `cb765d4e7`，迁移 `packages/core-backend/src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts`。

- 候选集与 UPDATE 都要求 `b.connection_id IS NULL`（该文件 `:158`、`:169`）。
- 按 §0 第 2 条，报 `CONNECTION_CANONICAL_UNAVAILABLE` 的行在加载时 `connection_id` 非空（`connection-resolver.cjs:270-279`；
  `connectionId` 直接取自列值 `external-systems.cjs:294`）。

**结论 1：S1–S6 都不会被 #5933 消除。** #5933 不碰任何当前报这个码的行。演示机的试拉行既然报了这个码，
它就已经是 canonical，#5933 对它没有影响。#5933 也不写 `data_sources`：它只读、只锁源行（`:152`、`:160`），
写的是 `integration_external_systems`（`:163`）和自己的账本（`:180`）。R60 升级的重启会让 S6 消失，但那是
重启的作用，与 #5933 无关。

**结论 2：#5933 可能新增这个码。** 它提升的行都满足「标记非 TRUE」（`:159`），这类行今天在 `resolveLegacy` 被
`CONNECTION_LEGACY_FALLBACK_DENIED` 拒绝（`connection-resolver.cjs:206-216`）。提升后改走 `resolveCanonical`：

| #5933 谓词是否排除 | 状态 |
|---|---|
| 排除（提升前已证明不成立） | S2a（`ds.deleted_at IS NULL` `:155`）、S2f（JOIN 要求源存在 `:152-153`）、S3b/S3a（`dataSourceOwnerId = ds.owner_id` `:154`，且保留戳）、S4 与 S5（`ds.tenant_id = b.tenant_id` `:156`，NULL 不等于任何值） |
| **不排除** | S2b（未查 `is_active`）、S2c（未查类型）、S2d（SQL 无法判断）、S2e/S1（部署状态） |

所以一行源已停用的 legacy 行，经 #5933 提升后，会从 `LEGACY_FALLBACK_DENIED` 变成 `CANONICAL_UNAVAILABLE`。
这一行在提升前后都不可用，只是报错码换了，但会让「按错误码归因」的排查多出一个来源。本机合成库实测见 §6。

**结论 3：#5933 真正带来的改变**，是让「可证明、标记非 TRUE」的 legacy 行从一律被拒变为可用。实测 1 行从
`LEGACY_FALLBACK_DENIED` 变为可用。这与本错误码无关。

## 4. R60 上机只读检查清单

**执行约定**（与 `scripts/ops/readonly-inventory-20260916/_preamble.sql` 同一契约）：

- 用只读角色，在运维机上通过 psql 连演示机库执行。
- 结果只在运维机本地看。对外（issue / PR / 交接文档）**只报**布尔、枚举与计数，不报 `binding_id_local_only` 列，也不报任何 id。
- **只判最近一次重启之后的报错**。SQL 读的是当前的库，试拉读的是后端这次启动时装载的注册表（§2 S6）。更早的报错
  （例如 r58/r59 日志里的）用的是更早那次启动的快照，不能拿当前库判。R60 升级会重启后端，包装脚本在重启之后还会跑
  一次定时试拉（交接 §3 第 4 步），以它或之后的计划任务结果为准。
- 会话开头先执行：

```sql
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';
-- 三个变量在运维机本地设置，不要抄进任何证据面：
--   tenant             = 计划任务环境里的 MS_TENANT_ID（未设置时是 default）
--   scheduler_user_id  = 计划任务令牌所属账号的 users.id
--   backend_started_at = 后端这次启动的时间，带时区（取法见 §4.6「S6 的判定」第 1 步；只有 Q6 用）
\set tenant '<在运维机本地填写>'
\set scheduler_user_id '<在运维机本地填写>'
\set backend_started_at '<在运维机本地填写，格式 YYYY-MM-DD HH:MM:SS+08>'
```

### 4.1 Q0 结构探针

```sql
SELECT
  to_regclass('integration_external_systems') IS NOT NULL          AS has_external_systems,
  to_regclass('data_sources') IS NOT NULL                          AS has_data_sources,
  to_regclass('integration_stock_prep_source_binding') IS NOT NULL AS has_source_binding,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'integration_external_systems' AND column_name = 'connection_id') AS has_connection_id,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'data_sources' AND column_name = 'scope_kind')             AS has_scope_kind,
  EXISTS (SELECT 1 FROM information_schema.columns
          WHERE table_schema = ANY (current_schemas(false))
            AND table_name = 'data_sources' AND column_name = 'live_id')                AS has_live_id,
  (SELECT bool_or(convalidated) FROM pg_constraint
    WHERE conname = 'fk_integration_external_systems_live_connection_id')              AS live_fk_validated;
```

期望：前 6 列都为 `t`。`live_fk_validated` 为 `f` 只表示这个外键还没执行过 `VALIDATE CONSTRAINT`（建时是 `NOT VALID`，
执行见 `scripts/ops/live-id-fk-validate-20260920/03-validate.sql`），并不说明有没有悬空行；有没有悬空行要跑同目录的
`01-inventory.sql`（只读）。

### 4.2 Q1 试拉用的是哪一行；Q2 令牌用户是否存在

```sql
-- Q1
SELECT
  count(*) FILTER (WHERE workspace_id IS NULL)     AS tenant_wide_rows,
  count(*) FILTER (WHERE workspace_id IS NOT NULL) AS workspace_rows,
  CASE
    WHEN count(*) FILTER (WHERE workspace_id IS NULL) > 0 THEN 'tenant_wide_row'
    WHEN count(*) = 1 THEN 'single_workspace_row'
    ELSE 'deployment_default'
  END AS pull_uses
FROM integration_stock_prep_source_binding
WHERE tenant_id = :'tenant'
  AND action_id = 'plm.stock-preparation.pull-bom.v1';

-- Q2
SELECT count(*) AS scheduler_user_rows FROM users WHERE id = :'scheduler_user_id';
```

Q1 的判读（定时试拉不带 workspace 提示，按 `stock-preparation-source-binding-store.cjs` 的 `get()` 取行，`:217-257`）：

- `tenant_wide_row`：有租户级行（`workspace_id IS NULL`，唯一索引保证至多一条）就只用它，其余 workspace 行一概不看（`:219-222`）。
- `single_workspace_row`：没有租户级行，且这个 `(tenant, action)` 下恰好一条 workspace 行时，用那一条（`:241-256`）。
- `deployment_default`：零行，或没有租户级行、workspace 行有两条以上（`:250` 的 `siblings.length !== 1`，两条指向同一个
  外接系统也算）时，用部署默认值 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`。这时 Q3 的 `used_by_pull`
  全是 `f`，需要在运维机本地把默认值里的 `externalSystemId` 与 Q3 的 `binding_id_local_only` 对上号。

Q3、Q4、Q6 里的 `pulled` 按同一规则只标出这一行，所以 `used_by_pull = t` 至多一行，并且与 `pull_uses` 一致（§6）。

Q2 应为 1。只有 Q3 里出现 `stamped = f` 的行时才需要它。

### 4.3 Q3 逐行判定（核心）

```sql
WITH cand AS (
  SELECT external_system_id, workspace_id
  FROM integration_stock_prep_source_binding
  WHERE tenant_id = :'tenant'
    AND action_id = 'plm.stock-preparation.pull-bom.v1'
),
pulled AS (
  -- 与绑定表 get() 在没有 workspace 提示时的取行规则一致（见 Q1 的判读）
  SELECT external_system_id
  FROM cand
  WHERE workspace_id IS NULL
     OR (SELECT count(*) FROM cand) = 1
),
b AS (
  SELECT
    es.id,
    es.tenant_id,
    es.connection_id,
    es.legacy_connection_fallback_eligible AS marker,
    NULLIF(BTRIM(es.config->>'dataSourceId'), '')      AS pointer,
    NULLIF(BTRIM(es.config->>'dataSourceOwnerId'), '') AS stamp,
    EXISTS (SELECT 1 FROM pulled p WHERE p.external_system_id = es.id) AS used_by_pull
  FROM integration_external_systems es
  WHERE es.tenant_id = :'tenant'
    AND es.kind = 'data-source:sql-readonly'
),
j AS (
  SELECT
    b.*,
    CASE
      WHEN b.connection_id IS NULL THEN (CASE WHEN b.pointer IS NULL THEN 'unbound' ELSE 'legacy' END)
      WHEN BTRIM(b.connection_id) = '' THEN 'blank_connection_id'
      ELSE 'canonical'
    END AS shape,
    ds.id IS NOT NULL AS ds_exists,
    ds.deleted_at IS NOT NULL AS ds_soft_deleted,
    ds.is_active AS ds_active,
    lower(ds.type) IN ('postgresql', 'postgres', 'http', 'sqlserver', 'mysql', 'plm') AS ds_type_loadable,
    lower(ds.type) IN ('mysql', 'postgres', 'postgresql', 'sqlserver') AS ds_type_sql_ok,
    CASE
      WHEN ds.id IS NULL THEN NULL
      WHEN NULLIF(BTRIM(ds.tenant_id), '') IS NULL THEN 'null'
      WHEN BTRIM(ds.tenant_id) = b.tenant_id THEN 'same'
      ELSE 'other'
    END AS ds_tenant,
    ds.scope_kind AS ds_scope_kind,
    COALESCE(b.stamp, :'scheduler_user_id') = ds.owner_id AS read_principal_is_owner
  FROM b
  LEFT JOIN data_sources ds
    ON ds.id = COALESCE(NULLIF(BTRIM(b.connection_id), ''), b.pointer)
)
SELECT
  j.id AS binding_id_local_only,
  j.used_by_pull,
  j.shape,
  j.marker,
  (j.stamp IS NOT NULL) AS stamped,
  j.ds_exists,
  j.ds_soft_deleted,
  j.ds_active,
  j.ds_type_loadable,
  j.ds_tenant,
  j.ds_scope_kind,
  j.read_principal_is_owner,
  CASE
    WHEN j.shape IN ('legacy', 'unbound') THEN 'NOT_THIS_CODE:legacy_branch'
    WHEN j.shape = 'blank_connection_id' THEN 'NOT_THIS_CODE:CONNECTION_ID_REQUIRED'
    WHEN NOT j.ds_exists THEN 'S2f:source_row_missing'
    WHEN j.ds_soft_deleted THEN 'S2a:source_soft_deleted'
    WHEN NOT j.ds_active THEN 'S2b:source_inactive'
    WHEN NOT j.ds_type_loadable THEN 'S2c:source_type_not_loadable'
    WHEN NOT j.read_principal_is_owner THEN
      CASE WHEN j.stamp IS NULL THEN 'S3a:unstamped_requester_not_owner' ELSE 'S3b:stamp_not_owner' END
    WHEN j.ds_tenant = 'other' THEN 'S4:source_tenant_mismatch'
    WHEN j.ds_tenant = 'null' AND j.ds_scope_kind <> 'legacy_private' THEN 'S5:tenantless_non_legacy_scope'
    WHEN NOT j.ds_type_sql_ok THEN 'NOT_THIS_CODE:CONNECTION_TYPE_UNSUPPORTED'
    WHEN j.pointer IS NOT NULL AND j.pointer <> BTRIM(j.connection_id) THEN 'NOT_THIS_CODE:CONNECTION_BINDING_MISMATCH'
    ELSE 'DATA_OK:see_4.6_for_S6_S2d_S2e_S1'
  END AS verdict
FROM j
ORDER BY j.used_by_pull DESC, verdict;
```

判定顺序与代码的拒绝顺序一致：先看加载层（S2f/S2a/S2b/S2c，对应 `DataSourceManager.ts:323-333`），再看属主
（S3，`:628`），再看租户（S4，facade `:517`），最后看无租户作用域（S5，facade `:520`）。这几种状态报的都是同一个码，
代码里先命中哪条并不影响结论。

一处边缘差异：SQL 用 `BTRIM`，默认只去两端的空格；代码用 JS 的 `trim()`（例如 `connection-resolver.cjs:24-26`、
`DataSourceManager.ts:243-245`），会去掉两端所有空白字符。`connection_id`、租户等值两端带制表符或换行时，两边的判定
可能不同，这时以代码为准。

**Q3 的前提**：库与内存注册表一致。Q3 读当前的库，试拉读后端这次启动时装载的注册表（§2 S6）。所以只拿它判最近一次
重启之后的报错；即使给出了 S 态，按下表处置后仍报错的，也要回到 §4.6 做 S6 的判定。

`verdict` 的判读（只看 `used_by_pull = t` 的那一行，至多一行；全为 `f` 时按 Q1 的说明在本地对上）：

| verdict | 含义 | 处置方向（均为生产写入 = O 层「先批后动」，本文不执行） |
|---|---|---|
| `S2a` / `S2f` | 试拉行指向已软删或不存在的源 | 由绑定者在界面上把外接系统重绑到活的源；存量悬空行的清理见 `scripts/ops/live-id-fk-validate-20260920/`（`01-inventory.sql` 只读，可一并跑） |
| `S2b` | 源未启用 | 查清停用原因（软删路径会同时置 `is_active=false`）后再决定 |
| `S2c` | 源类型不在注册表 | 以受支持类型重建源并重绑 |
| `S3a` | 没有戳，且令牌用户不是属主 | 绑定者本人重新提交一次绑定（带 `connectionId`）来补写戳，见 `onsite-connection-test-runbook-20260901.md` §1.1（`:89` 起） |
| `S3b` | 戳不是当前属主 | 先查来历（是同 id 重建，还是库级直改/恢复，或管理员批量接口改了属主），再由当前属主重绑 |
| `S4` / `S5` | 源的租户或作用域与试拉租户不符 | 租户归属属于 owner 决定，不在本文范围 |
| `DATA_OK:…` | 按当前的库能解析 | 转 §4.6：先做 S6 的判定，再看日志判断 S2d、S2e，最后才是 S1 |
| `NOT_THIS_CODE:…` | 这一行不会报本错误码 | 说明试拉用的不是这一行，或者码已经变了。回到 Q1 核对；Q1 核对无误、试拉仍报本码时，按 §4.6 做 S6 的判定 |

**修复何时生效**：`data_sources` 上的修复，只有经 `/api/data-sources` 路由做的（它调 `DataSourceManager` 的写方法，
`routes/data-sources.ts:545`、`:715`、`:809`、`:905`）会同时更新内存，不需要重启。其它途径——管理员批量接口
`PUT /api/admin/data/bulk`、SQL 直改、恢复——都要等后端重启、注册表重新装载之后才生效，重启前试拉仍按旧快照判（S6）。
§6 实测：经批量接口的四种修复，落库后同一进程里仍报本码，重启后才 OK。`integration_external_systems` 与绑定表
每次请求都读库，改了立即生效（§1.2 补充）。

### 4.4 Q4 汇总（可直接对外报的 values-free 形态）

```sql
WITH cand AS (
  SELECT external_system_id, workspace_id
  FROM integration_stock_prep_source_binding
  WHERE tenant_id = :'tenant'
    AND action_id = 'plm.stock-preparation.pull-bom.v1'
),
pulled AS (
  -- 与绑定表 get() 在没有 workspace 提示时的取行规则一致（见 Q1 的判读）
  SELECT external_system_id
  FROM cand
  WHERE workspace_id IS NULL
     OR (SELECT count(*) FROM cand) = 1
),
b AS (
  SELECT
    es.id,
    es.tenant_id,
    es.connection_id,
    es.legacy_connection_fallback_eligible AS marker,
    NULLIF(BTRIM(es.config->>'dataSourceId'), '')      AS pointer,
    NULLIF(BTRIM(es.config->>'dataSourceOwnerId'), '') AS stamp,
    EXISTS (SELECT 1 FROM pulled p WHERE p.external_system_id = es.id) AS used_by_pull
  FROM integration_external_systems es
  WHERE es.tenant_id = :'tenant'
    AND es.kind = 'data-source:sql-readonly'
),
j AS (
  SELECT
    b.*,
    CASE
      WHEN b.connection_id IS NULL THEN (CASE WHEN b.pointer IS NULL THEN 'unbound' ELSE 'legacy' END)
      WHEN BTRIM(b.connection_id) = '' THEN 'blank_connection_id'
      ELSE 'canonical'
    END AS shape,
    ds.id IS NOT NULL AS ds_exists,
    ds.deleted_at IS NOT NULL AS ds_soft_deleted,
    ds.is_active AS ds_active,
    lower(ds.type) IN ('postgresql', 'postgres', 'http', 'sqlserver', 'mysql', 'plm') AS ds_type_loadable,
    lower(ds.type) IN ('mysql', 'postgres', 'postgresql', 'sqlserver') AS ds_type_sql_ok,
    CASE
      WHEN ds.id IS NULL THEN NULL
      WHEN NULLIF(BTRIM(ds.tenant_id), '') IS NULL THEN 'null'
      WHEN BTRIM(ds.tenant_id) = b.tenant_id THEN 'same'
      ELSE 'other'
    END AS ds_tenant,
    ds.scope_kind AS ds_scope_kind,
    COALESCE(b.stamp, :'scheduler_user_id') = ds.owner_id AS read_principal_is_owner
  FROM b
  LEFT JOIN data_sources ds
    ON ds.id = COALESCE(NULLIF(BTRIM(b.connection_id), ''), b.pointer)
)
SELECT j.used_by_pull, v.verdict, count(*) AS n
FROM j
CROSS JOIN LATERAL (SELECT
  CASE
    WHEN j.shape IN ('legacy', 'unbound') THEN 'NOT_THIS_CODE:legacy_branch'
    WHEN j.shape = 'blank_connection_id' THEN 'NOT_THIS_CODE:CONNECTION_ID_REQUIRED'
    WHEN NOT j.ds_exists THEN 'S2f:source_row_missing'
    WHEN j.ds_soft_deleted THEN 'S2a:source_soft_deleted'
    WHEN NOT j.ds_active THEN 'S2b:source_inactive'
    WHEN NOT j.ds_type_loadable THEN 'S2c:source_type_not_loadable'
    WHEN NOT j.read_principal_is_owner THEN
      CASE WHEN j.stamp IS NULL THEN 'S3a:unstamped_requester_not_owner' ELSE 'S3b:stamp_not_owner' END
    WHEN j.ds_tenant = 'other' THEN 'S4:source_tenant_mismatch'
    WHEN j.ds_tenant = 'null' AND j.ds_scope_kind <> 'legacy_private' THEN 'S5:tenantless_non_legacy_scope'
    WHEN NOT j.ds_type_sql_ok THEN 'NOT_THIS_CODE:CONNECTION_TYPE_UNSUPPORTED'
    WHEN j.pointer IS NOT NULL AND j.pointer <> BTRIM(j.connection_id) THEN 'NOT_THIS_CODE:CONNECTION_BINDING_MISMATCH'
    ELSE 'DATA_OK:see_4.6_for_S6_S2d_S2e_S1'
  END AS verdict
) v
GROUP BY 1, 2
ORDER BY 1 DESC, 2;
```

Q4 的 CTE 部分与 Q3 逐字相同，只是把最后的投影换成了分组计数。

### 4.5 Q5 #5933 是否已在该库执行（R60 之后复核用）

```sql
SELECT count(*) AS pr5933_migration_rows
FROM kysely_migration
WHERE name = 'zzzz20260920150000_backfill_sql_readonly_legacy_connection_id';
```

### 4.6 日志检查与 S6 的判定（只读，在运维机本地看后端 pm2 日志；注意 `PM2_HOME` 用 pm2-runtime 那一份，见交接 §2）

装载相关的几行只在启动时打。后端重启过多次时，只看**最后一次启动**的那一段。批量接口的几行（表中 `Bulk` 开头的）
随时都可能出现，看 T0 之后的全部日志。

| 查什么 | 出处 | 指向 |
|---|---|---|
| `DataSourceManager persistence initialized` | `index.ts:4025` | 注册表初始化没有抛错。注意：查询 `data_sources` 失败时 `loadFromDatabase` 自己吞掉异常（`DataSourceManager.ts:359-362`），这一行照样会打，所以还要看 `Could not load from database` |
| `DataSourceManager initialization failed; continuing in degraded mode` | `index.ts:4027` | **S2e** |
| `[DataSourceManager] Could not load from database` | `DataSourceManager.ts:361` | **S2e** |
| `[DataSourceManager] Loaded <N> data sources from database (<M> skipped)`，M > 0 | `DataSourceManager.ts:358` | 有行被跳过，对照下一行 |
| `[DataSourceManager] Failed to load data source …`，后面跟 `Unsupported persisted data source type` | `:353` / `:332` | **S2c** |
| 同上，后面跟 `Failed to decrypt credential` | `:353` / `:401-403` | **S2d**（加密密钥与写入凭据时的不一致） |
| 同上，后面跟其它原因（例如 `config` 列是 JSON `null` 时 `recordToConfig`（`:410-420`）抛出的错） | `:353` | 这一行同样没装载，结果与 S2c、S2d 相同。Q3 不检查 `config`，可能给出 `DATA_OK` |
| `Bulk data update requested` / `Bulk update completed`，且同一行有 `"table":"data_sources"` | `routes/admin-routes.ts:1517`、`:1592` | 管理员批量接口直接改过 `data_sources`，没经过注册表。行内的 `timestamp`（UTC）晚于 T0 的，是 **S6** 的线索（见下文「S6 的判定」第 3 步）。默认日志级别下两行都会打（`LOG_LEVEL` 未设时为 `info`，`core/logger.ts:78`）。这两行带 `filters`、`updates`、`initiator`，只数次数，不要抄内容 |
| `Bulk data deletion requested` / `Bulk deletion completed`，且同一行有 `"table":"data_sources"` | `:1398`、`:1458` | 批量删除。仍被 canonical 行引用的源会被拒，这时紧跟着一行 `Bulk deletion refused` 开头的日志（`:1437`、`:1479`），所以一般不影响试拉行所指的源 |
| `[plugin-integration-core] route failed: POST /api/integration/table-actions/:actionId/dry-run` | `http-routes.cjs:10096` | 只能说明试拉失败，**不带错误码** |
| 计划任务自己的日志行：`"error":"CONNECTION_CANONICAL_UNAVAILABLE"`、`"dryRunHttpStatus":400` | `…scheduled-pull.mjs:517-525` | 确认错误来自试拉路径 |

只统计出现次数，不要抄出日志行里的 id。

**S6 的判定**（Q3 给出 `DATA_OK`，或者给出的 S 态按 §4.3 处置后仍报错时做；在 S1 之前做）：

1. **取后端这次启动的时间 T0**：`pm2 describe metasheet-backend` 的 `created at`；或者后端日志里**最后一行**
   `[DataSourceManager] Loaded <N> data sources from database` 的时间戳。仓库里的 pm2 配置带 `time: true`，每行都有
   时间（`ecosystem.config.cjs:73`）；它还开着 `autorestart` 和内存上限重启（`:62`、`:64`），所以要取最后一行。
   把 T0 填进会话变量 `backend_started_at`。
2. **取报错那次试拉的时间 T1**，即计划任务的上次运行时间。**T1 早于 T0 的报错不能用当前库判**，要等 T0 之后的下一次试拉。
3. **跑 Q6**，看试拉行所指的源在 T0 之后有没有被写过：

```sql
-- Q6
WITH cand AS (
  SELECT external_system_id, workspace_id
  FROM integration_stock_prep_source_binding
  WHERE tenant_id = :'tenant'
    AND action_id = 'plm.stock-preparation.pull-bom.v1'
),
pulled AS (
  -- 与绑定表 get() 在没有 workspace 提示时的取行规则一致（见 Q1 的判读）
  SELECT external_system_id
  FROM cand
  WHERE workspace_id IS NULL
     OR (SELECT count(*) FROM cand) = 1
)
SELECT
  es.id AS binding_id_local_only,
  EXISTS (SELECT 1 FROM pulled p WHERE p.external_system_id = es.id) AS used_by_pull,
  ds.created_at > :'backend_started_at'::timestamptz AS ds_created_after_start,
  ds.updated_at > :'backend_started_at'::timestamptz AS ds_updated_after_start,
  ds.deleted_at > :'backend_started_at'::timestamptz AS ds_deleted_after_start,
  CASE WHEN current_setting('track_commit_timestamp') = 'on'
       THEN pg_xact_commit_timestamp(ds.xmin) > :'backend_started_at'::timestamptz
  END AS ds_committed_after_start
FROM integration_external_systems es
JOIN data_sources ds ON ds.id = BTRIM(es.connection_id)
WHERE es.tenant_id = :'tenant'
  AND es.kind = 'data-source:sql-readonly'
  AND NULLIF(BTRIM(es.connection_id), '') IS NOT NULL
ORDER BY 2 DESC, 1;
```

判读（只看 `used_by_pull = t` 的那一行）：

- `ds_committed_after_start` 是这一行最后一次写入的提交时间是否晚于 T0，不依赖应用写不写 `updated_at`。只有该库
  开了 `track_commit_timestamp` 才有值。这个参数默认关闭，关闭时该列为 NULL，查询照常执行；最后一次写入早于最近一次
  开启该参数的行也是 NULL（§6 实测）。它为 `f` 时，说明这一行在 T0 之后没有写入，**可以排除 S6**。
- `ds_created_after_start` / `ds_updated_after_start` / `ds_deleted_after_start` 为 `f` 时，**不能排除 S6**。
  按本仓库的迁移链，`data_sources` 上没有自动刷新 `updated_at` 的触发器：带这个触发器的 `040_data_sources.sql`
  （`:206-209`）在迁移链里只是一个不执行的历史标记（`migration-provider.ts:29-35`、`:86`）。上机可以用
  `SELECT count(*) FROM pg_trigger WHERE tgrelid = 'data_sources'::regclass AND NOT tgisinternal` 确认（应为 0）。
  直接用 SQL 改库时不顺手写 `updated_at`，这一列就不会变（§6 实测）。经管理员批量接口改也一样：它只写请求里给出的列
  （`routes/admin-routes.ts:1583`），不会顺带写 `updated_at`（§6 实测四例都为 `f`）。
- 任何一列为 `t`，也**不等于 S6**。经 `/api/data-sources` 的修改同样会写这些列，但同时更新了内存（`persistDataSource`
  `DataSourceManager.ts:913`，软删 `:1088`）；已装载的源每次连上、断开或出错时，`updateStatus` 也会刷新 `updated_at`
  （`:922-946`，§6 实测）。所以只要 `ds_committed_after_start` 不是 `f`（为 `t`，或者参数关闭时为 NULL），都要对两样东西：
  - 运维记录：T0 之后有没有人直接改库、恢复备份，或者在后端运行期间跑过迁移或 `scripts/ops` 下的 SQL；
  - 后端日志：T0 之后有没有上表中带 `"table":"data_sources"` 的 `Bulk data update requested` / `Bulk update completed` 行
    （只数次数，不抄内容）。日志被轮转或清理过、覆盖不到 T0 之后的全部时间时，这一项不能用来排除。

  任何一项有，都按 S6 处理，以第 4 步的重启为准。

4. **决定性的检验是重启**。重启后注册表按当前库重新装载（R60 升级的重启就算一次）。重启之后的下一次试拉不再报这个码，
   就是 S6；重启后仍然报，才按当前库回到 Q3 判定。不需要为这一步单独重启，等 R60 的那次即可。

**S1 的判定**：日志显示最后一次启动时注册表已装载、没有跳过，Q3 对试拉行给出 `DATA_OK`，并且已按上一步排除 S6
（报错发生在最近一次重启之后，Q6、运维记录和日志显示源在重启后没有经 `DataSourceManager` 以外的途径改过，包括
管理员批量接口 `/api/admin/data/bulk`），错误却依旧——这时再核对部署包里
`plugins/plugin-integration-core/plugin.json` 的 `name`。标准包下 S1 不可达，见 §2。

## 5. 建议修复（本 PR 不改代码）

- **R1 原因被丢弃**：`connection-resolver.cjs:178` 的 `catch {}` 丢掉了 facade 的拒绝原因。facade 本身
  （`data-source-plugin-facade.ts:507-525`）又按「不泄露存在性」的设计，把 S2*、S3、S4、S5 都归成同一句 not found。
  建议：facade 对每个拒绝分支附一个**封闭词表**原因（例如 `not_loaded`、`owner_mismatch`、`tenant_mismatch`、
  `tenantless_scope`），`DataSourceManager` 对加载失败的 id 记录 `unsupported_type` / `decrypt_failed`。
  这个原因**只写服务端日志、不进 HTTP 响应**，这样既保住非属主调用者看不出存在性的不变量，运维也能直接从日志定位是 S 几。
- **R2 路由失败日志不带码**：`http-routes.cjs:10095-10097` 只打 method + path。建议加上 `error.code`（封闭词表，values-free）。
- **R3 委派日志在失败时缺席**：记录读身份委派的 info 日志（`http-routes.cjs:4659-4664`）写在加载**之后**，
  加载失败时不会出现，事后无法知道当时用的是戳还是请求者。建议在加载前或 catch 里记录 `delegated` 与 `bindingShape`（都是布尔或封闭词）。
- **R4 源就绪预检测不到这些状态**：预检加载时用的是请求者本人（`http-routes.cjs:6853-6855`），不是委派身份，
  所以非属主一跑预检就先报同一个 400。委派检查也只看有没有戳（`:4561-4570`）。runbook §1.1 的「一眼确认」
  只覆盖 S3a 且只对属主有效。建议：拉取动作的预检按委派身份加载，并用 R1 的原因词表报告 S2*/S3b/S4/S5。
- **R5 前端没有对应文案**：前端把它归为 `PLAN_READ_FAILED` 并附上原始码（`apps/web/src/services/integration/stockPreparation/projectSync.ts:484-487`、
  `:713-717`）。`apps/web/src` 对 `connection-resolver.cjs` 里的错误码零命中
  （`grep -rnE "CONNECTION_(CANONICAL|LEGACY|ID_REQUIRED|TYPE_UNSUPPORTED|BINDING_MISMATCH|TENANT_MISMATCH|RESOLUTION|REGISTRATION|SEALED)" apps/web/src` 计数 0），也就没有对应文案。建议补一句「连接不可用，请管理员按检查清单排查」，并给出本文链接。
- **重试风暴：不存在**。脚本每轮按项目顺序执行，dry-run 失败（本码就是 dry-run 失败）时该项目只发这一次 POST，
  不重试（`…scheduled-pull.mjs:502-526`、`:675-692`）；只有带 `--apply` 且 dry-run 成功、可执行时，才会再发一次 apply
  POST（`:553-563`）。「计划任务每日一次」来自交付说明（`customer-delivery-guide-20260904.md:232-234`），计划任务的
  注册不在库内。可选改进：在汇总行里按错误码计数，现在只有 `failed` 总数（`:592-605`）。
- **R6 同 id 重建会悄悄换属主**：创建路由只在内存里查重（`DataSourceManager.ts:481-483`），落库时按 id upsert，
  并复活软删行（`:895-915`）。所以对一个已软删或未装载的 id 再「新建」一次，就会把 `owner_id`/`tenant_id` 换成新建者。
  重建者不是原戳上的属主时，仍然引用这个 id 的 canonical 绑定会从 S2a/S2b/S2c/S2d 转成 S3b（租户不同时还会同时是 S4），
  而且从界面上看不出绑定的目标已经换了人。
  建议：创建路由对「库里已有同 id 行」给出明确的拒绝或确认，而不是静默复活。
- **给 #5933 评审的备注**（不阻塞）：#5933 的谓词不查 `ds.is_active` 和类型，会把 S2b/S2c 的 legacy 行提升成
  报本错误码的 canonical 行（§3 结论 2）。普查 `05-legacy-binding-census.sql` 可以考虑单列这一类。
- **R7 注册表看不见库级改动（S6）**：注册表启动后不再从库刷新（§1.2 补充），而 SQL 侧只有 Q6 这种间接线索。
  建议在 R1 的 `not_loaded` 原因上附一个布尔：库里这个 id 是否存在且为活行（按主键的一次只读查询，只写服务端日志）。
  这样「库里是活的、内存里没有」就能直接从日志看出是 S6。
- **R8 管理员批量接口绕过注册表**：`PUT/DELETE /api/admin/data/bulk` 的表名白名单含 `data_sources`
  （`routes/admin-routes.ts:1408-1412`、`:1528-1532`），改库后不刷新注册表，是 S6 在应用内的来源（§1.2 补充，§6 实测）。
  建议二选一，由 owner 定：把 `data_sources` 移出这两个白名单，数据源的修改一律走 `/api/data-sources`；或者保留，
  但改完后按受影响的 id 让注册表重新装载这些行。

## 6. 验证（本机合成数据，一次性集群）

环境：便携 PostgreSQL 16.10，新建数据目录，只监听本机回环地址，`initdb --no-locale -E UTF8`；全部为合成值。
本节的 SQL 都是从本文的 sql 代码块原样抽取后执行的；修订后（S6、`pulled` 取行规则、`DATA_OK` 文案、Q6）全部重跑了一遍，
下面的数字是重跑的结果。第 2 轮修订没有改动任何 sql 代码块（7 个代码块与上一版逐字相同），并在修订后的文本上重跑了
17 个用例、试拉行认定和 S6 三组，数字与下文一致。

- **建表**：按部署顺序跑真实迁移：`20251206000001`（data_sources）→ `057`、`079`（SQL）→ `zzzz20260902120000`
  （cutover）→ 植入数据 → `zzzz20260920120000`（live_id，`NOT VALID`）。S2a/S2f 的行在 live_id 迁移之前软删，
  以复现「存量被容忍」。S2f 在迁移之后硬删。
- **运行链路除读身份取值外都是真实模块**：`DataSourceManager.initialize` → `loadFromDatabase`、`createDataSourcePluginFacade`、
  插件 `createConnectionResolver`、`createDb`、`createExternalSystemRegistry`。对每一行调
  `getExternalSystemForAdapter({ runAs: 'user', principal })`，principal 按 `http-routes.cjs:4515-4518` 取「戳或请求者」。
  这一步是在验证脚本里照该处逻辑复刻的，没有经过 HTTP 路由；其余环节都调用真实模块。验证脚本是一次性的，放在本机临时目录，不入库。
- **结果**（17 个用例：9 个 S 态、2 个正常对照、2 个相邻码、4 个 legacy 行）：
  - 执行 #5933 之前：9 个 S 态（S2a/S2b/S2c/S2d/S2f/S3a/S3b/S4/S5）都实测报 `CONNECTION_CANONICAL_UNAVAILABLE`。
    正常对照（含无租户 `legacy_private`）返回 OK。相邻两例分别是 `CONNECTION_TYPE_UNSUPPORTED` 与 `CONNECTION_BINDING_MISMATCH`。
    4 个 legacy 行全部**不是**本码。§4.3 的 SQL 判定与实测结果 **17/17 一致**（S2d 按设计判为 `DATA_OK`，要看日志）。
  - 执行 #5933 之后（从 PR head `cb765d4e7` 取迁移原文运行 `up()`，账本 2 行）：被消除的本码 **0 个**。新增本码 **1 个**
    （源已停用的 legacy 行：`LEGACY_FALLBACK_DENIED` → `CANONICAL_UNAVAILABLE`）。另有 1 行从 `LEGACY_FALLBACK_DENIED` 变为 OK。
    SQL 判定仍然 17/17 一致。
  - 同 id 重建变体：对 S2a 的已软删源，以另一个属主调用真实的 `DataSourceManager.addDataSource` 重建同一个 id。
    落库后属主已变、`deleted_at` 为空、`is_active` 为真。该绑定仍报本码，SQL 判定从 S2a 变为 `S3b`，与实测一致。
  - S1（不注入 facade）与 S2e（不装载注册表）两个变体：13 行 canonical **全部**报本码，包括 SQL 判为正常的对照行和相邻码行；
    4 行 legacy 仍然不是本码。这与 §4.6「DATA_OK 但仍报错 → 看日志」的判读一致。
  - §4.3 SQL 的 9 个变异（去掉软删 / 停用 / 类型 / 属主 / 租户 / 无租户作用域判定、忽略戳、只按 legacy 指针 JOIN、
    把 legacy 当 canonical），每个变异都在新建的库上重跑，**各自至少出现 1 个不一致**（依次为 1/1/1/2/1/1/5/4/2）。
  - Q0–Q4 整段在 `default_transaction_read_only = on`、`ON_ERROR_STOP` 下执行，psql 退出码 0。Q4 的分组计数合计 17，
    与 Q3 的行数相同。Q5 在合成库里另建了一张按 Kysely 默认结构的 `kysely_migration` 表（`name` 主键）后单独执行，退出码 0。
- **试拉行的认定**（Q1 的 `pull_uses`，Q3/Q4 的 `used_by_pull`）：用真实的
  `createStockPreparationSourceBindingStore().get({ workspaceId: null })` 作对照，覆盖 7 种绑定形态：零行、一条租户级行、
  一条 workspace 行、两条 workspace 行、两条 workspace 行指向同一个外接系统、租户级行加一条 workspace 行、租户级行加两条
  workspace 行。修订后 **7/7 一致**。修订前的 `pulled` 只 3/7 一致：后四种形态会多标 `t`，其中两条 workspace 行时，
  store 实际走的是部署默认值。`pulled` 的 4 个变异（退回修订前、去掉单行分支、`= 1` 改成 `>= 1`、去掉租户级分支），
  加上 Q1 的 1 个变异（`= 1` 改成 `>= 1`），各自至少让 1 种形态不一致（依次为 4/1/4/2，Q1 为 2）。Q3、Q4、Q6 里的
  `pulled` 由脚本比对，逐字相同。
- **S6**：启动前植入 7 个源及其绑定，其中 3 个停用。注册表装载后，日志只有 `Loaded 4 data sources from database`，
  没有 skipped。然后绕过注册表改库，逐个观察同一进程的实测结果、Q3、Q6，以及重启后（新建 manager 重新装载）的结果：
  - 4 个纯 S6 用例：用 SQL 启用一个停用源（不写 `updated_at`）、用 SQL 启用一个停用源（同时写 `updated_at`）、用 SQL
    改属主并同步改戳、启动后用 SQL 新插入源和绑定。同一进程里都实测报本码，Q3 都判 `DATA_OK`；重启后都变为 OK。
  - 1 个遮蔽用例：源启动时停用，之后用 SQL 启用并改了属主。Q3 判 `S3b`，内存里这个源却没装载。重启后仍报本码，
    因为这时库里的状态就是 S3b。
  - 2 个对照用例：经 `DataSourceManager.updateDataSource` 改名（`/api/data-sources` 路由用的写方法），以及经 `connectDataSource` 连上
    （`updateStatus` 回写状态）。实测都 OK，但 `ds_updated_after_start` 都为 `t`。所以 `t` 不等于 S6。
  - Q6：`ds_committed_after_start` 对 5 个 SQL 写入用例都为 `t`，对未改动的对照源为 `f`。`ds_updated_after_start` 对
    3 个不写 `updated_at` 的 SQL 改动都为 `f`，所以 `f` 不能排除 S6。8 个用例与 §4.6 的判读 **8/8 一致**。修订前原文
    0/8：它没有 Q6，`DATA_OK` 的文案也不含 S6。Q6 的 4 个变异（提交时间改用 `updated_at`、比较方向反过来、按 legacy
    指针 JOIN、`ds_created_after_start` 恒为假），以及把 `DATA_OK` 文案退回旧文案的 1 个变异，各自至少让 1 个用例不一致
    （依次为 3/8/8/1，文案为 4）。
- **管理员批量接口**（第 2 轮修订新增）：库与上面相同的建法，另起一个新库。处理函数取自真实的 `routes/admin-routes.ts`：
  从它导出的路由里找到 `PUT` / `DELETE /data/bulk`，直接调用最后一层处理函数，跳过前面的管理员鉴权与安全确认两层中间件。
  启动前植入 5 个源及其绑定：对照源；停用源；属主与戳不符；租户与试拉租户不符；软删但仍被引用（在 live_id 迁移之前软删）。
  注册表装载后，经批量更新逐个「修好」：启用；把属主改成戳；把租户改成试拉租户；清空 `deleted_at` 并启用。结果：
  - 四例都返回 200，落库后都已修好；Q3 都判 `DATA_OK`；Q6 的 `ds_updated_after_start` 都为 `f`，`ds_committed_after_start`
    都为 `t`。同一进程里四例仍然全部报本码（内存里两例没装载，一例属主、一例租户仍是旧值）；重启后四例都 OK。对照源始终 OK。
  - 对被引用的对照源做批量删除：返回 409（`DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS`），库不变，试拉仍 OK。
  - 日志：四次批量更新各有一行 `Bulk data update requested` 和一行 `Bulk update completed`，批量删除有一行
    `Bulk data deletion requested` 和一行 `Bulk deletion refused …`，每行都带 `"table":"data_sources"`。
  - 自检：把同样四个改动换成经 `DataSourceManager`（`addDataSource` / `updateDataSource`）写入，同一进程里四例都变为 OK。
    所以上面同一进程仍报错，是批量接口没经过注册表造成的，不是验证脚本的问题。
  - 修订前的原文漏掉这条来源：它的 S6 只列 SQL 直改、恢复、迁移、ops SQL；§4.3 说经界面或 API 的修改不需要重启；
    §4.6 第 3 步只对运维记录，日志表里也没有批量接口的行。按原文，这四例在重启之前会被当作「已排除 S6」引向 S1，
    只有第 4 步的重启能纠正。修订后，§4.6 日志表里的 `Bulk data update requested` / `Bulk update completed` 与实测日志行
    匹配并指向 S6，第 3 步也要求查这两行（由一次性脚本对照实测日志行检查，见第 2 轮 PR 评论）。
- **`track_commit_timestamp`**：以上在该参数开启时运行。改为关闭并重启后，整段清单照常执行，`ds_committed_after_start`
  全为 NULL；把 Q6 里的 `CASE` 守卫去掉的变异在关闭时报 `could not get commit timestamp data`，psql 退出码 3。
  关闭期间写过的行，重新开启后该列为 NULL；开启、关闭、再开启之后，第一次开启期间写入的行也是 NULL。
- **psql 整段**：前言（三个变量填合成值）+ Q0–Q6 + §4.6 的触发器计数，以一个非超级用户、只授了 `SELECT` 的角色执行。
  参数开启和关闭时，psql 退出码都是 0；触发器计数为 0。
