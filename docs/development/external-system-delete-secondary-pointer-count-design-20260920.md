# 外部系统删除守卫的二阶指针计数（079 / 062）— 设计

- 日期：2026-09-20
- 分支：`fix/external-system-delete-secondary-pointer-count`
- 基线：`origin/main` @ `36d659c8a`
- 触碰面：`plugins/plugin-integration-core/lib/external-systems.cjs`、新增 `__tests__/external-systems-delete-dependent-references.test.cjs`、`plugins/plugin-integration-core/test-chain.txt`、`docs/development/data-source-live-id-fk-binding-lock-design-20260920.md:99` 的更正

## 1. 洞在哪

`deleteExternalSystem`（`lib/external-systems.cjs`）删除前只数一张表：`integration_pipelines`
（`countPipelineReferences`）。另有两张表持有指向外部系统的持久化指针，且**都刻意不建 FK**：

| 表 | 列 | 位置 | 语义 |
|---|---|---|---|
| `integration_stock_prep_source_binding`（079） | `external_system_id` | `migrations/079_create_integration_stock_prep_source_binding.sql:45` | 工作台里选源 的持久化绑定（每请求解析，替代 env 默认） |
| `integration_read_source_configs`（062） | `system_id` | `migrations/062_create_integration_read_source_configs.sql:27` | read-source 自助配置版本（draft / approved / retired） |

079 自己的表头（`079:16-23`）写明了为什么不建 FK：真正要判的资格（kind / status / role / 调用方可用其后的
core data source）不是约束能表达的，悬空 id 由读时 `TABLE_ACTION_SOURCE_INVALID` fail-closed 兜住。
**但 fail-closed 是给读路径的，不是给删除守卫的**：删除守卫不数它们，于是删掉外部系统后 079/062 直接悬空。

### 为什么叫「二阶」

悬空只是第一跳。`DataSourceManager.countExternalSystemReferences` 在删 `data_sources` 时数的是
**外部系统**（`connection_id` / legacy `config->>'dataSourceId'`）。外部系统一旦被删掉：

```
079/062 --(指向)--> external_system --(connection_id FK)--> data_sources
                       ^ 删掉这一跳
079/062 --(指向)--> (悬空)                                   data_sources 引用计数归零 -> 可删
```

即**删一个没有 pipeline 引用但有 079/062 引用的外部系统**，就把它下面数据源的引用计数一并清零，
数据源随后可被删除；而 079/062 的行还在，操作者仍以为绑定是活的。本 PR 关闭这条链的第一跳。

### 对上一份设计文档 `:99` 的更正

`docs/development/data-source-live-id-fk-binding-lock-design-20260920.md:99` 原文把 079 与
read-source-config store 登记为「**其它持 dataSourceId 指针**但删除守卫不计数的表」。这是**错的**：
079 存 `external_system_id`（079:45），062 存 `system_id`（062:27），两者指向的都是**外部系统**，
不是 `data_sources`。所以它们本就不该进 `countExternalSystemReferences`，也不该有指向 `data_sources`
的 FK——那一节的覆盖矩阵不因本 PR 变化。该行已改写为「二阶指针（`external_system_id` / `system_id`）
由外部系统删除守卫计数（本 PR）」。

## 2. 改法

`lib/external-systems.cjs` 新增 `countDependentBindingReferences({ tenantId, id })`，
`deleteExternalSystem` 在原 pipeline 计数之后调用它，两类计数**任一 > 0 即抛同一个**
`ExternalSystemConflictError`（`http-routes.cjs:871` 按名字里的 `Conflict` 映 409）。

```
countDependentBindingReferences
  ├─ countRows('integration_stock_prep_source_binding', { tenant_id, external_system_id })
  ├─ countRows('integration_read_source_configs',       { tenant_id, system_id, status: 'draft' })
  └─ countRows('integration_read_source_configs',       { tenant_id, system_id, status: 'approved' })
```

### 三个刻意的口径

