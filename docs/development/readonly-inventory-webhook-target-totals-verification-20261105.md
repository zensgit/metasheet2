# 只读盘点包：05 webhook 目标总数 + 02 头注释更正 — 验证记录（2026-11-05）

基线：`origin/main` 8e47e5bf0。改动只在 `scripts/ops/readonly-inventory-20260916/**` 与本文件。

## 1. 加了什么

| 文件 | 改动 |
|---|---|
| `05-trg04-webhook-target-totals.sql` | 新增。与 2026-11-05 在现场跑过的 `03-webhook-target-totals.sql`（sha256 `8f0733a9…`）是**同一份 SQL**；只改了三处自身文件名（头第 2 行、RUN WITH 行、`INVENTORY_RESULT file=` 字面量），外加一行来源注释 |
| `02-trg04-http-targets.sql` | **只改注释**：#5619 / #5649 已合并（1bcef347d、bd165412a），不再写"OPEN"；Q7 原标题"已经投递失败、不是新增破坏"是错的（R80 及以前两条路径都不检查目标）；新增 NOTE：02 看不见 `https://<内网主机名>`，问 R81 会拒多少用 05 |
| `README.md` | §0c（05 的来由、四个桶、`https_other` ≠ 安全、`psql -X`、`SET transaction_read_only` 的原因）；§1 加 05 行、改 02 行；§2 加 05 命令（带 `-X`）；§4 加 05 行；顶部执行状态如实更新 |
| `verify/fixture-webhook-totals.sql` | 新增。规则 r1–r16（无 r10）、订阅 w1–w6，逐字节取自 05 上机前自测用的夹具，加了说明头 |
| `verify/readonly-inventory-pack.test.mjs` | `FILES` 加 05（同一行，不挪工作流引用的行号）；结尾检查接受 `END AS inventory_result;`；新增 3 个静态测试 + 4 个合成库测试（见 §3） |
| `verify/run-verify.mjs` | `checkInternalTargetCases` 可指定文件；新增 `runWebhookTotals` / `checkWebhookTotalsReadOnly` / `withFixture` / `verifyWebhookTotals` |

`_preamble.sql` 未改（sha256 `f17db338…`，与 05 当初配套的那份相同）。

## 2. 机械证明

- **05 与源文件只差文件名**：`diff <源 03> 05-trg04-webhook-target-totals.sql` 只有四处差异：
  第 2 行改名、新增第 3 行来源注释、第 70→71 行 RUN WITH 改名、第 230→231 行
  `INVENTORY_RESULT file=` 改名。没有别的行变化。
- **02 非注释行不变**：两版都去掉匹配 `^\s*--` 的行后比较：240 行，sha256 都是
  `9be519b1…`，逐字节相同。

## 3. 测试

命令（合成库用 WSL PostgreSQL 14 上的一次性库 `inv05t_<hhmmss>`，trap 中 `DROP DATABASE … WITH (FORCE)`）：

```bash
node --test scripts/ops/readonly-inventory-20260916/verify/*.test.mjs                       # 无库层
DATABASE_URL=<一次性库> METASHEET_REAL_DB_TEST_STEP=1 \
  node --test scripts/ops/readonly-inventory-20260916/verify/*.test.mjs                     # 合成库层
node --test scripts/ops/ops-sql-pack-verify-wiring.test.mjs                                 # 接线（借主检出的 js-yaml）
```

结果：无库层 15 个测试，13 过 2 跳过（合成库层跳过时会大声提示）；合成库层 18/18 过；接线 6/6 过。

新增测试及合成库上的断言：

| # | 测试 | 断言 |
|---|---|---|
| 12 | 内网主机正则块与 02 逐字节相同 | `WITH atom AS (` 到它的 `\gset`，两边各恰好一处，且相等 |
| 13 | `SET transaction_read_only = on;` 紧跟 `\ir _preamble.sql` | 去掉注释和空行后，第 1 句是 `\ir`，第 2 句就是这句，全文只有一处 |
| 14 | 只输出计数；`INVENTORY_RESULT` 是最后一条语句 | 两个结果查询除标志列外全是 `count(`；最后一条语句就是 `INVENTORY_RESULT` 那个 SELECT |
| 15 | 四个桶（新 schema） | 规则 `t\|10\|10\|3\|3\|3\|1`、`f\|2\|3\|1\|1\|0\|1`；订阅 `t\|4\|0\|1\|2\|1`、`f\|2\|1\|0\|1\|0`；`status=complete scope=automation_rules+multitable_webhooks` |
| 16 | 缺列记为 incomplete，绝不当成 0 | legacy 夹具：R1 跳过，订阅 `t\|3\|0\|1\|1\|1`、`f\|0\|0\|0\|0\|0`，`incomplete reason=missing-columns:automation_rules scope=multitable_webhooks-only`；modern 夹具（它的手写子集没有 `enabled`）：订阅 `t\|8\|0\|3\|2\|3`、`f\|1\|0\|1\|0\|0`，同样的 incomplete；空 schema：`…automation_rules+multitable_webhooks scope=none` |
| 17 | 05 的主机模式通过 F7 全部用例 | 先跑 05，再在同一会话里用 05 自己 `\gset` 出的模式匹配 `INTERNAL_TARGET_CASES` |
| 18 | 单事务内保持只读 | 复制 05 + `_preamble.sql` 到临时目录，在 SET 之后注入 `UPDATE automation_rules SET name='witness' WHERE id='r1';`：`psql -X -1` 和 `AUTOCOMMIT=off` 两种方式都非零退出、stderr 带 25006、没有 `INVENTORY_RESULT` 行、r1 不变；对照组（用 UPDATE 替换掉 SET 那一行）在 `-1` 下退出 0 并把 r1 改成了 `witness`，说明起作用的正是这一句 |

另外，`FILES` 加入 05 后，前言、`INVENTORY_RESULT`、只读扫描三项原有测试也覆盖 05。

## 4. 亲眼看到的红（每次改完都从备份还原，并按 sha256 确认与改前逐字节相同：`00761630…`）

| 变异（只改 05） | 层 | 变红的测试 |
|---|---|---|
| M1 `url_missing` 条件改成 `u IS NULL OR u = ''`（非字符串 url 落进 url_missing） | 合成库 | 15：实际 `t\|10\|10\|5\|1\|3\|1`，期望 `t\|10\|10\|3\|3\|3\|1` |
| M2 删掉 `SET transaction_read_only = on;` | 无库 / 合成库 | 13；合成库层另有 18（"05 must carry exactly one SET transaction_read_only line"） |
| M2b 改成 `SET transaction_read_only = off;` | 合成库 | 13、18（"-1: an injected UPDATE must abort the run"） |
| M3 正则块删掉 `internal`（与 02 不再相同） | 无库 / 合成库 | 12；合成库层另有 17（`https://fake-svc.internal/x: got f, want t` 等） |
| M4 缺列分支改成输出 `complete` | 合成库 | 16（实际 `status=complete scope=multitable_webhooks-only`） |
| M5 规则结果查询多选一列 `min(b.id)` | 无库 | 14 |
| M6 `\ir` 之后插入一条 `UPDATE` | 无库 | 3（只读扫描）、13 |
| M7 `INVENTORY_RESULT file=` 改回 03 的名字 | 无库 | 2（结尾检查）、14 |

每个变异都只让预期的测试变红，其余测试保持通过。
