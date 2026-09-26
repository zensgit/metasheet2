# 设计：sql-readonly legacy 绑定行 `connection_id` 一次性回填（DDL 账本表 + DML 回填，#5896 后续）

- 日期：2026-09-20（本机 `date -u` 2026-09-21 02:05 起）
- 任务：Q5 收尾——把 #5896 设计 §7 登记为 **uncovered** 的「legacy 形态」关掉一半：凡是**今天就能无歧义证明**指向哪个 Connection 的 `data-source:sql-readonly` legacy 行，一次性提升为 canonical 形态；证明不了的一行不动，列给 owner。
- 基线：`origin/main` = `5edf4c3e1`（#5896 的迁移 `zzzz20260920120000_data_source_live_id_binding_lock.ts` 已在 main）
- 变更文件：
  - 迁移 `packages/core-backend/src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts`
  - 结构钉 `packages/core-backend/tests/unit/legacy-binding-connection-id-backfill-migration.test.ts`
  - 普查 `scripts/ops/readonly-inventory-20260916/05-legacy-binding-census.sql`（+ README 一行）
  - 本文 + `legacy-binding-connection-id-backfill-verification-20260920.md`
- 相关：#5896（live_id FK；本迁移**必须在它之后**部署）、#5783（legacy 重绑必须同写 canonical）、`zzzz20260902120000`（切换迁移，PR-1）、`data-source-live-id-fk-binding-lock-design-20260920.md` §7
- 2026-09-26 补充（据任务派发，owner 已同意）：谓词 7「源已启用」、谓词 8「源类型属于 SQL 只读可解析类型」。依据 `docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md` §3 结论 2：原谓词不查 `ds.is_active` 和类型，会把 S2b（源未启用）/ S2c（类型不在注册表）的 legacy 行提升成报 `CONNECTION_CANONICAL_UNAVAILABLE` 的 canonical 行。普查相应多出两类。见 §2、§5、§8 与验证文档 §11。

> **分类：DDL（新建账本表 `integration_external_system_connection_backfills`，`CREATE TABLE IF NOT EXISTS`）+ DML（回填 `integration_external_systems` 的行）。**
>
> **owner 门：这支迁移改 `integration_external_systems` 的行，不走「默认前进」。PR 开出后留 OPEN，owner 明示才合；合并前先在目标库跑 `05-legacy-binding-census.sql` 看 `backfillable` 数字。** 部署顺序：`zzzz20260920120000`（#5896）→ 本迁移。

---

## 1. 要关的登记项

#5896 把绑定 FK 重指到 `data_sources(live_id)`，让 canonical 形态（`connection_id` 非空）在删除并发的两个时序上都由数据库兜底。它的设计 §7 明确留下：

> **legacy 形态** `config.dataSourceId`（`connection_id IS NULL`）：没有 FK，`live_id` 机制对它无效。……关闭它需要 legacy 行也带 `connection_id`（#5783 的方向）。

本刀就是「legacy 行也带 `connection_id`」——但**只对能证明的行**。

## 2. 哪些行（九个谓词，每条都有代码依据）

`hit` CTE 的 JOIN + WHERE（迁移 `:200-219`；谓词 7、8 于 2026-09-26 补入）：

