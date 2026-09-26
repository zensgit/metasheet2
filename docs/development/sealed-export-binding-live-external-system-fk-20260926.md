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

## 4. 删除路径（非冻结代码）上的一处登记

**租户错配**：ACTIVE 绑定的租户 ≠ 其系统的租户。删除守卫的依赖计数按租户过滤（`external-systems.cjs` `countDependentBindingReferences`），看不见这种行，于是：

- 旧：删除放行，留下悬空；
- 新：删除被本外键以 23503 拒绝，**系统保留、不悬空**；但错误是原始驱动错误，HTTP 路由包装器把它交给 `sendError`（`http-routes.cjs` `registerIntegrationRoutes` → `sendError` → `inferHttpStatus`），状态推断没有这一支 → **未分类的 500**。body 为 `{code:"23503", message:<pg message>}`：pg 的 `message` 只含表名与约束名，键值在 `detail` 里、`sendError` 不转发——values-free，但是一个 500。真 PG `B-10` 断言了这三点（500、code、body 不含系统 id / binding id / 租户），并且在 #6076 的插件代码上复现同一结果（§5 组合实证）。

处理建议（本 PR 不做，因为 `external-systems.cjs` 正被 #6076 重写，同时动会冲突）：#6076 合入后，在其删除事务的 DELETE 处按 SQLSTATE 主判 `code === '23503' && constraint === 'fk_sealed_export_stock_prep_binding_live_external_system'`，映射为同一个 `ExternalSystemConflictError`（409，`sealedExportBindingCount` 取不分租户的计数或 `null`）——与 #5896 对 `fk_integration_external_systems_live_connection_id` 的做法同形。做了之后翻转 `B-10` 的三条 500 断言。普查包 01 的 `tenant_mismatch_active` 报出现场有没有这种行。

## 5. 与 #6076 的关系、合并顺序、要同步改的用例（要求 3）

两个 PR **改动文件零重叠**（本 PR 不碰插件、不碰 #6076 的测试与文档）。CI 上也互不打红（下面的行号按 #6076 头部 `effae715c`）：

- #6076 的真 PG 套件（`packages/core-backend/tests/integration/external-system-delete-bind-lock-protocol.db.test.ts`）只按 SQL 迁移清单建 schema（057…073、079），**不跑 TS 迁移**，所以本外键合入后它的 `R-073`（:623）照旧「悬空」通过；插件内存套件的 `R-073`（`__tests__/external-systems-delete-bind-lock-protocol.test.cjs:1084-1110`）是内存模型，也照旧通过。
- 但两者合入后，「073 悬空确实发生」对**真实部署**（会跑 TS 迁移）已不成立——这两条登记会变成过期陈述，必须翻转。

组合实证（执行型，scratch 脚本，未入库）：把 #6076 头部 `effae715c` 的插件 `lib/` 抽到 scratchpad，用 #6076 自己的迁移清单建 schema，一份不加、一份加上本迁移 `up()` 的 SQL（`verify/migration-up.sql`，与 `up()` 有漂移检查），跑 #6076 R-073 的「删除在前」交错与其镜像「写入在前」，删除方用 #6076 的 `deleteExternalSystem`（事务内 FOR UPDATE → 计数 → DELETE），写入方用冻结 provisioning 模块：

| 场景 | 旧（无外键） | 新（有外键） |
| --- | --- | --- |
| 删除在前（= #6076 R-073） | 写入方不等锁；两边都成功；系统 0、ACTIVE 绑定 1、**悬空 1** | 写入方**等锁**；删除成功；写入 `SEALED_EXPORT_INTERNAL_ERROR`（驱动 23503 / 本约束）；系统 0、绑定 0、**悬空 0** |
| 写入在前 | 删除不等锁；两边都成功；**悬空 1** | 删除**等锁**；写入成功；删除 `ExternalSystemConflictError`（409）且 `sealedExportBindingCount = 1`；系统 1、绑定 1、**悬空 0** |
| 租户错配的 ACTIVE 绑定 | 删除成功，悬空 1 | 删除抛原始 23503（本约束），系统保留，悬空 0（§4） |

