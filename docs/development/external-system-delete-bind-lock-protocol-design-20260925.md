# 外部系统删除 × 指针写入：锁协议（删除方 FOR UPDATE + 写入方 FOR KEY SHARE）— 设计与验证

- 日期：2026-09-25
- 分支：`fix/external-system-delete-bind-lock-protocol`
- 基线：`origin/main` @ `b736c7f5c`
- 收口对象：owner 复审登记的 #5923 残余（`docs/development/autonomous-run-20260921-outcome.md` 第 6 节「Q2/#5923（订正）」）：「守卫只封串行删除……计数与删除之间没有事务或行锁；计数之后提交的并发 bind 不会被拦住」；「仅给删除加事务不够，写入方必须共同参与约束/锁协议」。
- 前一刀：`docs/development/external-system-delete-secondary-pointer-count-design-20260920.md`（#5923：删除前串行计数 079/062/073）。
- 同类先例：`docs/development/data-source-live-id-fk-binding-lock-design-20260920.md`（#5784 ② 数据源删除 × 绑定：删除侧 FOR UPDATE + 绑定侧经 FK 取 KEY SHARE）。本刀把同一形状搬到「外部系统 × 指针表」这一层——区别在于指针表**刻意没有 FK**，所以写入方的 KEY SHARE 必须由应用层显式取。

---

## 1. 洞在哪（机器证据）

`deleteExternalSystem`（改动前 `plugins/plugin-integration-core/lib/external-systems.cjs`）：`selectOne` → `countPipelineReferences` → `countDependentBindingReferences` → `deleteRows`，四段各自 autocommit。计数与 DELETE 之间没有任何锁，写入方提交一条指针（079 `external_system_id` / 062 `system_id` / 073 `external_system_id`）不会与之冲突——这三张表刻意不建 FK（`migrations/079_create_integration_stock_prep_source_binding.sql:16-23`）。于是「删除方计数为零 → 写入方提交指针 → 删除方 DELETE」两者都成功，留下悬空。

真 PG 上重现（`packages/core-backend/tests/integration/external-system-delete-bind-lock-protocol.db.test.ts` 的 `NEC` 用例）：会话 D `BEGIN; SELECT; COUNT=0`，会话 W 提交一条 079 指针，D `DELETE; COMMIT` → `integration_external_systems` 中该行为 0、`integration_stock_prep_source_binding` 中指向它的行为 1。同一份用例对 `origin/main` 的插件代码跑（见第 7 节「旧红」）：8 个协议用例全红，因为任何一方都不曾等锁。

**仅给删除加事务为什么不够**：READ COMMITTED 下事务里的 COUNT 只是一个快照，写入方随时可以让它失效；只有一把与写入方冲突的行锁才能把「计数」变成「决定」。

## 2. 协议

写在 `plugins/plugin-integration-core/lib/external-system-pointer-lock.cjs` 的文件头（协议的完整说明就放在那里，代码注释与本节一致）：

| 侧 | 位置 | 做法 |
|---|---|---|
| 删除方 | `lib/external-systems.cjs` `deleteExternalSystem`（`:1390`） | **一个事务**（`:1407`），**第一条语句**是 `SELECT … FOR UPDATE` 锁住外部系统行（`:1412`），然后在**同一事务句柄**上计数 pipelines ×2 + 079 + 073 + 062 ×2（`:1231`、`:1346`），然后 DELETE（`:1448`）。任一计数非零 → 事务内抛 409 `ExternalSystemConflictError` → 回滚。 |
| 写入方 | `lib/external-system-pointer-lock.cjs` `lockExternalSystemForPointerWrite`（`:76`，落到 `db.selectOneForKeyShare`，`lib/db.cjs:244` 渲染 `… LIMIT 1 FOR KEY SHARE`，`:251`）——079 与 062 经它；pipelines/templates **不经它**：`pipelines.cjs` `requireExternalSystem`（`:465`）直接调 `db.selectOneForKeyShare`，where 是 pipeline 自己的 `scopeWhere(normalized)` + id（第 2.5 节） | 在**自己的写事务内、碰指针行之前**对将要指向的外部系统行取 `FOR KEY SHARE`；读回 `null`（本租户不存在，或删除在自己等锁期间已提交——刻意不区分）→ 按该路径**既有的 values-free 错误形状**拒绝，且不写任何东西。 |

两种交错都由数据库锁管理器封闭，不靠时序：

- **删除在前**：D 持 FOR UPDATE，计数为零，W 的 KEY SHARE 等待；D COMMIT 后 W 恢复、重读（PG 的 EvalPlanQual 重查）得 `null` → W 拒绝，指针 0 行。
- **写入在前**：W 持 KEY SHARE，D 的 FOR UPDATE 等待；W COMMIT 后 D 恢复、计数（READ COMMITTED 下每条语句在等锁之后取新快照）看见指针 → 409，系统行保留。

**隔离级别**：READ COMMITTED（部署实际级别）足够——保证建立在显式行锁 + 等锁后的新快照上，不依赖 SERIALIZABLE。

### 2.1 为什么 KEY SHARE 而不是 FOR SHARE（取舍）

写入方只需要一件事：在它 COMMIT 之前该行**不被删除、主键不变**。`FOR KEY SHARE` 只与 `FOR UPDATE`（DELETE、改键 UPDATE 都取它）冲突，与 `FOR NO KEY UPDATE`（普通 UPDATE，改 name/config/status）不冲突；所以：