| # | 谓词 | 依据 |
|---|---|---|
| 1 | `b.kind = 'data-source:sql-readonly'` | 见 §3：其它 kind 没有 canonical 形态可去 |
| 2 | `b.connection_id IS NULL` | legacy 形态定义；也是幂等条件（重放 0 行） |
| 3 | `b.config->>'dataSourceId' = ds.id` | 指针要解析到一个 `data_sources` 行 |
| 4 | `b.config->>'dataSourceOwnerId' = ds.owner_id` | 服务端 owner 戳必须等于**那个源**的 owner。删除守卫计 legacy 引用用的就是这对谓词（`packages/core-backend/src/data-adapters/DataSourceManager.ts:713-718`），切换迁移回填也只认这对（`zzzz20260902120000_add_integration_connection_binding.ts:97-106`）。缺了它，一个指向他人源的指针会被提升成 canonical 引用 |
| 5 | `ds.deleted_at IS NULL` | #5896 后 FK 指向 `live_id`（软删即 NULL）且 `NOT VALID`：每一条 UPDATE 逐行检查，一条指向已软删源的指针就会让整支迁移以 23503 中止。PG 实证：去掉此谓词，`up()` 直接 `23503 fk_integration_external_systems_live_connection_id` |
| 6 | `ds.tenant_id = b.tenant_id` | canonical 解析器拒绝租户不一致的注册（`plugins/plugin-integration-core/lib/connection-resolver.cjs:113-121`，`CONNECTION_TENANT_MISMATCH`；对未证租户（源 `tenant_id` 为 NULL）的放行：legacy 分支恒放行（`:258-265`），canonical 分支**只在 `runAs = 'user'` 代跑时**放行（`:184-191` `ownerUserCompatibility`）。迁移不替 owner 猜，所以谓词 6 比解析器更保守——只可能少回填 `tenant-unproven` 一类，不会多放）。`data_sources.tenant_id` 可空、旧行未证前保持 NULL（切换迁移头注释），所以 **NULL 租户的源不回填**（普查报 `tenant-unproven`），不由迁移替 owner 猜 |
| 7 | `ds.is_active = TRUE` | 主机只装载 `is_active = true AND deleted_at IS NULL` 的源（`packages/core-backend/src/data-adapters/DataSourceManager.ts:324-325`，`loadFromDatabase`）。没装载的 id 在 `assertAccess` 得到统一的 not found（`:621-631`），facade 原样抛出（`data-source-plugin-facade.ts:507-513`），`resolveCanonical` 把任何 facade 异常改写成 `CONNECTION_CANONICAL_UNAVAILABLE`（`connection-resolver.cjs:166-183`）。所以提升一行指向未启用源的 legacy 行，只是把今天的 `CONNECTION_LEGACY_FALLBACK_DENIED` 换成这个码（诊断文档 S2b） |
| 8 | `lower(ds.type) IN ('mysql', 'postgres', 'postgresql', 'sqlserver')` | 集合**从代码推导**，不凭记忆：① 能装载 = `DEFAULT_ADAPTER_REGISTRY` 的键（`DataSourceManager.ts:193-200`：postgresql、postgres、http、sqlserver、mysql、plm），经 `registerDefaultAdapters`（`:453-459`）→ `registerAdapterType` 小写化后登记（`:461-462`）；源码里没有别的 `registerAdapterType(` 调用（只有 `docs/DATA_SOURCE_ADAPTERS.md` 里的示例）。装载时比较 `record.type.toLowerCase()`（`:331-333`），**只小写、不去空白**。② 能接受 = 插件 `DEFAULT_SQL_CONNECTION_TYPES`（`plugins/plugin-integration-core/lib/connection-resolver.cjs:8`：mysql、postgres、postgresql、sqlserver），插件没有覆盖它（`index.cjs:308-314` 不传 `allowedSqlConnectionTypes`）；`assertRegistration` 对注册类型先去空白再小写（`:125-126`，`nonBlankString` `:24-26`），注册类型就是库里的原始列值（facade `:584` `adapter.getType()` → `BaseAdapter.ts:555-557` → `recordToConfig` `DataSourceManager.ts:415`）。③ 交集 = mysql、postgres、postgresql、sqlserver。比较写成 `lower(ds.type)`、不去空白：与两处运行时一样不分大小写；带首尾空白的类型过不了（不去空白的）装载，所以也不拿。能装载但不是 SQL 的（http、plm）提升后会报 `CONNECTION_TYPE_UNSUPPORTED`（`:125-132`），装载不了的（诊断文档 S2c）会报 `CONNECTION_CANONICAL_UNAVAILABLE`。四个目标串都是纯 ASCII 字母；PG `lower()`（中文 locale）与 JS `toLowerCase()` 映射到这些字母的码点集合一致（验证文档 §11 逐码点核对）。单测从两个运行时模块**重新推导**这个集合，与迁移里的常量不等即红 |
| + | `b.legacy_connection_fallback_eligible IS NOT TRUE` | 标记 TRUE + `connection_id` NULL 是切换迁移**有意的回滚形态**（其幂等条款：「后来把 connection_id 置 NULL 的回滚不会被重放撤销」），并且今天仍能经 `resolveLegacy` 解析（`connection-resolver.cjs:205-263`）。再 canonical 化它等于撤销一次运维决定，所以不动、普查单列。本迁移拿的行恰是**两条解析分支今天都不接受**的行（`resolveLegacy` 在 `:205-216` 拒绝标记 FALSE） |