合并顺序（两种都可行）：

- **推荐：#6076 先合 → 本 PR rebase 后合 → 同一个后续小 PR（或本 PR 追加提交，届时文件已在 main 上，不碰 #6076 分支）翻转 R-073**：
  1. 真 PG `R-073`：在建 schema 时（`MIGRATIONS` 之后）套本迁移 `up()`（导入 TS 模块经 Kysely 执行，或执行 `scripts/ops/sealed-export-binding-live-fk-validate-20260926/verify/migration-up.sql`），断言改为：`writerWaited === true`、`written.error.reason === 'SEALED_EXPORT_INTERNAL_ERROR'`、`deleted.error === null`、系统 0、ACTIVE 绑定 0；并补「写入在前」镜像：`deleterWaited === true`、删除 `ExternalSystemConflictError` 且 `sealedExportBindingCount === 1`、系统 1、绑定 1。用例名去掉 residual。
  2. 内存 `R-073`：内存 db 不建模外键；把它改名为「应用层：073 写入方不取应用层锁（数据库层由外键关闭，见本 PR）」，断言保留，日志文案去掉「dangles — registered residual」。
  3. 设计文档 §5：残余改为「数据库层由 `fk_sealed_export_stock_prep_binding_live_external_system` 关闭（本 PR）；应用层写入方仍不取锁；存量悬空由普查包处理」，并删掉「修掉它的人必须连同这条登记一起退掉」的待办。
  4. §4 的 23503→409 映射（可同一 PR），翻转本 PR `B-10` 的三条 500 断言。
- **若本 PR 先合**：#6076 合入前在其分支上做上面 1–3（本 PR 不改 #6076 分支）。

## 6. 存量：普查 / 补救 / VALIDATE 包

`scripts/ops/sealed-export-binding-live-fk-validate-20260926/`，与 `live-id-fk-validate-20260920` 同形，**只输出计数与布尔**：

- `01-inventory.sql`（只读，迁移前后都能跑）：`active_total / dangling_active / tenant_mismatch_active / retired_total / retired_system_absent / inflight_runs_on_dangling`，迁移后再经生成列复算（`generated_drift` 必须 0、`dangling_by_fk_column` 必须等于 `dangling_active`），末行 `INVENTORY_RESULT` 完成态。
- `02-remediate.sql`（默认干跑，精确字面量 `-v APPLY=1` 才提交，owner）：把悬空 ACTIVE 绑定置 `RETIRED`（不删行、不改指向——`external_system_id` 是不可变锚点），要求外键已存在，提交前活表必须零悬空，否则整单回滚。
- `03-validate.sql`（owner）：`VALIDATE CONSTRAINT`，23503 / 55P03 分类，其它不吞。
- `verify/`：用真实 SQL 迁移 057 + 068…075 建合成 schema，S1…S11 + PM1…PM7（详见包 README）。

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
| C-1 NOT VALID：存量悬空不挡 `up()`；非键 UPDATE 放行；VALIDATE 先 23503、退役后成功 | ✗ | ✓ |
| D-1 有数据时 `down()` 成功、恢复旧行为；随后 `up()` 越过悬空行再成功且幂等 | ✗ | ✓ |
| **合计** | **11 失败 / 6 通过** | **17 / 17** |

「旧」列就是「旧 schema 下删除被 ACTIVE 073 行引用的系统成功（悬空，红）」；「新」列是「被 RESTRICT 拒绝（绿）」。

### 7.2 变异自证（同一套件，迁移模块整份复制到 scratchpad 后单点改动，工作树未动；经 `SEALED_EXPORT_LIVE_FK_MIGRATION_MODULE` 载入）

