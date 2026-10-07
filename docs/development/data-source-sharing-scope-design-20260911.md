# G02 设计:外接数据源的共享与作用域(2026-09-11)

**基线**:worktree `docs/data-source-sharing-design`,父提交 `5f4b32122`。本文所有 `file:line`
均在该提交上实读复验过。

**在飞的三个相邻改动**(本文按它们**合并后**的形态写;它们不在本基线里,经 `gh pr diff` 只读查看):

| PR | 形态 | 本设计依赖它的哪一点 |
|---|---|---|
| #5587 `feat/data-sources-fold-into-workbench` | `/data-sources` 改重定向,列表落进数据工厂「连接管理」分区;新增 `apps/web/src/components/data-sources/DataSourcesPanel.vue` | 共享控件的落点就是这个面板,不再是 `DataSourcesView.vue` |
| #5593 `feat/data-sources-reference-count` | 列表带 `referenceCount`;新增 `DataSourceManager.countExternalSystemReferencesByIds`;扩 `tests/unit/data-source-visibility-authority-matrix.test.ts` | 列表投影已有新增列的位置;作用域列与它并列 |
| #5611 `feat/integration-permission-codes-seed` | 迁移 `zzzz20260910120000_add_integration_permissions.ts` 种子化 `integration:read/write/admin` + `data_sources:read/write/execute`,**授予给零主体**;RBAC 缓存 60s,改完要重登 | 动词表的「复用还是新增」以这六码为起点;新码沿用它的迁移形状 |

---

## 0. 先对账:差距报告逐条实读复验

协调方给的原始结论,我逐条读了一遍。**结论方向基本成立,但有三处需要点名订正**,另有三条报告没提到的事实值得补上。

### 0.1 行号系统性偏移 +12(`routes/data-sources.ts`)

