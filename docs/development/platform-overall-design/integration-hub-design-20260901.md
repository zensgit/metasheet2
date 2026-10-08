# 对接中心(Integration Hub)设计裁决 —— 一个中心,两层,以及那个没有任何页面画出来的 join(2026-09-01,DRAFT)

> **地位**:候选设计,不进入当前任何门;values-free。回应对象:数据工厂(`/integrations/workbench`)与外接数据源(`/data-sources`)两个既有页面的合并。
> **owner 诊断(2026-08-31,原文)**:「数据工厂及外接数据源 这两个页面都搞不懂…两个页面能合并呢?并且用户在哪里能看出来当前系统对接了哪些系统,用户可以对对接的系统进行修改,目前这两页面非常工程化,不是对数据库很熟悉的人估计接手不来」——并给出 24 小时内人性化实施的时限。
> **方法**:本稿全部结论来自对代码的三路独立核对(不是一次读码、一份猜测);每条发现都带 `path:line`。凡任务交底里的措辞与实读不一致之处,以实读为准并逐条标出更正。

---

## 0. 一句话结论

数据工厂(`integration_external_systems`,9 种连接 kind)与外接数据源(`data_sources`,用户自建的 SQL/HTTP 连接)是**两本互不相认的登记簿**,只靠 `integration_external_systems.config` 里一个隐藏 JSONB 指针 `dataSourceId`(仅两个"桥接 kind"使用)单向勾连;**没有一个页面画出这条 join**——数据工厂看不到某系统连的是哪个外接数据源,外接数据源页看不到谁在用某个连接。指针本身**可编辑但被设计成几乎用不了**(藏在"高级"开关背后、三种情况会拒绝保存、脱敏行完全不能改)。本设计不新建注册表、不新增写权限,只做**一个对接中心、两层**:Level 1 默认展示"对接了哪些系统 / 连的是哪个连接 / 谁在用 / 状态",把已经存在但从未被拼起来的信息拼起来;Level 2 折叠着今天工程化的连接库/读取源/清洗映射等全部原样保留,面向真正需要动手的实施者。

---

## 1. 现状:四本连接登记簿,各管一段

| 登记簿 | 表 / 机制 | 作用域与访问控制 | 凭据 | 关键证据 |
|---|---|---|---|---|
| **外接数据源**(`/data-sources`) | `data_sources` | 按 `owner_id` **严格**归属,**没有管理员绕过路径**;`workspace_id` 列存在但从未被任何鉴权代码读取(唯一调用方从不传它,永远是 `null`) | AES-256-GCM(`aes-256-gcm`),经 `/api/data-sources/:id/credentials` **只写不读**——所有响应体在 `sanitizeConfig()` 里被剥离 | 建表 `packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:20-56`(`owner_id` 非空 `:38`,`workspace_id` 可空 `:39`);鉴权 `packages/core-backend/src/data-adapters/DataSourceManager.ts:380-385`(`assertAccess`,只比较 `ownerId`);加密算法 `packages/core-backend/src/security/encrypted-secrets.ts:4`;只写凭据端点注释 `packages/core-backend/src/routes/data-sources.ts:545-548`;`workspace_id` 从不被传入的调用点注释 `data-sources.ts:352` |
| **数据工厂自己的登记簿**(`/integrations/workbench`) | `integration_external_systems` | 按 `tenant_id`(+可选 `workspace_id`/`project_id`) | K3 / HTTP / PLM 等 kind **各自携带自己的**加密凭据列 `credentials_encrypted`,与 `data_sources` 的加密管线完全独立(不同表、不同密钥材料路径) | 建表 `packages/core-backend/migrations/057_create_integration_core_tables.sql:19-46`;凭据加密 `plugins/plugin-integration-core/lib/credential-store.cjs:27`(同为 `aes-256-gcm`,但是独立实现) |
| **考勤对接**(`attendance_integrations`) | `attendance_integrations` + `attendance_integration_runs` | 按 `org_id`;插件私有 | 插件内自管 | 建表 `packages/core-backend/src/db/migrations/zzzz20260202093000_create_attendance_integrations.ts:7-58`;唯一读写方是 `plugins/plugin-attendance/index.cjs` 的原始 SQL,与另外两本登记簿之间没有任何外键或代码通路 |
| **PLM 嵌入的环境变量绑定** | 无表——一个环境变量 | 服务端配置,**永不取自请求**;单条记录(一个环境只绑一个 `data_sources` 行) | 沿用 `data_sources` 的凭据体系(因为绑的就是一行 `data_sources`) | `packages/core-backend/src/auth/embed-config.ts:56-58`:`embedDataSourceId()` 读 `process.env.PLM_EMBED_DATA_SOURCE_ID`,函数注释原文「The SERVER-configured PLM data source the embed is bound to (NEVER taken from the request)」;消费方 `packages/core-backend/src/routes/plm-embed.ts` |

