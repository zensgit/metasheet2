# 验证记录：数据源 live_id 生成列 + 绑定 FK 重指 + 取消 force（W7-B PR-B）

- 日期：2026-09-20（本机时钟 `date` 05:11–05:24 UTC）
- 设计：`data-source-live-id-fk-binding-lock-design-20260920.md`
- 基线：`origin/main` = `6ea19e2de`（PR-A #5889 已 squash 合入；PR-A 分支最终 `0648eb26c` 的三份表严格 fake 已在 main 上）
- 变更文件：迁移 `packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts`；`DataSourceManager.ts` / `routes/data-sources.ts`（去 force + 23503 映射）；`plugins/plugin-integration-core/lib/external-systems.cjs`（23503→409 映射）；openapi `src/paths/data-sources.yml` + `dist/*`；前端两处注释与两份 spec 的文案 fixture；单测四份 + 新增迁移/去 force 结构钉。

> values-free：本记录不含任何主机 / 口令 / 凭据。全部实证只在**本机一次性便携 PG 16 集群**上进行（scratchpad 内 `initdb`，loopback，`--auth=trust`，跑完 `pg_ctl stop`；数据库 `w7bb_verify` 每轮 `DROP … WITH (FORCE)` 重建）。**没有连接任何真实数据库。**

---

## 1. 便携 PG 集群与脚本（可重跑）

位置（会话 scratchpad，不入库）：`…/scratchpad/w7bb/`

| 文件 | 作用 |
|---|---|
| `w7bb-run-pg.sh` | 起 / 停一次性集群（`edb/pgsql/bin`，`PGDATA=pgdata`，`PGPORT=55441`，`--locale=C`），生成迁移变异体，按「仓库迁移 → 未变异副本 → 变异 a → 变异 b」跑四轮验证，逐轮打印 `n/32 checks` 与 `FAIL` 行。`NODE_PATH=$CB/node_modules` 让 scratchpad 里的变异副本能解析 `kysely`（上一轮三份副本因此没跑起来，本轮修好） |
| `w7bb-pg-verify.mjs` | 验证脚本本体（`node --import tsx`）。**真** `DataSourceManager`（删除侧）+ **真**插件 `createExternalSystemRegistry` 经**真** `lib/db.cjs`（绑定侧，第二个物理连接），schema 走真迁移（`20251206000001` + `zzzz20260902120000` + 被测迁移），`integration_external_systems` 表 DDL 照 057 原文建 |
| `w7bb-make-mutants.mjs` | 把迁移**复制**到 `mutants/` 后做锚点唯一的字符串变异（仓库文件不动）：`no-unique-index`（去掉 `uq_data_sources_live_id`）、`fk-back-to-id`（FK 改回 `REFERENCES data_sources(id)`）、`baseline-copy`（未变异副本，证明复制机制本身无害） |
| `w7bb-mutation.vitest.config.ts` | 代码侧内存级变异：vite `transform` 钩子里改写 `DataSourceManager.ts` / `data-sources.ts`（磁盘文件不动；锚点必须唯一命中，否则中止）。运行时放在 `packages/core-backend/` 下、**未跟踪、未提交**，跑完删除 |
| `w7bb-pg-*.log`、`w7bb-mut-*.log`、`w7bb-tsc.log` | 各轮原始输出 |

命令：

```bash
bash …/scratchpad/w7bb/w7bb-run-pg.sh
# 代码变异（在 packages/core-backend 下，配置文件临时存在）
W7BB_MUTATION=restore-force-branch npx vitest run --config w7bb-mutation.vitest.config.ts tests/unit/data-source-remove-ordering.test.ts tests/unit/data-source-scope.test.ts tests/unit/data-source-visibility-authority-matrix.test.ts tests/unit/data-source-live-id-binding-lock-migration.test.ts
W7BB_MUTATION=drop-fk-mapping        npx vitest run --config w7bb-mutation.vitest.config.ts <同上四份>
```

## 2. 环境

```
# PostgreSQL 16.9, compiled by Visual C++ build 1943, 64-bit
# isolation=read committed
```

## 3. 仓库迁移：32/32 通过（`w7bb-pg-repo.log`，3633 ms）

按脚本分组摘录（全部 PASS）：

