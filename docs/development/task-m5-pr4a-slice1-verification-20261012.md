# 任务功能 M5 PR-4a 切片 1（G1）验证记录（2026-10-12）

- 设计：Draft #6332，分支 `claude/tasks-m5-pr4a`，head `7f1c4c536f`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`（冻结稿 v4 及其后两次文档修订）。本切片按其 §1.3 切片 1、§3.1、§4.1、§4.3、§4.4、§5、§6.2 的 G1 行与 §7.1 的 `[a-01]`–`[a-05]`、`[a-24]`、`[a-37]` 实现。锁：`docs/development/task-feature-design-lock-20260917.md`（main 版）。
- 裁定只按日期与条目号引用：owner 2026-10-09 六项之第 3 项（G1 是 PR-4a 的第一片，先于重复任务的派生；只限创建人；任务已完成时再完成是空操作，不写第二条事件）；owner 2026-10-10（M5 从 PR-4a 的冻结开始，只起 Draft，不合并，不对任何环境应用 DDL）。
- 分支：`claude/tasks-m5-pr4a-s1`，从 `origin/main` `906840c74c` 开出。两个提交：代码与测试一个，本记录一个。不推送、不开 PR、不合并；本切片没有迁移、没有 DDL、没有新开关，也不打开任何 `TASKS_*` 开关。
- 本地环境：Node 25.9.0（CI 与另一台机器是 Node 20），`node_modules` 是指向主检出的符号链接，没有 `pnpm install`。真库在另一台机器上跑：PostgreSQL 16.15，Node 20.20.2，那里用的都是一次性的工作树与库，用完即删（§5 末行）。变异驱动、同步脚本与临时 tsconfig 都不入库。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `src/tasks/task-completion.ts` | `TaskCompletionEvent` 加可选 `payload`（类型 `TaskCompletionEventPayload`，字符串到字符串的只读记录）；新增纯函数 `applyCompleteForAll` |
| `src/tasks/task-access.ts` | 新增纯谓词 `canCompleteForAll({ actorId, createdBy })`，只比较 `actorId === createdBy`，不收角色集 |
| `src/services/task-records.ts` | `writeEvents` 把每个事件的 `payload` 写进 `task_events.payload`（没有就写 `{}`，即列缺省，返回形状仍是 `WrittenTaskEvent[]`）；`completeTask` 收 `scope`，模块私有的 `parseCompleteScope` 在行级判定之后校验它；详情加 `canCompleteForAll` |
| `src/routes/tasks.ts` | complete 路由把请求体里原样的 `scope` 字段交给服务（没有请求体或不是对象时为 `undefined`），路由不校验 |
| `tests/unit/task-completion.test.ts` | `applyCompleteForAll` 10 格 |
| `tests/unit/task-access.test.ts` | `canCompleteForAll` 3 格 |
| `tests/unit/task-records-guards.test.ts` | 服务层判定顺序与写入 6 格（按 SQL 前缀应答的 mock） |
| `tests/unit/tasks-route-errors.test.ts` | 路由交给服务的原样 `scope` 与 422 透传 2 格 |
| `tests/integration/task-m5-g1.db.test.ts`（新） | 真库 13 格：§5 表的 12 个格名（g1-follower 与 g1-outsider 合为一格，另加清单只读者）与 §5 表之外的 g1-signals |
| `tests/integration/task-p0a.db.test.ts` | 详情的整体形状断言加 `canCompleteForAll: false`（§3.8 加键的直接后果，读者是负责人） |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新真库文件的登记（锁 §5.2.1 ①②，④ 由既有的发现式单测核三集合相等） |

## 2. 实现要点（对照冻结设计）

