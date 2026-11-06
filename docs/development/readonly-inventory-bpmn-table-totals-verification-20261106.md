# 只读盘点包：07 旧 BPMN 表行数 — 验证记录（2026-11-06）

基线：`origin/main` a8ab73bee。改动只在 `scripts/ops/readonly-inventory-20260916/**` 与本文件。

## 1. 为什么

owner 2026-11-06 裁定「审批和自动化不用 BPMN，运行时和设计器都弃用」。删除代码之前，R82 安装单请站点先跑
`07`，确认 11 张 `bpmn_*` 表里没有数据。这是**安装前检查，不阻断安装**。`07` **从未在任何站点上跑过**。

## 2. 加了什么

| 文件 | 改动 |
|---|---|
| `07-bpmn-table-totals.sql` | 新增。与本地自测过的源文件逐字节相同（sha256 `839b0b2e413f4006020efab91ef2f5ac785e76cfb37bd8fb84d78d931defe44d`，LF）。11 张表取自 `zz20251231_create_bpmn_tables.ts`，每表一行 `count(*)`，最后一句是 `INVENTORY_RESULT` |
| `verify/fixture-bpmn-tables.sql` | 新增。11 张表，非零行数各不相同（3/2/1/7/4），标签对调会被发现 |
| `verify/readonly-inventory-pack.test.mjs` | `FILES` 加 07（同一行，不挪工作流引用的行号）；新增 2 个静态测试 + 4 个合成库测试 |
| `verify/run-verify.mjs` | 新增 `runBpmnTableTotals` / `runBpmnTableTotalsAsLimitedRole` / `checkBpmnTableTotalsReadOnly` / `verifyBpmnTableTotals`；CLI 输出 `bpmnTableTotals07` |
| `README.md` | §0d、§1 / §4 行、§2 两种 shell 的 07 命令（`-X`）、§5 文件清单、顶部执行状态 |

`_preamble.sql` 未改。工作流、`EXPECTED_OPS_TESTS_COUNT`（只数 `scripts/ops/__tests__`）都不需要改：
`ops-sql-pack-verify.yml` 的 hermetic 与 postgres:16 两个作业跑的是 `verify/*.test.mjs` 通配，测试只读包目录内的文件。

范围外：旧原生 SQL 迁移 `049_create_bpmn_workflow_tables.sql` 另建 `bpmn_deployments`；该迁移现为空操作历史标记，
当前代码不引用这张表，`07` 不统计它（见 README §0d）。

## 3. 测试

LF 副本（与 CI 检出一致），合成库为 WSL PostgreSQL 14 上的一次性库 `inv07_<hhmmss>_<pid>`，trap 中 `DROP DATABASE … WITH (FORCE)`：

```bash
node --test scripts/ops/readonly-inventory-20260916/verify/                         # 无库层：21 个，18 过 3 跳过
DATABASE_URL=<一次性库> METASHEET_REAL_DB_TEST_STEP=1 \
  node --test scripts/ops/readonly-inventory-20260916/verify/                       # 合成库层：31/31 过
DATABASE_URL=<一次性库> node scripts/ops/readonly-inventory-20260916/verify/run-verify.mjs   # ALL CHECKS PASSED
node --test scripts/ops/ops-sql-pack-verify-wiring.test.mjs                         # 接线 6/6（借主检出的 js-yaml）
```

| # | 测试 | 断言 |
|---|---|---|
| 26 | SET 紧跟 `\ir _preamble.sql` | 去掉注释和空行后第 2 句就是 `SET transaction_read_only = on;`，全文一处 |
| 27 | 只数 11 张表、只选计数、结果行最后 | 探针 `IN (...)` 与 B1 都恰为这 11 个名字；B1 每个分支只有序号、自身表名字面量和 `count(*)`，且数的就是它标的表 |
| 28 | 夹具精确计数 | 普通与 `psql -1` 两种方式都是 `3,2,0,1,0,0,0,7,0,0,4`，`status=complete scope=bpmn_tables:11` |
| 29 | 缺表不是零 | 删一张表：不输出计数，`incomplete reason=missing-tables:1 scope=none`；空 schema：`missing-tables:11` |
| 30 | 只能读一张表的角色 | 退出 0、不输出计数、`incomplete reason=missing-tables:10 scope=none` |
| 31 | 单事务内只读 | SET 之后注入 `UPDATE bpmn_process_definitions SET name='witness' WHERE id='d1'`：`-1` 与 `AUTOCOMMIT=off` 都 25006 中止、无 `INVENTORY_RESULT`、行不变；对照组（SET 换成 UPDATE）在 `-1` 下提交 |

Windows 检出（`core.autocrlf=true`）直接跑无库层时，既有的 `F4 (not regressed)` 会因 CRLF 红（它的正则按 `\n` 匹配 02 的 CTE，没有先去 `\r`）；该测试与 02 本 PR 都没改，CI 检出为 LF。

## 4. 亲眼看到的红

| 变异 | 变红的测试 |
|---|---|
| W1 夹具 `bpmn_audit_log` 少一行（4→3）；改完从备份还原，sha256 相同 | 28 |
| W2 去掉 07 的 SET 行（只改 LF 副本） | 26、31 |
| W3 07 的 B1 在 `bpmn_variables` 分支多选 `max(id)`（只改 LF 副本） | 27、28、31 |

每个变异只让预期的测试变红；还原后 31/31 通过。
