# 只读盘点包：05 webhook 目标总数 + 06 按钮 webhook 总数 + 02 头注释更正 — 验证记录（2026-11-05）

基线：`origin/main` 8e47e5bf0（推送前已 merge 最新 origin/main）。改动只在
`scripts/ops/readonly-inventory-20260916/**` 与本文件。

## 1. 加了什么

| 文件 | 改动 |
|---|---|
| `05-trg04-webhook-target-totals.sql` | 新增。与 2026-11-05 在现场跑过的 `03-webhook-target-totals.sql`（sha256 `8f0733a9…`）是**同一份 SQL**；只改了三处自身文件名（头第 2 行、RUN WITH 行、`INVENTORY_RESULT file=` 字面量），外加一行来源注释 |
| `06-trg04-button-webhook-totals.sql` | 新增。源文件 `r81-button-webhook-totals.sql`（sha256 `a2186596…`，155 行）；只改了三处自身文件名（头第 2 行、RUN WITH 行、`INVENTORY_RESULT file=` 字面量）。统计按钮字段的「发送 Webhook」，六列计数。**尚未在任何真实数据库上跑过** |
| `02-trg04-http-targets.sql` | **只改注释**：#5619 / #5649 已合并（1bcef347d、bd165412a），不再写"OPEN"；Q7 原标题"已经投递失败、不是新增破坏"是错的（R80 及以前两条路径都不检查目标）；新增 NOTE：02 看不见 `https://<内网主机名>`，问 R81 会拒多少用 05 |
| `README.md` | §0c（05 的来由、四个桶、`https_other` ≠ 安全、`psql -X`、`SET transaction_read_only` 的原因；06 的来由、六列、未上真实库、读 `meta_fields` 含按钮 secret 由 owner 定身份）；§1 / §4 加 05、06 行，改 02 行；§2 加 05、06 命令（带 `-X`）；顶部执行状态如实更新 |
| `verify/fixture-webhook-totals.sql` | 新增。规则 r1–r16（无 r10）、订阅 w1–w6，逐字节取自 05 上机前自测用的夹具，加了说明头 |
| `verify/fixture-button-webhooks.sql` | 新增。`meta_fields` 行 b1–b17，逐字节取自 06 的自测夹具，加了说明头。其它夹具都不建 `meta_fields`，所以不影响它们的数字 |
| `verify/readonly-inventory-pack.test.mjs` | `FILES` 加 05、06（同一行，不挪工作流引用的行号）；结尾检查接受 `END AS inventory_result;`；新增 6 个静态测试 + 8 个合成库测试（见 §3） |
| `verify/run-verify.mjs` | `checkInternalTargetCases` 可指定文件；新增 `runWebhookTotals` / `runButtonWebhookTotals` / `checkReadOnlyInOneTransaction` / `withFixture` 等 |

`_preamble.sql` 未改（sha256 `f17db338…`，与 05、06 当初配套的那份相同）。

## 2. 机械证明

- **05 与源文件只差文件名**：`diff` 只有四处差异：第 2 行改名、新增第 3 行来源注释、第 70→71 行
  RUN WITH 改名、第 230→231 行 `INVENTORY_RESULT file=` 改名。
- **06 与源文件只差文件名**：`diff` 只有三处差异：第 2、46、151 行，都是
  `r81-button-webhook-totals.sql` → `06-trg04-button-webhook-totals.sql`。
- **02 非注释行不变**：两版都去掉匹配 `^\s*--` 的行后比较：240 行，sha256 都是 `9be519b1…`，逐字节相同。

## 3. 测试

命令（合成库用 WSL PostgreSQL 14 上的一次性库 `inv05t_<hhmmss>`，trap 中 `DROP DATABASE … WITH (FORCE)`）：

```bash
node --test scripts/ops/readonly-inventory-20260916/verify/*.test.mjs                       # 无库层
DATABASE_URL=<一次性库> METASHEET_REAL_DB_TEST_STEP=1 \
  node --test scripts/ops/readonly-inventory-20260916/verify/*.test.mjs                     # 合成库层
node --test scripts/ops/ops-sql-pack-verify-wiring.test.mjs                                 # 接线（借主检出的 js-yaml）
```

结果：无库层 18 个测试，16 过 2 跳过（合成库层跳过时会大声提示）；合成库层 25/25 过；接线 6/6 过。

新增测试：

