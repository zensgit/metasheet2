# live_id FK 脚本包 — 验证记录（2026-09-20）

**本包未在任何真实库执行。** 下面所有证据都来自一台一次性便携 PostgreSQL 16.9
集群上的合成 fixture（`h5_fixture_*` 临时 schema，id 全是 `ds-live` /
`es-dangle-1` 这类明显假值），集群与二进制在验证后删除。`02 -v APPLY=1` 与 `03`
属生产写入，需 owner 单独批准后由 owner 执行。

- 设计：`docs/development/data-source-live-id-fk-validate-runbook-design-20260920.md`
- 脚本包：`scripts/ops/live-id-fk-validate-20260920/`
- 自验：`scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs`

## 0. 环境

| 项 | 值 |
| --- | --- |
| 服务端 | `PostgreSQL 16.9, compiled by Visual C++ build 1943, 64-bit` |
| 客户端 | `psql (PostgreSQL) 16.9` |
| 集群 | 便携 EDB 二进制，`initdb -A trust -E UTF8 --locale=C`，`127.0.0.1:55432`，验证后删除 |
| 编码 | `PGCLIENTENCODING=UTF8`（中文 locale 的 Windows 控制台默认 GBK，会在注释的破折号上炸） |
| 落点 | `dev/_pgtmp-h5/`，不在 `%TEMP%`（低磁盘时系统会清 `%TEMP%`） |

Fixture 的 schema 由 `verify/fixture-pre5896.sql`（#5896 之前的形状，含旧的
`REFERENCES data_sources(id)` 外键——正因为如此才种得出悬空行）加
`verify/migration-5896-up.sql`（#5896 `up()` 的四条语句逐字转录）构成。

种的三行数据源 / 三行绑定：

| 行 | 形态 |
| --- | --- |
| `ds-live` | 活的数据源 |
| `ds-dead-1` / `ds-dead-2` | 软删（`deleted_at` 非空） |
| `es-ok` → `ds-live` | 健康 canonical 绑定 |
| `es-dangle-1` → `ds-dead-1` | canonical 形态（config 里没有 `dataSourceId`） |
| `es-dangle-2` → `ds-dead-2` | legacy/切换期形态（config 带指针，marker TRUE） |

## 1. 命令与结果

```bash
# hermetic 层（无数据库）
node --test scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs
#   → tests 17 / pass 16 / fail 0 / skipped 1（LAYER 2 大声跳过）

# 全量
PSQL=<便携 psql> DATABASE_URL=postgresql://postgres@127.0.0.1:55432/postgres \
  node --test scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs
#   → tests 17 / pass 17 / fail 0 / duration_ms ≈ 25900
```

`run-verify.mjs` 直接跑出的报告：

```json
{
  "S1": { "total": 2, "hitIds": ["es-dangle-1", "es-dangle-2"], "groups": 2 },
  "S2": true, "S3": true, "S4": true, "S5": true, "S6": true,
  "S7": true,
  "S8": { "elapsed": 5074 },
  "S9": true, "S10": true,
  "S11": { "total": 3, "absentState": "absent" },
  "M1": { "total": 3, "hits": 2 },
  "M2": { "receipt": "<null>" },
  "M3": { "timedOut": true }
}
```

## 2. 场景逐条

