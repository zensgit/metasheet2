# 备料定时试拉 `CONNECTION_CANONICAL_UNAVAILABLE` 诊断（2026-09-25）

> values-free：本文只写表名、列名、条件、文件行号，不含主机、口令、令牌、连接 id、属主 id。
> 演示服务器统称「演示机」。
>
> **基线**：所有 `path:line` 在 origin/main `4189aa096` 上成立。下列文件在演示机当前版本 r59
> （`05461c739`）与 `4189aa096` 之间 `git diff --stat` 为空，因此本文的调用链同样适用于演示机上跑的代码：
> `connection-resolver.cjs`、`external-systems.cjs`、`http-routes.cjs`、`stock-preparation-table-actions.cjs`、
> `stock-preparation-source-binding-store.cjs`、插件 `index.cjs`、`data-source-plugin-facade.ts`、
> `DataSourceManager.ts`、`routes/data-sources.ts`、core `index.ts`、`scripts/ops/stock-preparation-scheduled-pull.mjs`。
>
> 背景：交接文档 `handoff-r59-two-machine-20260924.md:16` 记录「备料定时试拉报
> `CONNECTION_CANONICAL_UNAVAILABLE`（r58 日志末尾已出现）」，定性为已知、非 r59 引入。本文是对这条记录的代码侧诊断。

## 0. 结论

1. **全仓只有一个抛出点**：`plugins/plugin-integration-core/lib/connection-resolver.cjs:178-183`，即
   `resolveCanonical` 里的 `catch`。其余命中是一处注释、测试和文档（见 §1.1 的 grep）。
2. **能走到这个抛出点，说明被加载的那一行外接系统是 canonical 形态**，即 `integration_external_systems.connection_id` 非空。
   这由 `connection-resolver.cjs:270-279` 的分派决定。`connection_id IS NULL` 的 legacy 行进 `resolveLegacy`
   （`:205-267`），报的是 `CONNECTION_LEGACY_*`，不会是这个码。
3. **这个码的含义只有一句：主机侧 facade 的 `resolveConnectionRegistration` 抛了异常**，原因不限。原因在
   `connection-resolver.cjs:178` 的 `catch {}` 处被丢弃。facade 自己也按设计把「没加载 / 不是属主 / 租户不符」
   几种拒绝都归成同一个 not-found（`data-source-plugin-facade.ts:507-525`）。所以不管从 HTTP 响应、服务端日志还是前端，
   都看不出命中的是哪一种（§5 R1–R3）。
4. **定时试拉路径上，能触发它的状态有 9 种数据状态，外加 2 种部署状态**（§2）。真实 PG 上逐一复现过，
   9 种数据状态都实测报这个码（§6）。
5. **PR #5933 合入并在演示机执行后，不会消除这个错误**（§3）。#5933 只改 `connection_id IS NULL` 的行；
   报这个码的行按第 2 条一定是 `connection_id` 非空的行，两者不相交。#5933 反而可能新增这个码：
   它会把「源已停用（`is_active=false`）」一类 legacy 行提升成 canonical，这些行原来报 `CONNECTION_LEGACY_FALLBACK_DENIED`，
   提升后改报 `CONNECTION_CANONICAL_UNAVAILABLE`。真实 PG 实测：消除 0 个，新增 1 个。
6. 演示机实际属于哪种状态，**只能上机判定**。§4 给出只读 SQL 与日志检查清单，SQL 的判定列已在真实 PG 上用 17 个
   合成用例对照实际运行结果（17/17 一致），9 个变异各至少让 1 个用例不一致。

## 1. 调用链：定时试拉入口 → 连接解析 → 抛错

### 1.1 抛出点（全仓 grep）

```
git grep -n "CONNECTION_CANONICAL_UNAVAILABLE" origin/main -- .
```

