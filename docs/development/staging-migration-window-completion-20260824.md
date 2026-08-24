# Staging 迁移窗口完成记录(2026-08-24)

> **性质**:本文档**记录已完成的状态**,不授权任何后续动作。它把
> `staging-migration-backlog-disposition-20260822.md` 分析的那个窗口的**实际执行结果**落盘,
> 并把该窗口所依据的书面指引里**两处会被其他环境继承的程序缺陷**记为勘误(§2),
> 外加一条同类的照抄陷阱(§2(c))。
> **范围**:只读地引用 CI run 日志与仓内文件。未触碰任何主机、数据库或 CI。

## 1. 证据

**Workflow**:`Attendance Staging Window Runner`
(`.github/workflows/attendance-staging-window-runner.yml`,`workflow_dispatch`)
**head SHA**:`c345c6b405eebe5d9299e2a89d452c907f1aab6b`(两次运行同一 head)

| run | action | 结论 | 起 / 止(UTC) |
|---|---|---|---|
| `32694623829` | `migrate` | success | 2026-08-24T05:44:54Z → 05:48:07Z |
| `32694880864` | `deploy` | success | 2026-08-24T05:49:13Z → (同窗口内) |
| `32694976146` | `status` | success | 2026-08-24T05:50:49Z → (同窗口内) |
| `32695040817` | `migrate`(确认跑) | success | 2026-08-24T05:51:56Z → 05:54:36Z |

### 1.1 `run 32694623829` —— 备份 → 克隆彩排 → 真实应用

runbook 要求的三段全部出现在同一次运行里,顺序即下:

应用前(真实 staging DB):

```
2026-08-24T05:45:52Z  Applied: 321
2026-08-24T05:45:52Z  Pending: 16
```

备份(路径/摘要按 values-free 纪律不转录):

```
2026-08-24T05:46:32Z  [window-runner] backup OK: 46095547 bytes (dump stays on host, not uploaded)
```

克隆彩排(先只对彩排库应用,真实库不动):

```
2026-08-24T05:47:40Z  [window-runner] rehearsal isolation baseline: applied(real metasheet)=321 applied(window_runner_rehearsal)=321
2026-08-24T05:47:44Z  [window-runner] rehearsal isolation check: applied(real metasheet) 321->321; applied(window_runner_rehearsal) 321->337
2026-08-24T05:47:46Z  Applied: 337
2026-08-24T05:47:46Z  Pending: 0
2026-08-24T05:47:46Z  [window-runner] rehearsal: green — dropping window_runner_rehearsal and the in-container dump copy
2026-08-24T05:47:46Z  [window-runner] rehearsal OK
```

真实应用(彩排绿之后):

```
2026-08-24T05:47:48Z  Applied: 321
2026-08-24T05:47:48Z  Pending: 16
   ...
2026-08-24T05:47:53Z  Applied: 337
2026-08-24T05:47:53Z  Pending: 0
2026-08-24T05:47:54Z  [window-runner] apply OK: staging migrate ended at pending=0
```

**`321 / 16` → `337 / 0`**:实际应用 **16** 条(以 run log 为准——这是对真实 staging 状态的测量,
不是仓库侧推断)。

### 1.2 `run 32694880864`(`deploy`)—— 镜像切换 + 对齐判定

`action=migrate` 按其 workflow 头注是"拉取目标 SHA 镜像但**不切换正在运行的 app**",
因此镜像层面的前置由紧随其后的 `deploy` 跑完成:

```
2026-08-24T05:49:33Z   Container metasheet-staging-backend Recreated
2026-08-24T05:49:34Z   Container metasheet-staging-web Started
2026-08-24T05:49:45Z  Applied: 337
2026-08-24T05:49:45Z  Pending: 0
2026-08-24T05:49:45Z  [staging-migration-alignment-report] decision=aligned
2026-08-24T05:49:49Z  [window-runner] auth round-trip OK (me=200, settings=200)
2026-08-24T05:49:49Z  [window-runner] deploy OK: c345c6b405eebe5d9299e2a89d452c907f1aab6b
```