| 组 | 断言 | 证据 |
|---|---|---|
| 基线 | 旧 FK `connection_id → data_sources(id)` 就位（PR-1 schema） | `target_column=id` |
| 预置悬空 | 旧 FK 下，往已软删的 `ds_dead` 上绑一条 `es_stale` **被接受**（这就是洞） | 插入成功 |
| 迁移 up | **带着预置悬空行**迁移通过（NOT VALID） | 无异常 |
| 迁移 up | FK 现指 `data_sources(live_id)`，`ON DELETE RESTRICT`，`convalidated=false`；旧 FK 已删 | `{"conname":"fk_integration_external_systems_live_connection_id","convalidated":false,"confdeltype":"r","target_column":"live_id"}` |
| 迁移 up | 预置悬空行 `es_stale → ds_dead` **原样保留**；`ds_dead.live_id IS NULL`；`uq_data_sources_live_id` 为 UNIQUE INDEX | — |
| 真 manager | `addDataSource` 落库两行，`live_id = id` | count=2 |
| **时序 A**（删在前） | 绑定 INSERT 在删除持 FOR UPDATE 期间**阻塞** ≥800 ms（FK KEY SHARE vs FOR UPDATE） | `blockedWhileLocked=true` |
| 时序 A | 删除（计数看到 0）提交 | resolved |
| 时序 A | 恢复后的绑定被 FK 拒绝，经插件映射为 `ExternalSystemConflictError` `EXTERNAL_SYSTEM_CONNECTION_NOT_LIVE` | `constraint=fk_integration_external_systems_live_connection_id` |
| 时序 A | **新增悬空行 = 0**（只剩预置那条）；`ds_a` 已软删、`live_id NULL` | `new dangling = 0` |
| **时序 B**（绑在前） | 删除在未提交绑定上**阻塞** ≥800 ms | `blocked=true` |
| 时序 B | 绑定提交后删除计数到 1 → 409 | `DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS {"referenceCount":1}` |
| 时序 B | 文案「请先解绑 1 个外部系统」；行仍活（`live_id='ds_b'`）；内存未清 | — |
| **force** | `removeDataSource('ds_b', { force: true })` → 409，行未软删 | `DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS` |
| force | 绕过应用层**直接** `UPDATE data_sources SET deleted_at=now()` → 数据库拒绝 | `23503 fk_integration_external_systems_live_connection_id` |
| 兜底 | 人为让计数恒 0 → UPDATE 撞 FK → manager 映为 409，`referenceCount: null`；行仍活 | `409 DATA_SOURCE_REFERENCED_BY_EXTERNAL_SYSTEMS {"referenceCount":null}` |
| 唯一路径 | 解绑 `es_b` 后删除成功，`live_id NULL` | — |
| 非键列更新 | 另一事务持 `UPDATE … SET status` 未提交时，并发绑定**不阻塞** | `bound` |
| RESTRICT | 硬删已软删的 `ds_dead` 通过（`live_id NULL` 无人引用）；`es_stale` 留作 NOT VALID 存量债 | 无异常 |
| **down** | 带悬空行 `down()` 通过；旧 FK `connection_id → data_sources(id)` 恢复（RESTRICT，NOT VALID）；live FK / `live_id` 列 / 唯一索引均消失 | `{"conname":"fk_integration_external_systems_connection_id","convalidated":false,"confdeltype":"r","target_column":"id"}` |
| 幂等 | `down()` 后连跑两次 `up()` 无异常，FK 重新指向 `live_id` | — |

未变异副本 `baseline-copy`：32/32（3819 ms）——复制 + 绝对路径 `_patterns` 导入机制本身不改变结果。

## 4. 变异（应各红）

### 4a. 迁移变异（真 PG）

| 变异 | 结果 | 红在哪 |
|---|---|---|
| a. 去掉 `uq_data_sources_live_id` 唯一索引 | **2/3**，脚本在迁移处止步 | `migration up() … FAIL -- 42830 there is no unique constraint matching given keys for referenced table "data_sources"`（FK 无法指向非唯一列；生成列 + FK 这套设计离开唯一索引就建不起来） |
| b. FK 改回 `REFERENCES data_sources(id)` | **23/32** | `FK now targets … target_column:"id"`；**时序 A：`bind SUCCEEDED -> "ds_a"`，`new dangling = 1`**（洞重开）；`force: 直接软删 UPDATE succeeded`；兜底映射 `resolved`（没东西可映）；`unbind then delete` 因 ds_b 已被删掉而 not found；硬删已软删源撞 `23503`（RESTRICT 又看见了 `es_stale`）；`up() twice after down()` 红 |

### 4b. 代码变异（内存级，vitest transform，四份 spec 共 109 条）

| 变异 | 结果 | 红的用例 |
|---|---|---|
| c. 恢复 force 分支：manager 事务内 `if (options?.force !== true)` 包住计数 + 无 db 旁路 `else if (force !== true)` + 路由透传 `{ force: req.query.force === 'true' }` | **3 failed / 106 passed**（2 个文件红） | `remove-ordering › force is RETIRED (owner ruling ①): { force: true } changes nothing`（`promise resolved instead of rejecting`）；`remove-ordering › ③ memory-only manager (no db)`；`scope › removeDataSource has no force bypass … keeps its scope entry whatever options are sent` |
| d. 去掉 `isLiveConnectionFkViolation` → 409 的映射 | **1 failed / 108 passed** | `remove-ordering › DATABASE BACKSTOP (PR-B): the soft delete refused by the live-connection FK (23503) => the SAME 409`（`expected 500 to be 409`） |

