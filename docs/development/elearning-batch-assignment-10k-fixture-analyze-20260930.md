# elearning 批量指派 10,000 成员用例:夹具事务内 ANALYZE(2026-09-30)

- **范围**:只改测试夹具 `packages/core-backend/tests/integration/elearning-batch-assignment.db.test.ts`(+25 行)。零产品代码;不调任何超时 / 预算;10,000 上界断言不变;不动 `.github/workflows/*`;不动 `elearning-scope-access.db.test.ts`。
- **状态**:实现与验证完成,待门审;合并需 owner 点名。本文的判断不是授权。
- **证据标签**:【实测】= 本次在 Mac mini 上跑出;【CI】= GitHub Actions 日志;【转述】= 出自此前的独立验证,本次未重做。

## 1. 根因(一句)

用例「accepts exactly 10,000 current members and rejects 10,001 in the real resolver」在一个会回滚的事务里向 `users` / `user_orgs` 各写 10,001 行,随后直接调用真实解析器;这些行从未被 ANALYZE,如果此前 `pg_class` 把任一表记成 `reltuples = 0` 且 `relpages >= 1`,规划器按密度 0 把 10,000 行的连接估成 1 行,选出嵌套循环 + Join Filter,是纯 CPU 的慢,不是锁等待。与 #6171 在 `elearning-scope-access.db.test.ts` 上修的是同一形状。

该用例在 CI 上没有红过:它的预算是 60 s,慢态下 CI(PostgreSQL 14.24)读数为 11–15 s,常态约 0.5 s。【CI】本次亲读 run 36575942849:14693 ms;【转述】41 次执行里 9 次为 11.3–14.7 s,全部在 #6171 之前。

## 2. 改动

- 文件内新增一行 helper `analyzeBulkFixture`(与 scope-access 文件里的同名 helper 相同;没有抽共享模块,改动更小)。
- 在该用例里,`seedUsers(...)` 之后、下一条语句之前执行 `ANALYZE users, user_orgs`。
- 一次就够的理由:`user_orgs` 对 `users` 没有外键,两条批量 INSERT 之间没有要按新行规划的检查。【实测】危险态下两条 INSERT 为 15–246 ms,ANALYZE 为 18–28 ms(各 7 次)。
- 与 #6171 相同的副作用:`pg_statistic` 行随事务回滚;`pg_class` 的行数 / 页数是原地写入,回滚后留下(【实测】`10001/N`、整步里为 `10012/N`),直到 autovacuum 再处理这两张表。它只会让后续计划按更大的表估算。

## 3. 读数【实测】

环境:Mac mini,PostgreSQL 16.15,Node 20.20.2,vitest 1.6.1。被测头 `8e5814c75d`;修前臂是分支基 `cffd5dacbc` 的原文件(blob 逐字相同,已核)。一次性库,420 条迁移按 `plugin-tests.yml` 的 `MIGRATION_EXCLUDE` 应用,每轮起跑前断言 `current_database()`。

### 3.1 强制危险统计,两臂交替

每轮起跑前在事务外把 `users`、`user_orgs` 置成 `reltuples = 0` 且 `relpages >= 1` 并断言,否则脚本退出。这两张表和两张指派表关掉 autovacuum,统计不漂移。只跑这一条用例(`-t`)。

| 统计形状 | 修前臂(ms) | 修后臂(ms) |
|---|---|---|
| `0/724`、`0/457`(VACUUM 保留页后 ANALYZE),交替 3 轮 | 16951 / 16873 / 17389 | 1213 / 747 / 809 |
| `0/1`、`0/1`(CI 上天然出现的形状),交替 2 轮 | 17854 / 17002 | 667 / 754 |
| `0/572`、`0/327`,另把两张指派表也置成 `0/1`、`0/4652` | 17449 | 709 / 2029 |
| 对照:全新统计 `-1/0` | 609 | — |

- 修前臂的慢语句(auto_explain,单独一轮,不计时):`elearning-audience:resolve-membership` 6352 ms 与 6375 ms,`Nested Loop (rows=1)`、`Rows Removed by Join Filter: 50005000` 与 `99990000`;`elearning-batch-assign:lock-members` 4931 ms,`Rows Removed by Join Filter: 49995000`。
- 修后臂同两条语句:12–23 ms 与 7–11 ms(6 轮),计划为 `Hash Join`,估算 `rows=10001`,没有 Join Filter。
- 修后臂在被测头上共 9 个计时轮(含 §3.2 对照前的一轮与 §3.3 的整文件轮):7 轮为 667–1217 ms,2 轮约 2 s(2029、2044)。开语句日志的另一轮 1846 ms 里,ANALYZE 20 ms、两次解析 12 ms 与 15 ms,多出的时间不在新增语句上;2029 ms 那轮里采样器自身也停顿了约 1.5 s。【推断】机器 I/O 抖动。
- 全部交替轮里,该用例的后端没有出现过 `Lock:*` 等待,`pg_blocking_pids` 恒为空,未授予锁数恒为 0。

### 3.2 变异:去掉新增的那一行 ANALYZE 调用

| 起始统计 | 结果(ms) |
|---|---|
| 危险 `0/286`、`0/164`,2 轮 | 18132 / 17899 |
| 危险 `0/1`、`0/1` | 17253 |
| 非危险 `10001/286`、`10001/164` | 1020 |

危险态下回到修前的慢;非危险态下仍是快的,见 §5。

### 3.3 整文件与同步骤文件