**这条是"镜像已切换到 `c345c6b405`"的直接证据**,`decision=aligned` 是对齐报告自身的判定
(2026-08-20 那次同一报告判的是 `do_not_run_full_migrate`)。

### 1.3 `run 32695040817`(确认跑)

对一个已排空的库重跑,四处观测一致:

```
2026-08-24T05:52:18Z  Applied: 337 / Pending: 0
2026-08-24T05:54:13Z  Applied: 337 / Pending: 0
2026-08-24T05:54:16Z  Applied: 337 / Pending: 0
2026-08-24T05:54:20Z  Applied: 337 / Pending: 0
```

`run 32694976146`(`status`)在两次 migrate 之间亦读到 `Applied: 337 / Pending: 0`
(2026-08-24T05:51:09Z)。

### 1.4 与 `staging-migration-backlog-disposition-20260822.md` 的关系

本窗口执行的正是该报告分析的窗口,且是其**真超集**:该报告按题面只分析七条,实际应用 16 条,
七条全在其中(逐条比对 run log 的 `Pending migrations (in load order)` 清单):

该报告的七条(全部已应用):
`zzzz20260817120000_add_handle_action_to_approval_records` /
`zzzz20260817130000_create_approval_form_field_revisions` /
`zzzz20260818090000_add_policy_denied_action_to_approval_records` /
`zzzz20260818120000_create_approval_usable_member_groups` /
`zzzz20260821090000_create_attendance_org_resolution_shadow` /
`zzzz20260821091000_add_attendance_org_resolution_shadow_indexes` /
`zzzz20260821120000_recovery_authority_functions_fix_search_path`

七条之外另有九条(该报告成文后落的,及一条早于 `zzzz` 命名流的):

1. `076_create_integration_stock_prep_pack_installs`
2. `zzzz20260821100000_add_approval_instance_org_id`
3. `zzzz20260822120000_create_approval_comments`
4. `zzzz20260822130000_approval_attachments_process_binding`
5. `zzzz20260823040000_recovery09_prepare_legacy_default_org`
6. `zzzz20260823050000_provision_zero_membership_active_users`
7. `zzzz20260823100000_backfill_approval_instance_org_id`
8. `zzzz20260823149900_recovery09_close_approval_org_gap`
9. `zzzz20260823150000_close_approval_instance_org_id_gap_window`

该报告 §6 附录已预告"积压是移动靶";本记录以 run log 的 16 为准。

### 1.5 与 `origin/main` 的迁移面差量

`c345c6b405`(执行 head)与当前 `origin/main`(`96b6416717`)之间,
`packages/core-backend/src/db/migrations/` 与 `packages/core-backend/migrations/` 的 diff 为**空**
(`git diff --name-status c345c6b405 origin/main` 全量输出只有一个文件:
`docs/development/timemachine-owner-decision-sheet-20260821.md`)。
**即:自窗口执行以来 main 未新增任何迁移文件,`pending = 0` 对当前 main 依然成立。**

---

## 2. 程序勘误(供 prod / 后续窗口复用时继承)

窗口本身在 staging 上成功。但它所依据的书面指引里有三处缺陷:**照抄到别的环境会出问题**。
本节只更正程序,不改变任何已 ratify 的判据。

### (a) §7 预检一的 CHECK 判据过窄

**该报告 §7 的原文分两半,一半对、一半窄**:

- **指令半(正确)**:「把结果与**两条迁移各自的枚举列表**比对」——"各自"是对的,两条迁移
  各有一份枚举。
- **结论半(过窄)**:「任何不在**最终 16 项**内的值 ⇒ `ADD CONSTRAINT` 会失败」——这句把两份枚举
  塌缩成了最终那一份。

