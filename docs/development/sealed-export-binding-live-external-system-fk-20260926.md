# 073 sealed-export 绑定 × 外部系统删除：生成列 + NOT VALID 外键（#6076 残余 R-073，owner 裁决方案①）

- 日期：2026-09-26
- 上游：`docs/development/external-system-delete-bind-lock-protocol-design-20260925.md`（#6076）§5「残余：073 sealed-export 绑定写入方未参与」
- 先例：`zzzz20260920120000_data_source_live_id_binding_lock.ts`（#5896）+ `scripts/ops/live-id-fk-validate-20260920/`（#5906）
- 性质：**DDL**（owner 审）。冻结的 S6-A 模块与其 pin **一字未动**。

## 1. 洞

`integration_sealed_export_stock_prep_bindings.external_system_id`（073）指向 `integration_external_systems.id`，是一列无外键的 TEXT。删除守卫（`plugins/plugin-integration-core/lib/external-systems.cjs` `deleteExternalSystem`）在删除前数 ACTIVE 073 行，但 073 行唯一的写入方——冻结模块 `sealed-export-lifecycle-provisioning.cjs` `provisionInitialStockPreparationBinding`——不对系统行取锁，也取不了：它以 provisioning 角色运行，073/074/075 对该角色在 `integration_external_systems` 上零授权，而 PG 的锁子句要求至少一列 UPDATE 权限。于是「删除计数为零 → provisioning 插入 ACTIVE 绑定 → 删除提交」（以及反向交错）留下指向已删系统的 ACTIVE 绑定。#6076 用 R-073 用例把这个悬空钉成登记残余。

## 2. 改法（迁移 `zzzz20260926140000_sealed_export_binding_live_external_system_fk.ts`）

| 对象 | 定义 |
| --- | --- |
| 生成列 | `live_external_system_id TEXT GENERATED ALWAYS AS (CASE WHEN status = 'ACTIVE' THEN external_system_id END) STORED`。073 的状态词表恰为 `ACTIVE` / `RETIRED`（073:32）；RETIRED 是历史，删除守卫也只数 ACTIVE（`external-systems.cjs` `LIVE_SEALED_EXPORT_BINDING_STATUS`），所以历史行不能让系统删不掉。 |
| 外键 | `fk_sealed_export_stock_prep_binding_live_external_system`：`(live_external_system_id) → integration_external_systems(id)`，`ON DELETE RESTRICT`，**NOT VALID**。外部系统表主键就是 `id`（057:20），不含租户，所以是单列外键（与 057 的 pipelines 两条外键同形）。 |

数据库层的后果：

1. ACTIVE 绑定的 INSERT（以及 RETIRED→ACTIVE 翻转）由 RI 检查对系统行取 `FOR KEY SHARE`，与删除方的 `FOR UPDATE`（#6076）以及 DELETE 本身冲突——两边在数据库层串行。
2. 系统已不在、或在它等锁期间被删掉的 provisioning，被本约束以 SQLSTATE 23503 拒绝；冻结模块的边界把整个事务回滚并报固定、values-free 的 `SEALED_EXPORT_INTERNAL_ERROR`，什么都不写。
3. 删除一个仍被 ACTIVE 绑定引用的系统，不管应用层数出几，都被 23503 拒绝。

**RI 以表属主身份执行**（PG 的 RI 查询切换到被查询表的属主），所以 provisioning 角色**无需任何新授权**；冻结模块按列名 INSERT、`rowMatchesExpected` / `normalizeBinding` 只读它们点名的列、`SELECT *` 由 073 已授予的表级 SELECT 覆盖——模块与 pin 不改。

**为什么 NOT VALID**：已经存有「ACTIVE 绑定指向已删系统」的库（正是本洞造成的数据），带校验的 ADD CONSTRAINT 会失败并挡住部署。NOT VALID 只跳过对存量行的扫描；此后每条 INSERT、每条改变该键的 UPDATE 照样全查全锁。存量交给 owner 执行的普查 / 补救 / VALIDATE 包（§6），迁移里不改写任何行。

`down()`：先删约束再删生成列，不读写任何绑定行——有数据时照样安全回退，回退后恢复旧行为。

锁：`ADD COLUMN … STORED` 在 ACCESS EXCLUSIVE 下重写绑定表（单客户、极小）；`ADD CONSTRAINT … NOT VALID` 对两表取 SHARE ROW EXCLUSIVE、不扫描。迁移期间外部系统表的写入会短暂排队。