两次变异日志开头都有 `[w7bb-mutation] applied <name> to <file>`（锚点唯一命中）；跑完 `git status` 下 `src/` 只有原本的 `M`，磁盘源码未动。

插件侧映射的变异探针写在 `external-systems.test.cjs` 的注释里（去掉 `.catch` / 按英文散文判 / 映射所有 23503），由同一用例的三组 CONTROL 断言覆盖：另一约束名的 23503 原样透传、同名但 `23505` 原样透传、**只有英文散文没有 SQLSTATE 的错误不被信任**。

## 5. 单测 / 类型 / 前端 / 插件 / openapi

| 检查 | 命令 | 结果 |
|---|---|---|
| core-backend 四份 spec（含新增 `data-source-live-id-binding-lock-migration.test.ts`） | `npx vitest run --config vitest.config.ts tests/unit/data-source-remove-ordering.test.ts tests/unit/data-source-scope.test.ts tests/unit/data-source-visibility-authority-matrix.test.ts tests/unit/data-source-live-id-binding-lock-migration.test.ts` | **4 files / 109 passed** |
| core-backend 类型 | `npx tsc --noEmit` | exit 0 |
| 插件 | `node --test __tests__/external-systems.test.cjs` | pass 1 / fail 0（该文件是单脚本多段式，新增段 `connection FK violation (23503) maps to EXTERNAL_SYSTEM_CONNECTION_NOT_LIVE OK`） |
| 前端 | `npx vitest run tests/dataSourcesDeleteRefusal.spec.ts tests/dataSourcesPanelEmbedded.spec.ts` | 2 files / 21 passed |
| openapi dist | `npx tsx tools/build.ts` 后 `git diff --stat packages/openapi/dist` | 只有 DELETE `/api/data-sources/{id}` 描述、`force` 参数 `deprecated: true`、409 描述三处变化（36+/17-） |
| openapi dist-sdk（反驳者 blocker ④，CI `test (20.x)` 在 `plugin-tests.yml:799-802` 跑 `build`/`validate`/`generate:sdk` 后 `git diff --exit-code -- packages/openapi/dist packages/openapi/dist-sdk/index.d.ts`） | 在 `dist-sdk/` 按 `scripts/build.mjs` 同样两步手跑：`pnpm exec openapi-typescript ../dist/openapi.yaml --output ./index.d.ts` + `pnpm exec tsc client.ts --declaration --module NodeNext --moduleResolution NodeNext --target ES2020 --skipLibCheck`（`build.mjs` 用无 shell 的 `execFileSync('pnpm')`，Windows 上 ENOENT；CI 为 Linux 不受影响） | `index.d.ts` 6+/3-：DELETE 描述、`force` 参数 `@deprecated` JSDoc、409 描述三处，与 `src/paths/data-sources.yml` 一致；`client.{js,d.ts}`/`index.js` 无内容差（仅 CRLF 告警，已还原）。提交后 `git diff --exit-code` 该两路径为空 |
| `tests/unit` 里 `request(app)`（#4154） | 新增 spec 为纯文件/导出结构钉，不起服务 | 无 |
| 反斜杠折叠扫描 | `git diff origin/main \| grep -P '\x08'` | 空 |

## 6. 与上一轮（03:28–03:49）的差别

- 上一轮在 `19cb18f85` + PR-A 分支 `3ecf42d0d` 的合并上开发；期间 PR-A 又推了 `0648eb26c`（三份 fake 表严格）并于 05:17Z squash 合入 main。本轮把分支**重建在 `6ea19e2de`** 上，PR-B 增量三方合并回去，唯一冲突在 `data-source-remove-ordering.test.ts` 的 force 用例（`ops` 标签改为带表名的 `for-update:data_sources:<id>@trx`），已解。
- 上一轮三份迁移变异副本因 `Cannot find module 'kysely'` 没跑起来；本轮 `NODE_PATH` 修好后 a / b 两个变异按预期红，未变异副本与仓库文件同为 32/32。

## 7. 已知未覆盖（登记，不在本刀）

- legacy 形态 `config.dataSourceId`（`connection_id IS NULL`）无 FK，时序 A 对它仍敞开。
- `integration_stock_prep_source_binding` 等持指针但不在 `countExternalSystemReferences` 里的表：删除守卫与本 FK 都看不见。
- 存量悬空行由 NOT VALID 容忍、原样保留；`VALIDATE CONSTRAINT` 前需 owner 可见的清理。
