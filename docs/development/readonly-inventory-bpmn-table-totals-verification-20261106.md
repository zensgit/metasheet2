# 只读盘点包：07 旧 BPMN 表行数 — 验证记录（2026-11-06）

基线：`origin/main` a8ab73bee。改动只在 `scripts/ops/readonly-inventory-20260916/**` 与本文件。

## 1. 为什么

owner 2026-11-06 裁定「审批和自动化不用 BPMN，运行时和设计器都弃用」。删除代码之前，R82 安装单请站点先跑
`07`，确认 `bpmn_*` 表里没有数据。这是**安装前检查，不阻断安装**。`07` **从未在任何站点上跑过**。

## 2. 加了什么

| 文件 | 改动 |
|---|---|
| `07-bpmn-table-totals.sql` | 新增（sha256 `f0c10dc5bab80a0cd636f7d891bc6f92c1596ef6c5a9c9ef3e2c88802108f2c1`，LF；R82 安装单的 scratch 副本已同步为这份）。11 张核心表取自 `zz20251231_create_bpmn_tables.ts`，每表一行 `count(*)`；可选第 12 张 `bpmn_deployments`（见下）；最后一句是 `INVENTORY_RESULT` |
| `verify/fixture-bpmn-tables.sql` | 新增。11 张核心表 + `bpmn_deployments`，非零行数各不相同（3/2/1/7/4/5），标签对调会被发现 |
| `verify/readonly-inventory-pack.test.mjs` | `FILES` 加 07（同一行，不挪工作流引用的行号）；新增 2 个静态测试 + 5 个合成库测试 |
| `verify/run-verify.mjs` | 新增 `runBpmnTableTotals` / `runBpmnTableTotalsAsLimitedRole` / `checkBpmnTableTotalsReadOnly` / `verifyBpmnTableTotals`；CLI 输出 `bpmnTableTotals07` |
| `README.md` | §0d、§1 / §4 行、§2 两种 shell 的 07 命令（`-X`）、§5 文件清单、顶部执行状态 |

`_preamble.sql` 未改。工作流、`EXPECTED_OPS_TESTS_COUNT`（只数 `scripts/ops/__tests__`）都不需要改：
`ops-sql-pack-verify.yml` 的 hermetic 与 postgres:16 两个作业跑的是 `verify/*.test.mjs` 通配，测试只读包目录内的文件。

可选表 `bpmn_deployments`：只有旧原生 SQL 迁移 `049_create_bpmn_workflow_tables.sql`（现为空操作历史标记）会建它，
当前代码不引用。`07` 单独探测它（`current_schemas(false)` 里可见即算存在）：存在时 B1 在 11 行后多一行
`bpmn_deployments|<行数>`；不存在或当前角色看不见时输出
`-- bpmn_deployments not present (optional; only created by legacy 049)`。**完成态只由 11 张核心表决定**。
与首版相比只有新增行：头注释一段、可选探针块、B1 末尾一行 `:bpmn_deployments_branch`；前言 include、SET 行、
`INVENTORY_RESULT` 文本都没动。

## 3. 测试

LF 副本（与 CI 检出一致），合成库为 WSL PostgreSQL 14 上的一次性库 `inv07_<hhmmss>_<pid>`，trap 中 `DROP DATABASE … WITH (FORCE)`：

```bash
node --test scripts/ops/readonly-inventory-20260916/verify/                         # 无库层：21 个，18 过 3 跳过
DATABASE_URL=<一次性库> METASHEET_REAL_DB_TEST_STEP=1 \
  node --test scripts/ops/readonly-inventory-20260916/verify/                       # 合成库层：32/32 过
DATABASE_URL=<一次性库> node scripts/ops/readonly-inventory-20260916/verify/run-verify.mjs   # ALL CHECKS PASSED
node --test scripts/ops/ops-sql-pack-verify-wiring.test.mjs                         # 接线 6/6（借主检出的 js-yaml）
```

| # | 测试 | 断言 |
|---|---|---|
| 26 | SET 紧跟 `\ir _preamble.sql` | 去掉注释和空行后第 2 句就是 `SET transaction_read_only = on;`，全文一处 |
| 27 | 只数这些表、只选计数、结果行最后 | 探针 `IN (...)` 与 B1 都恰为 11 个核心表名；B1 每个分支只有序号、自身表名字面量和 `count(*)`；B1 最后一行是可选槽位，可选分支同形（序号 12）；可选表不进 `INVENTORY_RESULT` 的判定 |
| 28 | 夹具精确计数 | 普通与 `psql -1` 都是 `3,2,0,1,0,0,0,7,0,0,4` 再加 `bpmn_deployments|5`，`status=complete scope=bpmn_tables:11`，无"not present"行 |
| 29 | 没有可选表仍完整 | 删掉 `bpmn_deployments`：普通与 `-1` 都只有 11 行、输出"not present"行、`status=complete` |
| 30 | 缺核心表不是零 | 删一张核心表：不输出计数，`incomplete reason=missing-tables:1 scope=none`；空 schema：`missing-tables:11` 且输出"not present"行 |
| 31 | 只能读一张表的角色 | 退出 0、不输出计数、`incomplete reason=missing-tables:10 scope=none` |
| 32 | 单事务内只读 | SET 之后注入 `UPDATE bpmn_process_definitions SET name='witness' WHERE id='d1'`：`-1` 与 `AUTOCOMMIT=off` 都 25006 中止、无 `INVENTORY_RESULT`、行不变；对照组（SET 换成 UPDATE）在 `-1` 下提交 |

Windows 检出（`core.autocrlf=true`）直接跑无库层时，既有的 `F4 (not regressed)` 会因 CRLF 红（它的正则按 `\n` 匹配 02 的 CTE，没有先去 `\r`）；该测试与 02 本 PR 都没改，CI 检出为 LF。

## 4. 亲眼看到的红

| 变异 | 变红的测试 |
|---|---|
| W1 夹具 `bpmn_audit_log` 少一行（4→3）；还原后 sha256 相同 | 28 |
| W1b 已提交夹具去掉 `CREATE TABLE bpmn_signal_events`；还原后 `git diff` 为空 | 28、29（当时编号）、31（当时编号） |
| W2 去掉 07 的 SET 行（只改 LF 副本） | 26、单事务只读 |
| W3 07 的 B1 在 `bpmn_variables` 分支多选 `max(id)`（只改 LF 副本） | 27、28、单事务只读 |
| W4 28 的期望去掉可选行 `bpmn_deployments|5`；还原后 sha256 相同 | 28（实际多出 `'bpmn_deployments|5'`） |

W1–W3 在加可选表之前跑；W4 在加之后跑。每个变异只让预期的测试变红；还原后 32/32 通过。