谓词 7、8 也有看不见的：源凭据解密失败（诊断文档 S2d，装载时逐行跳过）和部署状态 S1 / S2e 在 SQL 里看不出来，被提升的行仍可能因为这些原因报 `CONNECTION_CANONICAL_UNAVAILABLE`。

## 3. 为什么只回填 sql-readonly（write-gated 明确不回填）

插件写路径是唯一证据（`plugins/plugin-integration-core/lib/external-systems.cjs`，main @ `5edf4c3e1`）：

- **sql-readonly 新建行永远写 `connection_id` 并在 INSERT 前剥掉 `config.dataSourceId`**：`requestedConnectionId` 在无 `connectionId` 时把 `config.dataSourceId` 当请求边界兼容取值（`:547-560`），insert 分支先 `validateCanonicalConnectionBinding` 再 `withoutLegacyDataSourcePointer`（`:862-879`），`baseRow.connection_id = connectionId`（`:758`）。所以 legacy 形态**已无创建路径**，纯属存量。
- **其它带 `config.dataSourceId` 的 kind（`data-source:sql-write-gated` 等）正相反**：`requestedConnectionId` 对非 sql-readonly 的 `connectionId` 直接抛 `ExternalSystemValidationError`（`:526-534`）并返回 `null`；`baseRow` 把这个 null 写进 `connection_id`（`:758`），`updateRow = { ...baseRow, … }`（`:774`）在**每次 update 都把它重写成 NULL**。给这类行回填 `connection_id`，下一次保存就静默归零——回填等于没回填，还会在两次保存之间制造一个 FK 参与者/不参与者交替的行。所以不碰，普查按 kind 列给 owner（Q4）。

## 4. 目标形态 = insert 路径的形态

`SET connection_id = hit.connection_id, config = b.config - 'dataSourceId'`（迁移 `:222-223`）：

- `connection_id` 置为源 id；
- `config` **去掉** `dataSourceId`（与 `withoutLegacyDataSourcePointer` `:483-488` 一致）；
- `config.dataSourceOwnerId` **保留**：insert 分支剥指针后紧接着用已证 principal 重新盖章（`resolveCanonicalBindingOwner`，`:874-879`），谓词 4 刚刚证明了同一事实（戳 == 源 owner），所以保留后的行与 canonical 新建的行不可区分；
- 标记保持 FALSE（本来就是，由附加谓词保证）；凭据、capabilities 不动。
- `updated_at`：迁移语句**不写**它，但表上自带的 BEFORE UPDATE 触发器 `trg_integration_external_systems_updated_at`（`packages/core-backend/migrations/057_create_integration_core_tables.sql:182-195`）会给每一条被 UPDATE 写到的行盖 `NOW()`。所以在按完整迁移链建出的库上，被回填的行（以及 `down()` 恢复的行）`updated_at` 会变成执行时间；被跳过的行不变。（2026-09-26 更正：原文写「`updated_at` 不动」，那次验证只搭了 057 的建表语句、没带触发器，见验证文档 §11。`plugins/plugin-integration-core/lib` 里对这张表 `updated_at` 的读取只有 `external-systems.cjs:286`、`:310` 两处行映射（作为 `updatedAt` 输出），库内没找到拿它做并发控制的代码；影响是界面上这些行的「更新时间」会显示成迁移执行时间。是否要保留原值由 owner 定，本轮不改行为。）