**这四本登记簿里,只有前两本(外接数据源 / 数据工厂)之间存在一条勾连**,且只对两个特定 kind 生效——见 §3。考勤对接与 PLM 嵌入绑定各自独立运作,今天没有、本设计也不打算让它们并入同一个 join(理由见 §10 非目标)。

**数据工厂的 9 种已注册连接 kind**(`plugins/plugin-integration-core/index.cjs:324-333`,`createAdapterRegistry().registerAdapter(...)` 链式调用逐一注册):

`http` / `plm:yuantus-wrapper` / `erp:k3-wise-webapi` / `erp:k3-wise-sqlserver` / `bridge:legacy-sql-readonly` / `metasheet:staging` / `metasheet:multitable` / `data-source:sql-readonly` / `data-source:sql-write-gated`。

最后两个——`data-source:sql-readonly`(读)与 `data-source:sql-write-gated`(写,受 C6 闸控)——就是"桥接 kind":它们不直接持有连接信息,而是通过 `config.dataSourceId` 指向 `data_sources` 里的一行,把外接数据源接进数据工厂的清洗/推送流水线。

---

## 2. 断点:没有一个页面画出这条 join

数据工厂的连接卡片只渲染名称、kind、角色、状态——不渲染它连的是哪个 `data_sources` 行:

```
apps/web/src/components/integration/IntegrationConnectionSection.vue:61-62
  <strong>{{ system.name }}</strong>
  <span>{{ system.kind }} · {{ system.role }} · {{ connectionStatusLabel(system) }}</span>
```

`/data-sources` 页面反过来只列"我自己建的连接",页面全文没有出现过"owner"字样,也没有任何"谁在用这个连接"的字段或列表。表单区直接铺开 host/port/database/username/password 这类原始连接参数(`DataSourcesView.vue:1-60`)——这正是 owner 诊断里"非常工程化,不熟悉数据库的人接手不来"的那一页;列表区(`DataSourcesView.vue:132-206`,表头「名称/类型/状态/连接测试」)同样没有"被谁引用"这一列——对 `DataSourcesView.vue` 与其数据层 `apps/web/src/data-sources/{api,types}.ts` 全量 grep `used.?by|consumer|reference|pipeline|external.?system|integration`,零命中。(旁证:数据工厂自己的读取源系统选择器甚至比连接卡片显示得更少——`apps/web/src/components/integration/IntegrationReadSourceWizard.vue:19-33` 每张系统卡只画 `name` 与 `kind` 两个字段。)

`/stock-prep` 备料工作台对某个数据源的实际使用(BOM 备料读取 PLM 用的是哪个连接)要经过三跳才能拼出来,且两个前端页面都不画其中任何一跳:

1. **配置物理存放处**是服务端环境变量,不是数据库行——`packages/core-backend/src/plugin-runtime-config.ts:2`(`INTEGRATION_CORE_STOCK_ACTIONS_ENV = 'INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON'`),原样解析为 JSON 于 `:104-107`,并入返回配置对象的 `stockPreparationTableActions` 字段(`:156`)。
2. **动作配置 → `source.externalSystemId`**:该配置在 `plugins/plugin-integration-core/lib/http-routes.cjs:2848-2853` 被读入并交给 `createStockPreparationTableActionRegistry`;归一化逻辑 `plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:155-183`(`normalizeSource`)第 178 行:`externalSystemId: requiredString(input.externalSystemId, 'source.externalSystemId')`。返回给前端的公开元数据(同文件 `publicActionMetadata`,353-386 行)**刻意不包含** `source`/`externalSystemId`——数据工厂自己专门的"表动作"面板(`apps/web/src/components/integration/IntegrationTableActionsPanel.vue`)对 `externalSystemId` 全文 grep 零命中,也就是说数据工厂自带的动作管理界面同样看不到这条绑定。
3. **`externalSystemId` → `integration_external_systems`**:`http-routes.cjs:3147-3150`(`b2aSourceSystemConfigLoader`)调用 `externalSystems.getExternalSystemAdapterConfig(...)`,取到该行的 `{id, kind, config}`(`plugins/plugin-integration-core/lib/external-systems.cjs:373-390`)。
4. **`config.dataSourceId` → `data_sources`**:`plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:557-561`,注释原文「The integration row carries only the reference to the data source — NEVER its credentials」,取出 `dataSourceId` 后经 `context.api.dataSources` 解析到 `data_sources` 表——就是 `/data-sources`(`DataSourcesView.vue`)读的同一张表(REST 对应 `packages/core-backend/src/routes/data-sources.ts:295` `GET /api/data-sources/:id`)。

三跳,没有一跳被 `IntegrationConnectionSection.vue` 或 `DataSourcesView.vue` 画出来。要回答"这个连接被谁用着",今天唯一的办法是有人手工把这三跳读一遍。

**结论**:owner 问的"用户在哪里能看出来当前系统对接了哪些系统"——**今天没有任何一个页面能回答**。不是某一页做得不好,是这条 join 从未被任何界面代码计算过。

