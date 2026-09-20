# live_id FK 存量悬空行：盘点 / 清理 / VALIDATE 脚本包（2026-09-20）

> **本包未在任何真实库执行。** 下面的 `01` 是只读盘点；`02 -v APPLY=1` 与 `03`
> 是**生产写入**，按 AGENTS.md「决策机制」属 owner（O）层「先批后动」，必须由
> owner 亲自执行或亲自授权后执行。本包只交付可审的脚本与证据。

## 1. 这包在补什么洞

PR #5896 把 `integration_external_systems.connection_id` 的外键改指
`data_sources(live_id)`（`live_id` 是 STORED 生成列：行活着时等于 `id`，软删后为
NULL），新约束 `fk_integration_external_systems_live_connection_id` 以
**NOT VALID** 建立：

- `packages/core-backend/src/db/migrations/zzzz20260920120000_data_source_live_id_binding_lock.ts:96-113`

`NOT VALID` 的含义是：**此后每一条写 `connection_id` 的 INSERT/UPDATE 都全查全锁**，
但**迁移前就已经悬空的存量行被容忍、从不扫描**。所以在把存量清干净之前：

- 约束不能 `VALIDATE`，`pg_constraint.convalidated` 一直是 `false`；
- 规划器不得依赖它；
- 「本库没有指向已删数据源的绑定」这句话只是对未来写入的承诺，不是事实陈述。

本包三步把它变成事实：**盘点（只读） → 清理（默认干跑） → VALIDATE（生产写入）**。

### 什么算「悬空」

就是外键自己判定的那条（MATCH SIMPLE）：

```sql
connection_id IS NOT NULL
AND NOT EXISTS (SELECT 1 FROM data_sources WHERE live_id = connection_id)
```

两种互斥子形态，`01` 用 `target_state` 报出来：

| target_state | 含义 |
| --- | --- |
| `soft-deleted` | `data_sources` 里有这一行，但 `deleted_at IS NOT NULL`（所以 `live_id` 为 NULL）。主流形态，含 #5896 之前所有 force 删除留下的行。 |
| `absent` | `data_sources` 里根本没有这个 id（硬删，或指针从未解析过）。`ON DELETE RESTRICT` 让它很难产生，但盘点不假设它不可能。 |

**不在盘点范围**：legacy 绑定形态（`connection_id IS NULL`，指针在
`config->>'dataSourceId'`）。它没有外键，#5896 不碰它，`VALIDATE` 也不看它。

## 2. 执行顺序与每步期望输出

三个文件都只有**一种**运行方式：整个文件交给 `psql -f`。
（`_preamble.sql` / `_preamble-write.sql` 里 `\set ON_ERROR_STOP on`，任何错误都会
让 psql 以非零码中止。）

### 01-inventory.sql —— 只读盘点

```bash
psql "$DATABASE_URL" -f 01-inventory.sql > 01.log 2>&1
# 可选：-v schema=public
```

期望输出（按顺序）：

1. 列探针：`data_sources.{id,live_id,deleted_at}` 与
   `integration_external_systems.{id,connection_id}` 各一行；
2. `-- live FK present / already validated:` 后面一行两个布尔值。第二个是 `f`
   说明约束还是 NOT VALID——这正是本包存在的理由；
3. 主结果块，三段：
   - `section=TOTAL` —— **必有且只有一行**，`n` 是悬空行数。`n=0` 就是「没有存量，
     直接去 03」的答案；
   - `section=BY_KIND_TENANT` —— 每个 `(kind, tenant_id)` 一行，`sum(n)` 等于
     `TOTAL.n`；
   - `section=HIT` —— 每个悬空绑定一行，`n=1`。**HIT 行数必须等于 `TOTAL.n`**；
4. 最后一行 `INVENTORY_RESULT file=01-inventory.sql status=…`。

`HIT` 行的列义：