| # | 测试 | 断言 |
|---|---|---|
| 12 / 14 | 05 / 06 的内网主机正则块与 02 逐字节相同 | `WITH atom AS (` 到它的 `\gset`，各恰好一处，且相等 |
| 13 / 15 | 05 / 06 的 `SET transaction_read_only = on;` 紧跟 `\ir _preamble.sql` | 去掉注释和空行后，第 1 句是 `\ir`，第 2 句就是这句，全文只有一处 |
| 16 / 17 | 05 / 06 只输出计数；`INVENTORY_RESULT` 是最后一条语句 | 结果查询除 05 的标志列外全是 `count(`；最后一条语句就是自己的 `INVENTORY_RESULT` SELECT |
| 18 | 05 四个桶 | 规则 `t\|10\|10\|3\|3\|3\|1`、`f\|2\|3\|1\|1\|0\|1`；订阅 `t\|4\|0\|1\|2\|1`、`f\|2\|1\|0\|1\|0`；`status=complete scope=automation_rules+multitable_webhooks` |
| 19 | 05 缺列记为 incomplete | legacy：订阅 `t\|3\|0\|1\|1\|1`、`f\|0\|0\|0\|0\|0`，`incomplete reason=missing-columns:automation_rules scope=multitable_webhooks-only`；modern（手写子集无 `enabled`）：订阅 `t\|8\|0\|3\|2\|3`、`f\|1\|0\|1\|0\|0`，同样 incomplete；空 schema：`…automation_rules+multitable_webhooks scope=none` |
| 20 / 24 | 05 / 06 的主机模式通过 F7 全部用例 | 先跑该文件，再在同一会话里用它自己 `\gset` 出的模式匹配 `INTERNAL_TARGET_CASES` |
| 21 / 25 | 05 / 06 单事务内保持只读 | 复制文件 + `_preamble.sql` 到临时目录，在 SET 之后注入 `UPDATE <表> SET name='witness' WHERE id=…`（05：`automation_rules` r1；06：`meta_fields` b1）：`psql -X -1` 与 `AUTOCOMMIT=off` 都非零退出、stderr 带 25006、无 `INVENTORY_RESULT`、行不变；对照组（SET 行换成 UPDATE）在 `-1` 下退出 0 且写入提交 |
| 22 | 06 六列 | `14\|3\|4\|2\|3\|2`，`status=complete scope=meta_fields` |
| 23 | 06 缺表记为 incomplete | 空 schema：不输出计数，`status=incomplete reason=missing-columns:meta_fields scope=none` |

`FILES` 加入 05、06 后，前言、`INVENTORY_RESULT`、只读扫描三项原有测试也覆盖它们。

## 4. 亲眼看到的红（每次改完都从备份还原，并按 sha256 确认与改前逐字节相同：05 `00761630…`，06 `33431df7…`）

| 变异 | 层 | 变红的测试 |
|---|---|---|
| M1（05）`url_missing` 条件改成 `u IS NULL OR u = ''` | 合成库 | 18：实际 `t\|10\|10\|5\|1\|3\|1` |
| M2（05）删掉 SET 行 | 无库 / 合成库 | 13；合成库另有 21 |
| M2b（05）SET 改成 `= off` | 合成库 | 13、21（"-1: an injected UPDATE must abort the run"） |
| M3（05）正则块删掉 `internal` | 无库 / 合成库 | 12；合成库另有 20（`fake-svc.internal: got f, want t`） |
| M4（05）缺列分支改成 `complete` | 合成库 | 19 |
| M5（05）结果查询多选 `min(b.id)` | 无库 | 16 |
| M6（05）`\ir` 后插入 `UPDATE` | 无库 | 3、13 |
| M7（05）`INVENTORY_RESULT file=` 改回旧名 | 无库 | 2、16 |
| N1（06）JSON 字符串形式的 `actionConfig` 不再算 unclassified | 合成库 | 22：实际 `14\|4\|4\|2\|3\|1` |
| N2（06）删掉 SET 行 | 无库 / 合成库 | 15；合成库另有 25 |
| N2b（06）SET 改成 `= off` | 合成库 | 15、25（"-1: an injected UPDATE must abort the run"） |
| N3（06）正则块删掉 `internal` | 无库 / 合成库 | 14；合成库另有 24 |
| N4（06）缺表分支改成 `complete` | 合成库 | 23 |
| N5（06）B1 多选 `max(bucket)` | 无库 | 17 |
| N6（06）`\ir` 后插入 `UPDATE` | 无库 | 3、15 |
| N7（06）`INVENTORY_RESULT file=` 改回旧名 | 无库 | 2、17 |

每个变异都只让预期的测试变红，其余测试保持通过。