---

## 3. 那根指针:能编辑,但被设计成几乎用不了

### 3.1 指针在哪、怎么被读取

`config.dataSourceId` 由两个桥接适配器在运行时读取并转成真实连接:

- `plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:561`:`const dataSourceId = requiredString(config.dataSourceId, 'config.dataSourceId')`
- `plugins/plugin-integration-core/lib/adapters/data-source-sql-write-gated-target-adapter.cjs:67`:同名字段,同样必填

实际的"join"发生在 `packages/core-backend/src/data-adapters/data-source-plugin-facade.ts` 的 `authorize()`(约 392-407 行):先 `manager.assertAccess(dataSourceId, owner)`(复用 §1 那条 owner-only 鉴权),再 `manager.getDataSource(dataSourceId)`。这条 facade 只挂给 `plugin-integration-core` 一家插件(`packages/core-backend/src/index.ts:2230-2236`,按 `manifest.name === 'plugin-integration-core'` 判断后才注入 `context.api.dataSources` / `dataSourceWrites`),其它插件拿不到。

### 3.2 UI 里能编辑,但藏得很深

指针的编辑入口就是数据工厂连接抽屉里 `data-source:sql-readonly` 的 `dataSourceId` 选择框(`apps/web/src/components/integration/IntegrationConnectionSection.vue:168`,`data-testid="data-source-bridge-id"`),但这个 kind 被标记为 `advanced: true`(`data-source-sql-readonly-source-adapter.cjs:701`;写入侧 `data-source-sql-write-gated-target-adapter.cjs:130` 同样标记),默认被"高级连接器"开关折叠(`apps/web/src/views/IntegrationWorkbenchView.vue` 中 `showAdvancedConnectors` 默认 `false`,过滤逻辑按 `showAdvancedConnectors.value || !adapter.advanced` 决定可见性)。也就是说:**指针存在、可编辑,但普通用户在默认视图里根本看不到它**。

### 3.3 保存会在三种情况下拒绝——即便找到了入口

`connectionDraftJsonError`(`apps/web/src/views/IntegrationWorkbenchView.vue:1281-1295`)在以下三种情况阻止保存:

1. 配置 JSON 解析失败(`catch` 分支);
2. 草稿里出现疑似密码/token/secret 等敏感字段形状(`hasUnsafeConnectionDraftSecret`);
3. 草稿文本包含 `<redacted>` 占位符——即草稿是从一条**已脱敏**的既有记录直接改出来的,还没被用户替换掉脱敏占位。

第三条直接决定了:**一条草稿一旦携带 `<redacted>` 占位符,今天在界面上就无法原样保存**——前端守卫代码(`IntegrationWorkbenchView.vue:1288`、`hasUnsafeConnectionDraftSecret` 内 `:2213` 把 `<redacted>` 与 `%3Credacted%3E` 列为唯一允许出现的"非密钥形状"字符串)确凿存在。但两轮独立核对都没能在服务端找到真正吐出这个**尖括号**字符串的位置:插件自己的脱敏工具 `plugins/plugin-integration-core/lib/payload-redaction.cjs:197` 吐出的是**方括号**的 `[redacted]`,是 `rowToPublicExternalSystem`(`external-systems.cjs:123`)实际使用的那份;能找到的尖括号 `<redacted>` 出处都是不相关的日志脱敏(K3 WebAPI/`SqlServerExecutor` 的请求日志脱敏)。**如实记录、不强行拉齐**:前端这道"脱敏行不可编辑"的守卫是真实代码,但它防的字符串今天可能从未真正出现在一条系统的 `config` 响应里——这本身是对接中心 Level 2 应该顺手核实、而不是本文替它下结论的一处细节。

写这个指针走的权限是 `integration:write`(`plugins/plugin-integration-core/lib/http-routes.cjs`,`externalSystemsUpsert` 处理函数 `requireAccess(req, 'write')`,默认分支 `hasPermission` 落到 `permissions.includes('integration:write')`)——不需要更高的 `integration:admin`;`dataSourceId` 也不在该 kind 的"私有配置"清单里,所以修改它甚至不触发额外的管理员二次校验。**API 层面这个指针本可以被正常写入;拦住它的是 UI 的三道保存前置条件和默认折叠,不是权限本身。**

---

## 4. 写入现实:读窄于全部、写更窄,K3(WebAPI)永久焊死

**读**:9 种 kind 里有 7 种实现了真实的读(`http`/`plm:yuantus-wrapper`/`erp:k3-wise-webapi`/`erp:k3-wise-sqlserver`/`bridge:legacy-sql-readonly`/`metasheet:staging`/`data-source:sql-readonly`)。另外两种按设计就是**只写不读**的目标适配器,不是缺口:`metasheet:multitable`(`metasheet-multitable-target-adapter.cjs:405`:`read: unsupportedAdapterOperation(...)`)与 `data-source:sql-write-gated`(`data-source-sql-write-gated-target-adapter.cjs:117`:同样的拒绝桩)。

