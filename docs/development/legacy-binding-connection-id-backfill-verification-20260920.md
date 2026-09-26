# 验证记录：sql-readonly legacy 绑定行 `connection_id` 一次性回填（DDL 账本表 + DML 回填，#5896 后续）

- 日期：2026-09-20（本机 `date -u` 2026-09-21 02:05–02:30 UTC）
- 设计：`legacy-binding-connection-id-backfill-design-20260920.md`
- 基线：`origin/main` = `5edf4c3e1`（§11 的基线另列）
- 2026-09-26 补：谓词 7（源已启用）/ 8（SQL 只读可解析类型）、普查十类、`updated_at` 更正，见 §11
- 变更文件：迁移 `packages/core-backend/src/db/migrations/zzzz20260920150000_backfill_sql_readonly_legacy_connection_id.ts`；结构钉 `packages/core-backend/tests/unit/legacy-binding-connection-id-backfill-migration.test.ts`；普查 `scripts/ops/readonly-inventory-20260916/05-legacy-binding-census.sql` + README；本文与设计文档。

> values-free：本记录不含任何主机 / 口令 / 凭据。全部实证只在**本机一次性便携 PG 16.9 集群**上进行（`_pgtmp-w8n/` 下 `initdb --auth=trust --locale=C`，仅 loopback，跑完 `pg_ctl stop` 并删除）。数据库 `q5_verify` / `q5_precutover` / `q5_mut_*` 每轮 `DROP … WITH (FORCE)` 重建，全部假值。**没有连接任何真实数据库。**

---

## 1. 脚本（会话 scratchpad，不入库）

| 文件 | 作用 |
|---|---|
| `q5-run-pg.sh` | 起 / 停一次性集群（`start` / `stop` / `status`） |
| `q5-verify.mjs` | 验证本体（`node --import tsx`，从 `packages/core-backend` 下运行，`kysely` / `pg` 经 `createRequire` 取包内实例）。schema 走**真迁移**：`20251206000001_create_data_sources_table` → 057 的 `integration_external_systems` DDL 原文 → `zzzz20260902120000`（切换）→ `zzzz20260920120000`（#5896）；普查经 `psql -A -v schema=public -f 05-legacy-binding-census.sql` 整文件跑，解析 Q2/Q3/Q4/Q5 与 `INVENTORY_RESULT`。`repo` 模式跑仓库迁移；`mutant <name>` 模式把迁移**复制**到 scratchpad `mutants/` 做锚点唯一的字符串变异后跑（仓库文件不动，`NODE_PATH` 指回包内 `node_modules`） |
| `q5-mut-setup.ts` + `q5-mut.vitest.config.ts` | 结构钉的**内存级**变异：setupFile 包一层 `fs.promises.readFile`，路径命中被测迁移时按 `Q5_MUT` 做锚点唯一替换（命中数 ≠ 1 即中止）。磁盘不动，跑完无残留 |
| `q5-pg-repo.log`、`q5-pg-mut-*.log`、`q5-mut-*.log`、`q5-tsc.log` | 原始输出 |

## 2. 环境

```
# PostgreSQL 16.9, compiled by Visual C++ build 1943, 64-bit
```

两个环境坑（记下来省后人时间）：上一位代理留下的 `_pgtmp-w8n/pgsql` 只解出了 `bin/`，`share/timezonesets` 缺失导致 `initdb` 失败；Git Bash 的 `unzip` 对 `'pgsql/share/*'` 模式静默不解子目录，改用 `C:/Windows/System32/tar.exe -xf pg.zip pgsql/share pgsql/lib` 才补齐。端口 56617 / 54329 在本机 `bind` 报 Permission denied（不在 `netsh … excludedportrange` 列表里），61234 可用。

## 3. 植入的 11 行（全假值）