- 绑定写入不会卡住管理员同时改同一个外部系统的名字/配置，反之亦然；
- 两个写入方互不阻塞（KEY SHARE 与 KEY SHARE 相容，`P-MIX` 用例实证）；
- 这正是 PG 自己的 RI 检查对被引用行取的锁，所以应用层参与者对「不被删」这一目的**与 FK 同强**。

`FOR SHARE` 会与 `FOR NO KEY UPDATE` 冲突，把指针写入和每一次配置编辑串行化，却不多换来任何保护。刻意不用。

PG 对任何锁子句都要求目标表**至少一列的 UPDATE 权限**（`SELECT` 文档；这也是迁移 075 存在的原因）。API 角色是表属主，不受影响；073 的 provisioning 角色**没有** `integration_external_systems` 上的任何权限，见第 5 节。

### 2.2 锁序与成环排查

全局顺序（无环）：**`data_sources` 行 → `integration_external_systems` 行 → 指针表行**。

| 路径 | 取锁顺序 | 出处 |
|---|---|---|
| 数据源删除（#5784 PR-A） | `data_sources` FOR UPDATE → 只 COUNT 外部系统（不取锁） | `packages/core-backend/src/data-adapters/DataSourceManager.ts:1070` |
| 外部系统写入（绑定 connection_id） | `data_sources` KEY SHARE（FK RI） → 外部系统行 | `external-systems.cjs` upsert；FK `fk_integration_external_systems_live_connection_id` |
| **外部系统删除（本刀）** | 外部系统行 FOR UPDATE → 只 COUNT 指针表（COUNT 不取行锁） → DELETE 自己那一行 | `external-systems.cjs:1412` → `:1231/:1346` → `:1448`；删除子表行不对父表取锁 |
| 079 `set` | 外部系统 KEY SHARE → 绑定行（select / update / insert） | `stock-preparation-source-binding-store.cjs:315` 在 `trx.selectOne(BINDING_TABLE)` 之前 |
| 062 `saveVersion` | 外部系统 KEY SHARE → 家族扫描 → INSERT 版本 → INSERT 审计 | `read-source-config-store.cjs:271` 在 `trx.select(CONFIG_TABLE)` 之前 |
| pipelines `upsertPipeline` / templates `instantiateTemplate` | 源系统 KEY SHARE → 目标系统 KEY SHARE → pipeline 行 → field mappings | `pipelines.cjs:465-469`（`writePipelineRow :516` 内）；templates 在 `integration-templates.cjs:472` 的事务里调用 `:484` |
| 073 `provisionInitialStockPreparationBinding`（**未参与**） | 073 绑定行 FOR UPDATE（`sealed-export-lifecycle-provisioning.cjs:491`）→ 授权表 → INSERT（`:547`） | 不取外部系统锁——见第 5 节 |

**「先锁指针表再锁系统行」的路径存在吗？** 全仓（`plugins/plugin-integration-core/lib`）对外部系统行取锁的调用只有本刀新增的几处（grep `selectOneForKeyShare(` / `lockExternalSystemForPointerWrite(` / `selectOneForUpdate(TABLE`），它们都是各自事务的**第一条**语句；唯一先锁指针行的路径是 073（`:491` 的 FOR UPDATE），而它根本不取系统锁，所以不与删除方形成「A 持系统锁等指针锁、B 持指针锁等系统锁」的环。删除方也从不对指针行取锁（COUNT 不取锁；`L-10` 用例钉住「删除事务只取一把行锁」）。两个写入方在两个系统上以相反顺序取 KEY SHARE 也不会死锁：KEY SHARE 与 KEY SHARE 相容，没有等待发生（`P-MIX`）。唯一索引等待（079 scope 唯一索引、062 版本唯一索引）只在两个 INSERT 之间发生，删除方不参与，也不成环。

### 2.3 42P01 容忍搬到事务前面

前一刀容忍「部署没跑过 079/062/073」（按 SQLSTATE `42P01` 判、放行删除）。事务内的 42P01 会让 PG 中止事务（后续语句 25P02），放行会静默变成拒绝。所以 `probeAbsentDependentTables`（`external-systems.cjs:1300`）在事务**之前**用 autocommit COUNT 探一次三张表是否存在——**探针的计数值丢弃**（没有锁、正是本协议要替换的那个快照），只保留缺失集合；事务内按缺失集合跳过。非 42P01 错误（42501、08006…）仍从探针处传播、删除不发生，与前一刀一致（B-07/B-08/B-14 仍绿）。代价：每次删除多 4 条 COUNT（删除是低频路径）。

### 2.4 错误形状（全部沿用各路径既有词表）

| 路径 | 锁后读到 `null` | 状态码 | 出处 |
|---|---|---|---|
| 079 `set` | `StockPreparationSourceBindingStoreError` code **`SOURCE_BINDING_SOURCE_NOT_LIVE`**，details 只带 `actionId` | 409（`sendError` 优先取 `.status`；与 `SOURCE_BINDING_WRITE_CONFLICT`、#5784 的 `EXTERNAL_SYSTEM_CONNECTION_NOT_LIVE` 同类） | `stock-preparation-source-binding-store.cjs:54`；路由在调用 `set` 之前已用 `assertBindableSource` 404 过看不见的系统，所以事务内的拒绝按构造就是与并发删除的冲突 |
| 062 `saveVersion` | `ReadSourceConfigValidationError`，`errors: [{ code: 'READ_SOURCE_SYSTEM_NOT_FOUND', field: 'systemId', reason: 'not_found' }]` | 400 `READ_SOURCE_CONFIG_INVALID`（`http-routes.cjs mapReadSourceConfigError`，形状不变） | `read-source-config-store.cjs:111` |
| pipelines / templates | `PipelineValidationError('sourceSystemId does not exist in this tenant/workspace')`（原句逐字） | 400（`/Validation/`） | `pipelines.cjs:472-474`。之前这条路径若输掉竞争会一路走到 INSERT 撞 057 的 FK，以裸 23503 上抛（`P-PIPE-A` 在 WPIPE 变异体上实测就是这个形状） |
| 删除方 | `ExternalSystemConflictError`，message/details 与前一刀逐字相同（pipeline 命中仍是 `external system is used by pipelines`） | 409 | `external-systems.cjs:1427-1443` |