## 3. 冻结写入方在外键存在后的行为（要求 2）

| 情形 | 结果 | 证据 |
| --- | --- | --- |
| 活系统，provisioning 角色（对系统表零权限） | 写入成功，`INITIAL_PROVISIONED changed:true`；重放幂等 `changed:false`；经冻结的角色绑定句柄 `createStockPreparationProvisioningDatabase` 同样成功 | 真 PG `B-6` |
| 指向不存在的系统 | 拒绝，`reason = SEALED_EXPORT_INTERNAL_ERROR`；底层驱动错误恰为绑定 INSERT 的一次 23503（约束名 = 本外键）；绑定 / 公钥 / authority 三表全部回滚为 0 行；拒绝对象序列化后不含系统 id、租户 | 真 PG `B-7`（直连与经冻结句柄各一次） |
| 删除在前（系统行已被删除事务锁住） | provisioning **等锁**，删除提交后被拒（INTERNAL_ERROR / 23503），零悬空 | 真 PG `B-8` |
| 写入在前（绑定 INSERT 已持 KEY SHARE） | DELETE **等锁**，provisioning 提交后 DELETE 被 23503 拒，系统与 ACTIVE 绑定都保留 | 真 PG `B-9` |

**会不会 500**：不会。冻结写入方唯一的入口是运维 CLI `plugins/plugin-integration-core/scripts/provision-stock-preparation-sqlserver-sealed-snapshot.cjs`（`stock-preparation-runtime-provisioning.cjs` → `provisionInitialStockPreparationBinding`），没有 HTTP 路由。CLI 对任何失败输出 `{"code":"SEALED_EXPORT_INTERNAL_ERROR","ok":false,"valuesFree":true}` 并以退出码 1 结束——fail-closed、不泄露。
代价与处理建议（不改冻结模块）：操作者看到的只是一个固定的 INTERNAL_ERROR，看不出是「系统不在」。建议：本迁移上线后，provisioning 报 INTERNAL_ERROR 时，先用普查包 01（只读、values-free）或一次布尔探针确认目标系统行存在，再查其它原因；这条写进 S6-A 运维手册即可，不需要动冻结代码。

## 4. 删除路径（非冻结代码）：一处已由 #6076 关闭、一处仍登记

删除路径现在是 #6076 的锁协议（main 上 `e535702e6`）：`deleteExternalSystem` 在**一个事务**里先把隔离级别钉为 READ COMMITTED，再对系统行 `SELECT … FOR UPDATE`，然后按租户计数依赖指针，计数为零才 DELETE。

**同租户、写入在前**（独立核验 F1 / N3）：绑定 INSERT 已执行、未提交时删除到达。

- 无本外键：写入方不取锁，删除的 FOR UPDATE 不等，计数看不见未提交的绑定 → 删除成功，写入提交后**悬空 1**。
- 有本外键、但删除路径还是 #6076 之前的版本（无事务、无 FOR UPDATE）：计数为 0，DELETE 等 RI 锁，写入提交后 DELETE 得原始 23503 → `sendError` 报**未分类的 500**（核验者在本 PR 旧头部实测）。
- **有本外键 + #6076（现状）**：绑定 INSERT 的 RI 检查对系统行持 KEY SHARE，删除的 FOR UPDATE **等锁**；写入提交后计数看见这条同租户绑定 → `ExternalSystemConflictError`，路由 **409**（`sealedExportBindingCount = 1`），系统与绑定都保留、零悬空。真 PG **`B-12`** 钉住：删除方等锁、错误名、不是 23503、`sendError` 给 409、系统 1 / ACTIVE 绑定 1 / 悬空 0。#6076 已在 main，本分支也已合入该 main，所以「本 PR 先于 #6076 合入」这条分支不再存在；同租户写入在前在本分支上是 409（B-12），不是 500。

**仍登记（未修）——租户错配**：ACTIVE 绑定的租户 ≠ 其系统的租户。删除守卫的依赖计数按租户过滤（`external-systems.cjs` `countDependentBindingReferences`），看不见这种行，于是：