| # | 断言 | 结果 |
| --- | --- | --- |
| S1 | 01 报 `TOTAL.n=2`；HIT 恰为 `es-dangle-1` / `es-dangle-2`；`es-ok` 不在；两行 `target_state` 都是 `soft-deleted`；`BY_KIND_TENANT` 之和 == TOTAL；**HIT 行数 == TOTAL.n**；`INVENTORY_RESULT … status=complete live_fk=present validated=no` | 过 |
| S2 | 02 不带 APPLY：STEP0 `dangling=2 remediable=2 blocked=0 needs_receipt=1 receipt_already_present=1`；STEP1=1、STEP2=2、STEP3=0；`mode=dry-run`；`REMEDIATE_TX=rolled-back`；**回滚后表里仍是 2 条悬空、`es-dangle-1` 的 `config.dataSourceId` 仍为 NULL** | 过 |
| S3 | `-v APPLY=true` / `APPLY=yes` / `APPLY=on` / `APPLY=0` 四个值全部停在 `mode=dry-run` + `rolled-back`，且表未变 | 过 |
| S4 | `-v APPLY=1`：`mode=apply` + `committed`；悬空归 0；两行 `connection_id` 为 NULL；`es-dangle-1.config.dataSourceId = 'ds-dead-1'`（凭证），`config.schema` 仍在（是合并不是替换）；`es-dangle-2` 的 `dataSourceOwnerId` 原样；`legacy_connection_fallback_eligible` 仍是 false（未伪造证据）；`es-ok` 完全未动 | 过 |
| S5 | 03 成功：`status=complete sqlstate=00000 detail=already_validated=no validated_now=yes`，`pg_constraint.convalidated` 翻成 `true`；再跑一次是 no-op（`already_validated=yes`） | 过 |
| S6 | validate 之后新插一行指向 `ds-dead-1` 的绑定 → 数据库以 **23503** 拒绝（用 PL/pgSQL 捕 `foreign_key_violation` 读 `SQLSTATE`，不靠匹配本地化错误文本） | 过 |
| S7 | 存量未清就跑 03：`status=failed sqlstate=23503 detail=reason=dangling-rows`，psql 非零退出，约束仍是 NOT VALID | 过 |
| S8 | 第二会话持 `ACCESS EXCLUSIVE` 时跑 03：`status=failed sqlstate=55P03 detail=reason=lock-timeout`，**5074 ms** 返回（`lock_timeout=5s`），非零退出 | 过 |
| S9 | 把一行的 `config` 改成非对象（`'"not-an-object"'::jsonb`）：干跑报 `blocked=1 remediable=1`；`APPLY=1` 抛 `REMEDIATE_ABORT reason=non-object-config rows=1` 并中止，**表一行未改（仍 2 条悬空）** | 过 |
| S10 | 不跑 #5896 迁移就跑 01：`status=incomplete reason=missing-column:data_sources.live_id`，且**一个盘点结果块都不打印**（不会把「不适用」报成 0） | 过 |
| S11 | 目标行**完全不在** `data_sources` 里的绑定（不是软删）：01 报 `target_state=absent`、`TOTAL=3` 且 F4 不变量在混合集合上仍成立；02 `APPLY=1` 照样写凭证 `ds-gone-forever` 并清空；03 成功。种法是唯一诚实的那种——先 DROP live FK、插入、再以 NOT VALID 建回来，正是 #5896 迁移留下的形状 | 过 |

S8 的 5074 ms 这个数字本身是证据：它落在 `lock_timeout=5s` 上，而不是
`statement_timeout=120s` 上，说明分类走的是锁超时那条路。

## 3. 三个变异（全部内存级，不落盘）

变异做法：读源文件文本 → 在内存里改 → 通过 psql 的 **stdin** 喂进去，cwd 设成包目录
让 `\ir` 仍能解析。仓库工作树里不产生任何变异文件，所以两个 harness 并行跑也不会
互相读到对方的变异。

| 变异 | 改法 | 观察 | 对应断言 |
| --- | --- | --- | --- |
| **M1** 01 的 TOTAL 不再共用 `hit` CTE | 把 TOTAL 分支的 `FROM hit` 换成 `FROM integration_external_systems es2 WHERE es2.connection_id IS NOT NULL` | `TOTAL=3` 而 HIT 仍是 2 行 | `assert.equal(hits, total, 'F4 invariant …')` **红**（harness 用 `assert.throws` 把这次变红本身断言下来） |
| **M2** 02 去掉 STEP1 凭证写入 | 整条 STEP1 语句替换成 `SELECT 'STEP1_RECEIPT_WRITTEN' AS step, 0 AS rows;` | `APPLY=1` 仍把指针清干净（悬空 0），但 `es-dangle-1.config.dataSourceId` 变成 `<null>` | 「canonical row gets its rollback receipt」**红** |
| **M3** 03 去掉有效锁超时 | 在 03 自己的 `SET lock_timeout` 之后插入 `SET lock_timeout = 0`（PostgreSQL 的「禁用」）；单纯删掉 03 那行会被 `_preamble-write.sql` 的 5s 默认值挡住——那个默认值本身也是防线的一部分 | 同一场锁竞争下 15 s harness 截止仍未返回，**一行 `VALIDATE_RESULT` 都没有** | 55P03 分类断言**红**（`timedOut=true`） |

另有一条 hermetic 变异，证明防漂移检查会咬：把 `verify/migration-5896-up.sql` 的
文本在内存里去掉 `NOT VALID` 子句，重跑「fixture 是否复现 up() 的每条语句」的检查，
断言它抛 `has drifted from the migration`。过。

## 4. 静态契约层覆盖到什么