非文档命中共 6 处：`connection-resolver.cjs:180`（唯一的 `throw`）、`http-routes.cjs:4493`（注释）、
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
| 6a | 读身份：动作 id 等于冻结 id 时，取外接系统行上服务端写入的 `config.dataSourceOwnerId`（归属戳）；没有戳就用请求者本人（令牌用户 `user.id`） | `http-routes.cjs:4506-4519`（等值比较在 `:4512`，冻结 id 定义在 `stock-preparation-workbench-access.cjs:243`）；peek 失败时回落为请求者 `:4535-4547`；`requestPrincipal` `:892-895` |
| 6b | 以该身份、`runAs: 'user'` 加载 | `http-routes.cjs:4639-4645`；`scopedAdapterInput` `:1272-1278` |
| 7 | `getExternalSystemForAdapter`：按 `(tenant_id, workspace_id, id)` 取行（无 workspace 提示时不放宽）；`data-source:sql-readonly` 走连接解析器；解析器抛的 `code` 原样放进 `ExternalSystemValidationError.details.code`，并被提升为 `.code` | `external-systems.cjs:1027-1058`；`selectScopedRow` `:970-976`；行映射 `:290-311`（`connectionId` `:294`）；错误类 `:92-99` |
| 8 | 解析器：非 `sql-readonly` 直接放行；`connectionId` 非空进 `resolveCanonical`，为 NULL 进 `resolveLegacy` | `connection-resolver.cjs:368-378`、`:269-289`（分派 `:270-279`） |
| 9 | `resolveCanonical`：先校验执行租户（不在 try 内，失败报 `CONNECTION_TENANT_MISMATCH`），再在 try 里调 facade；**任何异常都改写成 `CONNECTION_CANONICAL_UNAVAILABLE`**，包括 facade 缺失 | `connection-resolver.cjs:166-184`（`requireFacade` 在 try 内：`:172` → `:55-63`） |
| 10 | facade 由 core 只注入给名为 `plugin-integration-core` 的插件；插件把它交给解析器 | `packages/core-backend/src/index.ts:2514-2520`；`plugins/plugin-integration-core/plugin.json:3`；插件 `index.cjs:305-314` |
| 11 | `resolveConnectionRegistration` → `resolveRegistration`：principal / 租户 / runAs 校验 → `assertAccess` + `getScope` + `getDataSource` → 租户与作用域校验。**不连数据库**（没有 `connectDataSource`） | `data-source-plugin-facade.ts:580-588`、`:491-527` |
| 12 | `assertAccess`：内存注册表里没有这个 id，或 principal 不等于 `owner_id`，都抛同一句 not found；facade 传入的是裸字符串 principal，**平台管理员没有旁路** | `DataSourceManager.ts:621-631`、`:85-89`；`getDataSource` `:1148-1154` |
| 13 | 回到 HTTP：`inferErrorCode` 取 `error.code`；`name` 含 `Validation` → **400** | `http-routes.cjs:745-757`、`:848-852`、`:875` |
| 14 | 脚本把 `error.code` 记进该项目的 JSON 行（`error: "CONNECTION_CANONICAL_UNAVAILABLE"`, `dryRunHttpStatus: 400`, `failed: true`），整轮以退出码 1 结束 | `…scheduled-pull.mjs:473-477`、`:517-525`、`:696` |

补充两点：

- **内存注册表的来源**：进程启动时 `startOnce()`（`index.ts:3787`）在 `:4020-4028` 先 await
  `initializeDataSourceManager` → `loadFromDatabase`，之后才在 `:4397` 装插件、在 `:4861` listen。所以这不是
  「重启后立刻试拉、数据源还没加载」的启动竞态。
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
| **S3a** | 外接系统行**没有**归属戳，且令牌用户 ≠ `data_sources.owner_id` | R = 令牌用户（`http-routes.cjs:4510`、`:4518`）→ `DataSourceManager.ts:628-629` | 即 2026-09-05/06 的历史状态（`customer-delivery-guide-20260904.md:308-313`）。应用代码里写这张表的只有 `external-systems.cjs` 的 upsert（`:891`、`:935`）；迁移和 ops 脚本（如 `scripts/ops/live-id-fk-validate-20260920/02-remediate.sql`）属于 API 之外的写入。cutover 迁移只回填「戳 = 属主」的行（`zzzz20260902120000_…:97-106`），回填出的行本来就带戳。#5505 起，经 API 新建或重绑的 canonical 行都会写戳（`:916-923`、`:875-883`），不重绑的更新沿用已存的戳。所以没戳的 canonical 行，只能来自 #5452 与 #5505 之间经 API 建的行，或 API 之外的直写/恢复 |
| **S3b** | 有归属戳，但戳 ≠ 当前 `data_sources.owner_id` | R = 戳 → `:628-629` | 戳只写被 facade 证明过的属主（`external-systems.cjs:553-567`）；编辑数据源时保留原属主（`routes/data-sources.ts:712-718`）。但**同 id 重建会改属主**：`POST /api/data-sources` 的 id 由客户端给（`routes/data-sources.ts:84`），`addDataSource` 只查内存（`DataSourceManager.ts:481-483`），落库是按 id upsert，会覆盖 `owner_id`/`tenant_id` 并清空 `deleted_at`（`:895-915`）。所以一个已软删或未装载的源，被另一个人用同一个 id 重建后，原有的戳就进入本态（租户不同时还会同时进入 S4）。另一个来源是库级直改或恢复 |
| **S4** | 源有租户，且 ≠ 试拉租户 | `data-source-plugin-facade.ts:517-519` | 试拉租户 = `MS_TENANT_ID`，已经过令牌租户声明核对（`http-routes.cjs:1037-1061`）。外接系统行本身就是按这个租户取的（`external-systems.cjs:971`）。经 API 新建的源，租户取自建源者令牌的租户声明（`routes/data-sources.ts:533-549`） |
| **S5** | 源无租户（`tenant_id` 为 NULL），且 `scope_kind` ≠ `legacy_private` | `data-source-plugin-facade.ts:520-522` | 同样是无租户，`scope_kind = 'legacy_private'` 在 `runAs: 'user'` 下可以通过（`:523` 只拦 service；解析器侧放行在 `connection-resolver.cjs:185-193`、`:113-118`） |