**写**——比"只有两种能写"更细一层:

- `metasheet:multitable`——真实、无额外闸控的 `upsert`(`metasheet-multitable-target-adapter.cjs:474`),写回本方多维表。
- `data-source:sql-write-gated`(即 **C6**)——适配器自己的 `.upsert()` 方法本身是拒绝桩(`data-source-sql-write-gated-target-adapter.cjs:118`:`unsupportedAdapterOperation(..., 'upsert until C6 token-bound apply is implemented')`),真实写入走一条独立的"dry-run → 单次令牌 → apply"生命周期,直接调用 `context.api.dataSourceWrites.insertRows/updateRows`(`external-write-dry-run.cjs:1155,1164`,由 `http-routes.cjs:1459-1462` 接入)。这条链路上有**四层闸**,缺一不通:
  1. 权限 `integration:write`(`http-routes.cjs:4220`,`requireAccess(req,'write')`);
  2. 部署级开关 `INTEGRATION_C6_WRITE_APPLY_DISABLED`,为真时 Apply 路由直接 `403 C6_WRITE_APPLY_DISABLED`(`http-routes.cjs:837-839,4221-4222`);
  3. **目标那一行 `data_sources.config.options` 必须同时置位** `c6WriteTarget` 与 `genericQueryDisabled` 两个标志,且该行不能是"只读"——在 `data-source-plugin-facade.ts:496-510` 强制校验(`packages/core-backend/src/data-adapters/DataSourceManager.ts:76-82` 定义判定函数);这两个标志在 `/data-sources` 表单里**没有任何字段能勾选**(`DataSourcesView.vue` 通篇 `ds-field-*` testid 排查,不存在),今天只能靠直接改库或改服务端配置置位;
  4. UI 默认隐藏:适配器元数据 `ui: { hiddenByDefault: true, serverConfiguredOnly: true }`(`data-source-sql-write-gated-target-adapter.cjs:143-146`)。
- `erp:k3-wise-webapi` 与 `erp:k3-wise-sqlserver` 这两个 K3 相关 kind,**在适配器代码层面都有真实、非拒绝桩的写方法**(`upsert`/`insertMany`)——真正拦住它们的不是"没写代码",是下面这道专门的焊死。

**K3(WebAPI)写入永久焊死,四层独立、不可逆**——`plugins/plugin-integration-core/lib/k3-external-write-permanent-fence.cjs` 模块注释原文(约 3-45 行):「env flag、通用 C6 开关、owner policy、审批结果和请求参数均不能解锁」。范围严格限定为 `erp:k3-wise-webapi`(模块内 `K3_EXTERNAL_WRITE_TARGET_KIND` 常量),固定拒绝码 `K3_WISE_EXTERNAL_WRITE_DISABLED`,HTTP 403。四层各自独立、每层都是**无条件**抛错(不是某个 flag 判断出来的分支),生产代码里的确切位置:

1. Apply HTTP 路由——`http-routes.cjs:4274-4277`,`pipelinesExternalWriteApply` 函数体最前面,在任何凭据重载/适配器创建之前;
2. C6 apply 引擎——`external-write-dry-run.cjs:1067-1072`,`applyExternalWrite` 函数体第一条语句,在消费单次 dry-run 令牌之前;
3. K3 write-source——`plugins/plugin-integration-core/lib/adapters/k3-wise-c6-write-profile.cjs:391-400`,`writeRows` 函数体第一条语句,在解析 `targetAdapter()` 之前;
4. K3 WebAPI 适配器——`plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs:2445-2451`,`upsert` 函数体内、`await login()`(`:2453`)之前一行——代码注释自称"这是这个进程会向客户 K3 发出的第一个字节"。

**必须点名的一处缩窄**:`erp:k3-wise-sqlserver` 是**另一个** K3 相关 kind(`k3-wise-sqlserver-channel.cjs`),**不在**上述永久焊死模块的覆盖范围内。它自己的守卫更弱——`assertNoDirectK3Write`(`k3-wise-sqlserver-channel.cjs:163-171`)要求 `config.objects.<name>.writeMode === 'middle-table'`,但只要配置里显式置 `allowDirectTableWrite: true` 就能绕过。今天实际生产接线用的是只读执行器(`index.cjs:297` 接入 `createK3WiseSqlServerReadOnlyExecutor`),其 `insertMany()` 无条件抛 `SQLSERVER_WRITE_EXECUTOR_DISABLED`(`k3-wise-sqlserver-executor.cjs:335-340`)——今天同样是死的,但死法是"默认注入只读执行器",而不是"四层不可逆焊死";换一个执行器实现即可重新打开,不需要碰永久焊死模块一个字。**如果对接中心的任何界面文案要说"K3 写入被永久禁止",这句话对 `erp:k3-wise-webapi` 成立,对 `erp:k3-wise-sqlserver` 不成立——两个 kind 必须分开措辞,不能笼统说"K3"。**