values-free：`L-01`/`P-079-A` 断言拒绝 details 的 JSON 不含系统 id；062 的 tuple 只有 field/reason；`L-10` 断言 079 写入方（经 `lockExternalSystemForPointerWrite`）锁的 where 键恰为 `['id','tenant_id']`（无 workspace 键，与删除守卫的依赖计数同域）；`L-11` 断言 pipelines 写入方锁的 where 键为 `['id','tenant_id','workspace_id']`、删除方 pipelines 计数为 `['source_system_id'|'target_system_id','tenant_id','workspace_id']`、079/073/062 计数无 workspace 键（第 2.5 节）。

### 2.5 作用域：谁按 workspace 过滤（第二轮复审订正——第一版正文的保证 2、4 把 pipelines 写反了）

| 路径 | 锁 / 计数的 where | 出处 | 真 PG 抓到的 SQL（PG 16.10，本机） |
|---|---|---|---|
| 079 `set` 锁 | `tenant_id` + `id` | `external-system-pointer-lock.cjs:84-87` | `WHERE "tenant_id" = $1 AND "id" = $2 LIMIT 1 FOR KEY SHARE` |
| 062 `saveVersion` 锁（铸新版本时） | `tenant_id` + `id` | 同上 | 同上 |
| pipelines / templates `requireExternalSystem` 锁 | `tenant_id` + `workspace_id` + `id`（`scopeWhere(normalized)` + id——**原有形状**，本刀只把 `selectOne` 换成 KEY SHARE 读） | `pipelines.cjs:469-472` | `WHERE "tenant_id" = $1 AND "workspace_id" IS NULL AND "id" = $2 LIMIT 1 FOR KEY SHARE`（源、目标各一条） |
| 删除方 079 / 073 / 062 计数 | `tenant_id` + 指针列（073、062 另带 `status`），**无 workspace** | `external-systems.cjs:1276-1290`、`:1346` | `WHERE "tenant_id" = $1 AND "external_system_id" = $2`（073 另 `AND "status" = $3`；062 按两个活状态各一条） |
| 删除方 pipelines 计数 | `tenant_id` + `workspace_id` + 指针列（`scopeWhere`，#5923 **原有**——前一刀设计文档第 (a) 条本来就写着「与 `countPipelineReferences` 不同」） | `external-systems.cjs:1231-1242` | `WHERE "tenant_id" = $1 AND "workspace_id" IS NULL AND "source_system_id" = $2`（target 同形） |

**为什么不是协议漏洞**：pipeline 写入方的 where 与删除方 pipelines 计数是**同一个作用域**——一条 pipeline 只能命名它自己 workspace 里的系统，where 不命中就在写任何东西之前被 `PipelineValidationError` 拒绝；命中时锁住的就是删除方 `FOR UPDATE` 的同一物理行（`id` 是主键）。作用域之外的配对由 057 的真 FK 兜底：一条 ws2 的 pipeline 行指向租户级系统**只能靠裸 INSERT 造出来**，删除方计数不到它，DELETE 撞 FK 以 `23503` 失败、系统行保留（真 PG 实证：不是 409，也不是悬空；旧代码同样如此）。

**执行后果（原有行为，不是本刀引入）**：ws1 下写 pipeline 命名租户级（`workspace_id IS NULL`）系统 → `PipelineValidationError: sourceSystemId does not exist in this tenant/workspace`；同一对经 079 `set` / 062 `saveVersion` 成功（tenant_id + id）。`L-11`（内存）把三种 where 形状与这条执行后果一起钉住；`external-system-pointer-lock.cjs` 文件头「NOT EVERY WRITER GOES THROUGH THIS HELPER」一段同步。

### 2.6 062 复用路径在锁之前——登记的例外（第二轮复审订正保证 9）

`saveVersion` 的内容键复用查找（`read-source-config-store.cjs:258-260` → `reuseExisting :214-230`）在事务与锁**之前**执行，且**不看系统是否存在**。只有铸新版本（内容键在家族里未命中）才进事务、取 KEY SHARE、判系统存在。所以「本租户内不存在的 systemId → 400」**只对铸造路径成立**。两个真 PG 实证的例外（本机 PG 16.10，中文 locale；PR head 模块）：

| 情形 | 结果 | 锁 | 落行 / 审计 |
|---|---|---|---|
| (A) 保存 → approve → retire → 删除系统（retired 不计数，删除放行）→ **相同内容**再存 | `ReadSourceConfigConflictError { id: <配置 id>, reason: 'content_retired' }`，路由映射 409 `READ_SOURCE_CONFIG_STATUS_CONFLICT` | 0 条 `FOR KEY SHARE`，不开事务 | 不落行、不落审计 |
| (B) 存量活行（协议之前铸的、系统在本租户不存在）以**相同内容**再存 | `{ reused: true }`，路由 200 | 0 条 `FOR KEY SHARE` | 不铸新行；**新增 1 条 `reuse_version` 审计** |
| (A)/(B) 换**新内容** | `ReadSourceConfigValidationError` tuple `{ READ_SOURCE_SYSTEM_NOT_FOUND, systemId, not_found }`，路由 400 | 1 条 KEY SHARE（读到 null） | 不落行、不落审计 |