`data_sources`：`ds_ok1` `ds_ok2` `ds_own` `ds_wg`（t1 / u1，活）、`ds_dead`（t1 / u1，`deleted_at` 非空）、`ds_t2`（**t2** / u1）、`ds_null`（tenant **NULL**）。

`integration_external_systems`（除注明外 kind = sql-readonly、tenant t1、`connection_id` NULL、标记 FALSE、`config = {host, dataSourceId, dataSourceOwnerId:'u1'}`，`updated_at` 固定为 2026-01-02）：

| 行 | 偏差 | 预期普查类 | 迁移 |
|---|---|---|---|
| `b_ok1` | → ds_ok1 | backfillable | **改** |
| `b_ok2` | → ds_ok2 | backfillable | **改** |
| `b_dead` | → ds_dead | source-soft-deleted | 不动 |
| `b_own` | → ds_own，戳 `u2` | owner-mismatch | 不动 |
| `b_wg` | kind `data-source:sql-write-gated` → ds_wg | non-sql-readonly-kind | 不动 |
| `b_t2` | → ds_t2（源租户 t2） | tenant-mismatch | 不动 |
| `b_unproven` | → ds_null（源租户 NULL） | tenant-unproven | 不动 |
| `b_rb` | → ds_ok1，标记 **TRUE** | rollback-shape-marker-true | 不动 |
| `b_gone` | → `ds_missing`（无此源） | pointer-unresolved | 不动 |
| `b_canon` | `connection_id = ds_ok1`，无指针 | （canonical，不在 legacy 总体） | 不动 |
| `b_canon_ptr` | `connection_id = ds_ok1` **且** config 里残留指针 | （canonical） | 不动 |

## 4. 仓库迁移：31/31 通过（`q5-pg-repo.log`）

| 组 | 断言 | 证据 |
|---|---|---|
| schema | #5896 的 FK 在位：`fk_integration_external_systems_live_connection_id` → `live_id`，`convalidated=false` | 一条 FK，目标列 `live_id` |
| 普查 | `INVENTORY_RESULT file=05-legacy-binding-census.sql status=complete classes=8` | 末行原文 |
| 普查 Q2 | `legacy_rows_total=9`，八类各 1，`backfillable=2` | `{"legacy_rows_total":"9","non_sql_readonly_kind":"1","rollback_shape_marker_true":"1","pointer_unresolved":"1","source_soft_deleted":"1","owner_mismatch":"1","tenant_unproven":"1","tenant_mismatch":"1","backfillable":"2"}` |
| 普查 Q3 | 每类的 id 集合 == 上表预期，\|ids\| == Q2 计数 | `backfillable:[b_ok1,b_ok2]` 其余各一 |
| 普查 Q4 | 非 sql-readonly 按 kind：`data-source:sql-write-gated` 1 行 | — |
| 普查 Q5 | 分母 `bindings_total=11 canonical_rows=2 legacy_rows=9 unbound_rows=0 sql_readonly_rows=10` | — |
| 普查 | 只读：输出里没有任何 INSERT/UPDATE/DELETE/DDL 标签 | — |
| 谓词 5 的理由 | 绕过迁移直接 `UPDATE … SET connection_id='ds_dead' WHERE id='b_dead'` → **23503** `fk_integration_external_systems_live_connection_id` | 这就是「一条指向软删源的指针会让整支迁移中止」的机器证据 |
| `up()` | 无异常（无 23503） | — |
| `up()` | **恰好** `b_ok1`、`b_ok2` 变了；其余 9 行逐字段相同（含 `b_canon_ptr` 的残留指针） | `changed=["b_ok1","b_ok2"]` |
| `up()` | `b_ok1`：`connection_id=ds_ok1`，`config={host, dataSourceOwnerId:'u1'}`（指针没了、戳与 host 还在），标记 FALSE，`updated_at` 仍是 2026-01-02（这一条只在本节的部分链上成立：它没搭 057 的 `updated_at` 触发器；完整迁移链上的更正见 §11.6） | 行原文见日志 |
| `up()` | 账本恰好 2 行：`(b_ok1, ds_ok1, ds_ok1)` `(b_ok2, ds_ok2, ds_ok2)`，`tenant_id=t1`、`legacy_data_source_owner_id=u1`、`migration_name` 钉死 | — |
| 普查（回填后） | `legacy_rows_total=7`，`backfillable=0`，其余七类不变 | — |
| 重放 `up()` | 行与账本逐字节相同，`backfilled_at` 不变（`ON CONFLICT` 没被触发） | — |
| `down()` | `b_ok1` / `b_ok2` 恢复到植入时的行（`connection_id` NULL、`dataSourceId` 回到 config、`updated_at` 不变——同上，仅部分链；完整链上除 `updated_at` 外逐字节恢复，见 §11.6）；账本空 → 表已 DROP | 11 行快照 == 植入快照 |
| 再 `up()` | 又是 2 行，账本重建 2 行 | — |
| 人为重绑 | `UPDATE b_ok2 SET connection_id='ds_own'` 后 `down()`：`b_ok1` 恢复，`b_ok2` 保持 `ds_own` 且不长回指针 | — |
| 人为重绑 | 账本**保留**、恰好剩 `b_ok2` 一行 | — |
| 切换前 schema | 只有 057 表 + `data_sources`（无 `connection_id` 列）：`up()` 无操作、不建账本；`down()` 无操作 | 独立库 `q5_precutover` |