| 变异 | 改动 | 红的用例 | 计数 |
| --- | --- | --- | --- |
| M1 | 生成列去掉 status 过滤：`GENERATED ALWAYS AS (external_system_id) STORED` | B-3、B-4（RETIRED 挡删除）、B-5（RETIRED 插入被拒）、C-1、D-1 | **5 红** / 12 绿 |
| M2 | 去掉外键（`up()` 停在生成列之后） | B-1、B-2、B-5、B-7、B-8、B-9、B-10、B-11、C-1、D-1 | **10 红** / 7 绿 |

### 7.3 真实迁移链（`src/db/migrate.ts`，合成行）

在一个跑完全链的库上：S0 迁移已记录、生成列与外键存在、未 validate → S1 以 provisioning 角色植入 ACTIVE + RETIRED 两行（该角色对系统表零权限）→ S2 删除 ACTIVE 引用的系统：`23503` → S3 删除只被 RETIRED 引用的系统：成功 → S4 `--rollback`（有数据）成功、列与外键消失 → S5 旧 schema 下删除 ACTIVE 引用的系统：成功、悬空 1 → S6 `migrate` 越过悬空行成功（NOT VALID）→ S7 VALIDATE：`23503` → S8 退役该行后 VALIDATE 成功 → S9 已 validate 时再 `--rollback` 成功、`--list` 显示 1 条待执行 → S10 再 `migrate` 成功。

### 7.4 普查包 `verify/`

`node --test`（`DATABASE_URL` 指向一次性库、`METASHEET_REAL_DB_TEST_STEP=1`）：16/16，含 S1…S11 与 PM1…PM7；`METASHEET_REAL_DB_TEST_STEP=1` 而无 `DATABASE_URL` 时 1 失败（防跳过哨兵）；两者都无时 15 通过、1 跳过。

## 8. CI 接线

- 真 PG 套件：仓库所有真库套件都是逐文件写进工作流；本 PR 的 gh 令牌无 workflow 权限，所以它在无库的 `test (20.x)` 默认步骤里以 **skipped** 出现（可见的跳过，不是假绿）。迁移本身会被 `migration-replay.yml`（PG 15，跑两遍）与 `migration-prod-image-parity.yml`（postgres:15-alpine 全链）在 CI 上执行。
- **待办：需 workflow 权限**
  1. 新增 `.github/workflows/sealed-export-binding-live-fk.yml`（按 `sealed-export-s6a-grant-repair.yml` 同形：postgres 16 + 17 矩阵、`pnpm install`、`DATABASE_URL` + `EXPECT_DB=1` + `vitest --config vitest.integration.config.ts run tests/integration/sealed-export-binding-live-external-system-fk.db.test.ts`；paths 含 057、068…075、本迁移、该测试文件、`plugins/plugin-integration-core/lib/db.cjs`、`lib/external-systems.cjs`、`lib/http-routes.cjs`、`lib/sealed-export/sealed-export-lifecycle-provisioning.cjs`、`lib/sealed-export/stock-preparation-runtime-database.cjs`），并在**同一提交**把该测试文件加进 `packages/core-backend/vitest.config.ts` 的排除表（两点登记）。`plugin-tests.yml` 是 S6-A pin 输入，不扩。
  2. `ops-sql-pack-verify.yml` 的 `hermetic` / `execution-proof` 两个矩阵加 `sealed-export-binding-live-fk-validate-20260926`，两份 `paths` 加 `scripts/ops/sealed-export-binding-live-fk-validate-20260926/**`、本迁移文件、以及 `run-verify.mjs` 读取的 SQL 迁移 057、068…075；同一提交把包名加进 `scripts/ops/ops-sql-pack-verify-wiring.test.mjs` 的 `PACKS`。

## 9. 不在本刀范围 / 登记

- 应用层：冻结写入方仍不取应用层锁（数据库层已由外键串行）；不改冻结模块、不重算 pin。
- 删除路径 23503→409 映射（§4）。
- 普查包不在任何真实库执行；02 `APPLY=1` 与 03 是 owner 层动作。