这条事实直接约束本设计的非目标:**对接中心是只读的可见性 + 既有编辑入口的重新摆放,不改变任何一条写门的开合状态**(见 §10)。

---

## 5. 死表面:合并时可以一并退休的东西

以下代码/表在今天的代码库里是真实存在但**零生产调用**的死表面,合并页面时是清理它们的自然时机(不属于本设计的必做项,但值得记在候选清单里):

| 表面 | 状态 | 证据 |
|---|---|---|
| "发布 API 数据服务"占位 | 提示文案,连一个占位路由都没有;设计文档里本就是明确延后项 | `apps/web/src/views/IntegrationWorkbenchView.vue:362-364`,`data-testid="data-service-placeholder"`;`docs/development/data-factory-workbench-todo-20260514.md:63,95` 明确把"数据服务发布"列为界外(out-of-scope);对 `http-routes.cjs` 与 `packages/core-backend/src/routes/` 全量 grep `publish`,不存在任何 data-source/data-factory 发布路由 |
| Mongo / Redis / Elasticsearch 适配器 | 类文件存在且实现完整(600+ 行),但从未注册进可用类型表 | 文件:`packages/core-backend/src/data-adapters/{MongoDBAdapter,RedisAdapter,ElasticsearchAdapter}.ts`;注册表只有 6 个键 `packages/core-backend/src/data-adapters/DataSourceManager.ts:54-61`(`postgresql`/`postgres`/`http`/`sqlserver`/`mysql`/`plm`),`SUPPORTED_DATA_SOURCE_TYPES` 由该注册表派生(`:63-69`);前端 `apps/web/src/data-sources/types.ts:9` 的 `DATA_SOURCE_TYPES` 只镜像其中 4 个。三者唯一的其它出现是被已死的 `DataMaterializationService.ts` `require`(见下一行),同样零生产调用。**Athena 不属于此列——核实后予以更正**:`AthenaAdapter.ts` 只有 19 行,是文档管理子系统的类型定义(`IAthenaAdapter`),经 DI 容器真实绑定并被 `routes/federation.ts` 多处使用,是另一套活跃系统,与"未注册的数据源适配器 kind"完全不是一回事,不应与 Mongo/Redis/ES 并列 |
| `copyData` / `federatedQuery` | 方法体完整实现(批量分页复制 / 并行跨库查询),但**生产代码零调用**——唯一调用点是一条单测,且该单测断言二者必然被拒绝 | 定义:`packages/core-backend/src/data-adapters/DataSourceManager.ts:773-836`(`copyData`)、`:839-`(`federatedQuery`);唯一调用点及其断言:`packages/core-backend/tests/unit/data-source-readonly.test.ts:111-113`(`rejects.toThrow(/generic copy is unsupported/)` 等) |
| "跨插件 CRUD"命名空间挂了个空壳 | `CoreAPI.collection` 面向所有插件通用暴露,但背后的 `Repository` 类只有一个方法(`getName()`),没有任何一个 CRUD 方法;`sync()` 是空函数 | 暴露点 `packages/core-backend/src/index.ts:538-548`;`CollectionManager.register` 只是塞进内存 `Map`、`sync()` 注释原文"No-op for now"(`packages/core-backend/src/core/database/CollectionManager.ts:4-25`);`Repository` 定义 `packages/core-backend/src/core/database/Repository.ts:1-7`;对全仓库 grep `.collection.register`/`.collection.getRepository`/`.collection.sync`,除定义与接线代码外零命中——没有一个插件用过它 |
| GIP-\*(通用集成平台)一整条线,15 个文件 | 2026-07-23 曾被窄范围 ratify(仅 profile schema + 合规 harness + 只读 qualification spike),自述"latent":无路由、无调度、无运行时消费者;唯一一处真活线是 `isValidProfileId` 被 `read-source-config.cjs` 借用于校验版本号字符串格式 | 文件清单:`ls plugins/plugin-integration-core/lib \| grep '^gip-'` 命中 15 个;自述原文见 `plugins/plugin-integration-core/lib/gip-approved-binding-resolver.cjs:19`:「LATENT: no route, no scheduled run, no runtime consumer.」;窄范围 ratify 出处 `docs/development/gip-d0-general-integration-platform-design-lock-20260723.md:1-5`;唯一活线 `plugins/plugin-integration-core/lib/read-source-config.cjs:23,288`;对 `http-routes.cjs`/`index.cjs` grep `gip-`,零命中 |
| `data_source_connections` / `data_source_query_logs` 两张表 | 建表语句存在(与 `data_sources` 同一份迁移),但仓库里除该迁移文件自身外零引用 | 建表:`packages/core-backend/src/db/migrations/20251206000001_create_data_sources_table.ts:101-242`;引用排查:对 `packages/core-backend/src` 全量 grep 两个表名,命中仅此迁移文件一处 |
| `DataMaterializationService` | 类完整存在,零 importer | 类定义 `packages/core-backend/src/services/DataMaterializationService.ts:207`,单例导出 `:1324`;死码状态由迁移供给器自己的注释确认:`packages/core-backend/src/db/migration-provider.ts:89-93`「042b/044 external_tables) have zero importers repo-wide, so reviving the migration alone would not make the feature live.」 |