- **判定顺序（§3.1）**：全部在结构锁内：取任务（404）→ 角色集与 `canChangeCompletion(roles, 'complete', n)`（404）→ 解析 `scope`（422 `INVALID_SCOPE`）→ `scope === 'all'` 时 `canCompleteForAll`（404）→ 纯函数 → 写。路由只取原样字段，所以看不见任务的人、能看不能完成的人带非法 `scope` 都得到与任务不存在相同的 404。
- **`scope` 解析（`[a-01]`）**：缺省（字段不存在）为 `'self'`；出现但不是 `'self'` / `'all'` 的值（含 `null`、数字、大小写不同的字符串、数组）一律 422。reopen 的解析不动。
- **`applyCompleteForAll`（§4.1）**：分支顺序为：非创建人抛错 → `wasDone` 为真即空操作（任何模式，含仍有空行的 A6 形）→ `all` 模式且至少一名负责人：所有空行取同一个 `now`，已有时刻保留，至少填了一行时给一条 `completed`，payload `{ scope: 'all' }`（`[a-03]`）→ 其余（`any` 模式、零负责人）原样委托 `applyComplete`（`[a-04]`，结果逐项相同，事件不带 payload）。
- **时刻（`[a-37]`）**：锁内取一次应用时钟 `now`，行、任务的 `completed_at` 与 `completed` 的 `occurred_at` 都用它。
- **详情（`[a-05]`）**：`canCompleteForAll` = `canCompleteForAll(...)` ∧ 任务 open ∧ `all` 模式 ∧ 至少一名负责人；放在详情对象的末尾。
- **`version`（§4.3）**：G1 的翻转 +1，空操作不变。
- **事件与入队（§4.4）**：`completed` 已在可通知闭集里，照 PR-3b 的写法同事务入队；闭集不改。
- **PR-3c 普查**：没有新的待办输入写入函数（复用 `writeChangedAssignees` 与 `writeTaskDoneState`）；`completeTask` 仍在自己的函数体里 `note`、事务后顶层 `publish` 一次；没有新的 `catch` / `finally`。`tests/unit/task-counts-touchpoints.test.ts` 不改，62/62 绿。
- **范围**：只做切片 1。没有迁移、`TASK_ID_PREFIXES`、锁序包装器、§4.7 的 builder、`[own-3b-17]` 注释改写（都归切片 2–4）。

## 3. 偏离与本件的取法

1. **基点（偏离 §1.3 的开工前提）**：§1.3 写 PR-4a 从当时的 main 起并叠上 #6249。本分支照本次任务说明只从 `origin/main` 开出，没有叠 #6249。切片 1 不调用 #6249 的任何导出（§1.3 表里切片 1 的依赖为「无」），所以本切片的行为与验证都不受影响；切片 2 起要叠上 #6249。
2. **g1-concurrent 在服务层并发**：§5 的这一格要两个连接同时以 `scope: 'all'` 完成同一个任务。本格在测试进程里直接调用 `completeTask` 两次（各占一条池连接），不经 HTTP；交错照 §6.2 开头的持锁法由第三条连接在 `task_assignees` 上持 `SHARE` 锁强制，按 `pg_stat_activity` 等到两个后端都在等锁再释放。经 HTTP 的完成路径由其余各格覆盖。
3. **「逐行取时」变异的两种写法**：§5 说把同一个 `now` 换成逐行取时 ⇒ g1-creator-all 红。纯函数里逐行 `new Date()` 的写法（M05a）在真库里几乎总落在同一毫秒，g1-creator-all 抓不到它（两轮变异里该格都没有变红），由单测格「every stamped row carries the now argument」等 4 格杀死（该格用假时钟把系统时间放在别处）。逐行取库时钟的写法（M05b，`clock_timestamp()`）让 g1-creator-all、g1-keep-first、g1-concurrent 变红。§5 那句只对后一种写法成立。
4. **§5 表之外加的格**：真库 g1-signals（G1 的 `completed` 经 PR-3b 入队给除创建人之外的每个成员各一行，每名负责人提交后各收一条红点信号，重复调用不入队、不发信号；对应 §1.3 切片 1 的回归行 `M4|24` 与 `M4|26`）；g1-follower / g1-outsider 一格里另加清单只读者；四个单测文件的 21 格。
5. **既有测试的改动**：只有一处：`task-p0a.db.test.ts` 的详情整体形状断言加了一键 `canCompleteForAll: false`（§3.8 加键的直接后果）。其余既有格的期望值都没有改；四个单测文件只是追加格。
6. **只在真的填了行时写 `completed`**：§4.1 对 `all` 模式的说法是把空行都填上、写一条 `completed`，没有说没有空行可填时怎样。本件取至少填了一行才写，与 `applyComplete` 一致（没有改动就没有事件），也与 §5 的说明一致（去掉 `wasDone` 分支后 g1-repeat 不会多写，M03 实测如此）。由此带来的一个边角：一个 open、`all` 模式、每一行都已有时刻的任务（经接口到不了：最后一行盖上时任务就翻为 done，删掉最后一个未完成的负责人也会翻转），创建人的 `scope: 'all'` 会把它翻为 done 而不写事件；缺省的完成在同一状态下今天也是这样。列为一个待确认的问题（汇报里另列）。

## 4. 本地（RAN）

