# elearning 批量指派 10,000 成员用例:夹具事务内 ANALYZE(2026-09-30)

- **范围**:只改测试夹具 `packages/core-backend/tests/integration/elearning-batch-assignment.db.test.ts`(+25 行,零删除)。零产品代码;不调任何超时 / 预算;10,000 上界断言不变;不动 `.github/workflows/*`;不动 `elearning-scope-access.db.test.ts`。
- **状态**:实现与验证完成,待门审;合并需 owner 点名。本文的判断不是授权。
- **证据标签**:【重取】= 续做轮(21:32–21:53)在 Mac mini 上新建的一次性库里重新跑出;【上次】= 被额度中断的上一轮跑出,本轮未重取;【CI】= GitHub Actions 日志,本轮重读;【转述】= 出自此前的独立验证,本轮未重做。

## 1. 根因(一句)

用例「accepts exactly 10,000 current members and rejects 10,001 in the real resolver」在一个会回滚的事务里向 `users` / `user_orgs` 各写 10,001 行,随后直接调用真实解析器;这些行从未被 ANALYZE,如果此前 `pg_class` 把任一表记成 `reltuples = 0` 且 `relpages >= 1`,规划器按密度 0 把 10,000 行的连接估成 1 行,选出嵌套循环 + Join Filter,是纯 CPU 的慢,不是锁等待。与 #6171 在 `elearning-scope-access.db.test.ts` 上修的是同一形状。

该用例在 CI 上没有红过:预算 60 s,慢态下 CI(PostgreSQL 14.24)读数为 11–15 s,常态约 0.5 s。【CI】run 36575942849(`test (20.x)`)14693 ms;分支基 `cffd5dacbc` 的 main CI(run 36709007799)592 ms。【转述】41 次执行里 9 次为 11.3–14.7 s,全部在 #6171 之前。

## 2. 改动

- 文件内新增一行 helper `analyzeBulkFixture`(与 scope-access 文件里的同名 helper 相同;没有抽共享模块,改动更小)。
- 在该用例里,`seedUsers(...)` 之后、下一条语句之前执行 `ANALYZE users, user_orgs`。
- 一次就够:`user_orgs` 对 `users` 没有外键(【重取】`pg_constraint` 计数 0),两条批量 INSERT 之间没有要按新行规划的检查。
- 与 #6171 相同的副作用:`pg_statistic` 行随事务回滚;`pg_class` 的行数 / 页数原地写入,回滚后留下(【重取】修后臂每轮结束为 `10001/N`,修前臂保持 `0/N`),直到 autovacuum 再处理这两张表。它只会让后续计划按更大的表估算。

## 3. 读数

环境:Mac mini,PostgreSQL 16.15,Node 20.20.2。测试文件 blob `46c42ffa19`,在 `8e5814c75d`、`0794498848` 与本说明所在提交上逐字相同。修前臂是分支基 `cffd5dacbc` 的原文件(blob `aa6d35cee0`,逐字相同,已核)。每个一次性库都按 `plugin-tests.yml` 的 `MIGRATION_EXCLUDE` 应用 420 条迁移,每轮起跑前断言 `current_database()`。
**机器负载**:重取期间 Mac mini 上另有一条前端测试 lane 在跑,1 分钟负载 50–113(10 核)。绝对耗时偏大,只看两臂之间的差。

### 3.1 强制危险统计,两臂交替【重取】

在 A/B 库上先把 `users`、`user_orgs`、`elearning_assignments`、`elearning_assignment_members` 设为 `autovacuum_enabled = false`,并在每轮的起跑日志里用 `pg_class.reloptions` 断言。每轮起跑前在事务外把 `users`、`user_orgs` 置成 `reltuples = 0` 且 `relpages >= 1` 并断言,否则脚本退出。只跑这一条用例(`-t`)。

| 统计形状 | 修前臂(ms) | 修后臂(ms) |
|---|---|---|
| `VACUUM (TRUNCATE false)` 保留页后 ANALYZE(`0/1` 起,之后 `0/286`、`0/164`),交替 3 轮 | 22871 / 21872 / 23595 | 742 / 648 / 638 |
| `0/1`、`0/1`(CI 上天然出现的形状:空表留一页),交替 2 轮 | 23417 / 23867 | 646 / 710 |