**在这条路径上不可达、已排除的分支**（亲读代码）：

- principal 为空（`data-source-plugin-facade.ts:495` → `:271-282`）：R 要么是非空的戳，要么是已认证用户；路由先鉴权（`http-routes.cjs:5873`）。
- 租户为空（`:496-499`）：`resolveTenantId` 在更早处就抛 `TENANT_REQUIRED`（`http-routes.cjs:1040-1042`）。
- runAs 非法或为 service（`:500-503`、`:523-525`）：本路径固定 `runAs: 'user'`（`http-routes.cjs:1276`）。

**看起来像、但不是这个码的相邻状态**：出现下列码时，就不在本文 S1–S5 的范围内。

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
  `UNAUTHENTICATED`（`http-routes.cjs:1002-1006`，在加载之前的 `:5873`）；后者脚本自己拒绝运行（`…scheduled-pull.mjs:640-651`）。
  都不会报这个码。

## 3. PR #5933（legacy 行 `connection_id` 回填）能消除什么

依据：PR #5933 head `cb765d4e7`，迁移 `packages/core-backend/src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts`。

- 候选集与 UPDATE 都要求 `b.connection_id IS NULL`（该文件 `:158`、`:169`）。
- 按 §0 第 2 条，报 `CONNECTION_CANONICAL_UNAVAILABLE` 的行在加载时 `connection_id` 非空（`connection-resolver.cjs:270-279`；
  `connectionId` 直接取自列值 `external-systems.cjs:294`）。

**结论 1：S1–S5 都不会被 #5933 消除。** #5933 不碰任何当前报这个码的行。演示机的试拉行既然报了这个码，
它就已经是 canonical，#5933 对它没有影响。

**结论 2：#5933 可能新增这个码。** 它提升的行都满足「标记非 TRUE」（`:159`），这类行今天在 `resolveLegacy` 被
`CONNECTION_LEGACY_FALLBACK_DENIED` 拒绝（`connection-resolver.cjs:206-216`）。提升后改走 `resolveCanonical`：

| #5933 谓词是否排除 | 状态 |
|---|---|
| 排除（提升前已证明不成立） | S2a（`ds.deleted_at IS NULL` `:155`）、S2f（JOIN 要求源存在 `:152-153`）、S3b/S3a（`dataSourceOwnerId = ds.owner_id` `:154`，且保留戳）、S4 与 S5（`ds.tenant_id = b.tenant_id` `:156`，NULL 不等于任何值） |
| **不排除** | S2b（未查 `is_active`）、S2c（未查类型）、S2d（SQL 无法判断）、S2e/S1（部署状态） |

所以一行源已停用的 legacy 行，经 #5933 提升后，会从 `LEGACY_FALLBACK_DENIED` 变成 `CANONICAL_UNAVAILABLE`。
这一行在提升前后都不可用，只是报错码换了，但会让「按错误码归因」的排查多出一个来源。真实 PG 实测见 §6。

**结论 3：#5933 真正带来的改变**，是让「可证明、标记非 TRUE」的 legacy 行从一律被拒变为可用。实测 1 行从
`LEGACY_FALLBACK_DENIED` 变为可用。这与本错误码无关。

## 4. R60 上机只读检查清单