- 旧：删除放行，留下悬空；
- 新：删除被本外键以 23503 拒绝，**系统保留、不悬空**；但错误是原始驱动错误，HTTP 路由包装器把它交给 `sendError`（`http-routes.cjs` `registerIntegrationRoutes` → `sendError` → `inferHttpStatus`），状态推断没有这一支 → **未分类的 500**。body 为 `{code:"23503", message:<pg message>}`：pg 的 `message` 只含表名与约束名，键值在 `detail` 里、`sendError` 不转发——values-free，但是一个 500。真 PG `B-10` 断言了这三点（500、code、body 不含系统 id / binding id / 租户）。独立核验还证实：冻结写入方只核对操作者给的 spec、不读系统行，所以经唯一写入方就能写出这种行，不只是手插。

处理建议（后续项，本 PR 不做——本 PR 不改删除路径的行为）：在 `deleteExternalSystem` 的 DELETE 处按 SQLSTATE 主判 `code === '23503' && constraint === 'fk_sealed_export_stock_prep_binding_live_external_system'`，映射为同一个 `ExternalSystemConflictError`（409，`sealedExportBindingCount` 取不分租户的计数或 `null`）——与 #5896 对 `fk_integration_external_systems_live_connection_id` 的做法同形。做了之后翻转 `B-10` 的三条 500 断言。普查包 01 的 `tenant_mismatch_active` 报出现场有没有这种行。

## 5. 与 #6076 的关系、要同步改的用例（要求 3）

**#6076 已合入 main（`e535702e6`，2026-09-28），本分支已合入该 main。** 初稿里「推荐顺序」与「若本 PR 先合」两条分支因此不再有意义：只剩「本 PR 在 #6076 之后合入」这一种。下面的行号按本分支（合入 main `33047ef94` 之后、含本 PR 的改名）。

- #6076 的真 PG 套件（`packages/core-backend/tests/integration/external-system-delete-bind-lock-protocol.db.test.ts`）只按 SQL 迁移清单建 schema（057、061、062、068…073、079），**不跑 TS 迁移**，所以本外键合入后它的 `R-073`（:651）照旧「悬空」通过；插件内存套件的 `R-073`（`__tests__/external-systems-delete-bind-lock-protocol.test.cjs:1233`（函数），调用点 `:1805`）是不建模外键的内存模型，也照旧通过。两条都不会因本 PR 合入而变红。
- 两者断言的是**应用层**事实（冻结写入方不取应用层锁；在没有外键的 schema 上悬空），对部署后的结局（会跑 TS 迁移）已不是完整陈述——所以本 PR 改了它们的**名字与文案**，断言一条不动；部署后的结局由本 PR 真 PG 套件的 **B-13**（删除在前，走 #6076 的 `deleteExternalSystem`，= R-073 的交错）与 **B-12**（写入在前）断言。

组合实证（执行型，scratch 脚本，未入库；初稿在 #6076 分支头部 `effae715c` / `8ec811fb2` 上跑，独立核验在 `7c9966f61` 上复跑，结果相同；现在这三格的「新」列已由 B-12 / B-13 / B-10 在本分支上钉住）：用 #6076 自己的迁移清单建 schema，一份不加、一份加上本迁移 `up()` 的 SQL，删除方用 #6076 的 `deleteExternalSystem`（事务内 FOR UPDATE → 计数 → DELETE），写入方用冻结 provisioning 模块：

| 场景 | 旧（无外键） | 新（有外键） |
| --- | --- | --- |
| 删除在前（= #6076 R-073） | 写入方不等锁；两边都成功；系统 0、ACTIVE 绑定 1、**悬空 1** | 写入方**等锁**；删除成功；写入 `SEALED_EXPORT_INTERNAL_ERROR`（驱动 23503 / 本约束）；系统 0、绑定 0、**悬空 0** |
| 写入在前 | 删除不等锁；两边都成功；**悬空 1** | 删除**等锁**；写入成功；删除 `ExternalSystemConflictError`（409）且 `sealedExportBindingCount = 1`；系统 1、绑定 1、**悬空 0** |
| 租户错配的 ACTIVE 绑定 | 删除成功，悬空 1 | 删除抛原始 23503（本约束），系统保留，悬空 0（§4） |

本 PR 随之改的（#6076 的文件已在 main 上，改在本分支，不碰 #6076 分支）：