## 5. 迁移级变异（真 PG，`q5-pg-mut-*.log`，各应偏离且都偏离了）

| 变异（去掉一条谓词） | 结果 |
|---|---|
| `no-deleted-at`（谓词 5） | `up()` **23503** `fk_integration_external_systems_live_connection_id`，0 行改、无账本——整支迁移中止 |
| `no-tenant`（谓词 6） | 多改了 `b_t2` **和** `b_unproven`（`ds.tenant_id = b.tenant_id` 一条谓词同时挡住「租户不符」与「租户未证」） |
| `no-owner`（谓词 4） | 多改了 `b_own` |
| `no-kind`（谓词 1） | 多改了 `b_wg`（write-gated 被回填） |
| `no-marker`（附加谓词） | 多改了 `b_rb`（回滚形态被撤销） |
| `no-conn-null`（谓词 2） | 多改了 `b_canon_ptr`（canonical 行被重写、进账本） |

## 6. 结构钉与内存级文本变异（`q5-mut-*.log`）

基线：`npx vitest run tests/unit/legacy-binding-connection-id-backfill-migration.test.ts` → **14/14**；经变异配置不设 `Q5_MUT` 同样 14/14（包一层 readFile 本身无害）。

| `Q5_MUT` | 删掉的文本 | 红 |
|---|---|---|
| `p1-kind` | `WHERE b.kind = ${SQL_READONLY_KIND}`（WHERE 提到 connection_id 上） | 2 failed：predicate 1；predicate 2（`AND b.connection_id IS NULL` 形状随之变了） |
| `p2-conn-null` | `AND b.connection_id IS NULL` | 1 failed：predicate 2 |
| `p3-pointer` | `ON b.config->>'dataSourceId' = ds.id` | 2 failed：predicate 3；predicate 4（`AND` 变成了 `ON`） |
| `p4-owner` | `AND b.config->>'dataSourceOwnerId' = ds.owner_id` | 1 failed：predicate 4 |
| `p5-deleted` | `AND ds.deleted_at IS NULL` | 1 failed：predicate 5 |
| `p6-tenant` | `AND ds.tenant_id = b.tenant_id` | 1 failed：predicate 6 |
| `marker` | `AND b.legacy_connection_fallback_eligible IS NOT TRUE` | 1 failed：rollback shape left alone |
| `down-blanket` | `AND b.connection_id = l.connection_id` | 1 failed：down() restores ONLY ledger-recorded rows … |
| `down-dropif` | `DO $$ … IF NOT EXISTS … DROP TABLE … END $$` → `DROP TABLE IF EXISTS` | 1 failed：down() drops the ledger only when it is empty |