- 计划(auto_explain,单独一轮,不计时,危险态 `0/572`、`0/327`):
  - 修前臂:`elearning-audience:resolve-membership` 9601 ms 与 9317 ms,最外层为 `Nested Loop`(估 1 行),`Rows Removed by Join Filter` 为 50005000 + 99990000 与 50005000 + 100010000;`elearning-batch-assign:lock-members` 7554 ms,`Rows Removed by Join Filter: 49995000`。
  - 修后臂:同两条语句分别为 21 ms、22 ms 与 36 ms。最外层是 `Hash Join`,估 10001 行与 10000 行,没有 Join Filter 删行。
- 全部交替轮里,该用例的后端没有出现过 `Lock:*` 等待。采样间隔约 0.5 s,`pg_blocking_pids` 恒为空,未授予锁数恒为 0。非 CPU 的样本只有 `IO:WALWrite` 和 `Client:ClientRead`。

### 3.2 变异:去掉新增的那一行 ANALYZE 调用【重取】

| 起始统计 | 结果(ms) |
|---|---|
| 危险 `0/286`、`0/164`,2 轮 | 21975 / 22251 |
| 危险 `0/1`、`0/1` | 17321 |
| 对照:紧接其后的修后臂,危险 `0/286`、`0/164` | 975 |
| 非危险 `10001/286`、`10001/164`(上一行修后臂原地写下的) | 1151 |

危险态下回到修前的慢,非危险态下仍是快的,见 §5。

### 3.3 整文件与同步骤文件【重取】

- 整文件(5 条用例)从断言过的危险态 `0/572`、`0/327` 起跑:5/5 通过,10,000 用例 755 ms;在 `973527de01`(测试文件 blob 相同)上再跑一次:5/5,576 ms。
- 同步骤 41 个 elearning 文件,清单取自 `plugin-tests.yml` 该步,与 workflow 同一配置(`vitest.integration.config.ts`)与文件清单、一个 vitest 进程(本地直接调用 `node_modules/.bin/vitest`,另加 `--no-cache` 与 json 报告器)。每轮用全新库,autovacuum 保持默认,两臂交替各 2 次:

| 臂 | 结果 | 10,000 用例(ms) | 该文件执行位次 |
|---|---|---|---|
| 修后 `0794498848` | 两次都是 41/41 文件、359/359 用例 | 516 / 603 | 第 25 |
| 修前 `cffd5dacbc` | 两次都是 41/41 文件、359/359 用例 | 574 / 785 | 第 26 |

- 执行顺序由 vitest 决定:无缓存时按文件大小排序。修前臂本地的 41 个文件顺序与 main `cffd5dacbc` 的 CI 日志(run 36709007799)逐项相同。修后臂只因该文件多了 25 行,前移一位。
- 这 4 次都没有天然撞上危险态。修前臂两表全程 `-1/0`;修后臂也是 `-1/0`,直到该用例把它们写成 `10012/N`。【上次】上一轮修前臂有 1 次天然撞上,用例 7735 ms,两次 `resolve-membership` 各约 3.2 s,后端 active、无等待。
- 整步里出现过的锁等待只有测试自己制造的并发屏障:advisory 锁、`LOCK TABLE` elearning 表、`transactionid`。没有一条涉及 `users` / `user_orgs`。
- 只针对这个测试文件的 `tsc --noEmit`(临时 tsconfig 继承 core-backend 的 tsconfig):0 错误。往副本里注入一个类型错误,会在第 597 行报 TS2345,说明检查确实生效。仓库的 type-check 本身不含 `*.test.ts`。

## 4. 锁影响

事务内的 `ANALYZE` 对两张表各持一把 `ShareUpdateExclusiveLock`,到夹具事务回滚为止;修后臂里整条用例只有 0.5–1 s。

**它会挡住谁。** 【重取】持有者事务在批量写入后有 / 没有 ANALYZE 两种情况下,另一会话逐种语句探测(`lock_timeout` 1.5 s):

| 另一会话的语句 | 没有 ANALYZE(现状) | 有 ANALYZE |
|---|---|---|
| SELECT、SELECT FOR UPDATE、INSERT | 不等 | 不等 |
| `ANALYZE` / `VACUUM` | 不等 | **等** |
| `VACUUM (SKIP_LOCKED)` | 执行 | 立即跳过 |
| `ALTER TABLE … DISABLE TRIGGER` / `ADD COLUMN`、`CREATE TRIGGER` | 等 | 等 |

新增的冲突只有同一锁级的请求:`ANALYZE`、`VACUUM`,以及少数取同级锁的 DDL(如 `CREATE INDEX CONCURRENTLY`、`ALTER TABLE … SET (…)`)。取更强锁的 DDL 本来就要等夹具已持有的 `RowExclusiveLock`。

