# 任务功能 M5 PR-4a 切片 2（迁移、id 前缀、锁序包装器）验证记录（2026-10-12）

- 设计：分支 `claude/tasks-m5-pr4a`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`（冻结稿 v4 及其后两次文档修订）。本切片按其 §1.3 切片 2、§1.1 第 2、8、9 项、§2 全节、§4.1 的 `task-ids.ts` / `task-projection.ts` / `task-advisory-locks.ts` / `task-records.ts` / `task-scheduler.ts` 五行、§4.2、§6.1 的 `M5|7|锁序控件` 与 §6.3 的形状格实现。锁：`docs/development/task-feature-design-lock-20260917.md`（main 版）。
- 裁定只按日期与条目号引用：owner 2026-10-12（从切片 2 起继续实现 PR-4a，叠在 #6249 上，每片单独过闸，只开 Draft，未裁的问题取设计缺省，不合并，不对任何环境应用 DDL）；owner 2026-10-09（M5 受控叠放起草，合并按依赖串行）；S09（锁序包装器）、S30（两个 id 前缀与附件表随本迁移）及 §2 各处引用的 S 编号。本文自选的取舍按设计 §7.1 的 `[a-NN]` 缺省执行。
- 分支：`claude/tasks-m5-pr4a-s2`，起点 `0edb426c55`（PR-4a 设计 + 切片 1 + #6249 叠放）。四个提交加本次记录更新：代码与测试 `970d23444d`、本记录 `74a04a3464`、记录更正 `a5b442b848`、闸审第 1 轮修复 `f03391f105`，以及本记录的第 1 轮更新（§11）。不推送、不开 PR、不合并；迁移是 Draft，没有对任何共享环境应用；没有新开关，也不打开任何 `TASKS_*` 开关。
- 本地环境：Node 25.9.0，`node_modules` 是指向主检出的符号链接，没有 `pnpm install`。真库在另一台机器上跑：PostgreSQL 16.15，Node 20；那里用的都是一次性的工作树与库，用完即删（§5 末段）。变异驱动、同步脚本与临时 tsconfig 都不入库。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `src/db/migrations/zzzz20261012150000_create_task_m5_tables.ts`（新） | 设计 §2 的全部 DDL：`tasks` 四列、八条带名约束、两个索引；`task_comments_id_task_id_key`；七张表（每条 CHECK、外键、唯一约束都按 §2 的名字）与索引；触发器函数 `task_attachment_enqueue_purge_on_delete()` 与触发器 `task_attachment_purge_on_delete`。`up()` 按 §2.11 的 ①–⑩，`down()` 是严格逆序、全部 `IF EXISTS`，① 里先删两个索引、再按名逆序删八条约束、再删四列 |
| `src/tasks/task-ids.ts` | `TASK_ID_PREFIXES` 加 `field: 'tfld'`、`attachment: 'tatt'`（S30）；格式注释随之更新 |
| `src/tasks/task-projection.ts` | 自定义字段键的正则改为从 `TASK_ID_PREFIXES.field` 派生（§1.1 第 8 项），去掉原来写死 `tfld_` 的那条注释 |
| `src/db/task-advisory-locks.ts` | 在三个 helper 之后追加锁序包装器：`TASK_LOCK_RANKS`（structure 1、fence 2、projection 3）、`TaskLockOrderViolation`、`withTaskLockOrder(query)`（方法 `structure` / `projection` / `schedulerLeader`）与只供测试的记录钩子 `setTaskLockOrderRecorderForTests`。三个 helper 的函数体逐字节未改（相对起点的 diff 没有删除行） |
| `src/services/task-records.ts` | `withOrgStructure` 与 `createTask` 的取结构锁改经 `withTaskLockOrder(...).structure(orgId)`；导入只剩包装器与查询类型 |
| `src/services/task-scheduler.ts` | leader 锁的取锁一行改经 `withTaskLockOrder(...).schedulerLeader()`；头注改写那一句；`catch` 与 follower 判定不动 |
| `tests/integration/task-m5-schema.db.test.ts`（新） | 真库 53 格（`970d23444d` 时 50 格，第 1 轮加 3 格，§11）：目录形状钉（列、约束、索引、触发器逐项相等）、外键动作、映射表无外键无 org、触发器函数体、`pg_catalog` 依赖（含正控）、每条带名约束一正一反、§6.3 点名的各格、`down()` 后再 `up()`（同一连接同一事务内，比对快照后回滚）、`M5|7` 的真实路径格 |
| `tests/unit/task-lock-order.test.ts`（新） | 单测 18 格（`970d23444d` 时 15 格，第 1 轮加 3 格，§11）：包装器 13 格（含反序格、leader 共存两格、错误原样透传且不记录、记录在 helper 返回之后、同一实例上并发的两格、失败的请求仍计入），静态格 5 格（含正控） |
| `tests/unit/task-ids.test.ts` | 闭集格改为八种；新增 `field`、`attachment` 两格 |
| `tests/integration/task-m4-schema.db.test.ts` | `down()`→`up()` 那一格在同一事务里先 `m5Down`、后 `m4Down`，`m4Up` 之后再 `m5Up`（见 §3 第 3 条） |
| `tests/integration/task-m3-comments-deletion.db.test.ts` | `task_comments` 约束名的整体钉加一项 `task_comments_id_task_id_key`（见 §3 第 3 条） |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新真库文件的登记（锁 §5.2.1 ①②，④ 由既有的发现式单测核三集合相等） |

## 2. 实现要点（对照冻结设计）

- **迁移（§2）**：列、类型、缺省、约束名与表达式逐条照 §2.2–§2.9；CHECK 与触发器函数体里的函数都写 `pg_catalog.<名>`；不写任何行、不碰 `permissions`；不 `CREATE OR REPLACE`。两条系列外键 `NO ACTION`，绑定指向字段的外键 `RESTRICT`（`[a-08]`），附件指向评论的外键 `NO ACTION`（`[a-07]`），其余指向任务、清单、字段的外键 `CASCADE`。形状格里的期望值是照设计手写的，第一次在真库上跑就逐项相等，没有按库的输出回填。
- **包装器（§4.2，S09，`[a-36]`）**：每次 `withTaskLockOrder(query)` 建一个实例，记录本实例已放行的取锁请求（第 1 轮起：请求在放行时即计入，早于其语句发出；helper 失败的请求仍计入，§11）。取 rank 锁时，若已放行 leader，或 rank 低于已放行的最高 rank，抛 `TaskLockOrderViolation`；取 leader 时，若已放行任一 rank 锁，抛同一错误。判定在调用 helper 之前，所以违反时不发任何语句。helper 抛出的错误不经 `catch`，原样到达调用方，且不记录；包装器自己不发任何语句。整个包装器没有 `catch`、`finally`、`.then` / `.catch`，守 PR-3c 的规则 ③（普查单测 `task-counts-touchpoints` 绿，§4）。
- **生产路径**：取结构锁的两处与取 leader 锁的一处都改经包装器；三个 helper 在 `src/` 里除包装器之外没有任何引用（静态格钉住，§4）。门 7 的多重集不变：任务域扫描根里取锁字面量仍恰是三个登记导出各一处。
- **记录钩子**：模块级、默认 `null`；测试装上后每取到一把锁回调一次（实例号、锁名）。真实路径格每次只跑一个操作，并在操作前重装钩子，所以每个操作的序列单独断言，不会被别的操作的序列遮住。
- **`version`、事件、待办输入**：本切片不写任何业务行，不改任何写入点的事件或待办输入；PR-3c 普查的登记不变。

## 3. 偏离与本件的取法

1. **迁移文件名**：§2.1 的缺省名是 `zzzz20261011090000_create_task_m5_tables.ts`；本件按任务说明取 `zzzz20261012150000_create_task_m5_tables.ts`。两者都排在 `origin/main` 当时最晚的迁移 `zzzz20261010124500` 之后；`[a-23]` 本来就规定合并前按 PR-3a §2.1 重核、必要时改名。只是名字不同，形状不变。
2. **`M5|7` 真实路径格的承载文件**：§6.3 列的真库文件里没有专给锁序控件的一个；本件把真实路径格（与真库里的反序格、leader 共存格）放在 `task-m5-schema.db.test.ts`（`tasks-realdb` lane，§4.2 规定的 lane），包装器的单元格与静态格放在新单测 `task-lock-order.test.ts`。没有新增第六个真库文件。切片 4 首次武装时若要挪到 `task-m5-dependencies.db.test.ts`，挪的是格，不改断言。
3. **既有测试的两处改动**（迁移的直接后果，期望值以外不改）：
   - `task-m4-schema` 的 `down()`→`up()` 格：M5 的 `task_list_field_bindings_list_fk` 依赖 `task_lists`，M5 的组合外键与系列外键依赖 `tasks_id_org_id_key`，M4 的 `down()` 在 M5 已应用时删不掉它们；所以同一回滚事务里先 `m5Down` 再 `m4Down`，`m4Up` 之后再 `m5Up`。M4 的快照只取 M4 的表与 `tasks` 上 M4 的列、约束、索引，M5 的存在不改变它的期望值。
   - `task-m3-comments-deletion` 的 `task_comments` 约束名整体钉：多了本迁移加的 `task_comments_id_task_id_key`。
4. **包装器的形状由本件定**（设计只给了名字、rank 与规则）：方法名 `structure` / `projection` / `schedulerLeader`；同 rank 再取允许（规则是「rank 递减即抛」）；leader 再取 leader 允许（`[a-36]` 只禁止它与 rank 锁共存）；fence 只在 `TASK_LOCK_RANKS` 里占 rank 2，没有方法，PR-4c 接入时加。错误带 `code: 'TASK_LOCK_ORDER_VIOLATION'`、`held`、`requested`。
5. **`checkTableExists`**：任务说明要求照 M4 迁移的 `checkTableExists` 守卫写；M4 迁移（`zzzz20261009130000`）其实没有这类守卫，设计 §2.11 也没有，`ALTER TABLE tasks ADD COLUMN` 也无法这样守。本件照 M4 的实际写法：`up()` 不加守卫，`down()` 全部 `IF EXISTS`。列为 owner 问题（§9）。
6. **触发器函数体**：§2.1 只要求 `md5` 写成 `pg_catalog.md5`；函数体里的表名 `task_attachment_purge_intents` 与其余迁移一样不带 schema 前缀（PL/pgSQL 在执行时按会话的 `search_path` 解析；pg_restore 先装数据、后建触发器，装数据时它不触发）。
7. **`task-projection.ts` 的一行**：§1.3 切片 2 一行没有单列它，但 §1.1 第 8 项把它与两个前缀写在同一项，§4.1 也把它列在 PR-4a 的改动里，所以随前缀一起做了；`task-projection` 单测与任务 E 的 `'x'` 探针都绿（§4）。

## 4. 本地（RAN）

下表的 type-check、新改测试文件的类型与任务单测子集在提交之后、于 `970d23444d` 上重跑过一遍，表中是重跑的结果（开发中的第一遍早于形状文件里一格字面量的改动）；其余各项只读源文件或不收集形状文件，在那次改动前后结果相同。命令在 `packages/core-backend` 下（ops 在仓库根）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `tsc --noEmit -p .` | 0 errors |
| 新改测试文件的类型 | 临时 tsconfig（`extends` 本包配置，加 `noUnusedLocals`，`include` 本切片新增与改动的 5 个测试文件），不入库 | 本切片新增与改动的行 0 条诊断。共 15 条诊断：`task-lock-order.test.ts` 的 `import.meta` 一条是这份临时配置的 `module` 选项所致；其余 14 条都在 `task-m3-comments-deletion.db.test.ts` 本切片没有改的旧行里（`processID` 与 `import.meta`，第 671–1135 行；本切片只改了该文件第 1203–1204 行的约束名钉） |
| 任务单测子集 + 绊线 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/supertest-app-mode-tripwire.test.ts` | 50 files / 2094 passed。起点 `0edb426c55` 上同一命令是 49 files / 2077（另一台机器上跑的对照，见 §5 第 5 条）；多出的 17 格：`task-lock-order` 15、`task-ids` 2 |
| PR-3c 普查 | 上一行里的 `task-counts-touchpoints.test.ts` | 绿，文件未改 |
| 门 17 ④ | 上一行里的 `task-ci-coverage-enumeration.test.ts` | 绿：磁盘、`test.exclude`、lane 三个集合相等，都含新文件 |
| supertest 绊线 | 上一行里的 `supertest-app-mode-tripwire.test.ts` | 绿（本切片没有路由格） |
| 门 17 ① | `vitest run --config vitest.config.ts tests/integration/task-m5-schema.db.test.ts` | `No test files found`，exit 1，不是 skipped |
| 全量单测 | `vitest run --config vitest.config.ts`，不给 `DATABASE_URL` | 1318 files：4 failed / 1142 passed / 172 skipped；22676 格：43 failed / 20891 passed / 1742 skipped。红的 4 个文件是 `multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`，与切片 1 验证记录 §4 记的本机环境失败是同样的 4 个文件、同样的 43 格，与本切片改动的文件没有导入关系 |
| ops | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs scripts/ops/staging-tasks-smoke.test.mjs` | 194/194 |
| flag manifest | `verify:global-history-flag-manifest:test` 的三个文件 | 109/109（本切片没有新开关） |
| 门 7 | `find` 计数 + ERE `pg_advisory_xact_lock[[:space:]]*\([[:space:]]*hashtext[[:space:]]*\(` 扫四个 M2 根 | 根内文件数：`src/tasks` 29、`src/services/task-*` 15、`src/routes/tasks*` 4、`src/db/task-*` 1；命中恰 3 行，都在 `src/db/task-advisory-locks.ts`，向上最近的导出分别是三个登记 helper，各一次。正控：同一 ERE 在 `src/multitable/approval-record-projection-service.ts` 命中 1 行。`src/multitable/task-*` 仍不存在（PR-4c 起扫） |
| 门 15 | 本切片新增的 101 行生产注释（相对 `0edb426c55` 的 `src` diff 加新迁移文件），记号表同 PR-3c 验证记录 §6 | 0 命中 |
| 门 20 静态 | `src/tasks` 29 个文件；(A)(B) 两条 grep；持池 ERE | (A)(B) 0 命中（exit 1，与文件数一起记）；持池 ERE 恰三行（`connection-pool.ts:76`、`PostgresAdapter.ts:81`、`sharded-pool-manager.ts:191`）；行为 harness `task-pure-no-io` 与 `task-m5-probe` 在上面的子集里绿 |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录与三个提交说明（`970d23444d`、`74a04a3464`、`a5b442b848`；第 1 轮的两个见 §11） | 都 exit 0 |

## 5. 另一台机器（PostgreSQL 16.15，RAN）

三个一次性工作树：开发（起点 `0edb426c55` 加本地改动，逐文件同步，同步后两边文件集的 md5 摘要相同）、最终（`970d23444d` 本身）、对照（`0edb426c55` 本身）。库都是新建的空库，`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项，环境变量照 `tasks-realdb.yml`（`EXPECT_DB=1`、`TASKS_ENABLED=true`、同一个 `JWT_SECRET`）。

1. **迁移**：空库全量迁移 433 条 executed successfully，最后一条是 `zzzz20261012150000_create_task_m5_tables`。
2. **开发工作树上的单文件轮**：形状文件第一遍 49/50：字段名的空白格用了含制表符的值，而 CHECK 是 `btrim(name) <> ''`，只去空格（与 M4 迁移注释里写的一样），是测试自身的错，改成全空格后不再出现；其后形状文件连跑两遍各 50/50，跑完后七张新表与 `tasks` 里本文件的 org 前缀都是 0 行（附件、意图、映射、字段、依赖、绑定、取值逐表计数），说明清理完整、可重复跑。同库上 `task-m4-schema` 59/59、`task-m3-comments-deletion` 33/33、`task-m4-scheduler` 25/25、`task-m3-tree` 25/25。
3. **迁移 down 再 up（用迁移脚本本身，在跑过第 2 条那些文件的开发库上；各文件清理之后 `tasks` 当时为 0 行）**：`tsx src/db/migrate.ts --rollback` ⇒ 本迁移回滚，`--confirm` 报 NOT applied；目录计数从「7 张表、4 列、8 条 `tasks` 约束、3 个点名索引、1 个函数、1 条评论键」降到全 0，M4 的 `tasks_id_org_id_key` 仍在；再 `tsx src/db/migrate.ts` ⇒ 本迁移重新执行，计数回到原值，`--list` 报 Pending 0；之后形状文件 50/50。这一轮做了两遍：第一遍只核了 `--confirm` 与之后的形状文件（目录计数的那条命令因 shell 的写法没有打印出来），第二遍带上述计数。形状文件自己的 `down()`→`up()` 格另在事务内比对了完整快照（§1）。
4. **最终工作树**：新建库，lane 脚本读该工作树的 `tasks-realdb.yml`，23 个文件整体跑 3 遍，再跑鉴权门：

| 运行 | 结果 |
|---|---|
| lane 第 1 遍 | 23 files / 879 passed (879) |
| lane 第 2 遍 | 23 files / 879 passed (879) |
| lane 第 3 遍 | 23 files / 879 passed (879) |
| 鉴权门（`vitest.tasks-auth.config.ts`，`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`） | 1 file / 86 passed (86) |

三遍的日志里 `socket hang up` / `ECONNRESET` 均为 0。门 17 ②：新文件的静态展开数 50（50 个普通 `it`，没有 `.each`），三遍的收集并通过数都是 50；879 = 切片 1 记录的 829 + 50，其余 22 个文件的格数与切片 1 记录逐文件相同。第 1 遍逐文件的通过数（scheduler 文件有 5 格在 verbose 输出里各打印两次，已去重）：

| 文件 | 通过 | 文件 | 通过 |
|---|---|---|---|
| `task-p0a` | 13 | `task-m4-lists` | 66 |
| `task-read-path` | 57 | `task-m4-list-members` | 44 |
| `task-completion-grid` | 6 | `task-m4-list-items` | 25 |
| `task-rbac-trust` | 17 | `task-m4-groups` | 38 |
| `task-m3-tree` | 25 | `task-m4-org-members` | 46 |
| `task-m3-membership` | 45 | `task-m4-outbox` | 21 |
| `task-m3-comments-deletion` | 33 | `task-m4-delivery` | 30 |
| `task-m4-schema` | 59 | `task-m4-scheduler` | 25 |
| `task-m4-list-roles` | 50 | `task-m4-dingtalk` | 11 |
| `task-m4-paging-settings` | 77 | `task-m4-realtime` | 21 |
| `task-m4-dates` | 107 | `task-m5-g1` | 13 |
| `task-m5-schema`（新） | 50 | 合计 | 879 |

门 19 网格：`tsx tests/helpers/gate19-identities.ts <lane 第 3 遍日志> <锁>` ⇒ `gate19: passed identities equal the i-m2 list`。

5. **单测子集在那台机器上**：最终工作树 50 files，2093 passed / 1 failed；对照工作树 49 files，2076 passed / 1 failed。两边红的是同一格：`tasks-auth-ci-wiring` 的 runs the pre-install wiring contract（子进程里起 `python3` 解析 YAML，那台机器上失败，切片 1 记录 §5 第 3 条记过）；本地这一格是绿的（§4）。对照与最终相差 1 个文件、17 格，与 §4 一致。

用完之后三个工作树（开发、最终、对照）、两个库（开发库与最终工作树的 lane 库）与那台机器上本次的临时文件都已删除，删除后核对过：工作树列表、库列表与临时目录里都不再有本次的条目（§10）。推过去的两个引用（起点与第一个提交）留在那台机器的克隆里，没有删。

## 6. 变异（RAN，另一台机器的开发工作树与开发库）

做法：驱动脚本（不入库）逐个执行：断言 needle 在文件里恰出现一次 → 备份 → 写入变异并确认字节已变 → 跑单测 5 个文件（`task-lock-order`、`task-advisory-locks`、`task-counts-touchpoints`、`task-records-guards`、`task-scheduler`，共 212 格）与真库形状文件（50 格，JSON reporter）→ 从备份复制回去并核对 md5 相同。顺序执行，不与别的测试并发；没有用 `git checkout` / `reset` / `stash` / `clean`。MU9 改的是迁移本身，要重新迁移：备份、改写、`--rollback` 后再迁移（应用变异后的 `up()`）、跑形状文件、复制回原文件并核对 md5、再 `--rollback` 与迁移、形状文件 50/50。

**11 个变异全部至少被一格杀死，11 次还原全部逐字节相同。**

| # | 出处 | 文件 | 变异 | 单测红 | 真库红 |
|---|---|---|---|---|---|
| MU1 | §6.1 负控 | locks | 去掉包装器里的 rank 比较 | 反序格 | 真库反序格 |
| MU2 | §6.1 负控 | records | `withOrgStructure` 改回直接调用 `acquireTaskStructureLock` | 静态格 2 格（helper 名在 `src/` 出现、导入集合不符） | 设父格（序列为空） |
| MU3 | §6.1 负控 | locks | 去掉 leader 的独占判断（两半） | leader 共存 2 格 | 真库 leader 共存 2 格 |
| MU3a | 本件 | locks | 只去掉「取 leader 时已持 rank 锁」那一半 | 结构锁在先那一格 | 真库同一格 |
| MU3b | 本件 | locks | 只去掉「取 rank 锁时已持 leader」那一半 | leader 在先那一格 | 真库同一格 |
| MU4 | 本件 | scheduler | 调度 tick 改回直接调用 leader helper | 静态格 2 格 | tick 格（序列为空） |
| MU5 | 本件 | records | `createTask` 改回直接调用 helper | 静态格 2 格 | 建任务格（序列为空） |
| MU6 | 本件 | locks | 先记录、后取 leader 锁 | 「helper 出错不记录」格 | 未跑（单测已杀） |
| MU7 | 本件 | locks | 吞掉 leader helper 的错误（`.catch(() => undefined)`） | 7 格：PR-3c 普查规则 ③、错误原样透传格、`task-scheduler` 的 follower 判定 5 格 | 未跑（单测已杀） |
| MU8 | §2.11 | migration | `down()` 不删 `task_comments_id_task_id_key` | — | `down()`→`up()` 格 |
| MU9 | §2.7 `[a-07]` | migration | 附件指向评论的外键改 `ON DELETE CASCADE` | — | 4 格：约束集合钉、外键动作格、直接删评论被拒格、`down()`→`up()` 格 |

文件简称：locks = `src/db/task-advisory-locks.ts`，records = `src/services/task-records.ts`，scheduler = `src/services/task-scheduler.ts`，migration = 新迁移文件。MU2、MU4、MU5 的真库红都只落在被改的那个操作的格上，另两个操作的格仍绿，这正是每个操作单独断言的用意。

## 7. 回归行（§1.3 切片 2：全部 `M2|`、`M3|`、`M4|` 行）

本切片改了取结构锁与取 leader 锁的入口（三个 helper 的函数体不改），所以按设计逐行重跑。承载见下；「控件」列只写本次跑过的，以往记录里「手工，本次」的控件本次没有重做的，写「未重做」。

| 行 | 承载 | 本次运行 | 控件 | 结果 |
|---|---|---|---|---|
| `M2\|1\|整门`、`M4\|1\|清单第二租户`、`M4\|1\|新表面` | 鉴权门；`task-rbac-trust`；`task-m4-list-roles` 等清单文件 | 鉴权门；lane ×3 | 文件内的负控随运行跑过；手工控件未重做 | 绿 |
| `M2\|2\|整门`、`M4\|2\|清单路由`、`M4\|2\|新表面` | `task-rbac-trust` 六格；鉴权门 | lane ×3；鉴权门 | 格本身即对照 | 绿 |
| `M2\|3\|存活六格` | `task-completion-grid` | lane ×3 | — | 6/6 ×3 |
| `M3\|3\|增删人切模式` | `task-m3-membership` | lane ×3 | — | 45/45 ×3 |
| `M2\|4\|整门`、`M2\|5\|整门` | `task-read-path`；`task-records-guards`、`task-dates` | lane ×3；单测子集 | 手工控件未重做 | 绿 |
| `M3\|6\|整门` | `task-m3-tree`（含注释掉 `acquireTaskStructureLock` 取锁行的文件内负控，needle 仍按原文匹配） | lane ×3 | 文件内负控照常红→还原 | 25/25 ×3 |
| `M2\|7\|`（四个 M2 根） | 门 7 扫描 | §4 | 正控照常；第四处字面量的手工负控未重做 | 绿：多重集 = 三个登记导出各 1 |
| `M2\|8\|生产路径回退`、`M4\|8\|A支与非法IANA`、`M4\|8\|提醒与每日汇总` | `task-rbac-trust`、`task-read-path`、`task-m4-dates`、`task-m4-scheduler`；单测 `task-dates`、`task-reminders` | lane ×3；单测子集 | 文件内控件随运行跑过 | 绿 |
| `M2\|10\|标题子集` | `task-records-guards`、`task-ids` | 单测子集 | 手工控件未重做 | 绿 |
| `M2\|11\|整门`、`M2\|12\|整门`、`M2\|22\|整门`、`M4\|21\|新表面`、`M4\|22\|新表面`、`M2\|21\|整门`（前端） | `apps/web` 的任务 spec 与门 21 的 D/T/G | NOT RUN | — | 本切片不改 `apps/web` 与前端工作流 |
| `M2\|13\|整门`、`M4\|13\|新表面` | `task-rbac-trust` 的挂载格；鉴权门 | lane ×3；鉴权门 | 手工控件未重做 | 绿 |
| `M2\|14\|整门` | 含 DDL 的 PR 首段声明 | 没有开 PR | — | NOT RUN（PR 正文首段须写「含 DDL，未应用、未合并」，§8） |
| `M2\|15\|整门` | 本切片新增生产注释 | §4 | — | 0 命中 |
| `M2\|16\|整门` | 鉴权门；`tasks-auth-ci-wiring`、ops | 鉴权门；单测子集；ops 194/194 | 手工逐层控件未重做 | 绿 |
| `M2\|17\|①`、`M2\|17\|②`、`M2\|17\|④`、`M4\|17\|新表面` | §4 门 17 ① ④；§5 门 17 ② | 本地；lane ×3 | — | 绿；收集 879 = 展开 879（新文件 50 = 50） |
| `M2\|18\|整门`、`M4\|18\|新表面` | flag manifest 测试 | §4 | 手工控件未重做 | 109/109 |
| `M2\|19\|网格`、`探针①`、`探针②`、`M4\|19\|清单角色` | `task-read-path`、`task-m4-list-roles` 等 | lane ×3；门 19 身份比对 | 文件内探针随运行跑过 | 绿；`gate19: passed identities equal the i-m2 list` |
| `M2\|20\|整门`、`M4\|20\|新表面` | `task-pure-no-io`、`task-m5-probe`；门 20 静态 | 单测子集；§4 | — | 绿 |
| `M4\|23\|整门`、`M4\|24\|整门` | `task-m4-outbox`；单测 `task-notifications` | lane ×3；单测子集 | 文件内控件随运行跑过 | 21/21 ×3；绿 |
| `M4\|25\|整门` | `task-m4-scheduler`（文件内负控按原文匹配 leader helper 的取锁行，helper 未改，仍匹配） | lane ×3 | 文件内负控照常 | 25/25 ×3 |
| `M4\|26\|整门` | `task-m4-realtime`；单测 `task-counts-realtime`、`task-counts-touchpoints` | lane ×3；单测子集 | — | 21/21 ×3；绿 |

## 8. NOT RUN

- CI：没有推送，`tasks-realdb`、`plugin-tests` 等都没有在 GitHub 上跑过；门 17 ② 的 CI 那一半 NOT RUN。
- PR 正文与门 14：没有开 PR。PR 正文首段要写「含 DDL，未应用、未合并」；S37 那一句（任务域表都不在任何 DML 普查的分母里，本切片新建的 7 张表也不在，现有 CI 查不出对它们的直接 DML）由本记录先写在这里，PR 正文开 PR 时照写。
- PostgreSQL 14：`plugin-tests` 仍跑 14，本迁移只在 16 上跑过。迁移里没有用到 15 起才有的语法（设计 §2.2 已避开置空单列的组合外键），但 14 上的实际运行 NOT RUN。
- `M5|7|锁序控件` 正向格里设计点名、本切片还没有路径的部分：依赖增删、派生，以及设父、依赖、派生两两并发（切片 3、4）。fence 步（PR-4c）。
- 候选行与 `M5|10|P2子集`：本切片没有路由，不涉及。
- 前端：本切片不改 `apps/web`，前端 spec 没有跑。
- 既有门行的手工负控（以往验证记录里「手工，本次」的那些）：本次没有重做；文件内的负控随 §5 的 lane 跑过。
- flag manifest 里 `TASKS_ENABLED` 条目的前置迁移说明：本切片没有任何读路径读新列，所以没有改它；读新列的切片（3 起）要把本迁移加进那条前置说明（设计 §4.5）。

## 9. owner 问题与待定

1. **迁移文件名**（`[a-23]`）：本件取 `zzzz20261012150000`，与设计 §2.1 的缺省名不同；合并前照规则重核，二者择一或另改，都只是改名。
2. **`checkTableExists`**：任务说明要求的守卫在 M4 迁移与设计 §2.11 里都不存在，本件照 M4 的实际写法（`up()` 无守卫，`down()` 全 `IF EXISTS`）。若要加守卫，需要先定它对 `ALTER TABLE tasks ADD COLUMN` 与 `ADD CONSTRAINT` 的形状，并改设计 §2.11。
3. **`M5|7` 真实路径格的位置**：现放在 `task-m5-schema.db.test.ts`；切片 4 是留在这里，还是挪到 `task-m5-dependencies.db.test.ts`。
4. 设计里既有的 owner 问题（§7.2、§7.4）本切片没有改动；其中任务 E §7 问题 1 若取 (c) 或 (iii)，会给本迁移的 `tasks` 加列（§7.2 第一条），本切片按现行冻结值建表。

## 10. 清理

另一台机器上：开发、最终、对照三个工作树（node_modules 符号链接先解除）、开发库与最终工作树的 lane 库、本次的临时日志与变异驱动、备份文件都已删除；本地：临时 tsconfig 已删，变异驱动与同步脚本不入库；分支 `claude/tasks-m5-pr4a-s2` 的本地检出保留，其中的 `node_modules` 是符号链接、未提交。

## 11. 闸审第 1 轮修复（`f03391f105`，2026-10-12）

闸审第 1 轮没有确认 P1 / P2；P3 两条、NIT 九条。本轮按「确认项全改、明显正确的 P3 / NIT 改、owner 问题不裁」处理。迁移文件本轮未改（`git diff a5b442b848 f03391f105 -- src/db/migrations` 为空），所以 §5 第 1、3 条的迁移与回滚证据仍然有效。

### 11.1 改了的

| 发现（转述） | 改动 | 承载 |
|---|---|---|
| P3：迁移的闭集 CHECK 与 #6249 纯模块常量之间没有格把二者绑在一起 | 形状文件新增一格：从目录读 `task_fields_type_chk`、`task_attachments_mime_type_chk` / `_status_chk` / `_bind_kind_chk` / `_scan_state_chk` 的取值（按集合比），与 `TASK_FIELD_TYPES`、`TASK_ATTACHMENT_MIME_EXTENSIONS` 的键、`TASK_ATTACHMENT_STATUSES` / `_BIND_KINDS` / `_SCAN_STATES` 相等；`task_attachments_size_chk` 的上界等于 `TASK_ATTACHMENT_LIMITS.maxFileBytes`。迁移不导出常量，文件不动。清除原因与意图状态在纯模块里没有对应常量，只由形状钉守 | 真库 1 格 |
| NIT：两条行内主键没有按名拒绝的格 | `task_attachments_pkey`、`task_attachment_purge_intents_pkey` 各一格：同一 id、不同存储键再插一次，断言 23505 与约束名（存储键不同，避免两条唯一约束谁先触发不确定） | 真库 2 格 |
| NIT：`down()`→`up()` 格对 `tasks` / `task_comments` 只看 M5 的名字 | 同一格里另取两张表的全部列、约束、索引、触发器：`down()` 之后等于「之前减去 M5 的四列、八条约束加评论键、两个索引加评论键」，`up()` 之后等于之前；并核减去的个数正好是这些 | 原格加断言，格数不变 |
| NIT：同一实例上并发的两次取锁可以绕过顺序判定 | 包装器在放行时即把请求计入（早于语句发出），helper 失败的请求仍计入；记录钩子仍在 helper 返回之后调用；仍没有 `catch` / `finally` / `.then`（PR-3c 规则 ③ 普查绿） | 单测 3 格：并发 projection+structure、并发 leader+structure、失败请求仍计入 |
| NIT：静态格漏掉计算键的 `require()` 与非 `.ts` 文件 | 遍历扩到 `.ts` / `.js` / `.cjs` / `.mjs`（`.d.ts` 除外，JS 文件按 JS 解析）；导入集合也收 `require(...)` 与 `import x = require(...)`；无替换的模板字面量与字符串字面量同样计为点名；正控加计算键 `require`、`.js` 文件、`import =` 三种；遍历格加断言 `server.js` 在内 | 静态格数不变，正控扩充 |
| NIT：错误原样透传格是唯一能抓「重新包装但保留 SQLSTATE」的格 | 不改代码，在该格前加一行注释说明，免得以后被当成冗余删掉 | — |
| NIT：记录里的提交数与交叉引用 | 抬头改为列出全部提交；§4 的对照引用改为 §5 第 5 条；§4 文本扫描一行改为三个提交说明（本轮两个见下）；§1 的格数与 §2 的包装器描述随本轮更新 | 本节 |

### 11.2 只转记、不改代码的

- **每次调用建一个实例，`run()` 拿不到它**（P3）：在 `f03391f105` 上不可达（每个生产事务只取一把任务锁，静态格与真实路径格都钉住）。第一个在一个事务里取两把任务锁的切片（切片 4 或 PR-4c）要么把实例传进 `run`，要么按连接共享已放行列表，并加一格「`run()` 内部取第二把锁」。现在改实例模型会与设计 §4.2 的写法和既有的「每实例各自序列」单元格冲突，所以留到那时。
- **同一 rank 内的键序不受约束**（NIT）：PR-4a 每个事务只取一把结构锁，不会出现。PR-4c 在一个事务里取多把 projection 锁时按固定顺序取（如键文本排序），或由包装器拒绝排在已放行键之前的同 rank 键。包装器里加了一行注释说明这一点。
- **`M5|7` 格看不到锁由哪条连接取**（NIT）：事务作用域由 `M3|6` 的门 6 格守（把锁改到池上会让 `task-m3-tree` 红 3 格）；`M3|` 行已是每个切片的必跑回归行（§1.3），保持不变。
- **另一台机器上的计时类红**（NIT）：见 §11.4；处理办法同闸审建议：出现单个计时红时先与 main 对照。闸审自己的复现是 3 遍 lane 里 2 遍全绿，第 3 遍的红在起点上也出现。

### 11.3 本地（RAN，`f03391f105` 的工作树）

| 项 | 结果 |
|---|---|
| type-check（`tsc --noEmit -p .`） | 0 errors |
| 两个改动测试文件的类型（临时 tsconfig，加 `noUnusedLocals`，不入库） | 这两个文件 0 条诊断（其余诊断都在这份临时配置下的既有 `src` 文件里，与本轮无关） |
| 任务单测子集 + 绊线（同 §4 的命令） | 50 files / 2097 passed（= 2094 + 3） |
| PR-3c 普查、门 17 ④、supertest 绊线 | 都在上一行里，绿 |
| 门 17 ①（单测配置下收集形状文件） | `No test files found`，exit 1 |
| 门 7 | 命中仍恰 3 行，都在 `src/db/task-advisory-locks.ts` 的三个登记 helper 里 |
| 门 15 | 本轮新增的 6 行生产注释，§6 的记号表 0 命中 |
| 门 20 静态 | `src/tasks` 本轮未改 |
| 单测变异（工作树内备份→改写→跑→复制回并核 md5 相同） | MF1：把计入挪回 helper 返回之后 ⇒ 新增 3 格红；MF2a：`src/services` 新建一个 `.ts`，用 `require` 与计算键调用 helper ⇒ 导入集合格红；MF2b：`src/` 新建一个 `.js`，解构 `require` 一个 helper ⇒ 点名格与导入集合格红。两个临时文件跑后即删，工作树干净 |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录与本轮两个提交说明，都 exit 0 |

### 11.4 另一台机器（PostgreSQL 16.15，RAN）

两个一次性工作树：`f03391f105`（本轮）与当日 `origin/main` `1dd42d0876`（对照），各用新建的空库；环境变量与排除项同 §5。

| 运行 | 结果 |
|---|---|
| 迁移 | 433 条 executed successfully |
| 本轮 lane 第 1 遍 | 23 files / 881 passed、1 failed（882）：`task-rbac-trust` 的门 13 格，`/api/tasks/context` 的响应体为空（`orgId` 为 `undefined`） |
| 本轮 lane 第 2 遍 | 881 passed、1 failed（882）：`task-m3-comments-deletion` 的 M3-CONC-5/6 一格（计时） |
| 本轮 lane 第 3 遍 | 882 passed（882） |
| 鉴权门 | 86/86 |
| 门 19 | 第 3 遍日志：`gate19: passed identities equal the i-m2 list` |
| 形状文件 | 三遍都是 53/53；882 = 879 + 3 |
| 对照 lane 1 遍 | 21 files / 816 passed（816），鉴权门 86/86 |

两条红的对照：

- **M3-CONC-5/6**：两个文件交替跑 3 轮（本轮、对照各 3 遍），本轮第 3 轮红 1 格（「同一 org 的外人、执行人与不存在的 id 同时得到同样的 404」，用时 1179 ms，上限 1000 ms）；随后只跑该组格交替 6 轮，对照第 3 轮红同一格（1201 ms），本轮 6 轮全绿。与闸审在起点上见到的是同一格同一类（计时上限），本轮的包装器改动不发任何新语句，判为环境。
- **门 13 格**：只读的三个 GET，不经过包装器、不取任务锁。之后单跑 `task-rbac-trust` 交替 8 轮，加上前面 3 轮，本轮与对照各 11 遍全绿，没有复现；日志里 `ECONNRESET` / `socket hang up` 为 0。判为本机回环 HTTP 的偶发（未在对照上复现，如实记录）。

真库变异（本轮工作树与 lane 库；源文件备份→改写→跑形状文件→复制回并核 md5；库状态变异跑后按原名重建约束并核对存在）：

| # | 变异 | 形状文件结果 |
|---|---|---|
| 对照 | 不改 | 53/53 |
| MF3 | `TASK_FIELD_TYPES` 多一个 `'url'`（纯模块漂移、迁移不动） | 红 1 格：闭集与常量相等格 |
| MF4 | lane 库里删掉 `task_attachments_pkey` | 红 4 格，含新加的按名拒绝格 |
| MF4b | lane 库里删掉 `task_attachment_purge_intents_pkey` | 红 4 格，含新加的按名拒绝格 |
| MF5 | `down()` 末尾多删 M2 的 `idx_tsk_due` | 红 1 格：`down()`→`up()` 格（整表断言；原有只看 M5 名字的断言不会红） |
| MF6 | `up()` 末尾多建一个无名索引 `ON tasks (title)` | 红 1 格：同上 |
| 还原后对照 | — | 53/53；两条主键按原名存在 |

用完之后两个工作树、两个库与那台机器上本轮的临时日志都已删除，删除后核对过工作树、库与临时文件都不再有本轮的条目。推过去的两个引用（本轮提交与对照）留在那台机器的克隆里。

### 11.5 本轮提交

- `f03391f105`：代码与测试（包装器、单测、形状文件）。
- 本记录的第 1 轮更新：只改本文件。