下表各项都在 `23a220f288`（第一个提交，工作树与它相同）上跑过：开发中先跑过的几项（临时 tsconfig 的类型检查、ops、flag manifest、门 17 ①）在提交之后重跑了一遍，表中是重跑的结果；门 7、15、20 的扫描只读源文件，源文件在最后一次测试改动之前就已定稿。命令在 `packages/core-backend` 下（ops 在仓库根）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `tsc --noEmit -p .` | 0 errors |
| 新改测试文件的类型 | 临时 tsconfig（`extends` 本包配置，加 `noUnusedLocals`，`include` 本切片改动的 6 个测试文件），不入库 | 本切片新增与改动的行 0 条诊断；另有 85 条都在既有测试的旧行里，或在经导入进入这次编译、本切片没有改的文件里 |
| 任务单测子集 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts` | 38 files / 1599 passed。同一命令在 `906840c74c` 上是 38 / 1578；多出的 21 格：completion 10、access 3、records-guards 6、route-errors 2 |
| PR-3c 普查 | 上一行里的 `task-counts-touchpoints.test.ts` | 62/62，文件未改 |
| 门 17 ④ | 上一行里的 `task-ci-coverage-enumeration.test.ts` | 4/4：磁盘、`test.exclude`、lane 三个集合相等，都含新文件 |
| supertest 绊线 | `vitest run --config vitest.config.ts tests/unit/supertest-app-mode-tripwire.test.ts` | 3/3（本切片新增的路由格用的是 `usePinnedServer()` 与 `request(pinned.url())`） |
| 门 17 ① | `vitest run --config vitest.config.ts tests/integration/task-m5-g1.db.test.ts` | `No test files found`，exit 1，不是 skipped |
| 全量单测 | `vitest run --config vitest.config.ts`，不给 `DATABASE_URL` | 1307 files：4 failed / 1131 passed / 172 skipped；22184 格：43 failed / 20399 passed / 1742 skipped。红的 4 个文件是 `multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup`（PR-3c 验证记录 §3 记过的本机环境失败），与本切片改动的文件没有导入关系；它们在另一台机器上与 main 对照的结果见 §5。这是第二遍：第一遍时本工作树只链接了几个 `node_modules`，另有 50 个文件在收集时就失败（`Cannot find module` `zod` / `pg`，都来自插件目录），把其余 `node_modules` 也链接上之后重跑整套得到上面的数 |
| ops | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs scripts/ops/staging-tasks-smoke.test.mjs` | 194/194 |
| flag manifest | `verify:global-history-flag-manifest:test` 的三个文件 | 109/109（本切片没有新开关） |
| 门 7 | 本切片新增的生产行里的 `pg_advisory_xact_lock` | 0 处；三个登记导出未动 |
| 门 15 | 本切片新增的 53 行生产注释，记号表同 PR-3c 验证记录 §6 | 0 命中 |
| 门 20 静态 | `src/tasks` 21 个文件；(A)(B) 两条 grep；持池 ERE | (A)(B) 0 命中；持池 ERE 恰三行（`connection-pool.ts:76`、`PostgresAdapter.ts:81`、`sharded-pool-manager.ts:191`）；行为 harness `task-pure-no-io` 在上面的子集里 5/5（自动覆盖两个新纯函数） |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录与两个提交说明 | 都 exit 0。另对本切片改动的源文件与测试文件跑过：两个字面扫描器 exit 0；引号扫描器报 1 处，在 `src/tasks/task-completion.ts` 第 66 行，是 main 上既有的一行注释（main 第 55 行），本切片没有改它 |

## 5. 另一台机器（PostgreSQL 16.15，RAN）

两个一次性工作树（另有一个只跑单测的 main 对照工作树，见第 3 条），各配一个从空库全量迁移的一次性库（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项，各 432 条 executed successfully，最后一条是 main 当时最晚的迁移）；环境变量照 `tasks-realdb.yml`（`EXPECT_DB=1`、`TASKS_ENABLED=true`、同一个 `JWT_SECRET`）。

1. **开发工作树**：`906840c74c` 加上本地工作树的改动（逐文件复制过去）。用于开发轮与 §6 的变异。真库文件 `task-m5-g1.db.test.ts` 的开发轮：第一遍 11/13，两格因测试里 t0 换算成微秒的常数写错而红（测试自身的错，改正后不再出现）；修 §6 所述的事件排序之后，连跑 6 遍，每遍 13/13。变异整批结束时四个源文件的 md5 与本地 `23a220f288` 相同（§6）。
2. **最终工作树**：`23a220f288` 本身（推到那台机器的克隆里，在它上面建分离的工作树），新建库，lane 脚本读该工作树的 `tasks-realdb.yml`，22 个文件整体跑 3 遍，再跑鉴权门：