## 6b. 普查文件接入只读盘点包的静态契约（反驳者 blocker 修复，2026-09-21）

反驳者指出 `05-legacy-binding-census.sql` 没登记进 `scripts/ops/readonly-inventory-20260916/verify/readonly-inventory-pack.test.mjs` 的 `FILES`，因此三条 hermetic 契约（必须 `\ir _preamble.sql` / 必须以自己的 `INVENTORY_RESULT` 收尾 / 逐行无写语句）一条都不覆盖它；README §5 清单也没列它。修法各一行：`FILES` 追加 `'05-legacy-binding-census.sql'`，README 清单补一行。

| 项 | 结果 |
|---|---|
| `node --test verify/readonly-inventory-pack.test.mjs`（LF 规范化的 scratchpad 副本，无 `DATABASE_URL`） | **8 pass / 0 fail / 1 skipped**（layer 2 按设计大声跳过）；三条契约对五份文件全绿 |
| 同一命令在 Windows 检出（`core.autocrlf=true`，02 文件为 CRLF） | `F4 (not regressed): 02-trg04 …` 红：`0 !== 3`。**main 检出同样红**，是 `/WITH hit AS \(([\s\S]*?)
\)
/` 不认 CRLF 的既有本机假红，与本 PR 无关；CI（Linux, LF）不受影响 |
| 内存级变异（`w8n-guard-mutation.mjs`，照抄测试正则，不落盘） | 基线 GREEN；`inject UPDATE line` → 写语句命中 1；`strip \ir _preamble.sql` → 前言断言红；`strip INVENTORY_RESULT` → 收尾断言红；`append trailing SELECT 1;` → 末行 `) p;` 断言红。`FILES` 解析结果含 05，即这四种编辑现在都会被挡 |

## 7. 类型与其它

- `packages/core-backend`：`npx tsc --noEmit -p tsconfig.json` → exit 0（`q5-tsc.log`）。
- `tests/unit` 里没有 `request(app)`（本 spec 只读文件与导入模块）。
- `git diff origin/main | grep -P '\x08'` 为空（推送前核）。
- 迁移改用 `_patterns.ts` 已有的 `checkColumnExists`（原草稿本地重复了一份）；结构钉多钉一条 `import { checkColumnExists, checkTableExists } from './_patterns'`。

## 8. 没做 / 留给 owner

- 没在任何真实库上跑普查或迁移；`backfillable` 在 222 / 生产上是多少，未知。
- 便携 PG 集群与 `_pgtmp-w8n/` 已在收尾时停掉并删除。

## 9. F1（窗口 8 复审）：候选快照覆盖并发提交的重绑 —— 修复与实证

- 缺陷：七个资格条件只在候选 CTE `hit` 里，UPDATE 只按 `b.id = hit.binding_id` 写。READ COMMITTED 下候选来自旧快照，UPDATE 等到并发写入者的行锁后在其已提交的新版本上写，把合法重绑 legacy → canonical `source_b` 覆盖回 `source_a`，账本也记 `source_a`。
- 修复：UPDATE 的 WHERE 对当前行复核绑定侧条件（kind、`connection_id IS NULL`、回滚标记、tenant == 候选、指针 == 候选、owner 戳 == 候选）；候选 CTE 加 `FOR SHARE OF ds`；账本改由 `UPDATE … RETURNING` 喂，跳过的行不记账。
- owner 探针（改造版：新数据目录、独立端口、本机合成 PG 16.15，迁移模块分别指向 b591dd957 原文与修复后文件）：
  - 修复前：`{"outcome":"committed","expected":"source_b","actual":"source_a","ledger":["source_a"]}`
  - 修复后：`{"outcome":"committed","expected":"source_b","actual":"source_b","ledger":[]}`
