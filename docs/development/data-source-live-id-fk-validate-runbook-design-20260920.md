# live_id FK 存量悬空行：盘点 / 清理 / VALIDATE 脚本包 — 设计（2026-09-20）

**本包未在任何真实库执行。`02 -v APPLY=1` 与 `03` 是生产写入，需 owner 单独批准。**

- 脚本包：`scripts/ops/live-id-fk-validate-20260920/`
- 运行手册：同目录 `README.md`
- 验证记录：`docs/development/data-source-live-id-fk-validate-runbook-verification-20260920.md`
- 前置 PR：#5896（`123b1d1e5`）

## 1. 问题

#5896 把 `integration_external_systems.connection_id` 的外键从
`data_sources(id)` 改指 `data_sources(live_id)`，并以 **NOT VALID** 建立新约束
`fk_integration_external_systems_live_connection_id`：

- `packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts:96-113`
- 迁移自己在文件头 :48-56 写明了理由与遗留：「Pre-existing dangling rows are left
  for a separate, owner-visible cleanup rather than silently rewritten here.」

于是现状是：**新写入全查全锁，存量悬空行被容忍且从不扫描**。后果不是「暂时难看」，
而是三条具体的能力缺失：

1. 约束不能 `VALIDATE`，`pg_constraint.convalidated` 恒为 `false`；
2. 规划器不得依赖这条外键；
3. 「本库没有指向已删数据源的绑定」这句话只是对未来写入的承诺，不能作为事实陈述
   进任何证据面。

这一刀交付的就是把第 3 条变成事实所需要的、可审的三步。

## 2. 边界：为什么是脚本包而不是又一条迁移

写客户生产主表属 AGENTS.md「决策机制」O 层 ②「先批后动、不可默认前进」。一条自动
迁移会在部署时把这件事悄悄做掉，既拿不到 owner 的批准点，也没有干跑与回滚凭证。
所以：

- 盘点做成**只读**文件，会话层 `default_transaction_read_only = on`（写溜进来就
  25006），可以交给运维用只读角色跑；
- 清理做成**默认干跑**：跑完全部步骤、打印每步受影响行数，末尾 `ROLLBACK`；
  只有精确字面量 `-v APPLY=1` 才 `COMMIT`；
- `VALIDATE` 单独一个文件，自带 `lock_timeout` 与按 SQLSTATE 的失败分类。

三个文件都只有一种运行方式（整文件 `psql -f`），`ON_ERROR_STOP` 由 preamble 钉死，
每个文件以一行 `*_RESULT` 收尾作为完成态信号。这套形状直接抄
`scripts/ops/readonly-inventory-20260916/_preamble.sql` 的 F5 修复，不重新发明。

### 两个 preamble

`_preamble.sql`（只读，给 01）与 `_preamble-write.sql`（给 02/03）。分成两个文件而不是
让 02/03 「包含这个再把某个 GUC 关掉」，是因为后者会让 01 的只读保证变成有条件的。
写侧 preamble 明确不设 `default_transaction_read_only`，并且有一条 hermetic 测试
断言它**不含**这个字符串。

## 3. 判定谓词：与外键逐字一致

```sql
connection_id IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM data_sources WHERE live_id = connection_id)
```

这正是 MATCH SIMPLE 外键自己的判定。01 与 02 用同一条谓词，03 让数据库用它自己的
实现再判一次——三处一致是设计目标，不是巧合。

两种子形态在 01 里以 `target_state` 区分：`soft-deleted`（目标行在、`deleted_at`
非空）与 `absent`（目标行根本不在）。后者在 `ON DELETE RESTRICT` 下很难产生，但
盘点不假设它不可能。

**不在范围**：legacy 绑定形态（`connection_id IS NULL`，指针在
`config->>'dataSourceId'`）。它没有外键，#5896 不碰它，`VALIDATE` 也不看它。
这条在 #5896 迁移 :58-63 已登记为 NOT COVERED，本包不扩大范围。

## 4. 01：计数与 ID 必须同源（#5786 F4）

2026-09-16 那包的复核发现过一个具体漏法：计数走一条谓词、id 列表走另一条（只判
形状），于是列表里出现了计数里没有的行。本包不靠「两处文本写得一样」来避免它，而是
让 **TOTAL / BY_KIND_TENANT / HIT 是同一条语句里同一个 `hit` CTE 的三个分支**：

```sql
WITH hit AS ( …一次… )
SELECT … FROM (
  SELECT 'TOTAL', …, count(*) FROM hit
  UNION ALL SELECT 'BY_KIND_TENANT', …, count(*) FROM hit GROUP BY kind, tenant_id
  UNION ALL SELECT 'HIT', … FROM hit
) x ORDER BY …
```