## 5. 可逆性：独立账本表，不在 `config` 里打标

`config` 是客户端可见、每次保存 PATCH 合并（`resolveUpdatedConfig` `:456`）、服务端专有键在 normalize 收口处被剥（`SERVER_OWNED_CONFIG_KEYS` `:33`）——在里面放任何新键都会浮到工作台编辑表单。改为账本表 `integration_external_system_connection_backfills`（`binding_id` PK、`tenant_id`、写入的 `connection_id`、被移除的 `legacy_data_source_id` / `legacy_data_source_owner_id`、`migration_name`、`backfilled_at`）：values-free、API 不可见，`down()` 只按账本恢复。

**账本与 UPDATE 同一条语句，账本只由 UPDATE 的 `RETURNING` 喂**（`hit` → `upd`（UPDATE … RETURNING 实际写入行的 id / tenant / connection_id / owner 戳与被移除指针）→ `INSERT … SELECT … FROM upd`），「记账的行」和「改了的行」不可能漂移；UPDATE 跳过的候选不进账本。

**并发（窗口 8 复审 F1）**：READ COMMITTED 下 `hit` 候选来自语句快照；UPDATE 等到并发写入者的行锁后，是在对方已提交的新行版本上写。初版 UPDATE 只按 `b.id = hit.binding_id` 写，会把期间已提交的合法重绑（legacy → canonical B）覆盖回 A，账本也记 A。修法两道：① UPDATE 自己的 WHERE 对**正在写的当前行**逐条复核绑定侧条件（kind、`connection_id IS NULL`、回滚标记、tenant、指针 == 候选、owner 戳 == 候选），PG 在锁等待后会对新行版本重新求值（EvalPlanQual），不满足即跳过；② 候选 CTE `FOR SHARE OF ds` 锁住所 join 的源行，源的软删 / owner 变更 / 租户变更要么先提交（候选按新版本重判后掉出），要么等本迁移提交。两道各有两连接实库回归（`tests/integration/legacy-binding-connection-id-backfill-race.db.test.ts`），逐条去掉均红。

**谓词 7、8 的锁下复核（2026-09-26）**：两条都写在候选 CTE 的 JOIN 条件里，所以和谓词 3–6 一样由 `FOR SHARE OF ds` 复核：迁移在源行锁上等待期间，另一会话把源停用或把类型改成非 SQL 类型并提交，PG 按提交后的新版本重判 JOIN 条件，该候选掉出，不提升、不记账；从锁住到本迁移提交，源行不能再被改。**UPDATE 的 WHERE 不重复这两条（也不重复谓词 3–6 的源侧部分）**：UPDATE 不锁 `data_sources`，在 UPDATE 里 join 或子查询 `data_sources` 读的是语句快照，看不到 CTE 锁等待已经看到的新版本。这点有执行型证据：把谓词 7 或 8 从 CTE 挪到 UPDATE 的子查询里，竞争回归里「并发停用 / 并发改类型」那一条就红（验证文档 §11）。结构钉同时断言 UPDATE 段不读 `data_sources`，防止以后有人加一条看似复核、实际读快照的条件。

**锁代价（运维须知）**：迁移对所有候选源持 `FOR SHARE`，直到 migrate 批次提交；期间这些数据源的更新（编辑、软删、owner 移交）都会被阻塞。多行计划下锁序是逐行交错的 ds1 → b1 → ds2 → b2 …，与「先锁源再改绑定」以外顺序的写入者可能 40P01 死锁；PG 中止其中一方，若中止的是迁移，整体回滚（账本表在同一事务内创建，一并回滚），直接重跑 migrate 即可。

**账本 upsert（Sf7，有意为之）**：`ON CONFLICT (binding_id) DO UPDATE` 会覆盖此前 `down()` 保留下来的证据行（回填后被人改过的绑定，之后又被再次回填时）。账本必须描述数据当前的样子，`down()` 才能准确恢复这一次回填，所以旧证据被有意替换。

## 6. 幂等与 `down()` 的选择性