（旁证:`packages/core-backend/src/db/migration-provider.ts:80-99` 还记录了一份更大的"zombie migration"名单——038/040/041/042 系列——说明这类"表在、码不在"的情况在本仓库不是孤例,是有先例的已知模式,清理时可参照同一处理方式:保留迁移历史标记,不删除、不误读为"还在用"。）

---

## 6. 并行分支中的四个缺陷(伴随工作,进行中,不在本文解决范围)

以下四点是本次核对代码时顺带发现的缺陷。其中两点已核实到**正在其它工作区里进行、尚未提交**的同名并行分支(与本文档分支同源、同一基线);另外两点目前找不到对应分支——如实分开报告,不强行凑成"四个都有人在修"。本设计**不重新定义**任何一点的修法,只记录现状证据,并在 §7.4 说明对接中心如何在它们修完前后都不多开一寸写权限。

**① PLM 工作台路由绕过 `data_sources` 归属检查。**(**并行分支:`sec/plm-workbench-datasource-ownership`**,当前检出于另一工作区,基线与本文档分支相同,尚未提交)`packages/core-backend/src/routes/plm-workbench.ts` 至少 4 处(`:767`、`:967`、`:1030`、`:1131`)直接调用 `getDataSourceManager().getDataSource(dataSourceId)`,而 `getDataSource(id)` 本身**不做任何归属校验**——它只是 `this.adapters.get(id)`,找不到就抛错(`DataSourceManager.ts:546-552`)。真正做归属校验的是 `assertAccess(id, ownerId)`(`:380-385`),PLM 工作台路由全文 grep `assertAccess` 零命中。对比:PLM 嵌入路由(§1 第四行)同样调用 `getDataSource` 而非 `assertAccess`,但那是刻意设计——绑定源本就是服务端环境变量而非某个用户的资源;PLM 工作台这里绕过的却是一个**本该按 owner 归属**的用户资源,性质不同——`authenticate` 中间件确保了调用者已登录,但没有校验调用者是否是该 `data_sources` 行的 owner,任何登录用户理论上都能查到别人那条数据源的 PLM 能力/BOM 上下文。

**② `DELETE /data-sources/:id` 留下悬空指针。**(**未找到对应并行分支**——按实际情况报告,不假装存在)`packages/core-backend/src/routes/data-sources.ts:634-674`:删除只调用 `manager.removeDataSource(id)`(`DataSourceManager.ts:506-544`,只处理 `data_sources` 自己的软删/硬删)并写审计日志,不做任何跨表清理。结构上这也清理不了——`data_sources` 归 core-backend 管,指向它的 `integration_external_systems.config.dataSourceId` 归 `plugin-integration-core` 插件管,两者是不同的代码边界;而且 `config` 是一个普通 `JSONB` 列(`057_create_integration_core_tables.sql:27`),`dataSourceId` 只是应用层的君子约定,**连数据库外键都没有**,不存在任何级联清理的可能。`dataSourceId` 是被真实使用的字段(测试夹具 `plugins/plugin-integration-core/__tests__/external-systems.test.cjs:229-238`),删掉一个正被引用的连接后,引用它的数据工厂系统会在下次读取时才发现指针失效。

**③ 按用户归属阻挡管理员管理。**(**并行分支:`sec/datasource-visibility-model`**,当前检出于另一工作区,基线与本文档分支相同,尚未提交)`assertAccess`(`DataSourceManager.ts:380-385`,方法自带注释「a non-owner must not learn that someone else's source exists」)只比较 `scope.ownerId === ownerId`,是严格相等,没有任何角色分支——对整份 `data-sources.ts` 路由文件通读也找不到 `role === 'admin'` 或等价的管理员绕过。这与数据工厂自己的权限模型(`integration:read/write` 之上还有 `role:admin` / `integration:admin` 全通过,见 §7.4)形成反差:数据工厂的连接,平台管理员今天能管;用户自建的外接数据源,平台管理员今天连查看都不能,拿到的是与"不存在"完全相同的 404。这正是 owner 诊断里"用户可以对对接的系统进行修改"这句话在 `/data-sources` 一侧落空的根源。

**④ 桥接 kind 的保存会丢字段(`config.schema`)。**（**未找到对应并行分支**——按实际情况报告,不假装存在;此前草稿误写的 kind 名 `data-source:read`/`data-source:query` 在仓库里不存在,已更正为下面的真实 kind 名)`data-source:sql-readonly` 适配器会读取 `config.schema`(数据库 schema 名,如 Postgres 的 `public`)来限定表查找范围(`plugins/plugin-integration-core/lib/adapters/data-source-sql-readonly-source-adapter.cjs:562`),这是一个真实、被测试断言过的公开字段(`external-systems.test.cjs:229-238`)。问题在两端叠加:

- **前端**编辑保存时重建 `config` 的函数只写回两个字段,不包含 `schema`——`apps/web/src/views/IntegrationWorkbenchView.vue:1018-1025`(`buildDataSourceBridgeConfig`,注释原文「Only the data_sources reference + object — NO credentials are ever entered for this kind」,`schema` 在注释里都没被提到);
- **后端**的更新合并逻辑也救不回来:`upsertExternalSystem`(`plugins/plugin-integration-core/lib/external-systems.cjs:274-341`)更新时用 `preservePrivateConfigOnPublicUpdate`(`:219-231`)把旧 `config` 与新 `config` 合并,但这个函数**只保留 `PRIVATE_CONFIG_KEYS_BY_KIND` 里点名的私有键**——`data-source:sql-readonly` 的私有键集合只有 `{'lookupProjection'}`(`:24`),`schema` 不在其中,于是在整表替换(`:313`)时被静默丢弃。

两端合起来就是:编辑一条已经配置了非默认 `schema` 的既有桥接连接并保存,`schema` 会被静默清空——前端没往回写,后端的"保留私有字段"机制又恰好不覆盖这个公开字段,不会报错,下次读取的对象集合会悄悄变成默认 schema 下的那一套。

---

## 7. 设计:一个对接中心,两层

### 7.1 Level 1(默认,面向"用户"——不需要熟悉数据库的人)

一张系统卡片列表,一个系统一张卡,回答 owner 的原始问题"对接了哪些系统":

| 字段 | 来源 |
|---|---|
| 显示名 | `integration_external_systems.name` |
| 类型(人话版) | `kind` 经一张 kind→人话映射表(仿 §9 的 `plainLanguage.ts` 模式,而非直接吐 `erp:k3-wise-webapi` 这种字符串) |
| **连的是哪个连接** | 若为桥接 kind,`LEFT JOIN data_sources ON data_sources.id = integration_external_systems.config->>'dataSourceId'`;非桥接 kind(K3/HTTP/PLM 等)展示"内置凭据,未连外部登记的数据源"——如实反映 §1 的事实,不假装它们都走同一根指针 |
| **谁在用它** | 三处消费者的并集:①作为 `source_system_id`/`target_system_id` 被 `integration_pipelines` 引用(`plugins/plugin-integration-core/lib/pipelines.cjs:167,169,293,295`);②作为 `system_id` 被 `integration_read_source_configs` 引用(`plugins/plugin-integration-core/lib/read-source-config-store.cjs:21,121`);③被服务端客户包配置引用(§2 提到的、今天对两个页面都不可见的那条绑定)——第三条只做只读摘要展示,不代表本设计要把客户包配置搬进数据库 |
| 状态 + 最近一次测试 | `status` / `last_tested_at` / `last_error`(`057_create_integration_core_tables.sql:30-32`) |
| 操作 | 测试(既有的 test 端点)/ 换连接(=编辑桥接 kind 的 `dataSourceId`,把 §3 的入口从"高级开关背后"提到一等操作位置)/ 改凭据(=既有的凭据轮换端点,同样提级) |

Level 1 不新建任何读写路径——它调用的每一个字段、每一个操作,今天都已经在后端存在(见上表逐行出处);变化的只是"把它们摆在同一张卡片上",而不是分散在两个互不知道对方存在的页面里。

### 7.2 最小 join 规格(实现备忘,非新增契约)

```sql
SELECT es.*, ds.name AS connected_data_source_name, ds.status AS connected_data_source_status
FROM integration_external_systems es
LEFT JOIN data_sources ds
  ON es.config ->> 'dataSourceId' = ds.id
 AND es.kind IN ('data-source:sql-readonly', 'data-source:sql-write-gated')
LEFT JOIN integration_pipelines ip
  ON ip.source_system_id = es.id OR ip.target_system_id = es.id
LEFT JOIN integration_read_source_configs rsc
  ON rsc.system_id = es.id
```

外加一条只读摘要读出:服务端客户包配置里声明的系统/连接引用(§2)——按客户包文件逐条解析,不落库、不新增表。

### 7.3 Level 2(高级,默认折叠——面向实施者)

今天数据工厂工作台的既有分区原样保留,不删不改行为,只是从"唯一入口"降级为"折叠在 Level 1 之后的详情"。左侧导航沿用现有七组(`apps/web/src/views/IntegrationWorkbenchView.vue` 的 `railGroups`,约 658-668 行):**连接管理**(拟更名为"连接库",纳入原 `/data-sources` 的连接列表——见 §8)/ **读取源** / **组合** / **清洗映射** / **运行与推送** / **监控与死信** / **Bridge Agent 观测**。§3 描述的"高级开关""三道保存前置条件""脱敏行不可编辑"等工程化细节,在 Level 2 内**原样保留、不简化**——这里的读者本就需要看到这些细节,简化反而是隐患。

### 7.4 权限模型:不动