| 列 | 含义 |
| --- | --- |
| `key_id` | `integration_external_systems.id`，就是 02 要改的行 |
| `target_state` | 见上表 |
| `config_pointer` | `config->>'dataSourceId'` 已存在且非空——02 不会重写这行的 config |
| `config_object` | `jsonb_typeof(config)='object'`。为 `f` 表示 02 **写不进回滚凭证**，会拒绝处理这行 |
| `legacy_fallback` | `legacy_connection_fallback_eligible`，服务端持有的切换期证据；02 从不改它 |

**读日志的三条纪律**：

- 没有 `INVENTORY_RESULT` 行的运行是**不完整**的（中止 / 57014 超时 / 被取消 /
  管道截断）。**绝不可把「没打印」读成「零悬空」。**
- `status=incomplete reason=missing-column:data_sources.live_id` 表示 #5896 的迁移
  还没在这个库上跑过，不是「零悬空」。
- `TOTAL.n` 上千时先停手要预算，再拉完整 id 列表。

计数与 id 出自**同一个 `hit` CTE、同一条语句的三个分支**——不是三条重复谓词的语句。
这是 2026-09-16 那包复核里 F4 的教训（计数与 id 用了两套谓词，列表里有计数里没有的行）。
`verify/` 里有一个把 TOTAL 改成独立谓词的变异，用来证明这条不变量真的会红。

### 02-remediate.sql —— 清理（**默认干跑**）

```bash
# 干跑：照样跑完每一步、打印每步受影响行数，末尾 ROLLBACK
psql "$DATABASE_URL" -f 02-remediate.sql > 02-dry.log 2>&1

# 真写：只有 owner 授权后
psql "$DATABASE_URL" -v APPLY=1 -f 02-remediate.sql > 02-apply.log 2>&1
```

只有**精确字面量 `1`** 开写。`-v APPLY=true`、`APPLY=yes`、`APPLY=on`、`APPLY=0`、
不传 —— 全是干跑。

做什么（整个文件一个显式事务，目标行快照落在
`CREATE TEMP TABLE h5_dangling ON COMMIT DROP`，两步改同一批 id）：

| 步骤 | 动作 | 期望输出 |
| --- | --- | --- |
| STEP0 | 快照计数 | 一行：`dangling` 应等于 01 的 `TOTAL.n`；`blocked>0` 意味着 APPLY 会在 STEP4 主动中止 |
| STEP1 | canonical 形态（`config` 是对象且没有 `dataSourceId`）把当前 `connection_id` 写进 `config.dataSourceId` | `rows` == STEP0 的 `needs_receipt` |
| STEP2 | 这些行 `connection_id = NULL` | `rows` == STEP0 的 `remediable` |
| STEP3 | 从**活表**重新数悬空 | `rows` == STEP0 的 `blocked`（干净清理时为 0） |
| STEP4 | `APPLY=1` 且 `blocked>0` 时抛 `REMEDIATE_ABORT reason=non-object-config` | 只在真写时执行 |
| 末尾 | `REMEDIATE_RESULT … mode=apply\|dry-run …` + `REMEDIATE_TX=committed\|rolled-back` | 两行都要看 |

几条要点：

- **为什么先写凭证再清指针。** canonical 绑定的 `config` 里没有
  `dataSourceId`——`lib/external-systems.cjs:486` 和 `:548-553` 在 INSERT 前就把
  legacy 指针从 config 删掉了。`connection_id` 列是「这个绑定原来指向谁」的唯一
  记录，STEP2 会毁掉它，所以凭证必须在**同一个事务里先写**。
- **为什么不是删行。** 绑定行还带着 name / kind / role / capabilities / 凭据，以及
  下游 `integration_pipelines.source_system_id / target_system_id`
  （`migrations/057_create_integration_core_tables.sql:57,60`，ON DELETE RESTRICT）。
  置空指针是满足外键的最小改动，而且可逆；删行两样都不是。