**同库还有谁。**(本轮独立重核)
- 该步只有一个 vitest 进程,`vitest.integration.config.ts` 设 `fileParallelism: false`、`maxConcurrency: 1`,文件串行。该用例全程只用一条连接(`withRolledBackDb` 的 client,解析器也经它执行)。
- 该步只设 `DATABASE_URL`;41 个文件和 `tests/setup.integration.ts` 里没有别的 `*_DATABASE_URL`。它是迁移之后第一个用库的步骤;之前唯一起过数据库的步骤用的是自己 `initdb`、另一个端口的临时实例。Postgres 是 job 内自起的实例,步骤之间串行。
- 这 41 个文件没有任何针对 `users` / `user_orgs` 的表级语句(ANALYZE / VACUUM / ALTER / LOCK / TRUNCATE / 建索引 / 建触发器)。模板化的 `ALTER TABLE ${table}` 所用的表清单也核过:都是 `elearning_*` 表。
- 全仓测试里没有对这两张表的 `ANALYZE` / `VACUUM`。对 `users` 做 DDL 的测试有:5 个 approval 文件,在 `approval-realdb-acceptance.yml`,另一个 workflow、另一个库;以及 `invite-accept-concurrency-rollback`,在本 workflow 靠后的另一个步骤。
- 剩下的只有 autovacuum。

**autovacuum,两个方向。** 【重取】
- **夹具先持锁**:先把两表设成立即到期(阈值 0)。持有者执行 `ANALYZE` 后保持 140 s,期间 autovacuum 两次经过(21:42:51、21:43:51),两张表都记 `skipping vacuum of "…" --- lock not available`。这类日志行不带库名,但与本库同期的计数吻合。每 0.2 s 采样一次,本库的 autovacuum worker 被锁挡住的样本为 0。等待两表的未授予锁为 0,`autovacuum_count` 不变。释放后 1 分钟内,两表各被 autovacuum 处理一次。即非防回卷的 autovacuum 遇锁跳过、不排队(此为观测结论,未对照源码)。
- **autovacuum 先在表上**:把 worker 人为限速,并让两表都到期。夹具的 `ANALYZE users, user_orgs` 用了 2053 ms,期间处于 `Lock:relation` 等待,阻塞者是该 worker。超过 `deadlock_timeout`(1 s)后,PostgreSQL 先后取消了它在 `users` 与 `user_orgs` 上的任务(日志 `canceling autovacuum task`)。【上次】同一构造 2093 ms。

**结论。**
- 它不会让任何别的测试或进程多等:同库没有别的请求者会去要同级锁,autovacuum 选择跳过。
- 反方向有一种新增的、有上界的等待,由夹具自己承担:它的 ANALYZE 恰好撞上 autovacuum 正处理同一张表时,要多等一段,上界约为每表一个 `deadlock_timeout`,预算是 60 s。按 PostgreSQL 文档,防回卷的 autovacuum 不会被自动取消;但全新的 CI 库离默认防回卷阈值(2 亿事务)很远。
- 同类等待在 main 上已经存在:#6171 加的 ANALYZE,以及各 elearning 文件清理时的 `ALTER TABLE … DISABLE TRIGGER`。【上次】修前臂的整步运行里,`ALTER TABLE elearning_scope_revision_rules DISABLE TRIGGER` 就等了一个 autovacuum worker 至少 0.8 s。
- 用例超时后的孤儿事务:它本来就持有 `RowExclusiveLock`,多出的这把锁只多挡上表所列的同级请求,测试里没有这类请求。

## 5. 未覆盖 / 局限

- **没有在 PostgreSQL 14 上跑**。CI 是 14.24,本文全部实测读数来自 16.15;绝对耗时不可跨机比较,重取时机器另有高负载。
- **没有确定性的回归守卫**。测试自己不制造危险态;去掉这行 ANALYZE 后,非危险态下用例仍是快的(§3.2),所以多数 CI 执行看不出它被删掉。#6171 也是同样的性质。
- **只覆盖夹具批量写入的两张表**。被测代码自己写入的 `elearning_assignments` / `elearning_assignment_members` 不在其中。【上次】这两张表也被置成危险态时,修后臂为 709 ms 与 2029 ms。
- 天然危险态在 CI 上的发生率没有测。本轮 4 次整步运行 0 次撞上,上一轮修前臂 2 次撞上 1 次,样本都太小,不代表比例。
- autovacuum 相撞的 2053 ms 是人为构造的最坏情形(worker 被限速),不是 CI 上的观测值。
- 没有跑整个 `test` job,只跑了这一步的 41 个文件。