**执行约定**（与 `scripts/ops/readonly-inventory-20260916/_preamble.sql` 同一契约）：

- 用只读角色，在运维机上通过 psql 连演示机库执行。
- 结果只在运维机本地看。对外（issue / PR / 交接文档）**只报**布尔、枚举与计数，不报 `binding_id_local_only` 列，也不报任何 id。
- 会话开头先执行：

```sql
\set ON_ERROR_STOP on
\pset pager off
SET default_transaction_read_only = on;
SET statement_timeout = '120s';
SET lock_timeout = '5s';
SET idle_in_transaction_session_timeout = '30s';
-- 两个变量在运维机本地设置，不要抄进任何证据面：
--   tenant            = 计划任务环境里的 MS_TENANT_ID（未设置时是 default）
--   scheduler_user_id = 计划任务令牌所属账号的 users.id
\set tenant '<在运维机本地填写>'
\set scheduler_user_id '<在运维机本地填写>'
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

期望：前 6 列都为 `t`。`live_fk_validated` 为 `f` 表示存量悬空行还没清，这是 `NOT VALID` 的正常状态。

### 4.2 Q1 试拉用的是哪一行；Q2 令牌用户是否存在

```sql
-- Q1
SELECT (workspace_id IS NULL) AS tenant_wide_row, count(*) AS n
FROM integration_stock_prep_source_binding
WHERE tenant_id = :'tenant'
  AND action_id = 'plm.stock-preparation.pull-bom.v1'
GROUP BY 1;

-- Q2
SELECT count(*) AS scheduler_user_rows FROM users WHERE id = :'scheduler_user_id';
```

Q1 的判读：

- 定时试拉不带 workspace 提示。有 `tenant_wide_row = t` 的那一行就用它。
- 否则，恰好一条 `f` 行时用那一条（`stock-preparation-source-binding-store.cjs` 的单候选回退）。
- 零行（或两条以上 `f` 行且没有 `t` 行）时，用部署默认值 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`。
  这种情况下 Q3 的 `used_by_pull` 会全是 `f`，需要在运维机本地把默认值里的 `externalSystemId` 与 Q3 的
  `binding_id_local_only` 对上号。

Q2 应为 1。只有 Q3 里出现 `stamped = f` 的行时才需要它。

### 4.3 Q3 逐行判定（核心）

```sql
WITH pulled AS (
  SELECT external_system_id
  FROM integration_stock_prep_source_binding
  WHERE tenant_id = :'tenant'
    AND action_id = 'plm.stock-preparation.pull-bom.v1'
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
    ELSE 'DATA_OK:check_logs_for_S1_S2d_S2e'
  END AS verdict
FROM j
ORDER BY j.used_by_pull DESC, verdict;
```

判定顺序与代码的拒绝顺序一致：先看加载层（S2f/S2a/S2b/S2c，对应 `DataSourceManager.ts:323-333`），再看属主
（S3，`:628`），再看租户（S4，facade `:517`），最后看无租户作用域（S5，facade `:520`）。这几种状态报的都是同一个码，
代码里先命中哪条并不影响结论。

`verdict` 的判读（只看 `used_by_pull = t` 的那一行，或者按 Q1 的说明在本地对上的那一行）：

| verdict | 含义 | 处置方向（均为生产写入 = O 层「先批后动」，本文不执行） |
|---|---|---|
| `S2a` / `S2f` | 试拉行指向已软删或不存在的源 | 由绑定者在界面上把外接系统重绑到活的源；存量悬空行的清理见 `scripts/ops/live-id-fk-validate-20260920/`（`01-inventory.sql` 只读，可一并跑） |
| `S2b` | 源未启用 | 查清停用原因（软删路径会同时置 `is_active=false`）后再决定 |
| `S2c` | 源类型不在注册表 | 以受支持类型重建源并重绑 |
| `S3a` | 没有戳，且令牌用户不是属主 | 绑定者本人重新提交一次绑定（带 `connectionId`）来补写戳，见 `onsite-connection-test-runbook-20260901.md` §1.1（`:89` 起） |
| `S3b` | 戳不是当前属主 | 先查来历（是同 id 重建，还是库级直改/恢复），再由当前属主重绑 |
| `S4` / `S5` | 源的租户或作用域与试拉租户不符 | 租户归属属于 owner 决定，不在本文范围 |
| `DATA_OK:…` | 数据层面能解析 | 转 §4.6 看日志，判断是 S2d、S2e 还是 S1 |
| `NOT_THIS_CODE:…` | 这一行不会报本错误码 | 说明试拉用的不是这一行，或者码已经变了。回到 Q1 核对 |