**缺陷**:两条迁移是**串行**装 CHECK 的,中间存在一个 15 项的中间态。逐字读两个文件:

`packages/core-backend/src/db/migrations/zzzz20260817120000_add_handle_action_to_approval_records.ts:10-26`
的 `ACTIONS_WITH_HANDLE` 是 **15 项**,**不含 `policy_denied`**:

```
'created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment',
'cc', 'remind', 'jump', 'add_sign', 'reduce_sign', 'reassign', 'handle'
```

`packages/core-backend/src/db/migrations/zzzz20260818090000_add_policy_denied_action_to_approval_records.ts:17-34`
的 `ACTIONS_WITH_POLICY_DENIED` 是 **16 项**:

```
'created', 'approve', 'reject', 'return', 'revoke', 'transfer', 'sign', 'comment',
'cc', 'remind', 'jump', 'add_sign', 'reduce_sign', 'reassign', 'handle', 'policy_denied'
```

两者的 `up()` 都是 `DROP CONSTRAINT IF EXISTS` + 无 `NOT VALID` 的 `ADD CONSTRAINT`
(各自 `:33-38` / `:43-48`),即**各做一次全表验证扫描**。

**反例**:一行既存的 `action = 'policy_denied'`。它**在最终 16 项之内**,所以按 §7 的结论半判据
**预检通过**;但它不在迁移 #1 的 15 项之内,迁移 #1 的验证式 `ADD CONSTRAINT` 会先失败(`23514`)。
**过窄的判据会放行一个真实会炸的窗口。**

**更正后的程序**:对**每一个中间态各写一条显式的例外查询**,枚举从各自迁移文件里**逐字复制**
(不凭记忆重打):

```sql
-- 中间态 1:zzzz20260817120000 装的 15 项(注意:不含 policy_denied)
SELECT action, count(*) FROM approval_records
 WHERE action NOT IN ('created','approve','reject','return','revoke','transfer','sign','comment',
                      'cc','remind','jump','add_sign','reduce_sign','reassign','handle')
 GROUP BY action ORDER BY 2 DESC;

-- 中间态 2(最终态):zzzz20260818090000 装的 16 项
SELECT action, count(*) FROM approval_records
 WHERE action NOT IN ('created','approve','reject','return','revoke','transfer','sign','comment',
                      'cc','remind','jump','add_sign','reduce_sign','reassign','handle','policy_denied')
 GROUP BY action ORDER BY 2 DESC;

-- 保险带(见下:本表上恒为 0)
SELECT count(*) FROM approval_records WHERE action IS NULL;
```

**任一查询返回非空即不得直接应用。**

**关于 `NULL` 的准确说法**:`action NOT IN (...)` 对 `NULL` 永远不返回 true,所以上面两条例外查询
**对 NULL 行是沉默的**——这是单列一条 `IS NULL` 查询的理由。但需说明两点,以免读者误判风险:
① Postgres 的 CHECK 在求值为 NULL 时**通过**,所以即便存在 NULL 行也不会让 `ADD CONSTRAINT` 失败;
② `approval_records.action` 自建表起即 `TEXT NOT NULL`
(`packages/core-backend/src/db/migrations/20250924105000_create_approval_tables.ts:20`),
本表上 NULL 行不可能存在。**故该 `IS NULL` 分支是保险带(错向安全侧),不是已知风险**;
在 `action` 可空的其它表/环境上复用此程序时,它才是必需的。

### (b) 锁窗口预算按迁移计,而实际按整批计

**先纠正一处仓内既有的错误说法**:该报告 §2 #1 写「The `DROP`→`ADD` pair executes inside kysely's
**one-transaction-per-migration** wrapper」。**这与 kysely 源码不符。**

**源码认定**(`packages/core-backend/node_modules/kysely`,`package.json` 声明 `^0.28.8`,
lockfile 与 `node_modules` 均解析到 **0.28.8**):