登记位置：`R-062-REUSE-A/B`（内存，断言调用日志里没有 `selectOneForKeyShare`、没有 `BEGIN`）、`P-062-REUSE-A/B`（真 PG，断言会话语句里没有 `FOR KEY SHARE`）、契约车道「登记例外 A/B」（真 handler：409 `READ_SOURCE_CONFIG_STATUS_CONFLICT` / 200 `reused:true`）。**owner 决定**：若要「一律 400」，须把存在性检查（或锁）挪到复用分支之前——对外可见的行为变化（同内容再存从 200/409 变 400，且要为 retired 复用多取一次锁），本刀不做；做的人连同这些登记一起退掉。

## 3. 写入点穷举（先 grep 再动手）

口径：`grep -rn "integration_stock_prep_source_binding\|integration_read_source_configs\|integration_sealed_export_stock_prep_bindings\|integration_pipelines"` 于 `plugins/plugin-integration-core/lib`、`index.cjs`、`scripts/`、`packages/core-backend/src`（排除测试与 docs），加上 `packages/core-backend/migrations` / `scripts/ops` 的 `INSERT INTO` 扫描。命中并逐条交代：

| 指针表 | 写入点 | 本刀 | 说明 |
|---|---|---|---|
| 079 | `stock-preparation-source-binding-store.cjs` `set`（insert 分支 + update/rebind 分支） | **参与**（`:315`，两个分支共用） | 唯一写入者；`get` 只读。`stock-preparation-handoff-store.cjs:25` 只是注释里引用 079 作先例，不写它 |
| 062 | `read-source-config-store.cjs` `saveVersion`（铸新 draft） | **参与**（`:271`） | `reuseExisting`（`:214`）返回既有行、不写指针；`transition` approve（draft→approved，两者都是活状态）/ retire（活→终态）不制造新的活指针，不需要锁（若未来加「un-retire」，必须进协议） |
| 062 | `read-source-composition-config-store` | 不写 `system_id` | 只引用 config id |
| pipelines | `pipelines.cjs` `upsertPipeline`（create + update） | **参与**（`requireExternalSystem :465` 改为 KEY SHARE 读；`upsertPipeline :589` 改为**恒**在 `db.transaction` 内，`:601`；之前只有带 fieldMappings 时才开事务，autocommit 下的锁在语句结束即释放） | 057 有真 FK：PG 的 RI 检查本就对被引用行取 KEY SHARE。显式锁的增益是：输掉竞争时以既有 `PipelineValidationError` 拒绝而不是裸 23503（WPIPE 变异体实测：去掉显式锁后 `P-PIPE-A` 得到的是 pg `DatabaseError`——FK 兜底仍无悬空，但错误形状退化） |
| pipelines | `integration-templates.cjs` `instantiateTemplate` | **同一代码路径**（`:472` 事务内 `:484` 调 `writePipelineRow`） | `L-09` 结构钉 + `integration-templates.test.cjs` 的假件已带 `selectOneForKeyShare` |
| pipelines | `integration-templates.cjs` `upsertTemplate` | 不写 pipelines | 只写 templates 表 |
| 073 | `sealed-export/sealed-export-lifecycle-provisioning.cjs` `provisionInitialStockPreparationBinding`（`:466`，INSERT 在 `:547`） | **未参与——登记残余**，第 5 节 | 唯一写入者；`stock-preparation-runtime-store.cjs` 只写 runs 表；`sealed-export-package-provenance.cjs` 只把表名列入清单 |
| 任意 | 迁移回填 / `scripts/ops` | 无 | `packages/core-backend/migrations`、`scripts/ops` 无对这四张表的 `INSERT`；`scripts/ops/multitable-onprem-package-verify.sh` 只在清单里提到 073 表名 |
| 064 `integration_write_target_configs` | store 休眠 | 沿用前一刀口径 | 接线它的人同时补计数与写入方锁 |

## 4. 触碰面

- `lib/db.cjs`：新增 `selectOneForKeyShare`（根句柄与事务句柄，`:244`、`:409`）——按模块头「新增经校验方法」的扩展条款，同白名单、同参数化，无原生 SQL 出口。`externalModules.pluginDb` pin 重算（`s6a-package-provenance-pins.json:59`，前例 #5101 同法）。
- 新增 `lib/external-system-pointer-lock.cjs`：写入方半边的唯一入口，缺 `selectOneForKeyShare` 的句柄直接拒绝（不降级为普通 SELECT）。
- `lib/external-systems.cjs`：删除侧事务化 + FOR UPDATE + 探针；计数函数改为接受执行器。
- `lib/stock-preparation-source-binding-store.cjs`、`lib/read-source-config-store.cjs`：构造时要求 `selectOneForKeyShare`（与既有「transaction 必需」同一姿态）；写事务第一条语句取锁。
- `lib/pipelines.cjs`：如上。
- `lib/http-routes.cjs`、`index.cjs`、`package.json`、`.github/`：未动。
- 测试假件：13 个既有套件的内存 db 补 `selectOneForKeyShare` / `selectOneForUpdate` / `transaction`（凡不是本刀主题的假件一律「任何 id 都活」，并注明存在性语义由协议套件负责）；**插件目录之外还有一个消费者**——`scripts/ops/scenario-b-replay-contract.test.mjs`（把回放脚本接到真 `http-routes` + 真 `read-source-config-store` 上，由 `scenario-b-replay-verify.yml` 按 `plugins/plugin-integration-core/lib/**` 触发），第一版漏补、把该车道打红（5/5）；补法**不是**「任何 id 都活」：它的 `selectOneForKeyShare` 按 tenant_id + id 去登记替身里解析（系统登记在替身、不在内存 db 的表中），查不到返回 null，并新增两条用例钉住「未登记 / 已删除 / 别租户的同 id → 400 `READ_SOURCE_CONFIG_INVALID` + `READ_SOURCE_SYSTEM_NOT_FOUND` tuple，不落行不落审计不回显 id」；其 F3 反例用例因此改为先经真 `externalSystemsUpsert` 登记再保存（与脚本 REGISTER_SYSTEM → SAVE_CONFIG 同序）；`db.test.cjs` 的方法面清单与 `gip-server-bound-source-executor.test.cjs` 的导出面清单按新增项更新；`external-systems-delete-dependent-references.test.cjs` 的 B-02/B-12 改为断言**事务内**那一次计数（探针使每张表计数两次），并把内存变异器改为 CRLF 归一（本机 `core.autocrlf=true` 检出下 M-5 的多行锚点本就假红）。