- 整文件(5 条用例),从断言过的危险态起跑:5/5 通过,10,000 用例 1217 ms。
- 同步骤的 41 个 elearning 文件(清单与顺序取自 `plugin-tests.yml` 该步),一个 vitest 进程,全新库,autovacuum 默认,各跑 2 次:

| 臂 | 结果 | 10,000 用例(ms) |
|---|---|---|
| 修后 `8e5814c75d` | 41/41 文件、359/359 用例,两次 | 526 / 1593 |
| 修前 `cffd5dacbc` | 41/41 文件、359/359 用例,两次 | **7735** / 1091 |

- 修前臂第一次是天然撞上的慢态:两次 `resolve-membership` 各约 3.2 s,后端 active、无等待。那一轮没有记录两张表当时的统计;第二次全程 `-1/0`,没有撞上。
- 修后臂里,该用例之后的 16 个文件全部通过;第二次它们全程在 `users = 10012/287`、`user_orgs = 10012/164` 下运行,第一次结束时 autovacuum 已把两表改写为 `23/287`、`23/165`。
- 只针对这个测试文件的 `tsc --noEmit`:0 错误(仓库的 type-check 本身不含 `*.test.ts`)。

## 4. 锁影响

事务内的 `ANALYZE` 对两张表各持一把 `ShareUpdateExclusiveLock`,到夹具事务回滚为止(约 0.5 s)。

**它会挡住谁。** 【实测】持有者事务里有 / 没有 ANALYZE 两种情况下,另一会话逐种语句探测(`lock_timeout` 1.5 s):

| 另一会话的语句 | 没有 ANALYZE(现状) | 有 ANALYZE |
|---|---|---|
| SELECT、SELECT FOR UPDATE、INSERT | 不等 | 不等 |
| `ANALYZE` / `VACUUM` | 不等 | **等** |
| `VACUUM (SKIP_LOCKED)` | 执行 | 立即跳过 |
| `ALTER TABLE … DISABLE TRIGGER` / `ADD COLUMN`、`CREATE TRIGGER` | 等 | 等 |

新增的冲突只有同一锁级的请求:`ANALYZE`、`VACUUM`,以及少数取同级锁的 DDL(如 `CREATE INDEX CONCURRENTLY`、`ALTER TABLE … SET (…)`)。取更强锁的 DDL 本来就要等夹具已持有的 `RowExclusiveLock`。

**同库还有谁。**
- 该步只有一个 vitest 进程,`vitest.integration.config.ts` 设 `fileParallelism: false`、`maxConcurrency: 1`,文件串行;该用例全程只用一条连接。
- 该步是迁移之后第一个用库的步骤;之前唯一起过数据库的步骤用的是自己 `initdb` 的临时实例(另一个端口),结束时已停。Postgres 是 job 内自起的实例。
- 这 41 个文件里没有任何针对 `users` / `user_orgs` 的表级语句(逐文件 grep;模板化的 `ALTER TABLE ${table}` 所用的表清单也核过)。全仓测试里没有对这两张表的 `ANALYZE` / `VACUUM`;对它们做 DDL 的测试(approval、attendance、invite 的若干文件)都在别的步骤,步骤之间串行。
- 剩下的只有 autovacuum。

**autovacuum,两个方向。** 【实测】
- 夹具先持锁:真实的 autovacuum worker 三次经过,每次都记 `skipping vacuum of "users" --- lock not available`(`user_orgs` 同),从未等待,下一轮再来。
- autovacuum 先在表上:夹具的 `ANALYZE` 要等它做完这张表;超过 `deadlock_timeout`(1 s)后 PostgreSQL 取消该 worker(日志 `canceling autovacuum task`)。把 worker 人为拖慢、且两张表都到期时,`ANALYZE users, user_orgs` 用了 2093 ms(每表约 1 s)。

**结论。**
- 它不会让任何别的测试或进程多等:同库没有别的请求者会去要同级锁,autovacuum 选择跳过。
- 夹具自己的 ANALYZE 在恰好撞上 autovacuum 正处理同一张表时,会多等一小段,上界是每表一个 `deadlock_timeout`。这是本改动新增的、有上界的等待,预算是 60 s。
- 同类等待在 main 上已经存在:#6171 加的 ANALYZE,以及各 elearning 文件清理时的 `ALTER TABLE … DISABLE TRIGGER`。【实测】修前臂的整步运行里,`ALTER TABLE elearning_scope_revision_rules DISABLE TRIGGER` 就等了一个 autovacuum worker 至少 0.8 s。
- 用例超时后的孤儿事务:它本来就持有 `RowExclusiveLock`,多出的这把锁只多挡上表所列的同级请求,而测试里没有这类请求。

## 5. 未覆盖 / 局限

- **没有在 PostgreSQL 14 上跑**。CI 是 14.24,本次全部读数来自 16.15;绝对耗时不可跨机比较。
- **没有确定性的回归守卫**。测试自己不制造危险态;去掉这行 ANALYZE 后,非危险态下用例仍是快的(§3.2),所以多数 CI 执行看不出它被删掉。#6171 也是同样的性质。
- **只覆盖夹具批量写入的两张表**。被测代码自己写入的 `elearning_assignments` / `elearning_assignment_members` 不在其中;这两张表也处于危险态时,修后臂为 709 ms 与 2029 ms(§3.1)。
- 天然危险态在 CI 上的发生率没有测;本机整步运行里修前臂 2 次撞上 1 次,样本太小,不代表比例。
- autovacuum 相撞的 2093 ms 是人为构造的最坏情形(worker 被限速),不是 CI 上的观测值。
- 没有跑整个 `test` job,只跑了这一步的 41 个文件。