- Level 1 的读取门槛是 `integration:read`(今天数据工厂路由的 read 分支已支持 `integration:read` 或 `integration:write` 任一,见 `plugins/plugin-integration-core/lib/http-routes.cjs` 的 `hasPermission`,约 636-651 行)。**但前端路由今天把整个工作台页面挂在 `integration:write` 门槛上**(`apps/web/src/router/appRoutes.ts:270-274`,`meta.permissions: ['integration:write']`),持有只读权限的人今天连页面都进不去。本设计要求的唯一路由层改动就是这一处:把 Level 1 的可见性门槛降到 `integration:read`,Level 2 的可见性与全部写操作维持 `integration:write` 不变——这是**放宽查看范围,不是新增写权限**。
- `data_sources` 一侧的可见性(尤其是管理员能否在 Level 1 卡片里看到"连的是哪个外接数据源"这类细节)遵循 §6③ 所述、并行分支正在处理的归属裁决;本设计不抢先定义那条裁决,只承诺裁决落地后 Level 1 直接消费其结果,不需要再改一次 join。
- K3 permanent fence(§4)、C6 Apply 的部署开关(§4)、`multitable:manage-schema` 与 `multitable:write` 的分档——本设计一概不触碰,Level 1 的"测试/换连接/改凭据"三个操作背后调用的端点权限与今天完全相同,只是把入口从"藏在高级开关和三层信息架构里"挪到"一等位置"。

---

## 8. 迁移路径

1. **对接中心作为数据工厂工作台的新第一分区**上线:`railGroups` 前面插入一个 Level 1 卡片列表分区,读取 §7.2 的 join,不影响后面七个既有分区的路由/组件/测试。
2. **`/data-sources` 页面改为跳转**:路由 `meta` 保留(供直接输入 URL 的书签兼容),组件替换为对"高级 → 连接库"分区的重定向,原表单/列表功能原样保留在 Level 2 内,不删除、不重写。
3. 两步都是**加法**——旧页面的每一个功能点在新结构里都能找到,没有任何今天能做的操作在合并后消失。

---

## 9. 措辞规范(遵循 #5391 先例)

Level 1 的每一处措辞遵循 `feat(stock-prep-web): the workbench speaks to its users — plain language first, technical detail one click away`(#5391,`46aa463f3`)定下的规则,同一条规则今天只在备料工作台生效,本设计把它扩展到对接中心:

- **人话默认,技术详情一键展开**:kind 字符串、`config.dataSourceId` 这类标识符不消失,但默认折叠进每张卡片自己的"技术详情(排障用)"区,原样可见、可复制——`<details>/<summary>` 真实语义化折叠组件,内容折叠时仍留在 DOM 里(不是 `display:none`),复制/查找/读屏器都不受影响。既有实现:`apps/web/src/components/integration/stockPreparation/StockPrepTechnicalDetails.vue`;其人话映射表模式:`apps/web/src/services/integration/stockPreparation/plainLanguage.ts`(逐项 identifier → 中/英人话,查不到时原样兜底,不会因为漏收一个词就报错或空白)。这两个文件目前限定在备料工作台命名空间下,对接中心需要的是**同一套模式**,不是抢用同一份代码——具体是抽出共享组件还是各自建一份同构实现,留给实现阶段决定,不在本设计里裁定。
- 该规则的落脚点是**顺序**,不是删减:同一份信息,人话在前、原始标识符在后一键可达,而不是二选一。

---

## 10. 非目标 / phase 2 候选

**本设计不做的事**(与 §4 的写门现状对齐,fail-closed 优先于好看):

- **不新增任何写权限**。Level 1 的"换连接""改凭据"两个操作背后调用的是今天已经存在、已经受 `integration:write` 保护的端点;C6 的部署开关、K3 的四层永久焊死均不受本设计影响,继续维持关闭/焊死状态。
- **不合并考勤对接(`attendance_integrations`)与 PLM 嵌入的环境变量绑定**进同一个对接中心视图。理由:两者的作用域模型与另外两本登记簿本质不同——考勤对接按 `org_id` 归属、由插件私有管理,PLM 嵌入绑定是"服务端配置的单条环境变量,永不取自请求"的一次性场景绑定,都不具备"一个 tenant 下多条可管理连接"这个数据工厂/外接数据源共享的形状。把它们塞进同一张 join 表只会制造一堆恒为空的列。列为 **phase 2 候选**:待 phase 1 的 join 模式跑通、且有第二个真实需要跨这两本登记簿查询的场景出现时再评估,不预先设计。
- **不解决 §6 的四个并行缺陷**。对接中心的设计在这四个缺陷修复前后都成立——Level 1 展示的是"今天授权模型下这个用户能看到什么",缺陷修复只会让这个"能看到什么"的范围变得更准确,不需要对接中心本身跟着改。
- **不重排 Level 2 的任何既有交互**。工程化细节留给需要它们的人,不因为 Level 1 存在就删减或简化 Level 2。