| 运行 | 结果 |
|---|---|
| lane 第 1 遍 | 22 files / 829 passed (829) |
| lane 第 2 遍 | 22 files / 829 passed (829) |
| lane 第 3 遍 | 22 files / 829 passed (829) |
| 鉴权门（`vitest.tasks-auth.config.ts`，`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`） | 1 file / 86 passed (86) |

三遍的日志里 `socket hang up` / `ECONNRESET` 均为 0。门 17 ②：新文件的静态展开数 13（13 个普通 `it`，没有 `.each`），三遍的收集并通过数都是 13；其余 21 个文件本切片没有增删格（`task-p0a` 只改了一格里的一个期望值）。第 1 遍逐文件的通过数（去掉 verbose 输出里重复打印的 5 行，scheduler 文件有 5 格各打印两次）：

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
| `task-m4-dates` | 107 | `task-m5-g1`（新） | 13 |
| | | 合计 | 829 |

3. **最终工作树上的单测**（不给库）与 **main 对照**：任务单测子集加 supertest 绊线是 39 files，1601 passed / 1 failed。红的是 `tasks-auth-ci-wiring` 的 runs the pre-install wiring contract：它在子进程里跑 ops 的 wiring 测试，其中一格要起 Python 解析 YAML，那台机器上起 `python3` 失败（EPIPE）。为此在那台机器上另建了 `906840c74c` 的对照工作树：同一格同样红（1 failed / 1 passed），所以与本切片无关；本地这一格是绿的（§4 的 38 / 1599）。`tasks-route-errors` 在这一遍里是绿的（§6 M12 那次钩子超时因此不计）。multitable-recovery 四个文件在那台机器上也是 4 failed、43 格红，对照工作树上完全相同。门 17 ① 在那里同样报 `No test files found`（exit 1）。

用完之后三个工作树（开发、最终、对照）、两个库与那台机器上本次的临时文件都已删除，删除后核对过：工作树列表、库列表与临时目录里都不再有本次的条目。推过去的两个引用（main 与第一个提交）留在那台机器的克隆里，没有删。

## 6. 变异（RAN，另一台机器）

做法：驱动脚本（不入库）在另一台机器的一次性工作树里逐个执行：断言 needle 在文件里恰出现一次 → 备份 → 写入变异并确认字节已变 → 跑单测 6 个文件（`task-completion`、`task-access`、`task-records-guards`、`tasks-route-errors`、`task-counts-touchpoints`、`task-pure-no-io`）与真库文件 `task-m5-g1.db.test.ts`（JSON reporter）→ 从备份复制回去并核对 md5 与字节都相同。顺序执行，不与别的测试并发；没有用 `git checkout` / `reset` / `stash` / `clean`。整批前后四个被变异的源文件的 md5 相同，且与本地 `23a220f288` 的同名文件相同（`task-records.ts` `9c8cbc8e…`、`task-completion.ts` `f90b4de5…`、`task-access.ts` `86df48e7…`、`routes/tasks.ts` `9822edfc…`）。

**15 个变异全部至少被一格杀死，15 次还原全部逐字节相同。** 下表是第二轮。第一轮里 g1-self-unchanged 在与它无关的几个变异下也红过：该格自己不稳，同一次写入的两条事件（加人与随之的重启）时刻相同、原来按随机的事件 id 排序，两个孪生任务的顺序会不同；改为同一时刻内按事件类型排序后，未变异的该文件在另一台机器上连跑 6 遍都是 13/13，整批重跑。第一轮的 M14 因 needle 同时命中 reopen 路由（出现两次）被驱动跳过，第二轮改用只在 complete 路由出现的 needle。