- 仓库回归 `packages/core-backend/tests/integration/legacy-binding-connection-id-backfill-race.db.test.ts`（每条独立 schema；写入者开事务改行不提交 → 迁移 `up()` 起跑 → 第三连接经 `pg_stat_activity` 确认迁移在锁上等待 → 写入者提交 → 迁移必须提交且保留写入者的结果）：基线 up/重放/down、canonical 重绑、混合形态（写 `connection_id` 保留指针）、指针改指、owner 戳改写、回滚标记翻 TRUE、kind 改走、tenant 迁移、源 owner 变更、源软删、正对照（只改无关键仍回填并记账），外加 `EXPECT_DB` 哨兵，共 12 条。
- 内存级变异（vite transform 在加载时改迁移源码，不落盘）：去掉全部 6 条 UPDATE 复核 → 7 红；逐条去掉 kind / `connection_id IS NULL` / 标记 / tenant / 指针 / owner 戳 → 各恰好 1 条对应用例红；去掉 `FOR SHARE OF ds` → 源 owner 变更（行被写入）与源软删（迁移以 23503 中止）2 红；账本改回从候选喂 → 7 红；恢复 → 12 绿。
- CI：该文件从默认无库 vitest 配置排除（不会被收集后跳绿），整文件接入独立车道 `.github/workflows/legacy-binding-backfill-race-realdb.yml`（postgres:16 service、`EXPECT_DB=1`）；不改 s6a 钉住的 `plugin-tests.yml`。
- 生产普查与应用仍须 owner 授权。

## 10. 复审补充：down() 对齐 up()、锁代价、Sf7

- `down()` 的 WHERE 补 `b.tenant_id = l.tenant_id` 与 `b.config->>'dataSourceOwnerId' = l.legacy_data_source_owner_id`。反例（独立核验 Sf4/Sf5）：回填后绑定被移到另一租户，或 owner 戳改成别人，旧 `down()` 仍会把它退回成指向原租户 / 原 owner 源的 legacy 指针。
- 竞争回归新增 2 条（两连接，写入者持锁时 `down()` 起跑、第三连接确认等待、写入者提交）：Sf4 租户迁移、Sf5 owner 戳改写 → 行保持写入者的结果、账本行保留作证据。套件共 14 条。
- 内存级变异：去掉 `down()` 的 tenant 条件 → 只有 Sf4 红；去掉 owner 戳条件 → 只有 Sf5 红；恢复 → 14 绿。之前的 `up()` 变异照旧（去全部 6 条复核 → 7 红；去 `FOR SHARE OF ds` → 2 红）。
- 锁代价与 40P01、Sf7 账本 upsert 覆盖证据行：见设计文档 §5 与迁移 `up()` 注释（LOCKING COST / LEDGER UPSERT）。

## 11. 谓词 7（源已启用）/ 8（SQL 只读可解析类型）—— 2026-09-26

- 缘由：据任务派发，owner 已同意按 `docs/development/takeover-beiliao-20260821/stock-prep-connection-canonical-unavailable-diagnosis-20260925.md` §3 结论 2 补谓词：原谓词不查 `ds.is_active` 和类型，会把 S2b（源未启用）/ S2c（类型不在注册表）的 legacy 行提升成报 `CONNECTION_CANONICAL_UNAVAILABLE` 的 canonical 行。
- 时间：本机 `date -u` 2026-09-26 13:00–13:40 UTC。
- 基线：PR head `cb765d4e7`（与 main 的 merge-base `4189aa096`）。下文引用的 `DataSourceManager.ts`、`connection-resolver.cjs`、`data-source-plugin-facade.ts`、`BaseAdapter.ts`、插件 `index.cjs`、`external-systems.cjs` 在 `cb765d4e7` 与当时的 `origin/main`（`51acbb18f`）之间 `git diff` 为空，行号两边都成立。
- 改动：迁移候选 CTE 的 JOIN 加 `AND ds.is_active = TRUE` 与 `AND lower(ds.type) IN (${sql.join(SQL_READONLY_CONNECTION_TYPES)})`（`:213-214`，常量 `:138`）；普查新增 `source-inactive`、`source-type-unsupported` 两类（`classes=10`）；结构钉 +4；竞争回归 +4；本节与设计文档同步。
- values-free：全部在本机一次性便携 PG 16.10 集群上完成（scratchpad 数据目录、只监听 127.0.0.1、`initdb` 默认中文 locale，库级 `datcollate = datctype = zh-CN`，与演示机同为中文 locale），数据全部是假值。**没有连接任何真实数据库、演示机或客户系统。**