它们在结构上就不可能不一致。共享 TEMP VIEW 是另一条路，但只读事务下任何 `CREATE`
都是 25006，所以走不通。

三条支撑证据：hermetic 测试断言文件里 `WITH hit AS (` 只出现一次且三段都 `FROM hit`；
DB 层断言 `TOTAL.n == |HIT|`；变异 M1 把 TOTAL 换成独立谓词，证明这条断言真的会红。

**values-free**：输出只有 `integration_external_systems.id`、`tenant_id`、闭集 `kind`、
布尔与计数。没有 `config`、没有 `name`、没有 `credentials_encrypted`，也不输出
`connection_id` 指向的目标 id（02 自己重新推导，不需要从日志里抄目标）。

## 5. 02：回滚凭证为什么必须先写

canonical 绑定的 `config` 里**没有** `dataSourceId`——
`plugins/plugin-integration-core/lib/external-systems.cjs:486` 与 `:548-553` 在 INSERT
之前就把 legacy 指针从 config 里删掉了。所以对这类行，`connection_id` 列是「它原来
指向谁」的**唯一**记录，而 STEP 2 正是要毁掉这一列。

因此顺序是硬的：

1. **STEP 1** 对「`config` 是 JSON 对象且 `config->>'dataSourceId'` 为空」的行，把
   当前 `connection_id` 写进 `config.dataSourceId`；已经带指针的 legacy/切换期行
   跳过（凭证本来就在）。
2. **STEP 2** 这些行 `connection_id = NULL`。

两步在**同一个显式事务**里，目标行快照落在
`CREATE TEMP TABLE h5_dangling ON COMMIT DROP`，所以两步改的是同一批 id，中途新出现
的悬空行不会被处理一半。hermetic 测试用文本位置断言 STEP 1 在 STEP 2 之前；变异 M2
把 STEP 1 拿掉，证明凭证确实由这条语句产生。

### 三个刻意的「不做」

- **不删绑定行。** 绑定带着 name / kind / role / capabilities / 凭据，以及下游
  `integration_pipelines.source_system_id / target_system_id`
  （`packages/core-backend/migrations/057_create_integration_core_tables.sql:57,60`，
  ON DELETE RESTRICT）。置空指针是满足外键的最小改动且可逆；删行两样都不是。
- **不改 `legacy_connection_fallback_eligible`。** 它是服务端持有的切换期证据
  （`zzzz20260902120000_add_integration_connection_binding.ts` 文件头合同），一个悬空
  指针不构成任何证据。后果是明确的、也是想要的：02 之后这行是「legacy 形状指针 +
  marker 仍 FALSE」，`plugins/plugin-integration-core/lib/connection-resolver.cjs:206-212`
  对 marker 非 TRUE 的行直接抛 `CONNECTION_LEGACY_FALLBACK_DENIED`，不会悄悄读一个
  已删数据源。绑定本来就坏了，这一步只是让它按名字失败。
- **不触发外键复查。** STEP 1 不碰 `connection_id`（PostgreSQL 在引用键列未变时跳过
  RI 检查），STEP 2 置 NULL（MATCH SIMPLE 放行）。所以 02 在这些行当前正违反 NOT
  VALID 约束的情况下照样跑得通——这一点在真 PG 16.9 上验过。

### fail-closed：写不进凭证的行

`config` 不是 JSON 对象时，写凭证就得覆盖已有内容。这类行被计为 `blocked`、跳过；
并且 `APPLY=1` 下 `blocked > 0` 会**主动抛错中止整个事务**
（`REMEDIATE_ABORT reason=non-object-config`），而不是留下一张半干净的表让 03 去撞
23503。宁可什么都不改，也不留一个说不清的中间态。

### APPLY 门

`\set apply_mode off` 先把默认钉死，然后只有 `:'APPLY' = '1'` 这条 SQL 侧的精确字面量
比较能把它翻成 on。`APPLY=true`、`APPLY=yes`、`APPLY=on`、`APPLY=0` 全是干跑——
psql 的 `\if` 本来会把 `true/yes/on` 当真，这里刻意绕开它，对齐 AGENTS.md
「exact-literal `'true'` 才开」的同一条纪律。四个值都在 DB 层验过。

## 6. 03：分类而不是吞

`ALTER TABLE … VALIDATE CONSTRAINT` 放在 PL/pgSQL 块里，只捕两个 SQLSTATE：

| SQLSTATE | 条件名 | 输出 |
| --- | --- | --- |
| 23503 | `foreign_key_violation` | `status=failed reason=dangling-rows` |
| 55P03 | `lock_not_available` | `status=failed reason=lock-timeout` |