1. 设计文档 `docs/development/external-system-delete-bind-lock-protocol-design-20260925.md` §5：标题与正文改为「owner 选方案 1、由本 PR 在数据库层关闭；新写入与删除从迁移起全查全锁，存量悬空待 owner 跑 02 `APPLY=1` 与 03 后清零；租户错配的 500 仍登记」，删掉「修掉它的人必须连同这条登记一起退掉」的待办；§7 验证表 R-073 一行改为「无本迁移的 schema 上的前提」并指向 B-13。
2. 插件内存 `R-073`：改名为 `testSealedExportWriterTakesNoAppLock`（应用层：073 写入方不取应用层锁；数据库层由外键关闭，内存 db 不建模外键），断言一条不动，文案去掉「registered residual」。
3. #6076 真 PG `R-073`：用例名与头注释改为「前提：没有本迁移的 schema」并指向 B-13，断言不动。
4. `plugins/plugin-integration-core/lib/external-systems.cjs` 的两段注释（独立核验 F5）：「073 等表 DELIBERATELY carry no foreign key … the database will not refuse the delete either」对 073 不再成立，改为 079 / 062 仍无外键、073 自本迁移起由生成列外键拒绝删除；「073's writer is the registered exception」改为说明它经外键参与协议。只改注释，不改代码。

仍留作后续的：

- **#6076 真 PG `R-073` 的断言翻转**：要在那个套件的 schema 里套本迁移 `up()`（它现在只按 SQL 清单建 schema，套上会影响同 schema 上的其它用例，需要为 R-073 单开 schema 或在用例内 `up()` / `down()`）。本 PR 不做；等价的断言（同一交错、带外键、走同一个 `deleteExternalSystem`）已由本 PR 的 B-13 给出。
- §4 的 23503→409 映射（租户错配），做了之后翻转 `B-10` 的三条 500 断言。

## 6. 存量：普查 / 补救 / VALIDATE 包

`scripts/ops/sealed-export-binding-live-fk-validate-20260926/`，与 `live-id-fk-validate-20260920` 同形，**只输出计数与布尔**：

- `01-inventory.sql`（只读，迁移前后都能跑）：`active_total / dangling_active / tenant_mismatch_active / retired_total / retired_system_absent / inflight_runs_on_dangling`，迁移后再经生成列复算（`generated_drift` 必须 0、`dangling_by_fk_column` 必须等于 `dangling_active`），末行 `INVENTORY_RESULT` 完成态。
- `02-remediate.sql`（默认干跑，精确字面量 `-v APPLY=1` 才提交，owner）：**只**把悬空 ACTIVE 绑定置 `RETIRED`（不删行、不改指向——`external_system_id` 是不可变锚点），要求外键已存在，提交前活表必须零悬空，否则整单回滚。「只」有两层钉子：静态检查把快照语句与 STEP 1 的 UPDATE 整句钉死（含「系统不存在」子查询的**体**，不只到 `AND NOT EXISTS`），且 02 里五处该子查询的体必须逐字相同；执行层 S12 用两个夹具各放**一条** ACTIVE 活绑定（073 的单客户索引 `uniq_integration_sealed_export_stock_prep_single_customer` 全表只允许一条 ACTIVE，所以两种情形不能放进同一个夹具）——同租户活绑定、租户错配的活绑定——跑 `02 APPLY=1` 后两条都仍是 ACTIVE、整表行摘要不变、`dangling_before=0 retired=0 remaining=0`。这条 ACTIVE 就是客户唯一的活绑定：多退役一条，备料 sealed-export 路径即停。
- `03-validate.sql`（owner）：`VALIDATE CONSTRAINT`，23503 / 55P03 分类，其它不吞。
- `verify/`：用真实 SQL 迁移 057 + 068…075 建合成 schema，S1…S12 + PM1…PM9（详见包 README）。PM8（STEP 1 退役全部 ACTIVE）与 PM9（「系统不存在」子查询体被削弱：按绑定租户判存在 / `WHERE false`，快照与 STEP 1 两处一起改——只改一处是等价变异，另一处照样过滤）能通过 S1…S11，只被 S12 与静态钉子抓到。

VALIDATE 不在迁移里做，留给 owner 在普查后执行。

## 7. 验证（全部执行型）

环境：便携 PostgreSQL 16.10（只监听本机回环、专用端口，数据目录在本次 scratchpad，`initdb` 中文 locale，服务端消息为中文——一切判定按 SQLSTATE / 约束名 / 固定 token，不读散文）；node 20.20.2。

### 7.1 真 PG 套件 `tests/integration/sealed-export-binding-live-external-system-fk.db.test.ts`