### 11.1 类型集合从代码推导

| 半边 | 代码 | 结论 |
|---|---|---|
| 能装载 | `DEFAULT_ADAPTER_REGISTRY`（`packages/core-backend/src/data-adapters/DataSourceManager.ts:193-200`）；`registerDefaultAdapters`（`:453-459`）→ `registerAdapterType` 把键小写化（`:461-462`）；装载判断 `record.type.toLowerCase()`（`:331-333`），只小写、不去空白；源码里没有别的 `registerAdapterType(` 调用（`git grep` 只多出 `docs/DATA_SOURCE_ADAPTERS.md` 的示例） | postgresql、postgres、http、sqlserver、mysql、plm |
| 能接受 | `DEFAULT_SQL_CONNECTION_TYPES`（`plugins/plugin-integration-core/lib/connection-resolver.cjs:8`）；插件没有覆盖（`index.cjs:308-314`）；`assertRegistration` 去空白再小写（`:125-126`、`nonBlankString` `:24-26`）；注册类型 = 库里原始列值（facade `:584` → `BaseAdapter.ts:555-557` → `recordToConfig` `DataSourceManager.ts:415`） | mysql、postgres、postgresql、sqlserver |
| 交集 | — | **mysql、postgres、postgresql、sqlserver**，迁移里比较 `lower(ds.type)`、不去空白 |

单测 `predicate 8 — the declared type set equals …` 在测试里 `import` 真实的 `DEFAULT_ADAPTER_REGISTRY`、`require` 真实的 `connection-resolver.cjs`，按上面两条规则重算交集，与迁移常量逐项比较；普查那条用例断言普查里只有这一张类型表且等于重算结果。

大小写一致性（`p5933-lower-check.mjs`，只输出计数）：枚举全部 Unicode 码点（去掉代理区），分别用 JS `toLowerCase()` 与 PG `lower(chr(cp))` 找「小写后只由目标字母 `eglmopqrstvy` 组成」的码点：两边都是 24 个，都是 ASCII 大小写字母，集合相同（`sameSet: true`）。所以 `lower(ds.type) IN (…)` 选中的类型串，与运行时装载加解析的判定一致。

### 11.2 完整迁移链实库（`p5933-chain.spec.ts`，scratchpad，不入库）

schema 用仓库自己的 `tsx src/db/migrate.ts` 在空库上跑完整链（416 支迁移全部成功，最后一支就是本迁移，空数据上无操作）。实库里 `data_sources.is_active`、`type` 都是 NOT NULL，#5896 的外键 `convalidated = false`。植入 4 个源与 4 条 sql-readonly legacy 绑定（同租户、owner 戳匹配、标记 FALSE）：正常（postgresql、启用）、S2b（mysql、**未启用**）、S2c（mongodb，不在注册表）、http（能装载但不是 SQL）。迁移模块经 vite transform 在加载时替换（磁盘文件不动）：不设变量 = 工作区新 head；`old-head` = PR head `cb765d4e7` 的原文（与 `git show HEAD:` 逐字节相同）。

