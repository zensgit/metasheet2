# 外部系统删除守卫的二阶指针计数（079 / 062 / 073）— 设计

- 日期：2026-09-20
- 分支：`fix/external-system-delete-secondary-pointer-count`
- 基线：`origin/main` @ `36d659c8a`
- 触碰面：`plugins/plugin-integration-core/lib/external-systems.cjs`、新增 `__tests__/external-systems-delete-dependent-references.test.cjs`、`plugins/plugin-integration-core/test-chain.txt`、`docs/development/data-source-live-id-fk-binding-lock-design-20260920.md:99` 的更正

## 1. 洞在哪

`deleteExternalSystem`（`lib/external-systems.cjs`）删除前只数一张表：`integration_pipelines`
（`countPipelineReferences`）。另有三张表持有指向外部系统的持久化指针，且**都刻意不建 FK**：

| 表 | 列 | 位置 | 语义 |
|---|---|---|---|
| `integration_stock_prep_source_binding`（079） | `external_system_id` | `migrations/079_create_integration_stock_prep_source_binding.sql:45` | 工作台里选源 的持久化绑定（每请求解析，替代 env 默认） |
| `integration_read_source_configs`（062） | `system_id` | `migrations/062_create_integration_read_source_configs.sql:27` | read-source 自助配置版本（draft / approved / retired） |
| `integration_sealed_export_stock_prep_bindings`（073） | `external_system_id` | `migrations/073_create_sealed_export_stock_prep_runtime_authority.sql:19` | sealed-export S6-A runtime 绑定（ACTIVE / RETIRED，`:32`） |

073 与 079/062 完全同形，且**是活的**，不是死代码：写侧是 owner 侧 provisioning CLI
（`scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs:15` →
`lib/sealed-export/stock-preparation-runtime-provisioning.cjs:8` →
`sealed-export-lifecycle-provisioning.cjs:294` 写入 `external_system_id`）；读侧已接线
（`index.cjs:76` → `lib/sealed-export/stock-preparation-sqlserver-runtime.cjs:38` →
`stock-preparation-runtime-store.cjs:14` 的 `BINDING_TABLE`，`:133` 读出该列）；且它读出来的值确实是
`integration_external_systems.id`，由 `stock-preparation-sqlserver-source-authority.cjs:254` 的
`system.id !== binding.externalSystemId` 亲自比对。

079 自己的表头（`079:16-23`）写明了为什么不建 FK：真正要判的资格（kind / status / role / 调用方可用其后的
core data source）不是约束能表达的，悬空 id 由读时 `TABLE_ACTION_SOURCE_INVALID` fail-closed 兜住。
**但 fail-closed 是给读路径的，不是给删除守卫的**：删除守卫不数它们，于是删掉外部系统后 079/062/073 直接悬空
（073 的读侧同理，只是错误词是 `SEALED_EXPORT_BINDING_UNQUALIFIED`）。

### 为什么叫「二阶」

悬空只是第一跳。`DataSourceManager.countExternalSystemReferences` 在删 `data_sources` 时数的是
**外部系统**（`connection_id` / legacy `config->>'dataSourceId'`）。外部系统一旦被删掉：

```
079/062/073 --(指向)--> external_system --(connection_id FK)--> data_sources
                           ^ 删掉这一跳
079/062/073 --(指向)--> (悬空)                                   data_sources 引用计数归零 -> 可删
```

即**删一个没有 pipeline 引用但有 079/062/073 引用的外部系统**，就把它下面数据源的引用计数一并清零，
数据源随后可被删除；而 079/062/073 的行还在，操作者仍以为绑定是活的。本 PR 关闭这条链的第一跳。

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
  ├─ countRows('integration_stock_prep_source_binding',            { tenant_id, external_system_id })
  ├─ countRows('integration_sealed_export_stock_prep_bindings',    { tenant_id, external_system_id, status: 'ACTIVE' })
  ├─ countRows('integration_read_source_configs',                  { tenant_id, system_id, status: 'draft' })
  └─ countRows('integration_read_source_configs',                  { tenant_id, system_id, status: 'approved' })