## 5. 残余：073 sealed-export 绑定写入方未参与（owner 决定）

写入方是冻结的 S6-A 模块 `sealed-export-lifecycle-provisioning.cjs`（`s6a-package-provenance-pins.json:45` 的 s6 pin，自 #4694 以来从未重算），以 provisioning 角色运行（`stock-preparation-runtime-database.cjs:127` 断言 `current_user` 就是它），而 073/074/075 三份迁移对 `integration_external_systems` **零授权**（`grep integration_external_systems` 于三份迁移无命中；073 `:432-446` 对 PUBLIC REVOKE 的是 sealed-export 自己的表，`:609-635` 给 provisioning 角色的也只有那些表）。PG 要求锁子句至少一列 UPDATE 权限，所以哪怕改了模块，KEY SHARE 也会以 42501 被拒。

两种可行修法，**都是 DDL、都要 owner 授权**，本刀不做：

1. **FK 走生成列**（#5784 `live_id` 形状）：073 加 `live_external_system_id GENERATED ALWAYS AS (CASE WHEN status='ACTIVE' THEN external_system_id END) STORED` + `REFERENCES integration_external_systems(id) ON DELETE RESTRICT NOT VALID`。RI 检查以表属主权限执行，provisioning 角色无需新授权；冻结模块一字不改；存量悬空由 NOT VALID 容忍。RETIRED 行不入 FK，与守卫「只数 ACTIVE」一致。
2. **授权 + 改冻结模块**：新迁移给 provisioning 角色 `SELECT` + 单列 `UPDATE`（075 的最小授权形状）于 `integration_external_systems`，模块在 `:491` 之前取 KEY SHARE，s6 pin 重算——等于改动已批准的 S6-A 包。

在此之前，073 的两个交错都敞开（写入方不取锁，删除方的 FOR UPDATE 无从等待）。**机器钉住**：`R-073` 用例（内存与真 PG 各一）断言悬空**确实发生**；修掉它的人必须连同这条登记一起退掉。已考虑并否决的半措施：删除方对 073 表 `LOCK TABLE … IN SHARE MODE` 只封「写入在前」一半、需要 API 角色在 073 表上的 UPDATE/DELETE 权限（073 对 PUBLIC 已 REVOKE），且 `db.cjs` 无此方法。

## 6. CI 接线

- **插件内存套件**（`__tests__/external-systems-delete-bind-lock-protocol.test.cjs`，登记于 `test-chain.txt:40`，紧接同族 `:39`）：带行锁冲突表与缓冲事务的内存 db，跑 `integration-guard` 的「hermetic, no DB」链与 `plugin-tests.yml`。覆盖 L-01…L-11、F-25P02、FC-01…FC-07、R-062-REUSE-A/B、R-073、M-D1/M-W079/M-W062/M-WPIPE 四个去锁变异 + M-FC-LOCK/M-FC-079/M-FC-062/M-FC-PIPE 四个「守卫降级为无锁读」变异（源文本 → `_compile`，不落盘）。第二轮复审补的：
  - **F-25P02 + 事务句柄语义**：内存 db 的事务句柄按单连接串行执行语句，任一语句抛错后事务标记 aborted、后续语句一律抛 `{ code: '25P02' }`（同族 `external-systems-delete-dependent-references` 的内存 db 同样改法）。没有这条语义，复审变异 X4（`external-systems.cjs` `if (absentTables.has(table)) return 0` → `if (false) return 0`，即在事务内对缺表计数）在全部内存套件上是绿的、只在真 PG 上红——现在 `dependent-references` 的 **B-06** 直接红（错误码 25P02、行未删），并新增 **M-6** 变异体常驻；B-06 还多钉一条不依赖 25P02 语义的见证：三张缺表各被 autocommit 探针数过、事务内一次都没数。
  - **FC-01…FC-07**：直接打每一条 fail-closed 守卫（每次只缺一个方法，其余齐全）：079/062 构造器拒绝只缺 `selectOneForKeyShare` 的 db；`lockExternalSystemForPointerWrite` 拒绝缺该方法的执行器且从未调用 `selectOne`；`upsertPipeline` 拒绝缺 `transaction` 的 db、拒绝缺 `selectOneForKeyShare` 的事务句柄（事务内零语句、ROLLBACK）；`deleteExternalSystem` 拒绝缺 `transaction` 的 db（探针之前，零语句）、拒绝缺 `selectOneForUpdate` 的事务句柄（事务内零语句、ROLLBACK、行保留）。断言匹配 `(external-system delete lock protocol)` 报错文本。既有的构造器断言（`stock-preparation-source-binding.test.cjs`、`-scope-fallback.test.cjs`）传入的假件同时缺 `transaction`/`select`，所以那条新增条款以前从未被单独打到——复审变异 X9（三处守卫一起降级）在补之前对 7 个套件全绿，现在 FC-01 第一个红。
  - **M-FC-\***：四个「降级为无锁读」变异体各自翻转对应的 FC 断言（M-FC-LOCK：helper 缺方法时退到 `selectOne`，FC-03 的「从未调用 selectOne」翻；M-FC-079/062：删掉构造器条款，FC-01/02 翻；M-FC-PIPE：端点检查退到 `selectOne`，FC-05 翻——pipeline 在无锁下被写入）。
  - **L-11**、**R-062-REUSE-A/B**：第 2.5、2.6 节。