每个用例一个一次性 schema，由真实迁移 057 + 068…075（设 runtime / provisioning 两个一次性角色）建成，再按用例跑本迁移真实的 `up()` / `down()`（Kysely）。

| 用例 | 旧（`up/down` 为空操作的模块） | 新 |
| --- | --- | --- |
| sentinel、A-1/A-2/A-3（前提：无迁移时顺序删与两种交错都悬空） | ✓ | ✓ |
| B-1 生成列 + 外键形状（RESTRICT、NOT VALID、指向 `id`） | ✗ | ✓ |
| B-2 删除被 ACTIVE 引用的系统 → 23503 | ✗ | ✓ |
| B-3 RETIRED 不挡删除 / B-4 先退役再删 | ✓ / ✓ | ✓ / ✓ |
| B-5 缺失系统：ACTIVE 插入、RETIRED→ACTIVE 翻转 23503；RETIRED 插入放行 | ✗ | ✓ |
| B-6 冻结模块 + provisioning 角色写活系统 / 重放 / 经冻结句柄 | ✗ | ✓ |
| B-7 冻结模块写缺失系统 → INTERNAL_ERROR、一次 23503、零写入、values-free | ✗ | ✓ |
| B-8 删除在前：写入等锁后被拒，零悬空 | ✗ | ✓ |
| B-9 写入在前：DELETE 等锁后 23503，两行保留 | ✗ | ✓ |
| B-10 插件删除守卫：同租户 409；租户错配 → 原始 23503、系统保留、路由 500（values-free） | ✗ | ✓ |
| B-11 `up()` 幂等 | ✗ | ✓ |
| B-12 写入在前、走插件删除路径（#6076 `deleteExternalSystem`）：删除等锁 → 409 `ExternalSystemConflictError`（不是 23503）、路由 409、两行保留 | ✗ | ✓ |
| B-13 删除在前、走插件删除路径（= #6076 R-073 的交错）：写入等锁 → INTERNAL_ERROR（23503 / 本约束）、删除成功、零悬空 | ✗ | ✓ |
| C-1 NOT VALID：存量悬空不挡 `up()`；非键 UPDATE 放行；VALIDATE 先 23503、退役后成功 | ✗ | ✓ |
| D-1 有数据时 `down()` 成功、恢复旧行为；随后 `up()` 越过悬空行再成功且幂等 | ✗ | ✓ |
| **合计** | **13 失败 / 6 通过** | **19 / 19** |

「旧」列就是「旧 schema 下删除被 ACTIVE 073 行引用的系统成功（悬空，红）」；「新」列是「被 RESTRICT 拒绝（绿）」。B-12 / B-13 在旧 schema 下的第一条红断言都是「等锁」：没有外键时删除方 / 写入方根本不等。

### 7.2 变异自证（同一套件，迁移模块整份复制到 scratchpad 后单点改动，工作树未动；经 `SEALED_EXPORT_LIVE_FK_MIGRATION_MODULE` 载入）

| 变异 | 改动 | 红的用例 | 计数 |
| --- | --- | --- | --- |
| M1 | 生成列去掉 status 过滤：`GENERATED ALWAYS AS (external_system_id) STORED` | B-3、B-4（RETIRED 挡删除）、B-5（RETIRED 插入被拒）、C-1、D-1 | **5 红** / 14 绿 |
| M2 | 去掉外键（`up()` 停在生成列之后） | B-1、B-2、B-5、B-7、B-8、B-9、B-10、B-11、B-12、B-13、C-1、D-1 | **12 红** / 7 绿 |
| R3 | 外键加 `DEFERRABLE INITIALLY DEFERRED`（RI 检查挪到提交时，插入时不取 KEY SHARE） | B-7、B-8、B-9、B-12、B-13 | **5 红** / 14 绿 |

插件删除路径的内存变异（scratch 探针，`Module.prototype._compile` 载入变异源，不落盘）：把 `deleteExternalSystem` 的 `trx.selectOneForUpdate(TABLE, where)` 换成 `trx.selectOne`（#6076 的 M-D1），同一个「写入在前」交错：正品 → `ExternalSystemConflictError`、路由 409；变异 → 删除仍等（DELETE 撞上 RI 锁）但计数在锁之前做完，得原始 `23503`、路由 500。B-12 的「错误名 / 不是 23503 / 路由 409」三条断言正是对这个变异变红。

