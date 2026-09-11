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
`DataSourceManager.ts:593-603` 有两层:`:597` 先对 `platformAdmin === true` 提前 `return`,
`:600` 才做属主等值。actor 有两种形态(`:38-50` 的类型注释写得很清楚):裸字符串 = 数据面,
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
| `runAs=service` 也过 `assertAccess`,无服务身份旁路 | `data-source-plugin-facade.ts:500` 读 `runAs`,`:506` 无条件 `assertAccess(principal)`;`runAs` 只在 `:523` 用于**再收紧** | 成立 |
| 管道运行主体固定为创建者 | `pipeline-runner.cjs:413`、`:420`(取外部系统)、`:520`、`:526`(建 adapter),一律 `principal: pipeline.createdBy` | 成立 |
| `directory/*.ts` grep `data_source` = 0 | 16 个文件零命中 | 成立 |

### 0.4 报告没提、但影响设计的三条

**(a) 第 18 个 `assertAccess` 调用点在插件之外**:`routes/plm-workbench.ts:782`。
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
  所以 PR-2 单独上线时新分支取不到值(这是 PR-2 的验收点,见第 6 节)。
- **存量 tenantless 源不能被共享**,这是刻意的:它们要先补上租户。而「重存一次」并不会自动补上——
  `updateDataSource` 在 options 没有 `tenantId` 键时保留 `priorScope?.tenantId`
  (`DataSourceManager.ts:515-518`)。补租户需要一条显式路径,**本设计不覆盖**(见第 7 节第 10 条)。

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
→ 本设计**不修**它(见第 7 节第 7 条),但它是「不要把 read 面共享出去」的又一条理由,并单开一单。

---

## 4. 决策四:运行主体(最难的一段)

### 4.1 今天的事实

| 事实 | 位置 |
|---|---|
| 管道以创建者身份读源 | `pipeline-runner.cjs:413`、`:420`(取外部系统)、`:520`、`:526`(建 source/target adapter),全部 `principal: pipeline.createdBy` |
| `createdBy` 由服务端盖,不信 body | `http-routes.cjs:5314`(以及 `:5352`、`:5384`)`createdBy: user && (user.id 或 user.email)` |
| `created_by` **写一次不可改** | `pipelines.cjs:518-521`:只有 insert 分支带 `created_by`;update 分支 `{ ...baseRow }` 不含该键。**仓库里没有管道转交路径** |
| C6 外部写以 `createdBy` 为属主锚 | `http-routes.cjs:5462`、`:5577`:`ownerPrincipal = firstString(pipeline.createdBy)`,为空直接 422 `C6_WRITE_OWNER_PRINCIPAL_REQUIRED` |

### 4.2 `runAs=service` 也过 `assertAccess` —— **是保护,不是障碍**