- **真 PG 套件**（`packages/core-backend/tests/integration/external-system-delete-bind-lock-protocol.db.test.ts`；第二轮复审新增 **P-ABSENT**——只跑过 057 的第二个 schema 上删除放行，且会话语句记录证明四条依赖 COUNT 全在 `BEGIN` 之前、事务内零条；**P-062-REUSE-A/B**——第 2.6 节的两个例外，断言会话语句里没有 `FOR KEY SHARE`）：仓库里所有真库套件都是**逐文件**写进 `plugin-tests.yml`（该文件是 S6-A 证据 pin 输入、且本分支的 gh 令牌无 workflow 权限），没有任何按 glob 跑 `tests/integration` 的车道；默认 `vitest.config.ts` 未排除它，所以在无 DB 的 `test (20.x)` 默认步骤里它以 **skipped** 出现（不是假绿，是可见的跳过）。**待办：需 workflow 权限**——在 `plugin-tests.yml` 的「Run DB migrations」之后按 S3/S4 真库步骤同形加一步（`DATABASE_URL` + `EXPECT_DB=1` + `--config vitest.integration.config.ts run tests/integration/external-system-delete-bind-lock-protocol.db.test.ts --reporter=verbose`），并在同一提交把该文件加进 `vitest.config.ts` 的排除表（仓库的「两点登记」惯例）。CI 的 PG 是 14（`ankane/setup-postgres` 14），`FOR KEY SHARE` 9.3 起可用。
- 真 PG 套件的**防跳过哨兵**放在 `describeIfDatabase` **外面**、按 `EXPECT_DB === '1'` 开关（`approval-can-decide-current-node.db.test.ts:50-53` 同形）。第一版把它写在 describe 里面，没有 DATABASE_URL 时随整个 describe 一起 `describe.skip`，从来不看 EXPECT_DB——实测 `EXPECT_DB=1` 且无 DATABASE_URL 时 11 skipped、退出码 0，哨兵形同虚设。移出后同一命令 1 failed、退出码 1；无 EXPECT_DB 无 DATABASE_URL 时全部 skipped、退出码 0；有 DATABASE_URL + EXPECT_DB=1 时 11/11 通过。
- `scripts/ops` 的回放契约车道（`scenario-b-replay-verify.yml` → `node --test scripts/ops/scenario-b-replay.test.mjs scripts/ops/scenario-b-replay-contract.test.mjs`）由 `plugins/plugin-integration-core/lib/**` 触发，不是 required check，但被本刀打红过；补假件后 35/35 通过，第二轮复审再加「登记例外 A/B」两条（真 handler 上 409 `READ_SOURCE_CONFIG_STATUS_CONFLICT` reason `content_retired` / 200 `reused:true` + `reuse_version` 审计），37/37（第 7.4 节）。
- 套件里的 `EXTERNAL_SYSTEM_LOCK_PROTOCOL_PLUGIN_ROOT` 只用于第 7 节的旧红与变异运行，CI 不设。

## 7. 验证（全部执行型）

环境：便携 PostgreSQL 16.10（`127.0.0.1:61661`，数据目录在本次 scratchpad，`initdb --locale="Chinese (Simplified)_China" -E UTF8`，服务端消息为中文——所有判定按 SQLSTATE / 错误名，不读散文）；node 20.20.2；两条会话各自独占一个 pg client，经与 `packages/core-backend/src/index.ts:785` 同形的 `{ query, transaction }` 适配器驱动**真模块**（`lib/db.cjs` 的 `createDb` + 各 store/registry），真迁移 057/062/068-073/079 建在隔离 schema；「等锁」以观察者会话查 `pg_stat_activity.wait_event_type = 'Lock'` 认定（5 s 窗口内未观测到即判未取锁）。

### 7.1 旧红 → 新绿（同一套件、同一 PG）