**(a) 不按 workspace 过滤。** 与 `countPipelineReferences` 不同，这两个计数只带 `tenant_id` + 指针列。
079 的 `workspace_id` 可为 NULL（079:43），而读路径本身就有 `single_workspace_binding` 回退
（`lib/http-routes.cjs:4617-4626`）——一个租户级调用方会被解析到 workspace 级的绑定行上。若按删除请求
自带的 workspace hint 过滤，就会漏掉**读路径仍能到达**的行，守卫假绿。放宽只会**多拒**，不会多给：
两条查询都仍带调用方自己的 `tenant_id`，别的租户的行既不计数也不披露；错误 details 只带计数与 scope 句柄，
不带任何行 id。

**(b) 062 只数 draft / approved。** 生命周期 `draft → approved → retired` 且**不可回头**
（`lib/read-source-config-store.cjs:23-28` 的 `STATUS_TRANSITIONS`）。`retired` 是终态历史，不是活指针；
数它会让外部系统因为一条永远不可能被消费的版本行而**永久不可删**。

**(c) 两表缺失按 SQLSTATE `42P01` 容忍，其它错误一律传播。** 没跑过 079/062 迁移的部署必须保持原有删除行为；
这是唯一容忍的情形，**按 SQLSTATE 判，绝不读 message 散文**——222 的 PG 是中文 locale，英文
"relation ... does not exist" 根本不出现（同 `translateConnectionFkViolation` 的 23503 口径、
`DataSourceManager.ts:20`）。权限、连接中断、超时等一律抛出且**删除不发生**：读不到自己证据的守卫，
不能当证据说了零。

### 为什么两条 status 查询而不是一条 IN

`lib/db.cjs` 的 `buildWhereClause` 每个键只渲染一次等值比较，**没有 IN**；数组值会被 `prepareParamValue`
JSON 化后塞进 `= $n`，静默匹配不到任何行（即静默假绿）。所以两个活状态写成两条等值查询再求和，
而不是伪装成列表。**没有放宽 `db.cjs` 的表白名单**：`ALLOWED_PREFIX = 'integration_'`，两张表都已满足。

### 线上形状（未变的部分）

- pipeline 引用命中时，错误 message 逐字不变（`external system is used by pipelines`），
  `referencedPipelineCount` / `sourcePipelineCount` / `targetPipelineCount` 不变
  （`__tests__/http-routes.test.cjs:974` 已在线上形状上）。
- 新增 details 键：`referencedBindingCount`、`stockPrepSourceBindingCount`、`readSourceConfigCount`，
  全部是计数，values-free。
- 仅当 pipeline 计数为 0 而二阶计数 > 0 时，message 才换成
  `external system is used by source bindings or read-source configs`；状态码同为 409。

## 3. 没有做什么

- 不建 FK、不改 079/062 的 schema、不写迁移。建 FK 是另一个决定（079 表头解释了为什么当初不建），
  也需要清理存量悬空行，属 owner 可见的单独动作。
- 不改 `data_sources` 侧的 `countExternalSystemReferences`——二阶指针从不指向 `data_sources`。
- 不碰 `http-routes.cjs`、`package.json`、`.github/`、`lib/db.cjs` 的白名单。
- 不清理已存在的悬空 079/062 行：本 PR 只阻止**新增**悬空。

## 4. 残余

- **存量悬空行**：本 PR 之前删掉的外部系统留下的 079/062 行仍在，仍只在读时 fail-closed。盘点/清理需要
  连真实库，属 owner 侧动作。
- **一阶之外的第二跳**：外部系统被正确挡住后，`data_sources` 侧的覆盖不变（见上一份设计的第 7 节）。
- **别的持指针表**：全仓穷举只找到这两张按外部系统 id 持久化指针的表；将来新增同形表需要同步进这个计数
  （测试里 `countCalls` 的键断言会让「悄悄加了 workspace 过滤」立刻变红，但加表不会自动被发现）。