**刻意不捕** `57014 query_canceled`（statement_timeout / Ctrl-C）和其它一切
（42501、42704……）：那是一个含糊状态，不是一个诊断，不该被打扮成诊断。它们让文件
中止、一行 `VALIDATE_RESULT` 都不打印，README 把「没有 RESULT 行」明确定义为
**未知，去查**，既不是成功也不是「没有悬空」。这是 2026-09-16 那包 F5「never read a
missing line as zero」的同一条纪律。

`lock_timeout` 由 03 自己设（在 `\ir` 之后，覆盖 preamble 默认值），因为
`VALIDATE CONSTRAINT` 取 `SHARE UPDATE EXCLUSIVE`：它不挡普通读写，但在锁队列里排队
时会把后面的流量一起挡住。变异 M3 把有效锁超时去掉，在同一场锁竞争下证明这条分类
不是装饰。

退出码有意义：状态不是 `complete` 时最后一条语句再抛错，`psql -f` 非零退出；人读的
RESULT 行在那之前已经打印。

## 7. 回滚的不对称

02 可逆（README §3 给了逆操作 SQL），但有一个必须说清的前置：**目标 `data_sources`
行必须先复活**（`deleted_at` 置回 NULL），否则恢复 `connection_id` 的 UPDATE 会被
新外键以 23503 拒绝——因为 `live_id` 仍然是 NULL。复活一个数据源是 owner 决定，不在
本包范围。

03 之后的「回滚」意味着让约束重新接受悬空行，只能 DROP 再按 #5896 的 `up()` 以 NOT
VALID 建回来，是 schema 改动，同样是 owner 层动作。

还有一条操作陷阱写进了 README：`config.dataSourceId` 留着只是凭证，若之后把这行重新
绑到新的 `connectionId`，`connection-resolver.cjs:193-200` 会拿它和新 canonical id
比对、不等就抛 `CONNECTION_BINDING_MISMATCH`。所以重绑那一次必须同时显式传
`config: { dataSourceId: null }`，或按 README 给的 SQL 手工清。

## 8. 与 #5896 的部署顺序

```
#5896 迁移 → #5896 应用构建 → 01（只读，可重复） → 02 干跑 → owner 批准
  → 02 APPLY=1 → 重跑 01 确认 0 → 03
```

- 01 在迁移之前跑不出结论（少列），会报
  `status=incomplete reason=missing-column:data_sources.live_id`，**不是** 0。
  这条在 DB 层单独验过（S10）。
- 02 与 03 之间必须重跑 01：中间窗口里的新写入本身会被 NOT VALID 约束挡住（23503），
  但重跑 01 是唯一能证明这一点的动作。

## 9. 自验设计

`verify/` 两层，`node --test`：

- **LAYER 1 hermetic**（无数据库）：SQL 包的静态契约 + 一条防漂移检查——从
  `zzzz20260920120000_*.ts` 的 `up()` 里重新抽取四条 sql`` 模板、展开
  `${sql.lit/raw(...)}`、归一化空白，断言每一条都出现在
  `verify/migration-5896-up.sql` 里。再加一条「防漂移检查本身会咬」的测试：把
  fixture 文本在内存里去掉 `NOT VALID` 子句，断言检查抛错。
- **LAYER 2 DATABASE_URL 门控**：便携 PG 16.9 上的十一个场景（S1..S11）+ 三个变异，见验证文档。
  没有 `DATABASE_URL` 时**大声跳过**；`METASHEET_REAL_DB_TEST_STEP=1` 时缺库或缺
  `psql` 改为失败（fail-not-skip，对齐
  `scripts/ops/approval-s1-evidence-replay-gate.test.mjs`）。

**所有变异都在内存里**：改过的 SQL 走 psql 的 stdin，cwd 设成包目录让 `\ir` 仍能解析；
不写任何变异文件到盘上。这样两个 harness 并行也不会互相读到对方的变异（2026-09-11
「并行反驳者同树变异互撞」那条教训）。

CI：本 PR **不带** workflow 文件。推送本分支的令牌没有 `workflow` scope，
GitHub 直接拒收 `.github/workflows/**`。hermetic lane（checkout + setup-node，
无库无 secret，路径过滤）与 LAYER 2 的 postgres:16 service lane 都留作残余，
形状写在验证文档 §5，与 `readonly-inventory-20260916` 的处理一致。

未往根 `package.json` 加 `verify:*:test` 脚本：那一段是并发 PR 的高冲突区（多次
O(n²) 撞车），而 workflow 与 README 已经把命令写死，收益不值这个风险。