### 4.4 Q4 汇总（可直接对外报的 values-free 形态）

```sql
WITH pulled AS (
  SELECT external_system_id
  FROM integration_stock_prep_source_binding
  WHERE tenant_id = :'tenant'
    AND action_id = 'plm.stock-preparation.pull-bom.v1'
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
    ELSE 'DATA_OK:check_logs_for_S1_S2d_S2e'
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

### 4.6 日志检查（只读，在运维机本地看后端 pm2 日志；注意 `PM2_HOME` 用 pm2-runtime 那一份，见交接 §2）

| 查什么 | 出处 | 指向 |
|---|---|---|
| `DataSourceManager persistence initialized` | `index.ts:4025` | 注册表初始化没有抛错。注意：查询 `data_sources` 失败时 `loadFromDatabase` 自己吞掉异常（`DataSourceManager.ts:359-362`），这一行照样会打，所以还要看 `Could not load from database` |
| `DataSourceManager initialization failed; continuing in degraded mode` | `index.ts:4027` | **S2e** |
| `[DataSourceManager] Could not load from database` | `DataSourceManager.ts:361` | **S2e** |
| `[DataSourceManager] Loaded <N> data sources from database (<M> skipped)`，M > 0 | `DataSourceManager.ts:358` | 有行被跳过，对照下一行 |
| `[DataSourceManager] Failed to load data source …`，后面跟 `Unsupported persisted data source type` | `:353` / `:332` | **S2c** |
| 同上，后面跟 `Failed to decrypt credential` | `:353` / `:401-403` | **S2d**（加密密钥与写入凭据时的不一致） |
| `[plugin-integration-core] route failed: POST /api/integration/table-actions/:actionId/dry-run` | `http-routes.cjs:10096` | 只能说明试拉失败，**不带错误码** |
| 计划任务自己的日志行：`"error":"CONNECTION_CANONICAL_UNAVAILABLE"`、`"dryRunHttpStatus":400` | `…scheduled-pull.mjs:517-525` | 确认错误来自试拉路径 |

只统计出现次数，不要抄出日志行里的 id。

**S1 的判定**：日志显示注册表已装载、没有跳过，且 Q3 对试拉行给出 `DATA_OK`，但错误依旧——这时再核对部署包里
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
- **重试风暴：不存在**。脚本每轮每个项目只发一次 POST，顺序执行，失败不重试（`…scheduled-pull.mjs:502-526`、`:675-692`）。
  计划任务每日一次。可选改进：在汇总行里按错误码计数，现在只有 `failed` 总数（`:592-605`）。
- **R6 同 id 重建会悄悄换属主**：创建路由只在内存里查重（`DataSourceManager.ts:481-483`），落库时按 id upsert，
  并复活软删行（`:895-915`）。所以对一个已软删或未装载的 id 再「新建」一次，就会把 `owner_id`/`tenant_id` 换成新建者。
  重建者不是原戳上的属主时，仍然引用这个 id 的 canonical 绑定会从 S2a/S2b/S2c/S2d 转成 S3b（租户不同时还会同时是 S4），
  而且从界面上看不出绑定的目标已经换了人。
  建议：创建路由对「库里已有同 id 行」给出明确的拒绝或确认，而不是静默复活。
- **给 #5933 评审的备注**（不阻塞）：#5933 的谓词不查 `ds.is_active` 和类型，会把 S2b/S2c 的 legacy 行提升成
  报本错误码的 canonical 行（§3 结论 2）。普查 `05-legacy-binding-census.sql` 可以考虑单列这一类。

## 6. 验证（本机合成数据，一次性集群）

环境：便携 PostgreSQL 16.10，新建数据目录，只监听本机回环地址，`initdb --no-locale -E UTF8`；全部为合成值。

- **建表**：按部署顺序跑真实迁移：`20251206000001`（data_sources）→ `057`、`079`（SQL）→ `zzzz20260902120000`
  （cutover）→ 植入数据 → `zzzz20260920120000`（live_id，`NOT VALID`）。S2a/S2f 的行在 live_id 迁移之前软删，
  以复现「存量被容忍」。S2f 在迁移之后硬删。
- **运行链路全部是真实代码**：`DataSourceManager.initialize` → `loadFromDatabase`、`createDataSourcePluginFacade`、
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