| 用例 | `origin/main` 插件代码（旧） | 本分支（新） |
|---|---|---|
| sentinel（现在在 describe 外、按 EXPECT_DB=1 开关，第 6 节） | ✓ | ✓ |
| NEC 无锁形状悬空（原生 SQL） | ✓（悬空=1） | ✓（悬空=1，必要性成立） |
| P-079-A 删除计数零后 bind | ✗ 未等锁 | ✓ 等锁 → 409 `SOURCE_BINDING_SOURCE_NOT_LIVE`，指针 0 |
| P-079-B bind 持 KEY SHARE 后删除 | ✗ | ✓ 等锁 → 409，`stockPrepSourceBindingCount=1` |
| P-079-C 重绑（update 分支） | ✗ | ✓ 旧绑定仍指向活系统 |
| P-062-A / P-062-B | ✗ / ✗ | ✓ `READ_SOURCE_SYSTEM_NOT_FOUND`、无版本无审计 / ✓ `readSourceConfigCount=1` |
| P-PIPE-A / P-PIPE-B | ✗ / ✗ | ✓ `PipelineValidationError`（非 23503）/ ✓ `used by pipelines` 逐字 |
| P-MIX 两写入方相容、删除等两者、无 40P01 | ✗ | ✓ |
| R-073 残余悬空 | ✓（悬空） | ✓（悬空，登记） |
| P-ABSENT 只跑过 057 的 schema 上删除放行；依赖 COUNT 全在 BEGIN 之前（第二轮新增） | ✗（旧代码删除也放行，但根本不开事务：语句记录里没有 `BEGIN`，形状断言红） | ✓ |
| P-062-REUSE-A 同内容 + retired 版本 + 系统已删 → 409 content_retired、0 锁；新内容 → 400 tuple（第二轮新增） | ✗（复用一半旧代码同样 409；红在「新内容 → 400」：旧代码不看系统、直接铸出指向已删系统的版本） | ✓ |
| P-062-REUSE-B 存量活行同内容 → reused + reuse_version 审计、0 锁；新内容 → 400 tuple（第二轮新增） | ✗（同上，红在「新内容 → 400」） | ✓ |
| 合计 | **8 失败 / 3 通过**（第一轮 11 例）；**11 失败 / 3 通过**（第二轮 14 例） | **11 / 11**（第一轮）；**14 / 14 通过**（第二轮，8.6 s） |

### 7.2 变异自证（真 PG，插件目录整份复制到 scratchpad 后单点改动，工作树未动）

| 变异 | 改动 | 红的用例 | 计数 |
|---|---|---|---|
| M-D1 | 删除方 `trx.selectOneForUpdate(TABLE, where)` → `trx.selectOne` | P-079-A/B/C、P-062-A/B、P-PIPE-A/B、P-MIX | **8 红** / 3 绿 |
| M-W079 | 079 写入方的 `lockExternalSystemForPointerWrite` → 无锁 `trx.selectOne` | P-079-A/B/C、P-MIX | **4 红** / 7 绿 |
| M-W062 | 062 写入方同上 | P-062-A/B | **2 红** / 9 绿 |
| M-WPIPE | `requireExternalSystem` 的 `selectOneForKeyShare` → `selectOne` | P-PIPE-A（拒绝形状退化为 pg `DatabaseError`，FK 兜底仍无悬空）、P-PIPE-B | **2 红** / 9 绿 |
| X4（第二轮，复审提出） | `external-systems.cjs` `if (absentTables.has(table)) return 0` → `if (false) return 0`（缺表在事务内计数） | **P-ABSENT**：`deleteExternalSystem` 抛 SQLSTATE `25P02`（中文 locale 报文「当前事务被终止…」，按 code 判），行未删；其余 13 例绿 | **1 红** / 13 绿 |

每个变异只红它对应的写入点 / 用例，说明用例与改动点一一对应、没有互相掩盖。

第二轮复审的两个「原地变异、跑全部相关套件」复现（改动前的红 / 补见证后的红）：

| 变异 | 补见证前（复审所见） | 补见证后 |
|---|---|---|
| X4（同上，原地改 `external-systems.cjs`） | 12 个内存套件 + scenario-b 35/35 + 真 PG 11/11 **全绿** | `external-systems-delete-dependent-references` **B-06 红**（`code: '25P02'`）；真 PG **P-ABSENT 红**；M-6 常驻 |
| X9（三处守卫一起降级：`external-system-pointer-lock.cjs:77` 缺方法退到 `selectOne`；079 构造器 `:127`、062 构造器 `:187` 删掉 `selectOneForKeyShare` 条款） | 6 个内存套件 + scenario-b **全绿** | `external-systems-delete-bind-lock-protocol` **FC-01 红**（「Missing expected exception」）；FC-02/03 随后同红 |

### 7.3 内存套件（跑进 CI）

`node __tests__/external-systems-delete-bind-lock-protocol.test.cjs`：L-01…L-11、F-25P02、FC-01…FC-07、R-062-REUSE-A/B、R-073、M-D1/M-W079/M-W062/M-WPIPE、M-FC-LOCK/M-FC-079/M-FC-062/M-FC-PIPE 全部按预期（末尾正品回归再跑 L-01 与 FC-01…07）。四个去锁变异在内存里以模拟锁管理器复现同样的悬空；四个守卫降级变异各自翻转对应的 FC 断言。`node __tests__/external-systems-delete-dependent-references.test.cjs`：B-01…B-14（B-06 多两条见证）+ M-1…M-6 绿。

### 7.4 回归

改动前后对照（本机，CRLF 检出）：`db`、`external-systems`、`external-systems-delete-dependent-references`（B-01…B-14 + M-1…M-5）、`external-systems-list-workspace-fallback`、`stock-preparation-source-binding`（12/12）、`-scope-fallback`（16/16）、`-routes`、`read-source-config-store`、四个 `gip-*`、`pipelines`、`integration-templates`、`http-routes`、`http-routes-plm-k3wise-poc`、`pipeline-runner`、`sealed-export-package-provenance`（pin 重算后绿）、`sealed-export-s6a-initial-provisioning`、`sealed-export-s6a-lifecycle-provisioning`、`test-chain-completeness`（230 套件）——改动前因新增必需方法而红的 14 个套件，补假件后全绿；整条 `pnpm --filter plugin-integration-core test` 结果见 PR 正文。