`data-source-plugin-facade.ts:493` 取 `principal`,`:500` 取 `runAs`,`:506` **无条件**
`assertAccess(dataSourceId, principal)`,`:515-524` 三道再收紧(租户不等 404、tenantless 非 legacy 404、
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
(而 `assertAccess:600` 是纯字符串比较,从不查这个人是否还在职——见第 5 节)。

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
  要放宽必须一处一处显式接线。
- **「已证租户」只认 `req.authenticatedTenantId`**,也就是 `routes/data-sources.ts:246-249` 的口径。

### 4.5 为什么管道运行腿**不在第一波**接线(本节最要紧的一句)

插件侧的租户**不是已证租户**。`http-routes.cjs:1028-1052` 的 `resolveTenantId`:

- `:1030` 取值顺序是 `input.tenantId`(**请求体优先**)→ query → params → `user.tenantId`;
- `:1036-1043` 要求非平台管理员的 `user.tenantId` 必须等于它;
- `:1045-1050` 的注释**自认**:`user.tenantId` 在 token 无租户声明时由认证中间件从
  `x-tenant-id` **请求头**填充,「so on a claimless deployment those comparisons can be
  **header against header**」;
- `:1050` 调的 `assertVerifiedTenantClaim`(`:1221-1246`)是 `resolveTenantId` 这条链上
  唯一一处去问「租户是否被证明」的判定,
  而它 `:1224` **默认 no-op**——只有 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`
  (`:1317-1319`)才生效。

所以:如果让 facade 用 `options.tenantId` 去解锁 `tenant_shared`,在一个没开那个开关的部署上,
**请求头就能影响能读到哪个租户的共享源**——这是把已知的 x-tenant-id 问题放大到共享源上。

**裁决:管道运行腿(facade `:506` 的接线)有一条部署前置——
`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`。开关没开,共享源在运行腿保持 owner-only。**
这条前置写进 PR-7 的验收标准,不用「放宽一点点就能过」的方式绕过去。

于是共享的实际收益分两段落地:

- **第一段(核心侧,可以马上做)**:顾问在数据工厂里能看到、能浏览库表结构、能取样、能建绑定。
  因为这些走的是核心 router,`req.authenticatedTenantId` 是可证的。
- **第二段(插件侧,有部署前置)**:顾问创建的管道能真的跑起来。

**我没能判断的**:222 上 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 当前是什么值。
本 worktree 里读不到部署环境变量,未上机查,不推测。

---

## 5. 决策五:离职 / 收回语义

### 5.1 `directory/*.ts` 零联动意味着什么

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

### 5.2 孤儿化 / 转交 / 冻结 —— 最小可行的第一刀

**都不做。第一刀 = 只读可见性。**

- **冻结**(离职即拒)会在没有预警的情况下打断生产管道。备料这条线上,实施工程师建的源正是
  一线每天在用的东西;把它在某人办离职当天掐掉,是把一个治理缺口换成一次生产事故。
- **转交**需要先回答「转交给谁」。那是 owner 裁决,不是设计能替他定的。而且管道那侧
  `created_by` 在 upsert 路径上不可改(`pipelines.cjs:518-521`),转交要同时改两张表两个概念,
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

## 6. 切 PR

标准:每刀自己可上线、可回滚、不依赖后一个。

| # | 内容 | 依赖 | 验收标准 |
|---|---|---|---|
| **PR-1**(第一刀) | 新迁移种子化 `data_sources:use` / `:rotate` / `:share` 三码(照抄 #5611 形状,只种码不发权);`PUT /:id/credentials`(`:716`)的门从 `write` 改成 **`rotate` 独占** | 无(#5611 不是硬依赖,但同时在飞,注意迁移文件名排序) | ① 空库跑两遍幂等,`permissions` 多三行;② `down()` 能回滚;③ **上机前置**:只读查 `role_permissions` / `user_permissions` 中 `data_sources:write` 持有者为 0,不为 0 则先经角色补 `rotate`;④ 平台管理员轮换路径不变(`rbac.ts:69-72` 短路);⑤ 变异:把 `:716` 的门改回 `write`,「rotate 独占」用例必须红 |
| **PR-2** | `scope_kind` CHECK 放开第四值 `tenant_shared`;`DATA_SOURCE_SCOPE_KINDS`(`:208`)加值;`DataSourceActorContext` 加 `tenantId?`;`assertAccess`(`:593-603`)与 `scopePermitsListing`(`:1246-1252`)各加 `tenant_shared` 分支(**裸串形态不进该分支**) | 无 | ① 生产行为零变化——没有任何写入点产生 `tenant_shared`,新分支走不到;② `data-source-scope.test.ts` 与 `data-source-visibility-authority-matrix.test.ts` 加用例:裸串 actor 对 `tenant_shared` 源仍 404;③ 变异:去掉「裸串不放宽」那一行,裸串用例必须红;④ 迁移 down 能收回 CHECK(前置:无 `tenant_shared` 行) |
| **PR-3** | 新路由 `PUT /api/data-sources/:id/scope`,门 `data_sources:share`,细门 owner 或 platformAdmin;前置 `scope.tenantId !== null`;写 DB **且**同步 `scopes` Map;审计 `action:'update_scope'`。列表 / 详情投影加 `scopeKind` | PR-1(share 码)+ PR-2(合法值) | ① 非属主非管理员 404(不是 403,与既有不泄露存在性一致);② tenantless 源置 `tenant_shared` 被拒并给码;③ 置位后 `GET /api/data-sources` 对同租户他人可见,而 `GET /:id`、`GET /:id/test` 仍 404;④ 变异:去掉 tenantless 前置,对应用例红;⑤ 重启后作用域仍生效(证明 DB 与 Map 都写了) |
| **PR-4** | `/schema`(`:1203`)、`/tables/:table`(`:1257`)、`/select`(`:1143`)三处:门改 `rbacGuardAny(['data_sources:use','data_sources:read'])`,细门从裸串改成带 `req.authenticatedTenantId` 的 context | PR-2 | ① 同租户 + `use` 码 + `tenant_shared` → 200;② 同租户但源是 `private` → 404;③ 跨租户 → 404;④ 无租户声明的 token → 404(不回退 `req.user.tenantId`);⑤ 变异:把已证租户换成 `req.user.tenantId`,④ 必须红 |
| **PR-5** | 前端:`DataSourcesPanel.vue`(#5587)加「作用域」列 + 共享开关;`IntegrationWorkbenchView.vue:961` 的选源下拉标注「他人共享」来源 | PR-3 | ① 无 `share` 码时开关不可见 / 禁用;② 共享源在选源列表里能选、但点「查看配置」不出主机端口;③ 前端单测覆盖三种作用域的渲染 |
| **PR-6** | 离职只读可见性(第 5 节第一刀):`ownerActive` + 徽标 + 报表 | 无(可与任何刀并行) | ① 零写入;② 查询失败时该键**省略**而不是 `false`;③ 变异:把省略改成 `false`,「未知不是停用」用例必须红 |
| **PR-7**(有部署前置) | facade `:506` 接线,让管道运行腿接受 `tenant_shared` | PR-2 + **`MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED=true`** | ① 开关关闭时,facade 对 `tenant_shared` 源保持 owner-only(可证的降级);② 开关打开 + 同租户 → 放行;③ 变异:去掉开关判定,① 必须红 |

**第一刀为什么是 PR-1**:体量小(一支迁移 + 改一行门 + 测试),一个窗口内做得完,
并且**自己就有价值**——把轮换从改指向的同一把钥匙下摘出来,这正是报告核心那条。
它不给任何人发新权,所以上线风险只来自「独占收紧」,而那一条有明确的上机前置把关。

---

## 7. 不做什么(每条都给理由)

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
8. **管道转交 / `created_by` 可改。** 见 §5.2。
9. **改 RBAC 判定逻辑本身、动命名空间豁免名单。** #5611 的设计文档已经论证过:
   把 `data_sources` 加进 `NON_NAMESPACED_PERMISSION_RESOURCES`(`namespace-admission.ts:11-38`)
   等于让所有持有者绕过准入,是放宽。本设计的三个新码刻意与现有六码同前缀,复用同一个准入开关。
10. **存量 tenantless 源的补租户路径。** §1.4 说了这是缺口:重存不会自动补上 `tenant_id`
    (`DataSourceManager.ts:515-518` 在 options 无该键时保留旧值)。补它需要一条显式路径 +
    一个「凭什么认为这个源属于这个租户」的判定。**本设计不覆盖,登记为未解决项。**

---

## 8. 本文没能判断的

1. **222 上 `MULTITABLE_STOCK_PREP_TENANT_CLAIM_REQUIRED` 的当前取值。** 决定 PR-7 能不能排期。
   worktree 里读不到部署环境,未上机查。
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
5. **`updateDataSource` 在 `priorScope` 缺失时把 `scopeKind` 兜底成 `'private'`**
   (`DataSourceManager.ts:519`)。正常路径上 `priorScope` 总在(`adapters` 与 `scopes` 一起维护),
   所以这条兜底今天走不到;但我没有穷举出「adapters 有而 scopes 没有」是否真的不可能,
   因此不声称它是死代码,只登记为 PR-2 要加一条断言的地方。