```

### 四个刻意的口径

**(a) 不按 workspace 过滤。** 与 `countPipelineReferences` 不同，这几个计数只带 `tenant_id` + 指针列（073 另带 status）。
079 的 `workspace_id` 可为 NULL（079:43），而读路径本身就有 `single_workspace_binding` 回退
（`lib/http-routes.cjs:4617-4626`）——一个租户级调用方会被解析到 workspace 级的绑定行上。若按删除请求
自带的 workspace hint 过滤，就会漏掉**读路径仍能到达**的行，守卫假绿。放宽只会**多拒**，不会多给：
每条查询都仍带调用方自己的 `tenant_id`，别的租户的行既不计数也不披露；错误 details 只带计数与 scope 句柄，
不带任何行 id。

073 同样不按 workspace 过滤：它的 `workspace_id` 也可为 NULL（`073:17`），而读侧是拿**行自己的**
`workspace_id` 与调用方 scope 比对（`stock-preparation-runtime-store.cjs:117`），与删除请求自带的
workspace hint 无关。

**(b) 062 只数 draft / approved。** 生命周期 `draft → approved → retired` 且**不可回头**
（`lib/read-source-config-store.cjs:23-28` 的 `STATUS_TRANSITIONS`）。`retired` 是终态历史，不是活指针；
数它会让外部系统因为一条永远不可能被消费的版本行而**永久不可删**。

**(b2) 073 只数 `ACTIVE`。** 073 的状态词表只有 `ACTIVE` / `RETIRED`（`073:32`），而读侧仅在
`status === 'ACTIVE'` 且未过期时才让绑定合格（`stock-preparation-runtime-store.cjs:112-125`，状态判在
`:120`，不合格走 `SEALED_EXPORT_BINDING_UNQUALIFIED`）。`RETIRED` 与 062 的 `retired` 同读：终态历史，
不是活指针。**过期刻意不进过滤**：`expires_at` 过了的 ACTIVE 行仍是一条 owner 可据以重新 provision 的行，
而且一个依赖时间的删除守卫会在两次完全相同的请求之间自己变绿——守卫的判据必须是可重放的。

**(c) 三表缺失按 SQLSTATE `42P01` 容忍，其它错误一律传播。** 没跑过 079/062/073 迁移的部署必须保持原有删除行为；
这是唯一容忍的情形，**按 SQLSTATE 判，绝不读 message 散文**——222 的 PG 是中文 locale，英文
"relation ... does not exist" 根本不出现（同 `translateConnectionFkViolation` 的 23503 口径、
`DataSourceManager.ts:20`）。权限、连接中断、超时等一律抛出且**删除不发生**：读不到自己证据的守卫，
不能当证据说了零。073 是三张表里唯一一张迁移里 `REVOKE ALL ... FROM PUBLIC`（`073:432-446`）、只把权限授予
两个具名部署角色（`:531-602`）的表：API 角色若既非属主也不在其中，这条计数会抛 `42501`，按同一口径传播、
拒绝删除。修法是补一条 SELECT 授权，不是吞掉错误（见残余）。

**(d) 白名单未放宽。** `lib/db.cjs:25` 的 `ALLOWED_PREFIX = 'integration_'`，三张表都已满足。

### 为什么两条 status 查询而不是一条 IN

`lib/db.cjs` 的 `buildWhereClause` 每个键只渲染一次等值比较，**没有 IN**；数组值会被 `prepareParamValue`
JSON 化后塞进 `= $n`，静默匹配不到任何行（即静默假绿）。所以两个活状态写成两条等值查询再求和，
而不是伪装成列表（073 只有一个活状态，所以它就是一条等值查询）。

### 线上形状（未变的部分）

- pipeline 引用命中时，错误 message 逐字不变（`external system is used by pipelines`），
  `referencedPipelineCount` / `sourcePipelineCount` / `targetPipelineCount` 不变
  （`__tests__/http-routes.test.cjs:974` 已在线上形状上）。
- 新增 details 键：`referencedBindingCount`、`stockPrepSourceBindingCount`、`sealedExportBindingCount`、
  `readSourceConfigCount`，全部是计数，values-free（`B-11` 用 `Object.keys(details).sort()` 全等断言钉住，
  多出任何一个带值的键都会红）。
- 仅当 pipeline 计数为 0 而二阶计数 > 0 时，message 才换成
  `external system is used by source bindings or read-source configs`；状态码同为 409。这句是三张表**共用**
  的措辞（073 也是一种 source binding），不按表分叉——分叉等于把「是哪张表挡的」透给调用方。

## 3. 没有做什么

- 不建 FK、不改 079/062/073 的 schema、不写迁移。建 FK 是另一个决定（079 表头解释了为什么当初不建），
  也需要清理存量悬空行，属 owner 可见的单独动作。
- 不改 `data_sources` 侧的 `countExternalSystemReferences`——二阶指针从不指向 `data_sources`。
- 不碰 `http-routes.cjs`、`package.json`、`.github/`、`lib/db.cjs` 的白名单。
- 不清理已存在的悬空 079/062/073 行：本 PR 只阻止**新增**悬空。
- 不给 064 `integration_write_target_configs` 加计数（理由见下，登记为已知未覆盖）。

## 4. 本刀的覆盖面（写成可被一条 grep 证伪的形状）

口径基线：`grep -rn "external_system_id\|system_id" packages/core-backend/migrations/` 命中
**057 / 062 / 064 / 073 / 079** 五个文件（2026-09-20，`origin/main` @ `36d659c8a`）。逐个交代：

| 迁移 | 列 | 本刀 | 为什么 |
|---|---|---|---|
| 057 `integration_pipelines` | `source_system_id` / `target_system_id`（`057:58`、`:60`） | 不需要 | 是**真 FK** `REFERENCES integration_external_systems(id) ON DELETE RESTRICT`，数据库自己拒；另有 `countPipelineReferences` 给出 409 而不是裸 23503 |
| 079 `integration_stock_prep_source_binding` | `external_system_id`（`079:45`） | **计数** | 见上 |
| 062 `integration_read_source_configs` | `system_id`（`062:27`） | **计数**（draft / approved） | 见上 |
| 073 `integration_sealed_export_stock_prep_bindings` | `external_system_id`（`073:19`） | **计数**（ACTIVE） | 见上 |
| 064 `integration_write_target_configs` | `system_id` / `sandbox_system_id`（`064:19-20`） | **不计数（已知未覆盖）** | store 今天是休眠的：`createWriteTargetConfigStore` 只在 `lib/write-target-config-store.cjs:134` 定义、`:356` 导出，全仓 `__tests__/` 之外零实例化，所以生产上不应有行 |

073 内除 bindings 外没有第二个持指针列：同文件里 `external_system_id` 的另两处（`:245`、`:261`）是同表的
锚点不可变触发器，不是新指针。

**接线 064 的人必须同时在 `countDependentBindingReferences` 里加上它的计数**——这句话就是本表存在的理由。

## 5. 残余

- **（2026-09-25 后续）计数与 DELETE 之间无事务/行锁，并发 bind/delete 未封**——owner 复审登记（`autonomous-run-20260921-outcome.md` 第 6 节「Q2/#5923（订正）」）。已由锁协议收口：删除方同一事务内先 `FOR UPDATE` 再计数再删除，079/062/pipelines 写入方在各自写事务内先 `FOR KEY SHARE`；073 写入方（冻结 S6-A 模块 + provisioning 角色无权限）登记为 owner 决定的残余。见 `docs/development/external-system-delete-bind-lock-protocol-design-20260925.md`。

- **存量悬空行**：本 PR 之前删掉的外部系统留下的 079/062/073 行仍在，仍只在读时 fail-closed。盘点/清理需要
  连真实库，属 owner 侧动作。
- **一阶之外的第二跳**：外部系统被正确挡住后，`data_sources` 侧的覆盖不变（见上一份设计的第 7 节）。
- **064 未覆盖**：见上表。休眠不等于永远不醒；醒的那天这条计数是必做项。
- **073 在仓内没有退场路径**：写侧只写 `status: 'ACTIVE'`（`sealed-export-lifecycle-provisioning.cjs:294`），
  全仓（`plugins/plugin-integration-core/` 非测试面）没有任何一处把 073 行置为 `RETIRED`，且锚点列被
  不可变触发器钉死（`073:237-279` 的 `..._binding_anchors_immutable`）。于是一个已 provision 过 sealed-export 的外部系统，在本 PR 之后
  **只能由 owner 侧先退掉/删掉绑定行才能删**。方向是 fail-closed（宁可拦住也不制造悬空），但这是一项
  新增的操作代价，须让 owner 知道。
- **062 的 draft 也没有直接退场路径**：`read-source-config-store.cjs:25-28` 的 `STATUS_TRANSITIONS` 合法迁移只有
  `approve(draft→approved)` 与 `retire(approved→retired)`，该 store 全文没有 delete/discard。每次
  `saveVersion` 都会铸一个新 draft，于是任何被自助配置过的外接源，只要历史上留下过 draft，就必须逐个
  approve 再 retire 才能删。可经既有路由解除（store 的 approve / retire 已被路由层接线，`http-routes.cjs:3679`），属操作代价。
- **073 的 SELECT 授权**：073 的表对 PUBLIC 是 REVOKE 的。若某部署的 API 角色没有 SELECT，删除会以 `42501`
  被拒（B-14 钉住这条）。这是 fail-closed 的正确方向，但**部署侧需要补授权**，否则外部系统删不掉。
- **每次删除多发 4 条 COUNT**（079 一条 + 073 一条 + 062 两条）。删除是低频写路径，`Promise.all` 的每个分支
  都有 handler，不会产生 unhandled rejection。
- **加表不会被自动发现**：测试里 `countCalls` 的键断言能让「悄悄加了 workspace 过滤」立刻变红，但新增一张
  同形表不会自动进计数；上面那张覆盖面表就是给下一个人看的清单。
