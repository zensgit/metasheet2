# 验证记录：sql-readonly legacy 绑定行 `connection_id` 一次性回填（DML 迁移，#5896 后续）

- 日期：2026-09-20（本机 `date -u` 2026-09-21 02:05–02:30 UTC）
- 设计：`legacy-binding-connection-id-backfill-design-20260920.md`
- 基线：`origin/main` = `5edf4c3e1`
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
| `up()` | `b_ok1`：`connection_id=ds_ok1`，`config={host, dataSourceOwnerId:'u1'}`（指针没了、戳与 host 还在），标记 FALSE，`updated_at` 仍是 2026-01-02 | 行原文见日志 |
| `up()` | 账本恰好 2 行：`(b_ok1, ds_ok1, ds_ok1)` `(b_ok2, ds_ok2, ds_ok2)`，`tenant_id=t1`、`legacy_data_source_owner_id=u1`、`migration_name` 钉死 | — |
| 普查（回填后） | `legacy_rows_total=7`，`backfillable=0`，其余七类不变 | — |
| 重放 `up()` | 行与账本逐字节相同，`backfilled_at` 不变（`ON CONFLICT` 没被触发） | — |
| `down()` | `b_ok1` / `b_ok2` 恢复到植入时的行（`connection_id` NULL、`dataSourceId` 回到 config、`updated_at` 不变）；账本空 → 表已 DROP | 11 行快照 == 植入快照 |
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

## 7. 类型与其它

- `packages/core-backend`：`npx tsc --noEmit -p tsconfig.json` → exit 0（`q5-tsc.log`）。
- `tests/unit` 里没有 `request(app)`（本 spec 只读文件与导入模块）。
- `git diff origin/main | grep -P '\x08'` 为空（推送前核）。
- 迁移改用 `_patterns.ts` 已有的 `checkColumnExists`（原草稿本地重复了一份）；结构钉多钉一条 `import { checkColumnExists, checkTableExists } from './_patterns'`。

## 8. 没做 / 留给 owner

- 没在任何真实库上跑普查或迁移；`backfillable` 在 222 / 生产上是多少，未知。
- 便携 PG 集群与 `_pgtmp-w8n/` 已在收尾时停掉并删除。