### 7.3 真实迁移链（`src/db/migrate.ts`，合成行）

在一个跑完全链的库上：S0 迁移已记录、生成列与外键存在、未 validate → S1 以 provisioning 角色植入 ACTIVE + RETIRED 两行（该角色对系统表零权限）→ S2 删除 ACTIVE 引用的系统：`23503` → S3 删除只被 RETIRED 引用的系统：成功 → S4 `--rollback`（有数据）成功、列与外键消失 → S5 旧 schema 下删除 ACTIVE 引用的系统：成功、悬空 1 → S6 `migrate` 越过悬空行成功（NOT VALID）→ S7 VALIDATE：`23503` → S8 退役该行后 VALIDATE 成功 → S9 已 validate 时再 `--rollback` 成功、`--list` 显示 1 条待执行 → S10 再 `migrate` 成功。

### 7.4 普查包 `verify/`

`node --test`（`DATABASE_URL` 指向一次性库、`METASHEET_REAL_DB_TEST_STEP=1`）：18/18，含静态 17 例（新增「快照与 STEP 1 整句钉死」与「钉子对 PM8 / PM9 源码变红」两例）与执行层 S1…S12、PM1…PM9；`METASHEET_REAL_DB_TEST_STEP=1` 而无 `DATABASE_URL` 时 1 失败（防跳过哨兵）；两者都无时 17 通过、1 跳过。PM8 在 S12 两个夹具上都红、活绑定被提交成 RETIRED；PM9「按租户判存在」只在租户错配夹具上红（同租户夹具不受影响，符合其语义），PM9「`WHERE false`」两个夹具都红。

## 8. CI 接线

- 真 PG 套件：`.github/workflows/sealed-export-binding-live-fk.yml`（独立文件，按 `sealed-export-s6a-grant-repair.yml` 同形）：postgres 16 + 17 矩阵、`pnpm install`、字面量 `DATABASE_URL` + `EXPECT_DB=1`（缺库时防跳过哨兵变红，不是跳过）、`vitest --config vitest.integration.config.ts run tests/integration/sealed-export-binding-live-external-system-fk.db.test.ts`；paths 含该测试、本迁移、057、068…075、`plugins/plugin-integration-core/lib/**`（套件经 `http-routes.cjs` 载入大半个 lib）、两份 vitest 配置与工作流自身。**同一提交**把该测试加进 `packages/core-backend/vitest.config.ts` 的排除表（两点登记），无库的 `test (20.x)` 不再收集它。`plugin-tests.yml` 是 S6-A pin 输入，不动。迁移本身另由 `migration-replay.yml`（PG 15）与 `migration-prod-image-parity.yml`（postgres:15-alpine 全链）执行。
- 普查包：`ops-sql-pack-verify.yml` 的 `hermetic` / `execution-proof` 两个矩阵加了 `sealed-export-binding-live-fk-validate-20260926`（执行层 `METASHEET_REAL_DB_TEST_STEP=1`，缺库即红）；两份 `paths` 加了包目录、本迁移、以及 `run-verify.mjs` 施加的 SQL 迁移 057、068…075。`scripts/ops/ops-sql-pack-verify-wiring.test.mjs` 的 `PACKS` 加了包名；因为它的路径推导只扫 `*.test.mjs`，另加一条用例从 `run-verify.mjs` **导出的** `BASE_MIGRATIONS`（正是 harness 遍历的那个数组）核对这 9 个迁移都在两份 `paths` 里，并附一条内存变异（从 yml 文本删掉一条 → 不再匹配）证明它会咬。

## 9. 不在本刀范围 / 登记

- 应用层：冻结写入方仍不取应用层锁（数据库层已由外键串行）；不改冻结模块、不重算 pin。
- 删除路径 23503→409 映射（§4，租户错配仍是未分类 500）。
- #6076 真 PG `R-073` 的断言翻转（§5，需要在那个套件里套 TS 迁移 `up()`）。
- 普查包不在任何真实库执行；02 `APPLY=1` 与 03 是 owner 层动作。
- 独立核验的非阻断项（未改，仅登记）：`up()` 的幂等守卫只按名字判断——同名但表达式不同的生成列、同名的非外键约束都会让 `up()` 报成功（要人工预置同名对象才会出现）；55000 守卫没有执行型用例钉住（核验者实测守卫成立）。