`node --test` 的 LAYER 1（16 条，无数据库）：

- 01 含只读 preamble；02/03 含写 preamble，且写 preamble **不含**
  `default_transaction_read_only`；
- 01 **一条写语句都没有**（按语句形状匹配，不是裸关键词——`deleted_at` 和字符串
  `'soft-deleted'` 是只读文件的合法内容，第一版按裸词匹配在这里假红过一次）；
- 01 里 `WITH hit AS (` 只出现一次，且三段都 `FROM hit`；
- 01 以 `INVENTORY_RESULT` 语句收尾，且在盘点查询之后；
- 01 的谓词与外键一致（`connection_id IS NOT NULL` + `NOT EXISTS … live_id = …`）；
- 02 的门是 `:'APPLY' = '1'`、默认 `\set apply_mode off`、`\else` 分支是 `ROLLBACK`、
  整文件一个显式 `BEGIN;`；02 不出现 `legacy_connection_fallback_eligible =` 赋值，
  也不出现 `DELETE FROM`；
- 02 里写凭证的语句在清指针的语句**之前**，两者共用
  `CREATE TEMP TABLE h5_dangling ON COMMIT DROP`；
- 03 含 `VALIDATE CONSTRAINT …`、`WHEN foreign_key_violation`、
  `WHEN lock_not_available`、`'23503'`、`'55P03'`；**不含** `WHEN OTHERS`、
  **不含** `query_canceled`；`\ir` 之后自己 `SET lock_timeout`；状态非 `complete`
  时再抛错；
- README 写了 `APPLY=1`、owner 字样、以及逐字的逆操作 SQL；
- 防漂移：`verify/migration-5896-up.sql` 复现 `zzzz20260920120000_*.ts` `up()` 的全部
  4 条 sql`` 模板（展开 `${sql.lit/raw(LIVE_FK|LEGACY_FK)}` 后按空白归一比较）。

CI：**本 PR 未带 workflow 文件**——推送本分支的令牌没有 `workflow` scope，
`.github/workflows/**` 被 GitHub 直接拒收。已写好的 hermetic lane（checkout +
setup-node，无库无 secret，按路径过滤）留作残余 1，由有 scope 的一方落地。
LAYER 2 在没有 `DATABASE_URL` 时**大声跳过**，所以任何只跑 hermetic 层的 lane 都
只为静态契约负责、不会替没跑的那一半报绿。

## 5. 残余 / 未做

1. **两层都没挂 CI。**
   - hermetic 层：workflow 文件写好了但**不在本 PR 里**——推送用的令牌没有
     `workflow` scope，GitHub 拒收 `.github/workflows/**`（`remote rejected …
     without 'workflow' scope`）。要补的 lane 形状照
     `.github/workflows/approval-s1-evidence-replay-gate.yml`：`pull_request` +
     `push: main`，按 `scripts/ops/live-id-fk-validate-20260920/**` 与
     `packages/core-backend/src/db/migrations/zzzz20260920120000_*.ts` 过滤，
     步骤只有 checkout + setup-node@20 + `node --test <本包 verify 下的 .test.mjs>`。
     路径过滤的 check 不应直接提升为 required（会把没触发它的 PR 卡在 Expected）。
   - LAYER 2：需要一条带 `postgres:16` service 的独立 lane（形状照
     `.github/workflows/approval-s1-evidence-replay-gate-realdb.yml`），与
     `scripts/ops/readonly-inventory-20260916/verify/` 的处理一致。
2. **未往根 `package.json` 加 `verify:*:test` 脚本。** 那一段是并发 PR 的高冲突区；
   workflow 与 README 已经把命令写死。
3. **`ALTER TABLE … VALIDATE CONSTRAINT` 在超大表上的实际耗时没有测。** fixture 只有
   三行。README 给了 `lock_timeout` 旋钮和「换安静窗口」的指引，但没有给基于真实
   行数的耗时估算——上机前应由 owner 侧先看一眼 `integration_external_systems` 的
   行数量级。
4. **legacy 绑定形态（`connection_id IS NULL` + `config->>'dataSourceId'`）仍无外键。**
   #5896 迁移 :58-63 已登记为 NOT COVERED，本刀不扩大范围。
5. **`integration_stock_prep_source_binding` 等其它持有数据源指针的表同样不在约束内。**
   同上，#5896 已登记。
6. 便携 PG 集群与 `dev/_pgtmp-h5/` 已在验证后删除；证据只剩本文件里的数字。