- **两步都不会触发外键复查。** STEP1 不碰 `connection_id`（PostgreSQL 在引用键列
  未变时跳过 RI 检查），STEP2 置 NULL（MATCH SIMPLE 直接放行）。所以这个文件在
  这些行当前正违反（NOT VALID）约束的情况下照样跑得通。
- **不伪造切换期证据。** `legacy_connection_fallback_eligible` 原样不动。

### 02 之后这行长什么样

STEP2 之后，这行是「legacy 形状的指针 + marker 仍为 FALSE」。
`lib/connection-resolver.cjs:206-212` 对 marker 非 TRUE 的行直接抛
`CONNECTION_LEGACY_FALLBACK_DENIED`——**不会**悄悄走读已删数据源那条路。绑定本来就
已经坏了，这一步只是让它按名字失败。

⚠️ **重新绑定时必须同时清掉凭证。** `config.dataSourceId` 留着只是回滚凭证。若之后
通过 API 把这行重新绑到一个新的 `connectionId`，`resolveCanonical`
（`lib/connection-resolver.cjs:193-200`）会拿 `config.dataSourceId` 和新的
canonical id 比对、不等就抛 `CONNECTION_BINDING_MISMATCH`。所以重绑那一次 PATCH
里要同时显式传 `config: { dataSourceId: null }`（显式 null 清键是
`lib/external-systems.cjs` 支持的唯一清除方式），或按下面的 SQL 手工清。

### 03-validate.sql —— 把约束坐实（生产写入）

```bash
psql "$DATABASE_URL" -f 03-validate.sql > 03.log 2>&1
# 需要更长的锁等待：-v lock_timeout=30s
```

- 先 `SET lock_timeout`（本文件自己设，不依赖 preamble 默认值）并 `SHOW` 出来。
  `VALIDATE CONSTRAINT` 取 `SHARE UPDATE EXCLUSIVE`——它不挡普通读写，但在锁队列里
  排队时会把后面的流量一起挡住，所以锁超时不是可选项。
- 结果按 SQLSTATE 分类，只抓两个：
  - `23503 foreign_key_violation` → `status=failed reason=dangling-rows`：还有悬空，
    回去跑 01，再跑 02 `-v APPLY=1`；
  - `55P03 lock_not_available` → `status=failed reason=lock-timeout`：什么都没改，
    换个安静的窗口重试或调大 `-v lock_timeout`。
- **故意不抓**：`57014 query_canceled`（statement_timeout / Ctrl-C）和其它一切
  （42501 权限、42704 对象不存在……）。它们会让文件中止、**一行 `VALIDATE_RESULT`
  都不打印**。**没有 RESULT 行 = 未知，去查**，既不是成功也不是「没有悬空」。
- 退出码有意义：状态不是 `complete` 时最后一条语句会再抛错，`psql -f` 以非零退出。
- 幂等：已 validate 的约束再跑是 no-op，RESULT 行带 `already_validated=yes`。

## 3. 回滚

### 02 的逆操作

```sql
-- 前置：目标 data_sources 行必须先「复活」（deleted_at 置回 NULL），否则下面这条
-- UPDATE 会被 fk_integration_external_systems_live_connection_id 以 23503 拒绝
-- ——因为 live_id 仍然是 NULL。复活一个数据源是 owner 决定，不在本包范围内。
BEGIN;

UPDATE integration_external_systems
   SET connection_id = NULLIF(BTRIM(config->>'dataSourceId'), ''),
       updated_at = NOW()
 WHERE id IN ( … 从 02-apply.log 的 HIT/STEP 输出里抄 id … )
   AND connection_id IS NULL
   AND jsonb_typeof(config) = 'object'
   AND NULLIF(BTRIM(config->>'dataSourceId'), '') IS NOT NULL;

-- 只对 02 的 STEP1 真写过凭证的那些行（01 里 config_pointer=f 的行）做这一步；
-- 本来就带指针的 legacy 行不要清，那是它自己的数据。
UPDATE integration_external_systems
   SET config = config - 'dataSourceId',
       updated_at = NOW()
 WHERE id IN ( … 仅 STEP1 写过凭证的 id … );

COMMIT;
```