插件目录之外（第一版漏掉、被 CI 的 `replay self-test + producer/consumer contract (hermetic)` 抓到）：`node --test scripts/ops/scenario-b-replay.test.mjs scripts/ops/scenario-b-replay-contract.test.mjs` 在补假件前 28 通过 / 5 失败（契约套件 5/5 报 `createReadSourceConfigStore: scoped db helper (incl. transaction, selectOneForKeyShare) is required`），补后 35/35 通过（契约套件 5 条旧用例 + 2 条新的锁协议用例），第二轮再加「登记例外 A/B」后 **37/37**（契约车道的 fetchImpl 为此多路由了 `/read-source-configs/:id/retire` 到真 `readSourceConfigsRetire`）；`scripts/ops/scenario-b-replay-ci-wiring.test.mjs` 通过（未新增 require 闭包之外的文件）。变异自证：把契约套件假件的 `selectOneForKeyShare` 改成「任何 id 都活」（恒返回一行）→ 2 条新用例红、5 条旧用例仍绿，证明存在性语义只由新用例钉住；再把该方法整个删掉 → 回到 7 条全红（构造器 fail-closed）。

## 8. 没有做 / 已知代价

- 073 未参与（第 5 节）。
- 不建 FK、不写迁移、不清理存量悬空行。
- 每次外部系统删除多 4 条探针 COUNT；每次 079/062/pipeline 写入多 1–2 条 `SELECT … FOR KEY SHARE`（主键点查）。
- 写入方在删除进行中会**等待**（不是立刻失败）——等的时间等于删除事务的长度（毫秒级：一把行锁 + 6 条 COUNT + 1 条 DELETE）。
- 真 PG 套件在 CI 里尚未真跑（第 6 节待办）；本机 PG 16.10 与 CI 的 PG 14 之间，本刀用到的语法（`FOR KEY SHARE`、`GENERATED … STORED` 属迁移既有）均在 14 支持范围内。
- 内存假件里「任何 id 都活」的 13 处 stub 是为了把既有套件的主题与本刀解耦；它们不证明存在性语义，协议套件才证明。`scripts/ops/scenario-b-replay-contract.test.mjs` 的假件不在此列——它按登记替身解析，存在性语义在那条车道上是真的（第 4 节）。
- **行为变化（对外可见）**：`saveVersion` **铸新版本**（内容键在家族里未命中）时，对本租户内不存在的 `systemId` 返回 400 `READ_SOURCE_CONFIG_INVALID`（details.errors 里是 `{ code: READ_SOURCE_SYSTEM_NOT_FOUND, field: systemId, reason: not_found }`），不只是并发删除时的输家——第一版 PR 正文只写了并发一侧。之前先存配置、后登记系统也能 201（指针可以先于系统存在）；现在必须先登记。**不是「一律」**：内容键命中既有行的复用分支在锁之前、不看系统——同内容命中 retired 行得 409 `content_retired`，命中系统已不存在的存量活行得 200 `reused:true` 并写 `reuse_version` 审计（第 2.6 节，登记于 R-062-REUSE / P-062-REUSE / 契约车道）。

## 9. 第二轮复审订正记录（2026-09-25，独立核验者 / 终审 7 条 blocking）

| # | 复审结论 | 处置 |
|---|---|---|
| 1、5 | 保证 4「写入方锁的 where 只含 tenant_id + id」对 pipelines 不成立（真 PG 抓到 `tenant_id + workspace_id + id`） | 成立。收窄为「经 `lockExternalSystemForPointerWrite` 的 079/062」；pipelines/templates 沿用 `scopeWhere` + id。第 2 节表、2.4、2.5；`L-11` 钉 where 形状与「ws1 pipeline 命名租户级系统被拒、079 同对成功」的执行后果；`external-system-pointer-lock.cjs` 文件头补「NOT EVERY WRITER GOES THROUGH THIS HELPER」 |
| 2、5 | 保证 2「pipelines 计数不按 workspace 过滤」与代码相反（`countPipelineReferences` 用 `scopeWhere`）；「三张表」漏了 073 | 成立。改为「079/062/073 三张表的计数不按 workspace；pipelines 计数沿用 scopeWhere、带 workspace（原有）」；ws2 裸插 pipeline 的执行后果（23503、系统保留、非悬空）真 PG 实证记入 2.5；`L-11` 钉六条计数的 where 键 |
| 3、4 | 保证 9「一律 400 / 不落审计」被同内容复用分支推翻（retired → 409 content_retired；存量活行 → 200 + reuse_version 审计） | 成立。收窄为「铸新版本时」，两个例外登记（2.6 节；R-062-REUSE-A/B 内存、P-062-REUSE-A/B 真 PG、契约车道「登记例外 A/B」）；「一律」与否是 owner 决定的对外行为变化，本刀不改代码 |
| 6 | 保证 2「缺表容忍由事务前探针决定」没有会失败的见证；X4 变异体全绿 | 成立。内存 db 事务句柄补 25P02 语义（两套件）；B-06 加「缺表事务内零计数」见证；M-6 常驻；真 PG P-ABSENT（X4 下 25P02 红） |
| 7 | 保证 6（缺方法 fail-closed）在 CI 无见证；X9 全绿 | 成立。FC-01…FC-07 直接断言 + M-FC-LOCK/079/062/PIPE 四个降级变异体；X9 现在 FC-01 红 |

代码改动：无（`external-system-pointer-lock.cjs` 只改注释）。本轮不改变任何运行时行为；改的是保证的措辞与它们的见证。