`dist/cjs/migration/migrator.js:400-436` 的 `#runMigrations` 把**整个 `run` 闭包**——其中包含
`#migrateUp(db, state, step)`,即**该批全部待应用迁移**——交给**一个**事务:

```js
// migrator.js:430-431
if (adapter.supportsTransactionalDdl && !this.#props.disableTransactions) {
    return this.#props.db.transaction().execute(run);
}
```

决定性佐证三条:

1. `transaction()` 在整个 `migrator.js` 里**只出现这一次**(`grep -n "transaction()" migrator.js`
   唯一命中 `:431`)——不存在逐迁移的内层事务。
2. `#migrateUp` 的循环把**同一个** `db` 句柄传给每条迁移:
   `for (let i = 0; i < results.length; i++) { ... await migration.up(db) ... }`。
3. `PostgresAdapter.supportsTransactionalDdl` 返回 `true`
   (`dist/cjs/dialect/postgres/postgres-adapter.js:9-11`);同文件 `:19-22` 的注释自陈:
   「`pg_advisory_xact_lock` is automatically released at the end of the transaction and since
   `supportsTransactionalDdl` true, we know the `db` instance passed to acquireMigrationLock is
   actually a transaction」。
   ESM 产物同形(`dist/esm/migration/migrator.js:428-429`)。

`packages/core-backend/src/db/migrate.ts:25-39` 构造 `Migrator` 时只传 `db` /
`allowUnorderedMigrations: true` / `provider`,**没有传 `disableTransactions`**,
故走的正是上面的 `true` 分支。

**因此该报告 §7「锁窗口预算」一节不完整**。它正确指出「#1 与 #3 各做一次 `approval_records`
全表验证扫描并持 `ACCESS EXCLUSIVE`——同一批里连做两次」,但**没有说这把锁在两次扫描之后仍不释放**。

**更正后的锁模型**:迁移 #1 在 `approval_records` 上取得的 `ACCESS EXCLUSIVE`,
**一直持有到整批的最后一条迁移提交为止**——本窗口即穿过其后的 **15** 条迁移,而不只是穿过 #3 的扫描。
`pg_advisory_xact_lock` 同理(事务级)。**锁窗口必须按整批预算,不能按单条迁移预算**;
批越长,`approval_records` 被独占的时间越长,与该表自身行数无关的那部分时间由批里其余迁移决定。

### (c) §7 预检二的"照抄"查询在未应用的环境上跑不起来

该报告 §7 预检二让执行者把 `add_approval_instance_org_id` 迁移里的 `conflicts` 查询
「照抄为只读 SELECT 执行」。**照抄会死于 `42703`(undefined_column)。**

逐字读 `packages/core-backend/src/db/migrations/zzzz20260821100000_add_approval_instance_org_id.ts:121-130`,
该查询含谓词 `AND i.org_id IS NULL`:

```sql
SELECT a.instance_id
  FROM approval_attachments a
  JOIN approval_instances i ON i.id = a.instance_id
 WHERE a.instance_id IS NOT NULL
   AND i.org_id IS NULL
 GROUP BY a.instance_id
HAVING COUNT(DISTINCT a.org_id) > 1
 ORDER BY a.instance_id
```

而 `approval_instances.org_id` **正是这条迁移自己在 Phase 1 创建的列**
(同文件 `:86`:`ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS org_id text`)。
迁移体内该谓词成立,是因为它跑在 `ADD COLUMN` **之后**;而预检按定义跑在**应用之前**,
此时该列不存在。

**更正后的程序**:照抄时**删去 `AND i.org_id IS NULL` 一行**。
迁移前该列不存在,该谓词逻辑上对所有行恒真,删去后语义等价。

> 本窗口已过,(c) 纯为其它环境复用而记。

---

## 3. 结语

本文档**记录已完成的状态,不授权任何事**。
下一步(双主机 `postdeploy-full` 取新指纹证据)属 owner/ops 动作,需 owner 授权,不由本记录推进。