| 用例 | 新 head | 旧 head |
|---|---|---|
| schema：两表列与 #5896 外键在位 | 绿 | 绿（与迁移无关） |
| 普查（`psql -X -A -v schema=public -f 05-…sql` 整文件）：`classes=10`；`legacy_rows_total=4`、`source_inactive=1`、`source_type_unsupported=2`、`backfillable=1`，十列之和 = 总数 | 绿 | 绿（与迁移无关） |
| `up()`：提升的行、账本、被写到的行（`updated_at` 变了的行）都只有正常行 | 绿 | **红**：提升 4 行、账本 4 行 |
| `up()` 后普查 `legacy_rows_total=3`、`backfillable=0`、新两类不变；重放无变化；`down()` 后除 `updated_at` 外逐字节恢复 | 绿 | **红** |
| 竞争：迁移在源行锁上等待时另一会话停用该源并提交 → 不提升、不记账，迁移提交 | 绿 | **红** |
| 竞争：同上，把类型改成 http → 不提升 | 绿 | **红** |
| 竞争正对照：同上，把类型改成 `PostgreSQL`（大小写变体，仍合格）→ 照常提升并记账 | 绿 | **红**（旧 head 连 S2b/S2c/http 一起提升） |

合计：新 head 7/7；旧 head 5 红 2 绿（两条绿的与迁移无关）。

### 11.3 仓库竞争回归（`tests/integration/legacy-binding-connection-id-backfill-race.db.test.ts`，已有 CI 车道）

最小表形加 `type`（默认 `postgresql`）与 `is_active`（默认 TRUE）两列，新增 4 条：

1. 静态：未启用（S2b）、mongodb（S2c）、http、带前导空格的 ` mysql`（装载不去空白，所以装载不了）四行不提升；`SQLServer`（大小写变体）与基线行提升；账本只记后两行。
2. 竞争：迁移持锁期间另一会话 `UPDATE data_sources SET is_active = FALSE` 并提交 → 不提升、账本空，且第三连接经 `pg_stat_activity` 确认迁移确实在锁上等过、迁移已提交。
3. 竞争：同上，`SET type = 'http'` → 不提升。
4. 竞争正对照：同上，`SET type = 'PostgreSQL', is_active = TRUE` → 照常提升并记账。

本机（`DATABASE_URL` 指向便携集群，`EXPECT_DB=1`）：新 head **18/18**；旧 head **3 红**（上面 1–3）。

### 11.4 变异自证（全部内存级，磁盘文件不动）

竞争回归（vite transform 改迁移源码）：

| 变异 | 红 |
|---|---|
| 去掉 `ds.is_active = TRUE` | 2：静态 7/8、并发停用 |
| 去掉类型条件 | 2：静态 7/8、并发改类型 |
| 两条都去 | 3：静态、并发停用、并发改类型 |
| 把谓词 7 从 CTE 挪到 UPDATE 的子查询（`EXISTS (SELECT … FROM data_sources … is_active = TRUE)`） | 1：并发停用（UPDATE 读的是语句快照，看不到新版本） |
| 把谓词 8 同样挪到 UPDATE | 1：并发改类型 |
| 去掉 `FOR SHARE OF ds` | 5：源 owner 变更、源软删（23503）、并发停用、并发改类型、源侧正对照 |
| 比较原始列、不 `lower()` | 2：静态（`SQLServer` 不再提升）、源侧正对照 |
| 类型表去掉 sqlserver | 1：静态 |
| 类型表加上 http | 2：静态、并发改类型 |
| 旧 head 原文 | 3 |

完整迁移链 spec：去 `is_active` → 5 红；去类型条件 → 5 红（这两种变异下，夹具里的 S2b 或 S2c/http 行在每条用例都会被提升）；谓词 7 挪到 UPDATE → 只有「并发停用」红；谓词 8 挪到 UPDATE → 只有「并发改类型」红；不 `lower()` → 只有大小写正对照红。