报告给的 `:486` / `:324` / `:451` / `:1025` / `:704`,在本基线上分别是 **`:498` / `:336` / `:463` / `:1037` / `:716`**——
整整齐齐差 12 行。原因是 `f3c6dd09d`(#5605)在文件头部插入了 `wantsSchemaColumns` 及其注释块
(`routes/data-sources.ts:52-63`)。**报告的正文是在 #5605 之前的树上读的**。
语义没变,但后续任何人按报告行号去读都会读到隔壁的东西——这正是「头部与正文来自不同轮次」的老毛病,
所以本文一律用本基线行号,并在此显式登记偏移。

同一份报告里 `DataSourceManager.ts:589-603`、`:1246-1252`、`zzzz20260902120000:67`、
`data-source-scope.test.ts:218,225`、`pipeline-runner.cjs:413,420,520,526` **行号完全准确**,
说明这几条是另一轮读的。

### 0.2 被实读订正的三条

**订正 1 ——「`assertAccess` 只看 `ownerId`」不准确。**
`DataSourceManager.ts:593-603` 有两层:`:599` 先对 `platformAdmin === true` 提前 `return`,
`:600` 才做属主等值。actor 有两种形态(`:34-50` 的类型注释写得很清楚):裸字符串 = 数据面,
owner-only 无 admin 旁路;`DataSourceActorContext` 对象 = 管理面,平台管理员可越属主。
所以准确说法是「**属主等值 或 平台管理员**」——这恰好对上痛点里那句「唯一绕法是共用账号或平台管理员」,
但报告正文的措辞会让人以为管理员也进不去。

**订正 2 ——「`:704` vs `:451` 共用 write」的配对不准。**
换算后 `:463` 是 `POST /api/data-sources`(**创建**),不是「改配置」。真正的「改连接串」是
`PUT /api/data-sources/:id`(**`:615`**)。结论本身不但成立,而且**比报告说的更宽**:
七个变更路由共用同一个 `data_sources:write`——

| 路由 | 行 | 门 |
|---|---|---|
| `POST /api/data-sources` | `:463` | `data_sources:write` |
| `POST /api/data-sources/test` | `:549` | `data_sources:write` |
| `PUT /api/data-sources/:id` | `:615` | `data_sources:write` |
| `PUT /api/data-sources/:id/credentials` | `:716` | `data_sources:write` |
| `DELETE /api/data-sources/:id` | `:818` | `data_sources:write` |
| `POST /api/data-sources/:id/connect` | `:898` | `data_sources:write` |
| `POST /api/data-sources/:id/disconnect` | `:950` | `data_sources:write` |

**订正 3 ——「`workspace_id` 存了但没被消费」说轻了。**
报告只说读侧不消费(`DataSourceManager.ts:589-591` 的自认注释属实)。实读下来**写侧也从不写**:
`addDataSource` 在全仓只有**一个**生产调用点 `routes/data-sources.ts:495`,它传的是
`{ ownerId, tenantId, scopeKind: 'private' }`——**没有 `workspaceId`**(`:495-499`)。
`configToRecord` 于是落 `workspace_id: workspaceId || null`(`DataSourceManager.ts:415`)。
更新路径(`:667`、`:761`)只把先前的值原样带回。所以生产创建出来的行,`workspace_id` 恒为 `NULL`。
**不是「存了没读」,是「没存也没读」**——这直接决定了第 1 节为什么不做 workspace 档。

### 0.3 实读确认成立的条目

| 报告断言 | 本基线实读 | 判定 |
|---|---|---|
| `scopeKind` 硬编码 `'private'` | `routes/data-sources.ts:498`;全仓 grep `addDataSource(`(排除 node_modules 与测试)只此一个生产调用点 | 成立(行号订正) |
| RBAC 有 read/write/execute 三分但都在属主闸门之下 | 门:`:336`/`:463`/`:1037`;闸门:`:425`/`:631`/`:742`/`:825`/`:903`/`:955`/`:994`/`:1055`/`:1158`/`:1207`/`:1261` | 成立 |
| `assertAccess` 的 workspace 注释自认未消费 | `DataSourceManager.ts:589-591` | 成立 |
| `scopePermitsListing` 同样只看属主/管理员 | `DataSourceManager.ts:1246-1252` | 成立 |
| `scope_kind='workspace'` 生产零写入 | 全仓 `'workspace'` 只出现在 `DataSourceManager.ts:208`(常量)、`zzzz20260902120000:67`(CHECK)、三个测试文件 | 成立 |
| `DataSourcesView.vue` 无共享控件 | 788 行全文 grep `share`/`共享`/`scope`/`visib`/`owner`/`授权` 只命中 `:751` 的 `<style scoped>` | 成立 |
| `runAs=service` 也过 `assertAccess`,无服务身份旁路 | `data-source-plugin-facade.ts:500` 读 `runAs`,`:508` 无条件 `assertAccess(principal)`;`runAs` 只在 `:523` 用于**再收紧** | 成立 |
| 管道运行主体固定为创建者 | `pipeline-runner.cjs:413`、`:420`(取外部系统)、`:520`、`:526`(建 adapter),一律 `principal: pipeline.createdBy` | 成立 |
| `directory/*.ts` grep `data_source` = 0 | 16 个文件零命中 | 成立 |

### 0.4 报告没提、但影响设计的三条

**(a) 唯一一个在 `data-sources` 路由与 facade 之外的 `assertAccess` 调用点**:`routes/plm-workbench.ts:782`。
(全仓 `packages/core-backend/src` 下共 **17** 个调用点:facade 5 个 `:508/:540/:605/:624/:834`、
`routes/data-sources.ts` 11 个 `:425/:631/:742/:825/:903/:955/:994/:1055/:1158/:1207/:1261`、
`plm-workbench.ts` 1 个 `:782`;加上 `DataSourceManager.ts:593` 的定义行,grep 出来是 18 行。)
任何改动 `assertAccess` 语义的 PR 都要把它算进爆炸半径。

**(b) 数据面/管理面已经分形了**——这是本设计最重要的既有资产。
`resolveActor` 的文档注释(`routes/data-sources.ts:251-265`)明写:管理面(list/get/test/connect/
disconnect/update/rotate/delete)传 `DataSourceActorContext`,数据面(`/query :1055`、`/select :1158`、
`/schema :1207`、`/tables :1261`)传**裸 user id**,因此数据面没有平台管理员旁路。
「管理一个连接不等于能悄悄读它背后的客户数据」这条线已经画好了,共享设计只需要沿着它走。

**(c) 作用域是进程内内存 Map,没有失效通道。**
`DataSourceManager.scopes` 是 `private scopes: Map<...>`(`:252-258`),只在
`loadFromDatabase`(`:310-316`,启动时)、`addDataSource`(`:484-488`)、`updateDataSource`(`:565-568`)
三处写入。**没有任何 reload / 订阅 / 失效路径。** 当前部署形态是单进程
(`ecosystem.config.cjs:60-61` `instances: 1, exec_mode: 'fork'`),所以今天不出问题;
但这意味着**任何共享写入必须同时改 DB 行和这个 Map**,直接改库不重启不生效。
这条要写进每一刀的验收标准。

---

## 1. 决策一:作用域档位 —— **两档**(`private` / `tenant_shared`),不做 workspace 档

### 1.1 裁决

现有 CHECK 收三个值(`zzzz20260902120000:67`):`legacy_private | private | workspace`。
**新增第四个值 `tenant_shared`,不使用已有的 `workspace`。**

生效后的四值语义:

| `scope_kind` | 含义 | 谁产生 |
|---|---|---|
| `legacy_private` | 迁移前的存量行(`zzzz20260902120000:42-43` 回填) | 只由迁移产生,任何新路径都不写 |
| `private` | 属主私有(默认,`DataSourceManager.ts:461`、迁移 `:48` 的列默认值) | `routes/data-sources.ts:498` |
| `workspace` | **保留不用**。CHECK 允许但无人写、无人读 | 无 |
| `tenant_shared` | 同租户内「可用」——见第 2 节动词表的 use 面 | 新路由 `PUT /api/data-sources/:id/scope` |

「两档」指的是**运营上可选的档位只有两个**(私有 / 本租户共享);`legacy_private` 是存量标记,
`workspace` 是保留值,两者都不出现在任何 UI 选项里。

### 1.2 为什么不做 workspace 档(三条,都可实读)

1. `workspace_id` 生产上恒为 `NULL`(§0.2 订正 3)。做 workspace 档要同时新增写入者和读取者,
   而写入者需要一个「当前 workspace」的可信来源——核心侧的 `POST /api/data-sources` 今天根本不接收它。
2. 插件侧的 workspace 是**自报值**:`http-routes.cjs:1248-1250` 的 `resolveWorkspaceId` 从
   body/query/params 取第一个非空串,**没有任何校验**。拿它当授权维度等于把授权交给请求体。
3. 本仓已经因为「把租户当 workspace」踩过一次坑(PR #5472 的作用域洞)。`tenant_id` 是**有可证来源**的:
   `routes/data-sources.ts:483-497` 只从 `resolveAuthenticatedTenantId`(`:246-249`,只读
   `req.authenticatedTenantId`,注释 `:241-245` 明写不回退 `req.user.tenantId`,因为后者可能来自
   `x-tenant-id` 兼容头)取值。**租户是已证明的边界,workspace 不是。**

### 1.3 谁能改

- **属主本人**,或**平台管理员**(与 `assertAccess` 的两个 tier 一致)。
- 新码 `data_sources:share` 作为粗门(第 2 节),`assertAccess(id, actorContext)` 作为细门。
- **硬前置**:`scope.tenantId !== null` 才允许置 `tenant_shared`。理由是 `tenantId` 为 null 的源
  在 facade 里已经被两道判定当成「租户不明」处理(`data-source-plugin-facade.ts:520-524`):
  `tenantId === null && scopeKind !== 'legacy_private'` 直接 404,`tenantId === null && runAs === 'service'` 直接 404。
  给一个 tenantless 的源打上 `tenant_shared`,只会造出一个谁都读不到的行。

### 1.4 存量怎么迁 —— **不迁**(硬要求已满足)

- 新迁移只做一件事:**放宽 CHECK 让它多接受一个值**(`DROP CONSTRAINT` + `ADD CONSTRAINT` 收四值)。
  不 UPDATE 任何行,不改列默认值(仍是 `'private'`)。
- `legacy_private` 行一行不动;`private` 行一行不动。
- 可见性与今天逐字节相同:在 PR-3 的写入口落地之前没有路径会产生 `tenant_shared`,
  所以 PR-2 单独上线时新分支取不到值(这是 PR-2 的验收点,见第 7 节)。
- **存量 tenantless 源不能被共享**,这是刻意的:它们要先补上租户。而「重存一次」并不会自动补上——
  `updateDataSource` 在 options 没有 `tenantId` 键时保留 `priorScope?.tenantId`
  (`DataSourceManager.ts:515-518`)。补租户需要一条显式路径,**本设计不覆盖**(见第 8 节第 10 条)。

### 1.5 落到表/路由/控件

| 层 | 具体物 |
|---|---|
| 表 | `data_sources.scope_kind` CHECK 放开第四值;**不新增表、不新增列** |
| 常量 | `DataSourceManager.ts:208` 的 `DATA_SOURCE_SCOPE_KINDS` 加 `'tenant_shared'` |
| 读侧 | `assertAccess`(`:593-603`)与 `scopePermitsListing`(`:1246-1252`)各加一个分支 |
| 写侧路由 | 新增 `PUT /api/data-sources/:id/scope`,body 形如 `{ scopeKind: "private" 或 "tenant_shared" }` |
| 控件 | #5587 的 `apps/web/src/components/data-sources/DataSourcesPanel.vue`:列表加「作用域」列(私有/本租户共享),行操作加开关;详情弹窗加一行说明 |

---

## 2. 决策二:权限动词拆分

### 2.1 对报告建议(read / use / manage / rotate)的判断

**方向对,但四档不够,而且 read 与 use 的边界报告没说清——这恰恰是整件事的关键。**

#### 「能选用一个源跑管道」和「能读到它的配置」不是同一件事,而且差得很远

`sanitizeConfig`(`routes/data-sources.ts:321-327`)只解构掉 `credentials`,`connection` 原样放行:
返回值是 `{ ...rest, hasCredentials: boolean }`,而 `rest` 里带着 `connection`。

`connection` 里装的是 `host` / `server` / `port` / `database`(前端 `buildPayload.ts:36-40` 就这么填的)。
所以 **`GET /api/data-sources/:id`(`:421`,`data_sources:read` 门)会把客户库的主机、端口、库名回给调用者**
(`:437` 是那个返回点)。

`GET /api/data-sources/:id/test`(`:989`,同样是 `read` 门)更进一步:它返回
`redactSecrets` 之后的**驱动原文**。`BaseAdapter.redactSecrets`(`:500-525`)擦的是
`credentials.password/token/apiKey/secret` 与 `connection.password` 的**值**,外加
`password=` / `token=` / `Authorization:` 这类键值对;**它不擦 host、port、database、username**。
`DataSourceManager.ts:82-84` 的注释自己举了例子:形如
`Failed to connect to SQL Server: ... Login failed for user '…' ... <主机>:<端口>` 的原文。

而「选用一个源跑管道」实际需要的是:列库表(`GET /:id/schema` `:1203`)、看列
(`GET /:id/tables/:table` `:1257`)、取样(`POST /:id/select` `:1143`)。这三个的响应都不含
`connection`,失败时回的是固定句(`routes/data-sources.ts:68-76` 的 `SCHEMA_FAILURE_MESSAGE` /
`TABLE_INFO_FAILURE_MESSAGE`)。

**结论:use 面不泄露连接坐标,read 面泄露。共享必须只放开 use 面,不顺带放开 read 面。**
这是本设计的硬线,也是把 read 和 use 拆成两个动词的全部理由。

#### 「轮换凭据」和「改连接串」为什么必须分开

`:716`(轮换)与 `:615`(改连接串)今天共用 `data_sources:write`,意味着**任何能轮换口令的人,
同时能把这个源指向另一台机器**。两者的风险不同级:

- 轮换只换凭据,**目标库不变**。这是运维日常动作,频率高,应该能下放。
- 改连接串会**改变数据流向**。`assertSqlSourceProvisionableAtRuntime`(`DataSourceManager.ts:540-543`)
  只拦「已武装(armed)但没有 load 阶段 pin」的 id;`pinSqlSourceConnection` 只在 `phase === 'load'`
  时打 pin(`:734-736`)。**未武装的普通源,运行时改指向没有 pin 拦着**。
  于是「改连接串」是一条可以把已建好的管道接到别的主机上的路径,而「轮换」不是。

共用一个码 = 为了让运维能换口令,不得不同时给出改指向的能力。这就是 `:716` 与 `:615` 同门的实际代价。

### 2.2 最终动词表

RBAC 层是**粗门**(你这个人在本系统里能不能碰这类资源),`assertAccess` 是**细门**(你能不能碰这一个源)。
这是仓库既有的两腿模型(`routes/approval-comments.ts:5-10` 把它叫 "coarse leg-1 door")。
动词表只定义粗门;共享由细门决定。

| 动词 | 权限码 | 复用/新增 | 覆盖的路由(本基线行号) |
|---|---|---|---|
| **use** 选用 | `data_sources:use` | **新增** | `GET /:id/schema` `:1203`、`GET /:id/tables/:table` `:1257`、`POST /:id/select` `:1143` |
| **read** 读配置 | `data_sources:read` | 复用 #5611 | `GET /` `:336`、`GET /health` `:374`、`GET /:id` `:421`、`GET /:id/test` `:989` |
| **execute** 裸 SQL | `data_sources:execute` | 复用 #5611 | `POST /:id/query` `:1037` |
| **manage** 建改删连 | `data_sources:write` | 复用 #5611 | `:463`、`:549`、`:615`、`:818`、`:898`、`:950` |
| **rotate** 轮换凭据 | `data_sources:rotate` | **新增** | `PUT /:id/credentials` `:716`(从 write 里**摘出**) |
| **share** 改作用域 | `data_sources:share` | **新增** | 新路由 `PUT /:id/scope` |

三个新码,一支新迁移,形状照抄 #5611 的 `zzzz20260910120000_add_integration_permissions.ts`
(`DO $$` 表存在守卫 + `ON CONFLICT (code) DO NOTHING` + **只种码不写 `role_permissions`**)。

#### 为什么值得新增(而不是继续复用六码)

1. **use 是 G02 的全部意义**。不新增 use,「让顾问能选源」就只能靠给他 `data_sources:read`,
   而 read 会连主机端口一起给出去(§2.1)。用现有六码做不到「能用但看不到配置」。
2. **rotate 是报告核心那条的落点**。不摘出来,「拆分」就只是文档上的说法。
3. **share 必须独立**,否则「能改配置的人自动能把源共享出去」,把一个需要审计的授权动作
   混进日常配置编辑里。
4. **命名空间准入不多一个开关**。`derivePermissionResource`(`rbac/namespace-admission.ts:125-131`)
   按**第一个冒号之前**取 resource,三个新码的 resource 都是 `data_sources`,
   所以它们复用**同一个** `data_sources` 准入开关。运维不需要多开任何东西——这是选择
   「同前缀新动词」而不是「新资源前缀」的直接理由。

#### 向后兼容与「只能收紧」

- **use**:三个路由的门从 `rbacGuard('data_sources','read')` 改成
  `rbacGuardAny(['data_sources:use','data_sources:read'])`(`rbac/rbac.ts:119` 已有该工厂)。
  这对既有持有者**不构成收紧也不构成放宽**:今天持 read 的人照样过。新增的是「只持 use 的人也能过」,
  而 use 今天没有持有者。
- **rotate**:`:716` 的门改成 `rbacGuard('data_sources','rotate')` **独占**。
  这是一次**收紧**,回归面取决于「今天谁持有 `data_sources:write`」。
  #5611 的设计文档自述「六码种子化后持有者为零,也不预绑 `admin` 角色」,平台管理员走
  `rbac.ts:69-72` 的 `role:admin` 短路不受影响。**但这只在新装库上可证**——客户库里可能已经
  有人手写过 `INSERT INTO permissions` + 授予。因此:
  **PR-1 的验收前置是上机跑一条只读查询,确认 `role_permissions` / `user_permissions` 中
  `permission_code = 'data_sources:write'` 的行数为 0;不为 0 就先把 `data_sources:rotate`
  经角色补给这些主体,再切独占。**
  刻意**不**在迁移里写 `role_permissions` 自动补权——那会让迁移变成发权者,违背 #5611 定的「零自动」口径。
- **share**:新路由,新码,无存量,不影响任何既有调用者。

---

## 3. 决策三:凭据永不外泄

### 3.1 现在怎么存

调用链:`routes/data-sources.ts:495` `addDataSource(config, { ownerId, tenantId, scopeKind:'private' })`
→ `DataSourceManager.ts:479` `persistDataSource(...)`
→ `DataSourceManager.ts:759` `configToRecord(...)`
→ `DataSourceManager.ts:407-412` 落 `config: { connection, credentials: this.encryptCredentials(...), options, poolConfig }`
→ `encryptCredentials` 只加密 `SENSITIVE_CREDENTIAL_KEYS = ['password','apiKey','token']`(`:24`)
→ `encryptStoredSecretValue`(`security/encrypted-secrets`)
→ `data_sources.config`(JSONB)。

### 3.2 现在怎么回读

`DataSourceManager.ts:286` `loadFromDatabase()`(只在启动 / `initialize` 时跑)
→ `recordToConfig` → `decryptCredentials` → **明文只进 adapter 的进程内存**。

`decryptCredentials` 对密钥不匹配**fail loud**(抛 `Failed to decrypt credential ... ENCRYPTION_KEY may have changed`),
密文不会被当明文塞给 adapter。遗留明文原样透传,下次持久化时懒迁移成密文。

### 3.3 出网关的那一层 —— **就是 `sanitizeConfig`,共享路径上不需要新增任何一层**

`routes/data-sources.ts:321-327` 是响应投影,五个返回点全部经过它:
`:437`(GET 详情)、`:513`(创建)、`:687`(更新)、`:782`(轮换)、`:866`(删除)。
它把 `credentials` 整个解构掉,只留 `hasCredentials: boolean`。轮换路由自己在 `:757-758`
也写明「Rotation stays WRITE-ONLY for every tier」。

**共享只改「谁能通过 `assertAccess`」,不改响应投影。** 所以「共享一个源给他人可用」不会让凭据变可读——
凭据的不可读性由 `sanitizeConfig` 这一层保证,而共享完全不碰它。这是本设计选择
「改可见性而非改投影」的直接收益,也是回归测试的靶心:
`tests/unit/data-source-visibility-authority-matrix.test.ts:558` 已有一个叫
`poison sweep — credentials are write-only for EVERY tier, everywhere` 的 describe,
新增的 `tenant_shared` tier 要被加进那个 sweep。

### 3.4 两条必须点名的残余披露面(共享会放大它们)

**残余面 A:`connection` 不在剥离范围。** `:322` 只解构 `credentials`,`connection` 随
`...rest` 原样回。host/port/database 会回给任何通过 `assertAccess` 的人。
→ **本设计的应对:`tenant_shared` 不放开 read 面**(`GET /:id` `:421`、`GET /:id/test` `:989`
在细门上仍然 owner-only 或平台管理员)。

**残余面 B:`connection.password` 会明文落库并回显。**
`ConnectionConfigSchema`(`:79`)是自由 record(`z.record(z.union([z.string(), z.number(), z.boolean()]))`),
`connection` 可以带任意键包括 `password`。而 `configToRecord`(`:407`)只加密 `config.credentials`,
`connection` 原样入 JSONB;`sanitizeConfig` 又不剥 `connection`。
本仓自带的前端把口令放 `credentials`(`apps/web/src/data-sources/buildPayload.ts:39-41`),
所以**这条面不由随仓发布的 UI 触发**;但直接调 API 写 `connection.password` 的源会明文落库并随
`GET /:id` 回显。值得注意的是 `redactSecrets`(`BaseAdapter.ts:509`)**把 `conn.password` 算进秘密值**——
说明脱敏层认为它是秘密,而加密层与投影层不认。**三处口径不一致,这是我实读发现的既有洞,报告没提。**
→ 本设计**不修**它(见第 8 节第 7 条),但它是「不要把 read 面共享出去」的又一条理由,并单开一单。

---

## 4. 决策四:运行主体(最难的一段)

### 4.1 今天的事实

| 事实 | 位置 |
|---|---|
| 管道以创建者身份读源 | `pipeline-runner.cjs:413`、`:420`(取外部系统)、`:520`、`:526`(建 source/target adapter),全部 `principal: pipeline.createdBy` |
| `createdBy` 由服务端盖,不信 body | `http-routes.cjs:5314`(以及 `:5352`、`:5384`)`createdBy: user && (user.id 或 user.email)` |
| `created_by` **写一次不可改** | `pipelines.cjs:518-523`:只有 insert 分支带 `created_by`;update 分支 `{ ...baseRow }` 不含该键。**仓库里没有管道转交路径** |
| C6 外部写以 `createdBy` 为属主锚 | `http-routes.cjs:5462`、`:5577`:`ownerPrincipal = firstString(pipeline.createdBy)`,为空直接 422 `C6_WRITE_OWNER_PRINCIPAL_REQUIRED` |

### 4.2 `runAs=service` 也过 `assertAccess` —— **是保护,不是障碍**

`data-source-plugin-facade.ts:495` 取 `principal`,`:500` 取 `runAs`,`:508` **无条件**
`assertAccess(dataSourceId, principal)`,`:517`/`:520`/`:523` 三道再收紧(租户不等 404、tenantless 非 legacy 404、
tenantless + service 404)。

判断:`principal` 与 `runAs` 回答的是**两个不同的问题**——`principal` 是「以谁的名义」,
`runAs` 是「这次调用是不是用户亲自发起的」。`runAs` 在这段代码里**只用于再收紧,没有一处用于放宽**。
把 `assertAccess` 从 service 路径上摘掉,等于让任何拿到 `dataSourceId` 的插件读任意源
——`index.cjs:214/256/280` 那条跨插件通信通道就是现成的入口。**所以它是保护。**

真正的障碍在别处:**`principal` 恒等于 `createdBy`**(`pipeline-runner.cjs:413/420/520/526`),
于是「以触发者身份跑」在今天的代码里**无法表达**——不是被 `assertAccess` 挡住,是根本没有那个变量。

### 4.3 三个候选的租户安全含义

**(a) 沿用创建者。**
跨租户由 `facade:515-518`(`scope.tenantId !== requestedTenant` → 404)挡住,与运行主体无关。
风险是 owner 线与 tenant 线**会漂移**:创建者离职、调岗、换租户之后,管道仍以他的名义读
(而 `assertAccess:600` 是纯字符串比较,从不查这个人是否还在职——见第 6 节)。

**(b) 改用触发者。不推荐,三条硬伤:**
1. **定时 / 服务触发没有触发者**。`index.cjs:256` 的跨插件 `runPipeline` 被强制改写成 `runAs:'service'`,
   它没有人类主体;把 principal 换成触发者,这条路径直接没得填。
2. **打断 C6 外部写的属主锚**。`http-routes.cjs:5462` / `:5577` 明确要求 `pipeline.createdBy`,
   拿它当 `ownerPrincipal` 往下传。运行主体一改,这个锚要么继续用 createdBy(那就没改成)、
   要么跟着改(那就把外部写的授权主体换成了每次不同的人)。
3. **既有管道会在第一次被别人手工触发时红**。触发者的可见性可能比创建者窄,
   一条今天跑得好好的管道换个人点一下就 404。这在可上线性上不可接受。

**(c) 引入服务主体。不推荐(现在不做),两条理由:**
1. `assertAccess`(`:593-603`)今天只认两个 tier:`userId` 字符串等值、`platformAdmin` 布尔。
   服务主体是第三个 tier,而且是**没有人在背后**的那种。
   `pipeline-runner.cjs:523-525` 的注释已经就这个问题表过态:
   「fails closed instead of **inventing a service identity** for legacy/null createdBy pipelines」——
   仓库现有立场就是不发明服务身份。
2. `facade:523` 明确拒绝 tenantless service。要让服务主体可用,得先保证每个源都有租户;
   而存量源大量 tenantless(§1.4)。顺序反了。

### 4.4 推荐:**(a') 沿用创建者,但把「创建者能不能读到这个源」从属主等值改成作用域判定**

即 `assertAccess` 的细门从「`ownerId === userId` 或 `platformAdmin`」放宽为
「`ownerId === userId` 或 `platformAdmin` 或(`scopeKind === 'tenant_shared'` 且
`scope.tenantId === 调用方的【已证】租户`)」。

**关键约束(这条是为了不让写入口为了让读取更宽而扩大回退):**

- `DataSourceActorContext` 新增 `tenantId?: string`(`DataSourceManager.ts:52-55`)。
- **裸字符串形态一律保持 owner-only。** 没有携带已证租户的调用方,拿不到 `tenant_shared` 分支。
  这样 `routes/data-sources.ts:1055/1158/1207/1261`、`routes/plm-workbench.ts:782`、
  facade 的五处(`:508/:540/:605/:624/:834`)在改动当天**保持今天的行为**,
  要放宽必须一处一处显式接线。**这「一处一处」的归属见 §5.6 的逐段表,哪一刀接哪一处见 §7。**
- **「已证租户」只认 `req.authenticatedTenantId`**,也就是 `routes/data-sources.ts:246-249` 的口径。

### 4.5 插件侧的 `resolveTenantId` 不是已证租户(本节最要紧的一句)

插件侧的租户**不是已证租户**。`http-routes.cjs:1028-1052` 的 `resolveTenantId`:

- `:1030` 取值顺序是 `input.tenantId`(**请求体优先**)→ query → params → `user.tenantId`;
- `:1036-1043` 要求非平台管理员的 `user.tenantId` 必须等于它;
- `:1045-1049` 的注释**自认**:`user.tenantId` 在 token 无租户声明时由认证中间件从
  `x-tenant-id` **请求头**填充,「so on a claimless deployment those comparisons can be
  **header against header**」;
- `:1050` 调的 `assertVerifiedTenantClaim`(`:1221-1246`)是 `resolveTenantId` 这条链上
  唯一一处去问「租户是否被证明」的判定,
  而它 `:1224` **默认 no-op**——只有 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`
  (`:1317-1319`)才生效。

所以:如果让 facade 用 `options.tenantId` 去解锁 `tenant_shared`,在一个没开那个开关的部署上,
**请求头就能影响能读到哪个租户的共享源**——这是把已知的 x-tenant-id 问题放大到共享源上。

**但这说的是 `resolveTenantId` 这一条链,不是「插件侧拿不到已证租户」。**
同一文件里还有 `resolveVerifiedClaimTenantId`(`:1139-1159`):它只读 `req.authenticatedTenantId`,
claimless 直接 403,**不受 W4 开关影响**,`:6833` / `:6867` 两条路由已经在用。
插件侧因此有一条现成的、与开关无关的已证租户读法——§5.6 的逐段放宽正是建立在它上面,
而**不是**建立在 `resolveTenantId` 上。

**裁决(实读复核后收窄):有部署前置的不是整条管道运行腿,而是它里面拿不到 `req` 的那一段。**
HTTP 发起的 run / dry-run 有 `req`,可以直接取 `req.authenticatedTenantId`(§5.6);
定时、跨插件(`index.cjs:245-256`)、后台大 BOM 作业没有 `req`,它们的 `tenantId` 是调用方自报
(`pipeline-runner.cjs:389` 原样使用),必须先有一条不可伪造的来源才谈得上放宽。
两条可选前置(W4 开关,或治理路由服务端盖 server-only 标记 + 跨插件门剥除)与验收写在 §7 的 PR-9;
两条都没有时保持 owner-only。

**上一版在这里写的「第一段(核心侧,可以马上做)……能建绑定」是错的**——绑定本身就过插件 resolver,
实读与订正见 §5.3(b) 与 §5.4。共享的收益按段落地,分段清单在 §5.6,刀序与每刀的可验证陈述在 §7。

**我没能判断的**:222 上 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 当前是什么值。
本 worktree 里读不到部署环境变量,未上机查,不推测。

---

## 5. 绑定 → resolver → adapter → facade → 实际读取:整条路径的实读

**为什么补这一节。** 上一版把共享的接线点只写到 `resolveRegistration`,又说「第一阶段核心侧即可建绑定」。
两句都经不起实读:实际读取还在 facade 另一处裸属主门上;绑定本身就穿过插件 resolver。
本节把整条路径逐段列出——每段标明**闸在哪、闸判定谁的身份、这个身份从哪来**——
再逐段论证放宽怎么做才不是「机械放宽全部访问检查」。§5.4 是对本文上一版的自我订正。

### 5.1 先分清三类门:只有一类是本设计要动的

一次「顾问用同事共享的源」不是一次 `assertAccess`,是三类门的串联:

| 门类 | 判定什么 | 本基线出现在 | 本设计动不动 |
|---|---|---|---|
| **属主门** | 调用方身份是否 `=== scope.ownerId`(或 platformAdmin) | `DataSourceManager.assertAccess:593-603`;`packages/core-backend/src` 下 17 个调用点(§0.4a) | **只动这一类** |
| **租户门** | 两个租户值是否相等(源的 / 绑定行的 / 执行上下文的) | `facade:517`、`connection-resolver.cjs:118-124`、`:77-87` | 不动,且新分支要**再加**一道 |
| **形态门** | 源是否只读、连接类型是否在白名单、连接器 kind 是否匹配 | `facade:548-554`、`connection-resolver.cjs:126-131`、`http-routes.cjs:4502-4507`、`stock-preparation-source-binding.cjs:133-152` | 一个都不动 |

### 5.2 路径逐段表(本基线实读)

| 段 | 触发面 | 代码路径(file:line) | 这一段的属主门 | 门检查谁的身份 | 身份从哪来 |
|---|---|---|---|---|---|
| **A 建源** | 连接管理面板新建 | `routes/data-sources.ts:463` → `:495` `addDataSource(config, { ownerId, tenantId, scopeKind:'private' })` | 无(属主在此产生) | — | `ownerId` = `resolveUserId(req)`;`tenantId` = `resolveAuthenticatedTenantId(req)`(`:246-249`,只读 `req.authenticatedTenantId`) |
| **B1 建绑定·规范连接** | 数据工厂新建「只读 SQL 桥接」 | 路由表 `http-routes.cjs:25` → 处理器 `:4740`(`:4742` `requireAccess('write')`、`:4746` `principal: requestPrincipal(req)` + `runAs:'user'`、`:4757` `scopedAuthenticatedWriteInput`)→ `external-systems.cjs:521 upsertExternalSystem` → 新建腿 `:624` / 改绑腿 `:583` `validateCanonicalConnectionBinding`(`:493-517`)→ `connection-resolver.cjs:166 resolveCanonical` → `:172 facade.resolveConnectionRegistration` → `facade:580` → `resolveRegistration:491` | **`facade:508 assertAccess(裸串)`** | 发请求的人 | `requestPrincipal(req)`(`http-routes.cjs:883-886`,`user.id` 取不到再取 `user.email`) |
| **B2 建绑定·legacy 指针** | 旧形态 `config.dataSourceId` | `external-systems.cjs:332 withValidatedDataSourceBinding` → `:360 dataSourceBinder.assertReferenceable` → `facade:617 assertReferenceable` | **`facade:624 assertAccess(裸串)`** | 同上 | 同上;通过后 `:373` 服务端盖 `config.dataSourceOwnerId` |
| **B3 备料选源绑定** | 备料工作台「选源」 | 路由表 `http-routes.cjs:214-215` → GET `:7870` / POST `:7965`(两腿都 `requireAccess('admin')`)→ `:7903` / `:8017` `resolveDataSourceAccessibility`(`:4545-4566`)→ `:4559 directory.describe(dataSourceId, principal)` → `facade:589 describe` | **`facade:605 assertAccess(裸串)`** | 发请求的管理员 | `requestPrincipal(req)`;拒绝落到 `:4562` 的 `catch` → `false` → `stock-preparation-source-binding.cjs:151 'data_source_not_accessible'` → `:166 assertBindableSource` 422 `SOURCE_BINDING_SOURCE_INELIGIBLE`(GET 腿则在 `:235` 直接把候选滤掉) |
| **C adapter 装载** | 上面每一次读之前 | 备料:`http-routes.cjs:4465 loadTableActionSourceAdapter` → `:4492 resolveTableActionReadPrincipal`(`:4357-4369`)→ `:4498 loadSystem(scopedAdapterInput(...))`(`:1263-1270`,`runAs:'user'`)→ `:4522 createAdapter`;通用:`:5250 externalSystemObjects` / `:5270 externalSystemSchema` / `:4772 externalSystemsTest` 同一形状 → `external-systems.cjs:736 getExternalSystemForAdapter` → `:754 connectionResolver.resolve` | **`facade:508 assertAccess(裸串)`**(第一道)+ 租户门 `facade:517`、`connection-resolver.cjs:118-124`、`:77-87` | 备料一线拉取动作:**绑定属主**(`config.dataSourceOwnerId`,`http-routes.cjs:4366-4369`);其余:请求用户 | 服务端盖的戳(`external-systems.cjs:373` / `:439-447`),或 `requestPrincipal(req)`;`createAdapter` 本身不判权,只把 principal 装进闭包(`data-source-sql-readonly-source-adapter.cjs:693-694`) |
| **D 实际读取·插件侧** | 数据工厂看对象/字段、备料 dry-run/apply、管道读 | `data-source-sql-readonly-source-adapter.cjs:557` 的四个方法:`:573 api.test`、`:585 api.getSchema`、`:595 api.getTableInfo`、`:625 api.select`;`api` = `context.api.dataSources`(核心只注入给 `plugin-integration-core`,`packages/core-backend/src/index.ts:2400-2404`) | **`facade:529 authorize` → `:540 assertAccess(裸串)`**(第二道) | 闭包里的 principal(同 C 段) | 同 C 段。**这一段没有任何租户判定**:`authorize(dataSourceId, principal, strict)` 的签名与函数体(`:529-575`)都不读 `scope` |
| **E 实际读取·核心侧** | 连接管理面板自己的库表结构 / 取样 | `apps/web/src/data-sources/api.ts:143`(schema)/`:163`(tables)/`:179`(select)→ `routes/data-sources.ts:1203/:1207`、`:1257/:1261`、`:1143/:1158`;裸 SQL `/query :1037/:1055` | **`assertAccess(resolveUserId(req))` 裸串** | 发请求的人 | `resolveUserId(req)`;`:1051-1054` 的注释写明数据面故意无管理员旁路 |
| **F 管道运行时** | 管道 run / dry-run / 死信重放 / 跨插件 | `pipeline-runner.cjs:389 tenantId = input.tenantId` → `:408 connectionRunAs` → `:413`/`:420 loadExternalSystemForAdapter({ principal: pipeline.createdBy })`(走 C 段的门)→ `:520`/`:526 createAdapter({ principal: pipeline.createdBy })`(读时走 D 段的门) | C 段 + D 段两道,都是裸串 | `pipeline.createdBy` | 服务端盖(`http-routes.cjs:5314`),`pipelines.cjs:518-523` 写一次不可改;`input.tenantId` 则来自路由 `scopedInput` 或跨插件调用方**自报**(`index.cjs:245-256` 的 `runPipeline` 只强制 `runAs:'service'`,不校验 tenantId) |
| **G 旁路两处** | 不在共享范围,但改 `assertAccess` 会波及 | `routes/plm-workbench.ts:759-783 getOwnedDataSource`(裸串,`:782`);写腿 `facade:826-834`(裸串,`:834`) | 裸串属主门 | 请求用户 / 写腿 principal | 本设计**不放宽这两处**(§5.6) |

**一句话读法**:一次插件侧的真实读取要穿过**两道**裸串属主门(C 段 `facade:508`、D 段 `facade:540`),
而建绑定也要穿过其中一道(B1 走 `:508`、B2 走 `:624`、B3 走 `:605`)。
核心侧的读取只有一道(E 段)。

**表外还有一条腿,登记在此免得把上表当成穷举**:密封快照(sealed snapshot)。
`external-systems.cjs:782 getExternalSystemForSealedSnapshot` → `:804 connectionResolver.resolveSealedSqlServer`
→ `connection-resolver.cjs:291` → 核心的 `createDataSourceSealedSnapshotConnectionFacade`
(`data-source-plugin-facade.ts:793`,装配在 `packages/core-backend/src/index.ts:3148`)→ `:800` 转调
`resolveConnectionRegistration` → **同一个 `facade:508`**。它 `:799` 还强制 `runAs === 'user'`。
本设计**不单独为它接线**:它复用 C 段那道门,PR-7 放宽 `:508` 之后它会**一并**接受 `tenant_shared`,
所以 PR-7 的验收里要显式加一条密封快照用例,别让它成为无人测试的搭车者。

### 5.3 审阅人两句的实读结论

**(a)「PR-7 只点名 resolveRegistration,后续 read facade 的 authorize() 仍执行裸 owner 检查」——成立。**

`resolveRegistration`(`facade:491-527`)与 `authorize`(`facade:529-575`)是**两个独立函数,各自调一次 `assertAccess`**
(`:508` 与 `:540`),一处的放行不会传递到另一处。只放宽 `:508` 的后果可以逐步复现:

1. 顾问 B(非属主、同租户)在数据工厂打开一个绑向共享源的外接系统;
2. `externalSystemObjects`(`http-routes.cjs:5250`)先 `loadSystem`(`:5255`)→ resolver → `facade:508`:**放行**(已放宽);
3. 同一处理器 `:5256 createAdapter` → `adapter.listObjects()`(`data-source-sql-readonly-source-adapter.cjs:583-587`)→ `api.getSchema` → `facade:636` → `authorize:529` → `:540 assertAccess(裸串 B)`:**抛出统一 not found**;
4. `facade:512`/`:543` 把它包成 `DataSourceUnavailableError`,插件映射成 4xx。

现象就是审阅人说的那种:**连接解析过了、一读就被拒**。备料 dry-run(`loadTableActionSourceAdapter` → adapter `read()` → `api.select`)、
管道运行(F 段)同理——它的两道门就是 C 段与 D 段这两处。所以「共享只接 registration」只接通了半条路。

**(b)「第一阶段核心侧即可建绑定不成立,绑定本身就经过插件 resolver」——成立,而且比原话更广。**

「建绑定」在本仓有三条腿,**三条都在插件里,三条都过 facade**:B1 `:508`、B2 `:624`、B3 `:605`(见 §5.2)。
核心侧 `routes/data-sources.ts` 里没有创建绑定的路由。排除 `node_modules` 与测试后实读:
`assertReferenceable` 的生产调用点只有 `external-systems.cjs:360` 一处;
`resolveConnectionRegistration` 的插件侧调用点只有 `connection-resolver.cjs:172`(canonical)与 `:235`(legacy)两处,
另有一处在核心内部——`facade:800`,密封快照 facade 自己转调(见 §5.2 表下的注)。

顺带订正一个更基础的用词:**「数据工厂」这块屏幕本身也不是核心侧**。
它的选源/看对象/看字段走的是插件路由(`apps/web/src/services/integration/workbench.ts:1071`/`:1085`/`:1099`),
真正走核心路由的只有「连接管理」面板自己的库表结构与取样(`apps/web/src/data-sources/api.ts:143`/`:163`/`:179`)。
所以「核心侧可以马上做」能兑现的范围,比上一版写的小得多——只有 E 段和列表。

### 5.4 本文上一版的五处自我订正(实读为准)

1. **`facade` 的 `assertAccess` 行号是 `:508`,不是 `:506`。** `:506` 是 `let adapter`。
   受影响的三处已就地改正(§0.3 表、§4.2、§7 的刀)。`:500` 读 `runAs`、三道再收紧在 `:517`/`:520`/`:523`,这两处原文正确。
2. **§4.5 的「第一段(核心侧,可以马上做):……能建绑定」删除。** 理由见 §5.3(b)。
   该段已改写成「核心侧能兑现的是 E 段 + 列表,绑定属于插件侧」。
3. **§0.2 订正 1 上一版写 `:597`,实读是 `:599`,已就地改正。** `DataSourceManager.ts:598` 是
   `normalizeActor(actor)`,`:599` 是 `if (platformAdmin === true) return`,`:600` 是属主等值(原文正确)。
   「属主等值 或 平台管理员」这个结论不变,只是行号。
4. **上一版三处写的 `pipelines.cjs:518-521`,实读是 `:518-523`,已就地改正。**
   `created_by: normalized.createdBy` 在 `:522`,insert 分支块是 `:519-523`。
   「update 分支不带该键、仓库里没有管道转交路径」这个结论不变。
5. **§0.4(a) 的「第 18 个调用点」把定义行数进去了。** `packages/core-backend/src` 下 `assertAccess` 的
   **调用点是 17 个**,第 18 行是 `DataSourceManager.ts:593` 的定义。已在 §0.4(a) 就地列全这 17 处,
   「plm-workbench 那处要算进爆炸半径」这个结论不变。

### 5.5 三种「机械放宽」会出什么事(每条都可实读)

1. **把 `authorize()` 的属主门直接去掉、或只留 `scopeKind === 'tenant_shared'` 判定。**
   `authorize` 今天**零租户维度**(`:529-575` 不读 `scope`,签名里也没有租户),
   去掉属主门等于让凡是拿到 `dataSourceId` 的调用者都能读到与自己无关的租户的共享源;
   而 `index.cjs:245-256` 的跨插件 `runPipeline` 是一条**没有人类主体**的现成入口(它只强制 `runAs:'service'`)。
   → 所以给 `authorize` 放宽时**必须同时引入租户等值**,这是它今天没有的一道门,不是放宽而是补齐。
2. **拿插件侧的 `resolveTenantId` 当放宽依据。** `http-routes.cjs:1028-1052`:`:1030` 取值顺序请求体优先,
   `:1045-1049` 的注释自认 claimless 部署上是 header-against-header,
   `:1050` 的 `assertVerifiedTenantClaim`(`:1221-1246`)`:1224` 默认 no-op。
   → 用它解锁 `tenant_shared`,等于把 x-tenant-id 洞放大到共享源上。
3. **只放宽绑定段、不放宽读取段(或反过来)。**
   前者造出「保存成功、每次读都失败」的行——`stock-preparation-source-binding.cjs:118-131` 把这种
   accepted-yet-unreadable 明确点名为「这个功能存在就是为了消除的脚枪」;
   后者就是本次审阅抓到的那条。**两段必须在同一波里成对接线,且读取段先合**(§7 的刀序)。

### 5.6 逐段放宽判定(每段单独论证,统一谓词 + 统一降级)

**统一谓词**(`assertAccess` 的第三分支,`DataSourceManager.ts:593-603` 内):

> 放行 = `ownerId === userId` **或** `platformAdmin === true` **或**
> (`scopeKind === 'tenant_shared'` **且** `scope.tenantId !== null` **且** `scope.tenantId === 已证租户`)

**三条不可协商的口径:**

- **「已证租户」只有一个来源**:`req.authenticatedTenantId`。核心侧口径见 `routes/data-sources.ts:241-249`;
  插件侧已有同样口径的现成读法 `http-routes.cjs:1139-1146 resolveVerifiedClaimTenantId`(**不受 W4 开关影响**,
  已被 `:6833`/`:6867` 两条路由使用)。**永不**取 `user.tenantId` / `x-tenant-id` / body / query / params。
- **拿不到已证租户 = 不进第三分支 = 今天的行为**(owner-only)。这是**降级**,不是放行;
  claimless 部署因此一个字节都不变,也不会被本设计逼着开 W4 开关。
- **数据面 actor 对象由唯一构造器产出 `{ userId, tenantId }`,永不置 `platformAdmin`**;
  管理面继续用 `resolveActor`(`routes/data-sources.ts:267-275`),**该函数一个字节不改**。

**为什么 `resolveActor` 必须一个字节不改(这是最容易踩的一脚)**:它同时喂着
`:425`(GET 详情)、`:631`(改连接串)、`:742`(轮换)、`:825`(删除)、`:903`/`:955`(连/断)、`:994`(test)。
一旦给它加上 `tenantId`,`assertAccess` 的第三分支会**顺带**让同租户里持 `data_sources:write` / `rotate` 的人
**改/删/轮换**别人的共享源——
一次「让列表多看见一行」的改动会变成一次写权限放宽。
→ 列表可见性改用 `listDataSources` / `healthCheck` 的**独立可选字段**(只被 `scopePermitsListing:1246-1252` 读),
不经 `resolveActor`。变异探针:把 `tenantId` 塞进 `resolveActor`,「非属主不能改/删/轮换共享源」用例必须红。

**逐段结论:**

| 段 | 放不放宽 | 放宽判定 / 已证租户从哪来 | 拿不到已证租户时 | 不放宽的后果 |
|---|---|---|---|---|
| A 建源 | 不需要 | — | — | 无 |
| **列表可见性**(`:336`/`:348` → `scopePermitsListing:1246-1252`) | **放宽** | 统一谓词;已证租户 = `req.authenticatedTenantId`,经 `listDataSources` 新可选字段传入,**不经 `resolveActor`** | 只看见自己的(今天行为) | 顾问在面板里看不到共享源,后面每一步都无从开始 |
| **E 核心读取**(`:1158`/`:1207`/`:1261`) | **放宽** | 统一谓词;已证租户同上,经数据面 actor 对象传入 | 裸串 → owner-only | 顾问看得见源但列不出表、取不到样 |
| E' 核心 read 面(`:425` GET 详情、`:994` test)与 `/query :1055` | **不放宽** | — | — | 刻意:`:437` 经 `sanitizeConfig` 会回 `connection`(主机/端口/库名,§3.4 残余面 A),`:994` 回未脱主机的驱动原文;`/query` 是裸 SQL |
| **C adapter 装载**(`facade:508`) | **放宽** | 统一谓词;已证租户由插件路由从 `req.authenticatedTenantId` 取出,**显式**经 `scopedAdapterInput`(`http-routes.cjs:1263-1270`)→ `getExternalSystemForAdapter`(`external-systems.cjs:736`)→ `connectionResolver.resolve`(`connection-resolver.cjs:172`)传下去;`options.tenantId` 这一路**仍按现状只做租户等值**(`facade:517`),不被复用为放宽依据 | 不传 = 裸串 = owner-only | 规范绑定在连接解析处就 400,后面的读根本不会发生 |
| **D 插件读取**(`facade:540`) | **放宽** | 统一谓词 **+ 新增租户等值**(`scope.tenantId === 已证租户`,这是 `authorize` 今天没有的一道);已证租户由 adapter 闭包携带(`data-source-sql-readonly-source-adapter.cjs:557`/`:693-694`),由插件路由填,来源同上 | 不传 = 裸串 = owner-only | **这就是审阅人抓到的那条**:连接过了、一读就 404 |
| **B1/B2/B3 建绑定**(`facade:508` / `:624` / `:605`) | **放宽** | 统一谓词;已证租户来源同 C 段;B3 的两腿(`:7903`/`:8017`)把它传进 `resolveDataSourceAccessibility`(`:4545-4566`)→ `describe` | 不传 = 裸串 = owner-only,`dataSourceAccessible` 仍是 `false`(**不是** `undefined`——`undefined` 是「问题不适用」,不能拿它当放宽) | 顾问选不到、建不成绑定 |
| **F 管道运行时**(无 `req` 的那一腿) | **有前置才放宽** | 已证租户必须有一个不可伪造的来源。两条可选前置:(i) `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`(`http-routes.cjs:1317-1319`),或 (ii) 由治理 HTTP 路由服务端盖一个 server-only 标记并在跨插件门剥除——形状照抄 `index.cjs:164-173 withoutServerOnlyRunMarkers` | 两条都没有 = owner-only | 顾问能建管道、能 dry-run(有 `req`),但定时/跨插件/后台作业跑不通 |
| G `plm-workbench.ts:782` | **不放宽** | — | — | 刻意:该文件 `:766-779` 的注释自己说了「若 PLM 流程确实需要组织共享源,该放宽属于数据源可见性模型」——本设计给出模型,但接线是它自己的一刀 |
| G' 写腿 `facade:834` | **不放宽** | — | — | 刻意:共享的语义是「你能用这个连接读」,不是「你能用它写」(§8 第 11 条) |

---

## 6. 决策五:离职 / 收回语义

### 6.1 `directory/*.ts` 零联动意味着什么

- 16 个文件 grep `data_source` / `dataSource` **零命中**。
- 离职计划器的效果类型只有三种:`deprovision-planner.ts:8`
  `'membership_changed' | 'grant_changed' | 'user_changed'`。**没有「他名下的资产」这一类**。
- 最激进的策略 `mark_inactive`(`deprovision-planner.ts:11-13` 的策略枚举)也只翻用户行。
- 而 `assertAccess:600` 是 `scope.ownerId !== userId` 的**纯字符串比较**,从不查这个 id 对应的用户
  是否还在职;`scopes` Map 又是启动时从 DB 灌进来的(`:310-316`),连「用户表变了」这件事都收不到。

**合起来的结论:A 离职之后,`data_sources.owner_id` 仍是 A,管道 `created_by` 仍是 A,
管道照跑,属主校验照过。** 我实读过的这三处——`assertAccess:593-603`、`scopes` 的三个写入点
(`:310-316` / `:484-488` / `:565-568`)、离职效果类型(`deprovision-planner.ts:8`)——
没有一处会注意到 A 已经走了。也就是说,「收回」在这条链上没有落点。

### 6.2 孤儿化 / 转交 / 冻结 —— 最小可行的第一刀

**都不做。第一刀 = 只读可见性。**

- **冻结**(离职即拒)会在没有预警的情况下打断生产管道。备料这条线上,实施工程师建的源正是
  一线每天在用的东西;把它在某人办离职当天掐掉,是把一个治理缺口换成一次生产事故。
- **转交**需要先回答「转交给谁」。那是 owner 裁决,不是设计能替他定的。而且管道那侧
  `created_by` 在 upsert 路径上不可改(`pipelines.cjs:518-523`),转交要同时改两张表两个概念,
  不是一刀的体量。
- **孤儿化**(owner_id 置 null)会让 `assertAccess` 对谁都不成立,等价于冻结。

**第一刀的具体形状:**

| 项 | 具体物 |
|---|---|
| 后端 | `GET /api/data-sources`(`:336`)每项加 `ownerActive?: boolean`——按 `owner_id` 批量查 `users.is_active`,一次 `IN` 查询,失败时**省略该键**(照抄 #5593 `referenceCount` 的「undefined 不是 false」口径) |
| 前端 | #5587 的 `DataSourcesPanel.vue` 在属主列旁显示「属主已停用」徽标 |
| 报表 | 一条只读查询 / 管理端页面:列出 `owner_id` 指向非活跃用户的源,以及引用它们的绑定数(复用 #5593 的 `countExternalSystemReferencesByIds`) |
| 写入 | **零**。不改 owner_id,不改 scope_kind,不拒任何请求 |

这一刀把「看不见」变成「看得见」,并且不会造成生产中断,因此可以独立上线、独立回滚。
转交路由 `PUT /api/data-sources/:id/owner` 是第二刀,不在本设计范围内。

---

## 7. 切 PR:每一刀放宽路径上的哪一段

标准:每刀自己可上线、可回滚;**每刀只放宽 §5.2 表里的一段或一组同类段**,并写清
「合完之后共享源能走通到哪一步」——这句是可验证陈述,不是进度描述。

**共用夹具(所有端到端验收都用它)**:同租户两个人 A、B,**token 带已证租户声明**;
A 建源 `S`(只读账号)、A 建外接系统 `X` 绑 `S`(canonical `connectionId`)、A 把 `S` 置 `tenant_shared`;
`X` 这一行本来就对同租户可见——`external-systems.cjs:988 listExternalSystems` 与 `:679 selectScopedRow`
都只按 `scopeWhere`(`:137`,租户 + workspace)取行,不按属主过滤,
所以 B 今天就能在数据工厂里**看见** `X`,只是一点开就报连接不可用。**共享要修的正是这个「看得见、点不开」**。

| # | 放宽的段 | 依赖 | 合完后共享源走通到 |
|---|---|---|---|
| PR-1 | 无(只拆动词) | — | 不变 |
| PR-2 | 无(只改判定函数与值域) | — | 不变(零调用点传已证租户) |
| PR-3 | 无(只造值) | PR-1、PR-2 | 源能被标成 `tenant_shared`,读取仍全拒 |
| PR-4 | 列表可见性 + E 段 | PR-2、PR-3 | B 在连接管理面板看见 `S`、能列库表、能取样 |
| PR-5 | 无(前端) | PR-3、PR-4 | 同上,加上界面能表达 |
| PR-6 | 无(离职只读可见性) | — | 不变 |
| PR-7 | C 段 + D 段 | PR-2、PR-3 | B 在数据工厂打开 `X`:能看对象、看字段、跑 dry-run |
| PR-8 | B1/B2/B3 三条绑定腿 | **PR-7**(刀序硬约束) | B 能自己建绑向 `S` 的外接系统,能在备料选源里选中它 |
| PR-9 | F 段(无 `req` 的运行腿) | PR-7 + 一条部署前置 | B 的管道在定时/跨插件/后台作业里也能跑 |

**刀序硬约束(PR-7 必须先于 PR-8)**:先放宽绑定、后放宽读取,会在中间窗口里造出
「保存成功、每次读都失败」的绑定行——`stock-preparation-source-binding.cjs:118-131` 把这种
accepted-yet-unreadable 明确点名为这个功能本身要消除的脚枪。反过来先放宽读取,
中间窗口里只是「还建不了新绑定」,没有任何行会处于坏状态。

---

### PR-1 动词拆分与轮换独占(不碰路径上任何一段)

**放宽的段**:无。三个新码只种不发(`permissions` 多三行),`:716` 的门从 `write` 改 `rotate` 独占是**收紧**。

**其它段的后果**:零。属主门一处不动。

**合完后**:共享源走不通任何一步——这一刀与共享无关,它的价值是把「换口令」从「改指向」的同一把钥匙下摘出来(§2.1)。

**验收**:① 空库跑两遍幂等;② `down()` 能回滚;③ **上机前置**:只读查 `role_permissions` / `user_permissions`
里 `permission_code = 'data_sources:write'` 的行数为 0,不为 0 则先经角色补 `data_sources:rotate`(备料那条教训:
直接给 `user_permissions` 会被命名空间过滤成 403,必须经角色);④ 平台管理员轮换路径不变(`rbac.ts:69-72` 短路)。

**变异**:把 `:716` 的门改回 `write`,「rotate 独占」用例必须红。

---

### PR-2 判定函数与值域(核心单点,当天零段生效)

**放宽的段**:无——这一刀改的是**判定函数本身**,不是任何调用点。

- 迁移把 `scope_kind` 的 CHECK 放开第四值 `tenant_shared`(不 UPDATE 任何行,不改列默认值);
- `DATA_SOURCE_SCOPE_KINDS`(`DataSourceManager.ts:208`)加值;
- `DataSourceActorContext`(`:51-54`)加 `tenantId?: string`;
- `assertAccess`(`:593-603`)加 §5.6 的统一谓词第三分支;`scopePermitsListing`(`:1246-1252`)加对应分支 + 新可选字段;
- **裸字符串 actor 与不带 `tenantId` 的 actor 对象都进不了新分支**(这条是 §4.4 的裁决,不变)。

**其它段的后果**:18 个调用点当天全部保持今天的行为,因为**没有任何调用点传 `tenantId`**。

**合完后**:共享源还不存在(没有写入口),读取路径逐字节不变。这是可验证陈述:见验收①。

**端到端验收**:① 全套现有 `data-source-scope.test.ts` / `data-source-visibility-authority-matrix.test.ts`
零修改通过(证明「当天零段生效」);② 新增:手工构造 `scopeKind:'tenant_shared'` 的源,
裸串 actor、`{userId}` actor、`{userId, platformAdmin:false}` actor 三种形态**都** 404;
只有 `{userId, tenantId: 源的租户}` 放行;③ `tenantId: null` 的源即使标 `tenant_shared` 也不放行;
④ 迁移 `down()` 能收回 CHECK(前置:库里无 `tenant_shared` 行)。

**变异**:去掉「裸串不进第三分支」那一行 → ② 的裸串用例必须红;
去掉 `scope.tenantId !== null` 那一条 → ③ 必须红。

---

### PR-3 写入口 `PUT /api/data-sources/:id/scope`(只造值,不放宽任何门)

粗门 `data_sources:share`;细门 `assertAccess(id, resolveActor(req))`——**属主本人或平台管理员**,
与今天的管理面一致(这一刀**不**用新谓词,共享的授权动作本身仍是 owner-only)。
硬前置 `scope.tenantId !== null`(§1.3)。写 DB **且**同步 `scopes` Map(§0.4c:该 Map 没有失效通道)。
审计 `action:'update_scope'`。列表 / 详情投影加 `scopeKind`。

**其它段的后果**:所有读取段仍 owner-only,所以这一刀**只会造出一个还没人能用的标记**。

**合完后**:`S` 能被标成 `tenant_shared`;B 仍然看不见它、读不到它。这是验收③。

**端到端验收**:① 非属主非管理员置位 → 404(不是 403,与既有不泄露存在性一致);
② tenantless 源置位 → 拒绝并给码;③ 置位后 B 调 `GET /api/data-sources` **仍看不到** `S`(PR-4 才放开),
调 `GET /:id`、`/schema` 全 404;④ 重启进程后作用域仍生效(证明 DB 与 Map 都写了);
⑤ 列表投影里 `scopeKind` 对属主可见。

**变异**:去掉 tenantless 前置 → ② 必须红;只写 DB 不写 Map → ④ 必须红(不重启也能看出:置位后同进程内 `getScope` 应立刻返回新值)。

---

### PR-4 列表可见性 + E 段核心读取

**放宽的段**:列表可见性(`routes/data-sources.ts:336`/`:348` → `scopePermitsListing:1246-1252`)
与 E 段三条数据面路由(`/select :1158`、`/schema :1207`、`/tables/:table :1261`)。

**放宽判定**:§5.6 统一谓词。已证租户 = `req.authenticatedTenantId`(`:246-249`);
列表经 `listDataSources` 的**新可选字段**传入,E 段经**数据面 actor 构造器**传入。
**`resolveActor` 一个字节不改**(§5.6 的那一脚)。
粗门同步从 `rbacGuard('data_sources','read')` 改成 `rbacGuardAny(['data_sources:use','data_sources:read'])`
(`rbac/rbac.ts:119` 已有该工厂)——对既有持有者既不收紧也不放宽。

**其它段保持 owner-only 的后果**:B 能在面板里看见并浏览 `S`,但
① `GET /:id`(`:425`)、`GET /:id/test`(`:994`)仍 404——刻意,它们会回主机端口与驱动原文(§3.4);
② `/query`(`:1055`)仍 404——裸 SQL 不在 use 面;
③ 数据工厂里点开 `X` 仍报连接不可用(C/D 段没接)。

**合完后**:B 在**连接管理面板**里看得见 `S`、能列出库表、能取一页样本;
在**数据工厂**里仍然点不开 `X`。

**端到端验收**(从绑定到真读到数据):
① A 建 `S` + 置 `tenant_shared` → B `GET /api/data-sources` 列表里出现 `S`(且带 `scopeKind`);
② B `GET /api/data-sources/{S}/schema` → 200,表名非空;
③ B `POST /api/data-sources/{S}/select {table, limit:1}` → 200,**取到真实行**;
④ B `GET /api/data-sources/{S}` → 404;`GET /{S}/test` → 404;`POST /{S}/query` → 404;
⑤ `S` 若是 `private`,①②③ 全 404;
⑥ 跨租户的 C(另一个租户,同样持 `use` 码)对 ①②③ 全 404;
⑦ B 的 token **无租户声明**(claimless)时 ①②③ 全 404——且错误与今天逐字一致(降级,不是新错误)。

**变异**:
(a) 把已证租户换成 `req.user.tenantId` → ⑦ 必须红;
(b) 把 `tenantId` 加进 `resolveActor` → 新增用例「B 不能 `PUT /{S}`、不能 `DELETE /{S}`、不能轮换 `{S}` 凭据」必须红;
(c) 去掉列表新字段、改走 `resolveActor` → 同 (b);
(d) 把 `GET /:id` 也改成新谓词 → ④ 必须红。

---

### PR-5 前端(#5587 面板)

`DataSourcesPanel.vue` 加「作用域」列 + 共享开关(无 `share` 码时不可见/禁用);
`IntegrationWorkbenchView.vue` 的选源下拉标注「他人共享」。

**放宽的段**:无。

**合完后**:走通范围与 PR-4 相同,只是界面能表达它。

**验收**:① 无 `share` 码时开关不可见/禁用;② 共享源在选源列表可选,但「查看配置」不出主机端口;
③ 前端单测覆盖 `private` / `tenant_shared` / `legacy_private` 三种渲染。

---

### PR-6 离职只读可见性(与共享正交,可并行)

`GET /api/data-sources`(`:336`)每项加 `ownerActive?: boolean`;失败时**省略该键**;前端徽标;报表。

**放宽的段**:无,零写入。

**合完后**:与共享无关;它回答的是「这个源的属主还在不在职」(§6.1)。

**验收**:① 零写入;② 查询失败时该键省略而不是 `false`;③ 报表能列出属主非活跃的源与引用它们的绑定数。

**变异**:把省略改成 `false` → 「未知不是停用」用例必须红。

---

### PR-7 C 段 + D 段:插件侧读取(**这一刀是审阅人指出的缺口的正面修复**)

**放宽的段**:C 段 `facade:508`(`resolveRegistration`)**与** D 段 `facade:540`(`authorize`)——**必须同刀**。
只接 `:508` 就是被审阅人抓到的半条路;只接 `:540` 则连接在 C 段就已经解析失败,读根本不会发生。

**放宽判定**:§5.6 统一谓词。两处的已证租户都由插件路由从 `req.authenticatedTenantId` 取出,
**显式**沿 `scopedAdapterInput`(`http-routes.cjs:1263-1270`)→ `getExternalSystemForAdapter`(`external-systems.cjs:736`)
→ `connectionResolver.resolve`(`connection-resolver.cjs:172`)→ facade 传下去,
以及由 adapter 闭包(`data-source-sql-readonly-source-adapter.cjs:557`、`:693-694`)带到四个读方法。

**两条只在这一刀出现的额外要求:**

1. **`authorize` 要同时补上租户等值**。它今天零租户维度(`:529-575`),
   所以第三分支必须自带 `scope.tenantId === 已证租户`——这是补一道今天没有的门,不是放宽(§5.5 第 1 条)。
2. **`options.tenantId` 不得被复用为放宽依据**。C 段现有的 `facade:517` 租户等值读的是这个自报值,
   它继续只做**等值**;放宽只认新传进来的已证租户。两个值必须是两个参数,不能合并。

**其它段保持 owner-only 的后果**:B 还**建不了**新绑定(B 段没接)——所以这一刀只对
**A 已经建好的** `X` 生效。这正是它能独立上线的理由:不产生任何新行。

**合完后**:B 在数据工厂打开 `X` → 能列对象、能看字段、能跑 dry-run 并看到数据;
B 想自己建一个绑向 `S` 的新外接系统仍然 422/400。

**端到端验收**(从既有绑定到真读到数据):
① B `GET /api/integration/external-systems/{X}/objects` → 200,对象列表非空;
② B `GET /api/integration/external-systems/{X}/schema?object=...` → 200,字段非空;
③ B 触发一次读(备料 dry-run 或管道 dry-run,均为 HTTP 发起,有 `req`)→ **拿到真实行**;
④ `S` 改回 `private` → ①②③ 全部回到今天的拒绝(同样的错误码,不是新错误);
⑤ 跨租户 C → ①②③ 全拒;
⑥ B claimless token → ①②③ 全拒,且错误与今天逐字一致;
⑦ 直接构造一次**跨插件** `runPipeline`(`index.cjs:245-256`,无人类主体)指向 `S` → 仍拒(F 段未接,PR-9 才动)。
⑧ 密封快照腿(`external-systems.cjs:782` → `connection-resolver.cjs:291` → `facade:800` → `:508`)
   对 `tenant_shared` 的行为被显式断言一次——它搭 `:508` 的车,不能没人测。

**变异**:
(a) 只接 `:508`、不接 `:540` → ①②③ 必须红(**这条变异就是审阅人那句的回归钉**);
(b) 只接 `:540`、不接 `:508` → ①②③ 必须红;
(c) 去掉 `authorize` 新增的租户等值 → ⑤ 必须红;
(d) 把已证租户换成 `resolveTenantId(req, ...)` 的结果 → ⑥ 必须红;
(e) 去掉 adapter 闭包里的传递、让 facade 自己兜底取租户 → ⑥ 必须红。

---

### PR-8 B 段:三条绑定腿

**放宽的段**:B1 `facade:508`(PR-7 已接,这里只是复用)、B2 `facade:624`(`assertReferenceable`)、
B3 `facade:605`(`describe`)。插件侧对应改三处:`withValidatedDataSourceBinding`(`external-systems.cjs:332-374`)、
`validateCanonicalConnectionBinding`(`:493-517`)、`resolveDataSourceAccessibility`(`http-routes.cjs:4545-4566`)
各自把已证租户显式传下去。

**放宽判定**:§5.6 统一谓词,来源同 PR-7。

**一条必须点名的语义**:`resolveDataSourceAccessibility` 的三态
(`true` / `false` / 缺席)不能被这一刀搅浑。缺席的含义是「这个 kind 不带 core 源引用,或宿主没有这个 seam」
(`:4528-4544` 的注释),**不是**「未知即放行」;拿不到已证租户时结果仍是 `false`,不是缺席。
变异探针就钉在这里。

**其它段保持 owner-only 的后果**:写腿(`facade:834`)与 `plm-workbench.ts:782` 不动;
B 建出来的绑定仍然只能**读**。

**合完后**:B 能自己建一个绑向 `S` 的 `data-source:sql-readonly` 外接系统 `X2`,
建成后立刻能读(因为 PR-7 已经把 C/D 段接好了);B 也能在备料选源的下拉里看到并选中 `X`/`X2`。

**端到端验收**:
① B `POST /api/integration/external-systems` 建 `X2`(canonical `connectionId = S`)→ 201;
② `X2` 的 `config.dataSourceOwnerId` 被服务端盖成 **B**(`external-systems.cjs:634-639` 的 `proven:true` 腿),
   不是 A——共享不改属主归属,只改「谁能通过」;
③ B 立刻 `GET /api/integration/external-systems/{X2}/objects` → 200 有数据(证明绑定与读取是同一波接通的);
④ B `GET /api/integration/stock-preparation/source-binding` → `X`/`X2` 出现在 `eligibleSources`;
   `POST` 选中它 → 200,随后一次备料 dry-run 读到真实行;
⑤ `S` 是 `private` 时,①④ 回到今天的 422 `SOURCE_BINDING_SOURCE_INELIGIBLE` / 400,错误码不变;
⑥ 跨租户 C 建 `X2` → 拒;⑦ B claimless → 拒。

**变异**:
(a) 把 `dataSourceAccessible` 在「拿不到已证租户」时改成缺席(而不是 `false`)→ ⑤ 的备料腿必须红;
(b) 去掉 `:605` 的接线只接 `:624` → ④ 必须红(备料选源走 `describe`,不走 `assertReferenceable`);
(c) 去掉 `:624` 的接线只接 `:605` → legacy 指针绑定用例必须红;
(d) 让 `resolveCanonicalBindingOwner` 盖 A 而不是 B → ② 必须红。

---

### PR-9 F 段:无 `req` 的运行腿(有部署前置)

**放宽的段**:只有 F 段里**拿不到 `req`** 的那部分——定时/跨插件/后台大 BOM 作业。
HTTP 发起的 run / dry-run 在 PR-7 就已经走通(它们有 `req`)。

**前置(二选一,都没有则保持 owner-only)**:
(i) `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`(`http-routes.cjs:1317-1319`),
让 `resolveTenantId` 这条链上的租户变成已证;或
(ii) 由治理 HTTP 路由把 `req.authenticatedTenantId` **服务端盖**成一个 server-only 标记随运行输入下传,
并在跨插件门剥除——形状照抄 `index.cjs:164-173 withoutServerOnlyRunMarkers`(它已经在剥两个 Symbol 键)。

**为什么不能只靠 `input.tenantId`**:跨插件 `runPipeline`(`index.cjs:245-256`)只强制 `runAs:'service'`,
`tenantId` 是调用方自报;`pipeline-runner.cjs:389` 原样使用。

**其它段保持 owner-only 的后果**:没有前置时,B 的管道只能由 B 手工在页面上触发。

**合完后**:B 的管道在定时/后台作业里也能读到 `S`。

**端到端验收**:① 两条前置都没有时,后台作业对 `tenant_shared` 源保持 owner-only(**可证的降级**,
错误与今天一致);② 前置 (i) 或 (ii) 就位 + 同租户 → 放行并读到真实行;
③ 跨插件 `runPipeline` 自报一个别的租户 → 拒;④ 跨租户 → 拒。

**变异**:(a) 去掉前置判定 → ① 必须红;(b) 不剥 server-only 标记(方案 ii)→ ③ 必须红。

---

### 回归靶心(所有刀共用)

- `tests/unit/data-source-visibility-authority-matrix.test.ts:558` 的
  `poison sweep — credentials are write-only for EVERY tier, everywhere`:**新增 `tenant_shared` tier 必须进这个 sweep**。
- `tests/unit/data-source-scope.test.ts`:新谓词的真值表(含裸串 / 无 tenantId 对象 / tenantless 源三条负向)。
- `tests/unit/data-source-plugin-facade.test.ts`:`:508` 与 `:540` 两处**分别**的放行/拒绝矩阵——
  两处必须各有独立用例,否则 PR-7 的变异 (a)(b) 抓不住。
- `plugins/plugin-integration-core/__tests__/connection-resolver.test.cjs`:租户门不被新参数绕过。
- `plugins/plugin-integration-core/__tests__/data-source-sql-readonly-source-adapter.test.cjs`:闭包携带已证租户。
- `plugins/plugin-integration-core/__tests__/stock-preparation-source-binding-routes.test.cjs`:
  `dataSourceAccessible` 三态不被搅浑。

---

## 8. 不做什么(每条都给理由)

1. **跨租户共享。** `facade:515-518` 的租户等值是今天挡住跨租户读的地方之一;
   `routes/data-sources.ts:483-497` 的租户只从已证声明来。这两处是本设计的地基,不碰。
   「A 租户的源共享给 B 租户」不在任何一档里。
2. **外部用户 / 匿名共享 / 分享链接。** 所有判定都建立在 `req.user` + 已证租户上,
   没有主体就没有判定。不为它设计。
3. **行级 / 列级数据权限。** 源侧只读账号才是那条线的答案——`routes/data-sources.ts` 里
   `isReadOnlySql` 的注释自己说了:「Best-effort application-layer gate, NOT a sandbox ...
   The real read-only guarantee must come from connecting the data source with a read-only
   database account」。在应用层做行级过滤会制造一个不能证明的保证。
4. **`scope_kind = 'workspace'` 档。** `workspace_id` 生产上恒为 NULL(§0.2),
   插件侧 workspace 是未校验的自报值(`http-routes.cjs:1248-1250`)。保留 CHECK 里的这个值不删
   (删它要动存量 CHECK),但不写不读。
5. **服务主体 / 机器身份。** 理由见 §4.3(c)。
6. **凭据代持、借用、「帮你保管口令」。** 共享的语义是「你能用这个连接」,不是「你能拿到这把口令」。
   `sanitizeConfig` 那一层不开口子。
7. **`connection.password` 明文落库那条洞**(§3.4 残余面 B)。它是既有洞、不由本设计引入、
   随仓 UI 不触发;修它要同时动 schema 校验、加密范围与响应投影三处,是独立一刀。
   **单开一单,不塞进共享这条线。**
8. **管道转交 / `created_by` 可改。** 见 §6.2。
9. **改 RBAC 判定逻辑本身、动命名空间豁免名单。** #5611 的设计文档已经论证过:
   把 `data_sources` 加进 `NON_NAMESPACED_PERMISSION_RESOURCES`(`namespace-admission.ts:11-38`)
   等于让所有持有者绕过准入,是放宽。本设计的三个新码刻意与现有六码同前缀,复用同一个准入开关。
10. **存量 tenantless 源的补租户路径。** §1.4 说了这是缺口:重存不会自动补上 `tenant_id`
    (`DataSourceManager.ts:515-518` 在 options 无该键时保留旧值)。补它需要一条显式路径 +
    一个「凭什么认为这个源属于这个租户」的判定。**本设计不覆盖,登记为未解决项。**

11. **共享放开写。** `facade:826-834` 的写腿 `authorize`(`:834`)与 `routes/plm-workbench.ts:782`
    都保持 owner-only(§5.6 的 G / G' 行)。`tenant_shared` 的语义是「同租户可读用」,不含写,
    也不含 PLM 工作台那条旁路——后者要放宽是它自己的一刀(`plm-workbench.ts:766-779` 的注释已经预留了这句)。

---

## 9. 本文没能判断的

1. **222 上 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 的当前取值。** 决定 PR-9 的前置 (i) 能不能直接用
   (前置 (ii) 不依赖它)。worktree 里读不到部署环境,未上机查。
2. **客户库里 `data_sources:write` 今天是否真的零持有者。** #5611 的设计文档断言种子化后持有者为零,
   但那是对「迁移自己不发权」的断言,不是对「客户库里没人手写过」的断言。PR-1 的收紧安全性依赖这一条,
   已写成上机前置。
3. **`private` 与 `legacy_private` 在细门上是否应该继续同权。** 今天它们在 `assertAccess` 里
   走同一条路径(`:600` 只看 ownerId,不看 scopeKind);只有 facade `:520` 对二者区别对待
   (tenantless 时 `legacy_private` 放行、`private` 拒绝)。本设计保持这个不一致不动,
   因为改它会动存量行为,而我没有足够证据说明 facade 那处区分的完整意图。
4. **`referenceCount`(#5593)在共享之后的语义。** 它的 legacy 腿按
   `this.scopes.get(id)?.ownerId === config->>'dataSourceOwnerId'` 归属(P2-A 属主归因),
   共享源被他人绑定时那个戳会是谁,取决于绑定写入路径怎么盖 `dataSourceOwnerId`——
   那条路径不在本基线里(随 #5593 一起在飞),未读到,不判断。
5. **备料选源那两腿的权限档与共享档对不齐。** `stockPreparationSourceBindingGet` / `Set`
   (`http-routes.cjs:7871` / `:7966`)都是 `requireAccess(req, 'admin')` —— 整合 ADMIN 档。
   共享之后,一个持 `data_sources:use` 但不是整合管理员的顾问**仍然选不了源**。那是插件自己的权限模型,
   不是本设计能改的;要不要给备料选源另开一档,未与 owner 对齐,不擅自改。

6. **绑定属主代跑与 `tenant_shared` 的关系。** `resolveTableActionReadPrincipal`
   (`http-routes.cjs:4357-4369`)让一线拉取以**绑定属主**的身份去读,注释 `:4329-4333` 自陈
   「a first-class share on the data source would be a better long-term answer」。共享落地后代跑是否该退役,
   取决于 owner 对「谁的凭据在答、审计里记谁」的取舍——本文不裁决,只登记两者在解同一个问题。

7. **列表投影会带 `ownerId`**(`DataSourceManager.ts:1289`)。共享之后同租户他人会看到属主的用户 id。
   它是管理元数据(与 #5593 的 `referenceCount` 同级,不含 `connection`,所以不泄露主机端口),
   但要不要在「`tenant_shared` 且调用方非属主」时省略该键,是 owner 的取舍,不默认做。

8. **`updateDataSource` 在 `priorScope` 缺失时把 `scopeKind` 兜底成 `'private'`**
   (`DataSourceManager.ts:519`)。正常路径上 `priorScope` 总在(`adapters` 与 `scopes` 一起维护),
   所以这条兜底今天走不到;但我没有穷举出「adapters 有而 scopes 没有」是否真的不可能,
   因此不声称它是死代码,只登记为 PR-2 要加一条断言的地方。