- 重放：谓词 2 让第二次 `up()` 命中 0 行、账本 0 插入（PG 实证：行与账本逐字节相同，`backfilled_at` 不变）。
- `down()` 只恢复**账本里有、且行仍是本迁移留下的样子**的行：`kind` 仍 sql-readonly、`connection_id` 仍等于账本记录值、`tenant_id` 与 owner 戳（`config->>'dataSourceOwnerId'`）仍等于账本记录值（与 `up()` 的复核对齐，复审 Sf4/Sf5）、`config` 里没有重新出现 `dataSourceId`、`migration_name` 匹配。恢复即删对应账本行；账本**空了才 DROP**。人在回填后重绑过的行原样保留，其账本行留作证据、表不删（PG 实证：重绑 `b_ok2` 后 `down()` 只恢复 `b_ok1`，账本剩 `b_ok2` 一行）。
- 切换迁移的 `down()` 会不会撞上本账本？切换迁移 `down()` 只删自己加的列/约束，账本是独立表，互不影响；但**回滚顺序必须是本迁移先 down**（否则 `connection_id` 列被删，本 `down()` 的 UPDATE 会失败——迁移框架本身就按逆序回滚）。

## 7. 与切换迁移在指针匹配上的一处刻意差异

切换迁移用 `NULLIF(BTRIM(config->>'dataSourceId'), '') = ds.id`（`zzzz20260902120000:104-105`），本迁移与普查用**精确相等**。理由：删除守卫（`DataSourceManager.ts:716-718`）与 `resolveLegacy` 的取值都是精确值；带空白的指针在守卫眼里本来就「不引用」，回填它反而会让守卫突然看见一个新引用。切换迁移当年已经把能 BTRIM 匹配的行拿走并标 TRUE，剩下带空白的（如果有）落在普查 `pointer-unresolved` 类，交 owner。

## 8. 普查 SQL（十类，含 owner 要的四类）

owner 要求四类（可回填 / 指向软删源 / owner 不匹配 / 非 sql-readonly）。为了让「其余各类为什么不动」每一类都有名字，细分为十个**互斥**类（先匹配先赢，十列之和 == `legacy_rows_total`）：`non-sql-readonly-kind` → `rollback-shape-marker-true` → `pointer-unresolved` → `source-soft-deleted` → `owner-mismatch` → `tenant-unproven` → `tenant-mismatch` → `source-inactive` → `source-type-unsupported` → `backfillable`。2026-09-26 新增的两类**排在其它不回填类之后、`backfillable` 之前**：一行落进这两类，说明它过了其余全部谓词，所以这两列的计数恰好就是「只因源未启用 / 只因类型不支持而不回填」的行数（也就是补谓词前迁移会多提升的行），原有七类的含义不变。类型比较与迁移同一张表、同一个 `lower()`（单测断言普查里只有这一张类型表、且等于从运行时推导出的集合）。Q2 只出计数（`source_inactive`、`source_type_unsupported` 两列），values-free；Q3 的 id 只供本地使用，不上证据面。Q2 计数与 Q3 id 读同一个 `hit` CTE；Q4 按 kind 列非 sql-readonly 指针；Q5 给全表分母；末行 `INVENTORY_RESULT … status=complete classes=10`（Q1 的列探针同时要求 `data_sources.is_active` 与 `type`），缺列则 `incomplete reason=missing-column:…`，并在 `live_id` 缺席时加 `note=data_sources.live_id-absent(#5896-not-applied)`（= 本迁移还不能上）。执行契约与包内其它四份相同（`\ir _preamble.sql`：ON_ERROR_STOP、`default_transaction_read_only = on`、超时），并已登记进 `verify/readonly-inventory-pack.test.mjs` 的 `FILES`，受同一组静态契约断言（必须 `\ir _preamble.sql`、必须以自己的 `INVENTORY_RESULT` 收尾、逐行无写语句）覆盖；README §5 清单同步列出。

## 9. 部署顺序、回滚、不做的事