结构钉（`fs.promises.readFile` 在 setupFile 里包一层，按锚点唯一替换）：基线 19/19；11 个变异各恰好 1 红——迁移去 `is_active`、去类型条件、类型表加 http、去 sqlserver、UPDATE 段读 `data_sources`；普查去 `source-inactive` 分支、去 `source-type-unsupported` 分支、类型表与迁移不一致、`source-inactive` 挪到 `tenant-unproven` 之前、去 `source_inactive` 计数列、`classes=10` 改回 8。

### 11.5 为什么 UPDATE 的 WHERE 不重复谓词 7、8

任务原文要求「候选 CTE 与 UPDATE 的锁下复核 WHERE 都加上」。实际做法是只加在候选 CTE 的 JOIN 条件里，理由是执行型证据而不是推理：UPDATE 不锁 `data_sources`，在 UPDATE 里读 `data_sources` 用的是语句快照；11.4 里「挪到 UPDATE」两条变异各让对应的并发用例红，说明 UPDATE 里的这类条件拦不住并发停用 / 改类型。真正起作用的是候选 CTE 的 `FOR SHARE OF ds`：锁等待后 PG 按提交后的新版本重判整条 JOIN 条件（谓词 3–8）。两处都加的话，UPDATE 里那一份删掉也没有任何用例会红，是无法验证的重复条件，所以没加；结构钉断言 UPDATE 段不读 `data_sources`。如果 owner 仍要求两处都写，改动是一行，但须同时撤掉这条结构钉。

### 11.6 更正：`updated_at` 会被 057 的触发器改写

完整迁移链上跑出来的事实：`integration_external_systems` 有 BEFORE UPDATE 触发器 `trg_integration_external_systems_updated_at`（`packages/core-backend/migrations/057_create_integration_core_tables.sql:182-195`），给每一条被 UPDATE 写到的行盖 `NOW()`。迁移语句本身不写 `updated_at`（结构钉照旧断言这一点），但被回填的行、以及 `down()` 恢复的行，`updated_at` 都会变成执行时间；被跳过的行不变（11.2 用它确认 S2b/S2c/http 行根本没被写到）。§4 里「`updated_at` 仍是 2026-01-02」「`down()` 逐字节恢复」两条是在只搭了 057 建表语句、没带触发器的部分链上得出的，在完整链上不成立，已在原处加注；迁移头注释 NOT TOUCHED 一段与设计文档 §4 同步改正。行为本轮不改，是否保留原值列入设计文档 §11 给 owner。

### 11.7 其它检查

- `packages/core-backend`：`npx tsc --noEmit -p tsconfig.json` → exit 0。
- 只读盘点包静态契约（`node --test verify/readonly-inventory-pack.test.mjs`）：LF 规范化的 scratchpad 副本 **8 pass / 0 fail / 1 skipped**；Windows 检出直接跑仍是 §6b 记过的 `F4 … 02-trg04` CRLF 本机假红，与本改动无关。
- `tests/unit` 里没有 `request(app)`；推送前按字节扫描改动文件，无控制字符、LF 行尾。

### 11.8 没做 / 留给 owner

- 没在任何真实库上跑普查或迁移；`source_inactive`、`source_type_unsupported`、`backfillable` 在演示机或生产上各是多少，未知。**生产普查与执行仍须 owner 授权。**
- S2d（源凭据解密失败）和部署状态 S1 / S2e 在 SQL 里看不见，谓词 7、8 管不到；被提升的行仍可能因此报 `CONNECTION_CANONICAL_UNAVAILABLE`。
- 诊断文档 §2 的 S6（内存注册表与库不一致）同样是 SQL 看不见的：迁移按库判，运行中的后端按启动时的快照判。在后端运行期间执行本迁移，若之前有绕过 `DataSourceManager` 的 `data_sources` 改动，重启前仍可能不一致。