**注意不对称**：02 是可逆的，但 03 之后「回滚」意味着让约束重新接受悬空行，那只能
`ALTER TABLE integration_external_systems DROP CONSTRAINT
fk_integration_external_systems_live_connection_id` 再按 #5896 迁移的 `up()`
重新以 NOT VALID 建回来——这是 schema 改动，同样是 owner 层动作。

### 重绑后清掉凭证（见上面的 ⚠️）

```sql
UPDATE integration_external_systems
   SET config = config - 'dataSourceId',
       updated_at = NOW()
 WHERE id = '…'
   AND connection_id IS NOT NULL
   AND config->>'dataSourceId' IS DISTINCT FROM connection_id;
```

## 4. 授权点（owner 亲自执行）

| 步骤 | 性质 | 谁 |
| --- | --- | --- |
| `01-inventory.sql` | 只读（会话 `default_transaction_read_only = on`），只输出 id 与计数 | 可由运维以只读角色执行 |
| `02-remediate.sql`（不带 APPLY） | 干跑，末尾 ROLLBACK；但**连接的是生产库** | 需要生产库只读/读写连接，按现场规矩走 |
| `02-remediate.sql -v APPLY=1` | **写客户生产表** | **owner 先批后动（O 层 ②）** |
| `03-validate.sql` | **DDL：把约束提升为 validated**，全表扫描 + SHARE UPDATE EXCLUSIVE | **owner 先批后动（O 层 ②）** |

values-free：本包输出只有 `integration_external_systems.id`、`tenant_id`、
闭集 `kind`、布尔与计数。没有 `config`、没有 `name`、没有
`credentials_encrypted`、没有主机/口令/凭据。把日志贴出去之前仍然自己看一眼。

## 5. 与 #5896 的部署顺序

```
#5896 迁移（zzzz20260920120000）  ←── 必须先上；01 在这之前只会报
      │                               status=incomplete reason=missing-column
      ▼
#5896 应用构建（不再发 force）
      │
      ▼
01-inventory.sql（只读，随时可跑，跑几次都行）
      │
      ▼   TOTAL.n > 0
02-remediate.sql（先干跑，把 02-dry.log 交 owner 看）
      │
      ▼   owner 批准
02-remediate.sql -v APPLY=1
      │
      ▼   再跑一次 01，确认 TOTAL.n = 0
03-validate.sql
```

- `01` 在迁移之前跑不出结论（少列），所以顺序不能颠倒。
- `02` 与 `03` 之间**必须**重跑 `01`：中间窗口里有新写入的话，新写入本身会被
  NOT VALID 约束挡住（23503），但重跑 01 是唯一能证明这一点的动作。
- `03` 成功之后，新的悬空绑定在数据库层就不可能落地了——`verify/` 里的 S6 就是这条。

## 6. 自验

```bash
# 只跑静态契约层（无需数据库）
node --test scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs

# 全量：指向一个一次性的合成库，绝不能指向真实库
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/scratch \
  node --test scripts/ops/live-id-fk-validate-20260920/verify/live-id-fk-validate-pack.test.mjs
```

`verify/run-verify.mjs` 在 `h5_fixture_*` 临时 schema 上跑 S1..S10 十个场景与
M1/M2/M3 三个变异；变异全部在内存里做（改过的 SQL 走 psql 的 stdin，cwd 设成包目录
让 `\ir` 仍能解析），**不落盘**，所以两个 harness 并行也不会互相读到对方的变异。
详见 `docs/development/data-source-live-id-fk-validate-runbook-verification-20260920.md`。