- 顺序：`zzzz20260920120000`（#5896）→ 本迁移。文件名时间戳已保证；本迁移的谓词 5 写在 `deleted_at` 上、不依赖 `live_id` 列存在，所以即使误序也只是「行过滤仍正确、FK 不是 live 的」，不会坏数据。
- 迁移在 `connection_id` / `legacy_connection_fallback_eligible` / `data_sources.tenant_id` 任一缺席时**直接 return**（PG 实证：切换前 schema 上 `up()`/`down()` 均无操作、不建账本）。
- 回滚：`down()`（§6）。生产上如需回滚，先看账本表还剩几行、是谁。
- **不做**：不改插件代码；不 `VALIDATE CONSTRAINT`；不动 `integration_stock_prep_source_binding` 等其它持指针的表；不动 write-gated；不动标记 TRUE 的回滚形态；不猜 NULL 租户。

## 10. 验证（详见 verification 文档）

- 结构钉 14 条（F1 后 15 条：谓词 2 与回滚标记两条钉收窄到候选 CTE；「同一 `hit` CTE」一条改为「账本只由 RETURNING 喂」；新增一条钉 UPDATE 复核与 `FOR SHARE OF ds`）：七个谓词各自存在、目标形态、`down()` 选择性、账本只在空时 DROP；九个内存级文本变异各红（`fs.promises.readFile` 在 setupFile 里包一层，磁盘不动）。
- F1 两连接竞争回归（真 PG，12 条，独立 CI 车道 `legacy-binding-backfill-race-realdb.yml`，`EXPECT_DB=1` 防跳绿）：见 verification §9。
- 便携 PG 16.9：真迁移建 schema（`20251206000001` → 057 DDL → `zzzz20260902120000` → `zzzz20260920120000`），植入 11 行（八类各一 + 可回填两行 + canonical 对照两行），普查八类计数与 id 正确 → `up()` 只改 2 行无 23503 → 重放 0 行 → `down()` 逐字节恢复（那次只搭了 057 的建表语句、没有它的 `updated_at` 触发器；完整迁移链上 `updated_at` 除外，见 §4）→ 再 `up()` → 人为重绑后 `down()` 只恢复一行；六个迁移级变异各按预期偏离（去谓词 5 → 23503；去其余任一谓词 → 对应那一行被错误回填）。
- 谓词 7、8（2026-09-26）：便携 PG 16.10（中文 locale）用**完整迁移链**（`tsx src/db/migrate.ts`，416 支）建库，植入正常 / S2b / S2c / http 各一行：PR 旧 head 提升 4 行、账本记 4 行；新 head 只提升正常行、账本只记它，普查 `source_inactive=1`、`source_type_unsupported=2`、`backfillable=1`；迁移持锁期间另一会话停用源或把类型改成 http → 不提升。竞争回归套件增至 18 条；结构钉增至 19 条；变异自证见验证文档 §11。

## 11. 留给 owner 的决定

1. 合不合本 DML 迁移（先跑普查看 `backfillable`）。生产普查与执行仍须 owner 授权。
2. 普查其余九类各多少行、怎么处置：`source-inactive`（源未启用）要么启用源后再开一支同形迁移，要么解绑；`source-type-unsupported`（类型装载不了，或能装载但不是 SQL）要人判这条绑定本来该指向什么；`source-soft-deleted` 与 `pointer-unresolved` 是死引用（解绑或删行）；`owner-mismatch` 要人判；`tenant-unproven` 等 `data_sources.tenant_id` 证明后需要再开一支同形迁移（已应用的迁移不会重跑；语句本身幂等，新符合的行才会被拿进来）；`rollback-shape-marker-true` 是历史运维决定；`non-sql-readonly-kind` 归 write-gated 线。
3. 被回填行的 `updated_at` 会被 057 触发器改成执行时间（§4）：接受，还是另开一刀保留原值（例如在同一事务里临时停用该触发器，这需要表锁，另行评估）。本轮不改行为。
4. #5896 §7 的登记文案在合并后可改为「legacy 形态：可证明的 sql-readonly 行已回填（zzzz20260920150000）；剩余类别见普查」。