| # | 出处 | 文件 | 变异 | 单测红 | 真库红（行为） | 说明 |
|---|---|---|---|---|---|---|
| M01 | §5 | records | 去掉 `completeTask` 里的 `canCompleteForAll` 判定 | 1 | g1-assignee、g1-list-editor | 请求到达纯函数，对非创建人抛错，得 500 而不是 404 |
| M02 | §5 | records | 把它换成 `can(roles, 'edit')` | 1 | g1-assignee、g1-list-editor | 同上 |
| M03 | §5 | completion | 去掉 `applyCompleteForAll` 的 `wasDone` 空操作分支 | 2 | g1-repeat-null-row | g1-repeat 保持绿，与 §5 的说明一致 |
| M04 | §5 | records | 去掉 `withOrgStructure` 里的取结构锁 | 6 | g1-concurrent | 单测红的 6 格是既有格（断言第二句是取锁） |
| M05a | §5（纯函数形） | completion | 填空行时逐行 `new Date()` | 4 | 无 | 见 §3 第 3 条：真库里同一毫秒，抓不到；由单测杀死 |
| M05b | §5（SQL 形） | records | 写负责人行时每行取 `clock_timestamp()` | 0 | g1-creator-all、g1-keep-first、g1-concurrent | |
| M06 | 本件 | records | 在角色判定之前解析 `scope` | 2 | g1-bad-scope | 关注人、局外人带非法 `scope` 得 422 |
| M07 | 本件 | records | `writeEvents` 丢掉 payload | 1 | g1-creator-all、g1-keep-first | |
| M08 | 本件 | completion | 已有时刻的行也重新盖 | 2 | g1-keep-first | |
| M09 | 本件 | records | 详情的 `canCompleteForAll` 不看状态 | 0 | g1-detail | |
| M10 | 本件 | records | 详情的 `canCompleteForAll` 改用 `edit` 能力 | 0 | g1-detail | |
| M11 | 本件 | completion | `any` 模式也走填满分支 | 1 | g1-any / g1-zero | |
| M12 | 本件 | completion | 零负责人也走填满分支 | 1 | g1-any / g1-zero | 单测另有 1 格红：`tasks-route-errors` 的一个钩子超时 15 s，该文件 mock 了服务、与此变异无关，是另一台机器已知的本机回环 HTTP 不稳；未变异时该文件在那里通过（§5），不计为杀死 |
| M13 | 本件 | routes | 路由在调用服务之前校验 `scope` | 1 | g1-bad-scope | 局外人带非法 `scope` 得 422 |
| M14 | 本件 | routes | 路由不把 `scope` 交给服务 | 1 | 8 格（g1-creator-all 起） | |

文件简称：records = `src/services/task-records.ts`，completion = `src/tasks/task-completion.ts`，routes = `src/routes/tasks.ts`。

## 7. 回归行（§1.3 切片 1）

§1.3 给切片 1 列的回归是 `M2|3`、`M3|3`、`M4|24|整门`、`M4|26|整门`。它们的承载都在 §5 的 lane 与 §4 的任务单测子集里，三遍 lane 各自全绿：

| 行 | 承载 | 本次运行 | 结果 |
|---|---|---|---|
| `M2\|3\|存活六格` | `task-completion-grid` 6 格（直接调用 `completeTask`，不带 `scope`，即缺省路径） | lane ×3 | 6/6 ×3 |
| `M3\|3\|增删人切模式` | `task-m3-membership` 的门 3 与切模式两组（该文件 45 格） | lane ×3 | 45/45 ×3 |
| `M4\|24\|整门` | 纯函数网格在 `task-notifications` 单测；真库格在 `task-m4-outbox`（21 格） | 单测子集；lane ×3 | 绿；21/21 ×3 |
| `M4\|26\|整门` | `task-m4-realtime`（21 格）；`task-counts-realtime` 与 `task-counts-touchpoints` 单测 | lane ×3；单测子集 | 21/21 ×3；绿 |

G1 路径本身在这两道门上的表现另由真库格 g1-signals 看过（§3 第 4 条）。lane 里其余 `M2|`、`M3|`、`M4|` 的真库承载也随之跑过（§5 的逐文件表）；文件内的负控照常执行，以往记录里的手工负控本次没有重做（§8）。

## 8. NOT RUN

- CI：没有推送，`tasks-realdb`、`plugin-tests` 的 `test (20.x)` 等都没有在 GitHub 上跑过。门 17 ② 要求在 lane 绿后从 CI 的 verbose 日志读出收集数；本次只在另一台机器上读过（§5），CI 那一半 NOT RUN。
- PR 正文：没有开 PR。门 14 的正文一半不适用于本切片（没有 DDL），其余正文要求（门 17 的展开计数等）待开 PR 时写。
- 鉴权门的 M5 子集（门 1 / 2 / 13 / 17 / 20 的 M5-g 行，含字段第二租户）：归切片 6，本切片没有写这些格。既有的鉴权门作为回归在另一台机器上跑过（§5）。
- 候选行计分：G1 的格是候选格（`[a-24]` 的门 3 子集行），要等锁修订写进 `arm-set` 才计分；本记录不声称任何门「通过」。
- 与 #6249 叠在一起的树、PR-4a 最终 head 上全部 `M2|` / `M3|` / `M4|` 行的重跑（§6.4）：本分支没有叠 #6249，也只有切片 1，这两项 NOT RUN。
- 既有门行的手工负控（以往验证记录里「手工，本次」的那些）：本次没有重做；文件内的负控随 §5 的 lane 跑过。
- 前端：本切片不改 `apps/web`，前端 spec 没有跑。
