# 任务功能 M5 PR-4a 切片 3（重复任务）验证记录（2026-10-12）

- 设计：分支 `claude/tasks-m5-pr4a`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`（冻结稿 v4 及其后两次文档修订）。本切片按其 §1.3 切片 3、§3.2、§3.8（详情的系列字段与系列删除）、§4.1（`task-recurrence-records.ts`、两处写入 helper、PR-3c 普查的登记与 mock 应答）、§4.4、§4.7、§6.2 候选 M5-a、§6.2.1 第一行、§6.4 门 26 的系列删除格实现。锁：`docs/development/task-feature-design-lock-20260917.md`（main 版）。
- 裁定只按日期与条目号引用：owner 2026-10-12（从切片 2 起继续实现 PR-4a，叠在 #6249 上，每片单独过闸，只开 Draft，未裁的问题取设计缺省，不合并，不对任何环境应用 DDL）；S14–S17、S33、S35（2026-10-09）；R16、R17、N2（2026-10-07）。本文自选的取舍按设计 §7.1 的 `[a-NN]` 缺省执行。
- 分支：`claude/tasks-m5-pr4a-s3`，起点 `5822434947`（切片 1–2 叠在 #6249 上）。提交：任务 E 的合并 `f384e3368b`、代码与单测 `b4b1f18f38`、真库文件 `80f47afe7e`、两次真库发现的修复 `80602b312a` 与 `b51d7f4844`、本记录（`a3be47171a`、`b9cd053dd3`）；闸审第 2 轮（§11）：任务 E 第二个改动的合并 `b4a9e7518e`、修复 `07e468e42a` 与本记录的本轮更新。不推送、不开 PR、不合并；没有新开关，没有新的 `TASKS_*` 读点；迁移仍是切片 2 的 Draft，没有对任何共享环境应用。
- 任务 E 的改动在它自己的分支：`claude/tasks-e-pure-9999`，从 `origin/claude/tasks-e-pure`（`39a2a29be9`，#6249 的远端头）起，两个提交 `10a4813bb0` 与 `d0c80dea1f`（闸审第 2 轮，§11.1），各以一个合并提交带进本切片（§2）。本地同名分支 `claude/tasks-e-pure` 指向远端压缩之前的旧历史，没有用它。
- 本地环境：Node 25.9.0，`node_modules` 是指向主检出的符号链接。真库在另一台机器上跑（PostgreSQL 16.15，Node 20），用的都是一次性工作树与库，用完即删（§6 末段）。变异驱动与临时 tsconfig 都不入库。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `src/routes/tasks-entity.ts`（新） | `registerTaskEntityRoutes`：`PUT /api/tasks/:id/recurrence`（`authenticate` + `rbacGuard('tasks','write')`，缺 org ⇒ 422 `ORG_MISSING`） |
| `src/routes/tasks.ts` | `tasksRouter()` 里一行 `registerTaskEntityRoutes(router)` |
| `src/services/task-recurrence-records.ts`（新） | 设 / 清规则（`setTaskRecurrence`）；系列读：`loadSeries`、`orderSeriesChain`、`occurrenceOrdinal`（沿链计数）、`liveSuccessorId`、`loadTaskSeriesFacts`（删除时判定是否属于系列）、`canonicalRecurrence`。不写任何待办输入，没有 `catch` / `.then` / `.catch` / 会吞错的组合子 |
| `src/services/task-records.ts` | `loadTask` 在既有列之后读 `recurrence`、`recurrence_series_id`、`previous_occurrence_id`、`due_date`（缺列一律 `?? null`）；`writeEvents` 的入参放宽为带可选 `payload` 的事件；写入 helper `spawnNextOccurrenceIfDue`；`completeTask` 调用它；详情加 `recurrence`、`seriesId`、`previousOccurrenceId`、`nextOccurrenceId` |
| `src/services/task-structure.ts` | `removeAssignee`、`switchCompletionMode` 调用 `spawnNextOccurrenceIfDue`；系列删除：只读加行锁的 `lockAndPlanSeriesDelete`、写入 helper `softDeleteSeriesOccurrences`；`deleteTaskById` 先在结构锁内读一次系列列（`loadTaskSeriesFacts`）判是否属于系列，属于则走系列路径，否则执行 M3 单删的原有语句（它们本身不变，但前面多了这一次只读系列列的读，见 §3 第 5 条）；成功体加 `deletedIds` |
| `src/tasks/task-access.ts` | 新 builder `buildTaskSeriesMembersCondition`（含已软删）与 `buildLiveChildrenOfTasksCondition`，都经模块唯一的 org 子句；`[own-3b-17]` 注释改写为两个读者及各自理由 |
| `src/tasks/task-field-access.ts`（新） | 私有 `taskFieldOrgClause` 与 `buildTaskFieldByIdCondition`（偏离 1，§3） |
| `src/services/task-org-members.ts` | 只改头注：调用方清单加上派生 |
| `tests/integration/task-m5-recurrence.db.test.ts`（新） | 真库 67 格（§5；闸审第 2 轮由 47 格扩到 67 格，§11.1） |
| `tests/unit/task-counts-touchpoints.test.ts` | `WRITE_HELPERS` 与写入者集合各加两个 helper；`respondWith` 在 `SELECT 1` 通配之前为三条新读补应答；人口、`TOUCHPOINTS`、`TOUCHPOINT_NAMES`、`WRITER_FILES` 与三条规则不变 |
| `tests/unit/task-records-guards.test.ts` | 通知 producer 那组的 mock 对系列成员读答空（它对每条 `FROM tasks WHERE` 都答同一行，否则删除会被当成系列） |
| `tests/unit/task-access.test.ts`、`tests/unit/task-field-access.test.ts`（新） | 两个新 builder 的钉文、参数与「org 子句恰一次」；字段 builder 的钉文与源文里 org 列只出现在生成器的模板字面量 |
| `tests/tasks-auth/tasks-auth-gate.ts` | 路由人口格加一张 M5 表（一行 `PUT /api/tasks/:id/recurrence`），计数 `[8, 13, 30, 1]`，并做同样的分派绑定（偏离 2） |
| `tests/integration/task-p0a.db.test.ts`、`task-m3-comments-deletion.db.test.ts`、`task-m3-membership.db.test.ts` | 详情的整体钉加四个系列键（都为 `null`）；单删成功体的整体钉加 `deletedIds: [id]`（8 处） |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新真库文件的登记（锁 §5.2.1 ①②；④ 由既有的发现式单测核三集合相等） |

## 2. 任务 E 的一处改动（#6249，设计 §4.1、§7.2）

`planSpawn` 在下一期截止日越过 `9999-12-31` 时返回 `{ ok: false, reason: 'series_ended' }`，不再让 `nextOccurrenceDueDate` 抛 `RangeError`。做法：把步进逻辑移进模块私有的 `stepOccurrenceDueDate`，越界时返回 `null`（按天、按周先用 `civilDayDiff` 比较剩余天数，按月、按年比较年份）；`planSpawn` 用它，`null` ⇒ `series_ended`；`nextOccurrenceDueDate` 仍在 `null` 时抛 `RangeError`，导出集合不变（任务 E 的 `'x'` 探针按导出逐个探，计数不变）。服务层没有任何 `catch`。

单测：`tests/unit/task-recurrence.test.ts` 新增一格，覆盖按天、按周（下一周越界）、按月、按年四种越界，按周同一周内仍能落在 `9999-12-31` 的正格，按天落在 `9999-12-31` 的正格，以及 `nextOccurrenceDueDate` 本身仍抛 `RangeError`。负控：把 `planSpawn` 改回调用 `nextOccurrenceDueDate` ⇒ 这一格红（1 failed / 93 passed），还原后绿。任务 E 的全部 11 个单测文件在 `10a4813bb0` 上 481/481（含门 20 的 `task-pure-no-io`、`task-m5-probe` 与 `task-m5-time-zone`；本节原写的「10 个文件 457/457」漏了 `task-m5-time-zone` 的 24 格，闸审第 2 轮更正并重跑），`tsc --noEmit` 0 错。

这一处只看下一期截止日本身。闸审第 2 轮确认它不够：由它派生的开始日、截止时刻与顺延的提醒仍可能越界，并让翻转 500。第二个改动 `d0c80dea1f` 补上这三处，见 §11.1。

## 3. 偏离与本件的取法

1. **字段 builder 提前到本切片**：§1.3 把 `task-field-access.ts` 放在切片 5，但 §3.2 / §4.7 写明派生要经 `buildTaskFieldByIdCondition` 读出字段定义来判断哪些取值是成员型，派生是它的第一个调用者。本切片只建这一个 builder 与私有 org 子句；`buildTaskFieldsOfOrgCondition` 留给切片 5。
2. **鉴权门**：新路由会让门 1 / 2 / 16 的路由人口格变红，所以本切片在那一格加了 M5 表与分派绑定；新路由的门 1 / 2 逐路由格（缺 org、准入、码）归切片 6（§1.3），本切片没有做。
3. **详情**：只加系列四键。`isMilestone`、`dependencies`、`fieldValues` 归切片 4、5。
4. **设 / 清规则写 `updated_at`**：设计只规定事件时刻取锁后的一次 `clock_timestamp()`；本件让同一次读数也写进 `updated_at`（与 M3 设父写 `updated_at` 的先例一致），`version` 不动（`[a-10]`）。列为 owner 问题（§9）。
5. **系列删除的读与行锁的先后（照设计，不是偏离）**：设计 §3.8 第 1 步先装载系列，第 2 步再按 id 升序对目标与链上更晚、未软删且未完成的各期取有界 `FOR UPDATE`；系列路径照此执行：「结构锁 → 读系列 → 按 id 升序逐行加锁 → 读角色、负责人与子任务 → `planSeriesDelete`」。唯一与第 1 步字面不同的是子任务在行锁之后才读（第 1 步把它放在锁前），这只会更严。完成态与系列列只在结构锁内改，集合在锁内不变（设计同段已写明）；评论写只持 `FOR KEY SHARE`、不改任务行。非系列路径（含读不到行时）执行 M3 单删的原有语句，但它们前面多了一次结构锁内的系列列读（`loadTaskSeriesFacts`），所以 M3「行锁先于一切读」在字面上不再成立；这次读只取系列列，而系列列只在本事务持有的结构锁下改，所以不削弱 M3R2-CONC-1。行锁 helper 的注释已按此改写（§11.1）。另：系列路径按期逐个调用 helper，每次 3 s 上限，所以结构锁持有期间最坏等待是期数 × 3 s，§3.8 第 2 步允许逐行调用，实际期数小。
6. **派生事件的 actor**：`recurrence_spawned` 与新一期的 `created` 记在这次翻转的调用者名下（`planSpawn` 的 `actorId`）：完成的人、G1 的创建人、删负责人或切模式的人。
7. **既有测试的改动**：只改期望值里新增的键（详情四键、删除的 `deletedIds`）与两处 mock 应答，见 §1。

## 4. 本地（RAN）

命令在 `packages/core-backend` 下（ops 在仓库根），都在最终提交 `b51d7f4844` 的内容上跑。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `tsc --noEmit -p .` | 0 errors |
| 本切片新增与改动的测试文件的类型 | 本行原先的结果作废：原来的两份临时配置继承了本包的 `exclude`（含 `**/*.test.ts`），`*.test.ts` 根本不在程序里，「0 条」是空检查。闸审第 2 轮重跑并更正，见 §11.3 | 见 §11.3 |
| 任务单测子集 + 绊线 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/supertest-app-mode-tripwire.test.ts` | 51 files / 2102 passed / 0 failed。比切片 2 多 1 个文件、5 格：`task-recurrence` 1、`task-access` 2、`task-field-access` 2 |
| PR-3c 普查 | 上一行里的 `task-counts-touchpoints.test.ts` | 绿：人口仍是三个服务文件；写入者恰为八个写入点之五加五个 helper；两个新 helper 只被写入点直接调用；规则 ③ 的模块遍历含 `task-recurrence-records.ts`，没有吞错点 |
| 门 17 ④ | 上一行里的 `task-ci-coverage-enumeration.test.ts` | 绿 |
| 门 17 ① | `vitest run --config vitest.config.ts tests/integration/task-m5-recurrence.db.test.ts` | `No test files found`，exit 1，不是 skipped |
| ops | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs scripts/ops/staging-tasks-smoke.test.mjs` | 194/194 |
| 门 7 | ERE `pg_advisory_xact_lock[[:space:]]*\([[:space:]]*hashtext[[:space:]]*\(` 扫 `src/tasks`、`src/services/task-*`、`src/routes/tasks*`、`src/db/task-*` | 恰 3 行：`src/db/task-advisory-locks.ts` 第 17、25、29 行，即三个登记导出各一处（本切片对 `src/db/` 的 diff 为空） |
| 新 `TASKS_*` 读点 | `grep TASKS_` 三个新源文件 | 只有 `tasks-entity.ts` 头注里的一句说明，没有读点 |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录、新真库文件与全部提交说明 | 都 exit 0 |

## 5. 真库文件 `task-m5-recurrence.db.test.ts`（67 格，闸审第 2 轮之后）

静态展开 67：普通 `it` 37 格，`it.each` 三组展开 30 格（三种不派生形状 × 四条翻转路径 12 格，四种日历末端形状 × 四条路径 16 格，`rec-instant-paths` 2 格）。闸审第 2 轮之前是 47 格（31 + 16，日历末端只有 `9999-12-31` 一种形状）。格名以 `rec-` 开头；对照设计：

| 设计条目 | 格 |
|---|---|
| 三个调用点与 G1 各派生恰一期；日期步进、时刻与时区、系列两列、负责人行未完成 | `rec-complete`（截止日加 2 天、开始日同移、时刻与时区照抄、`due_at` 重算、提醒保持 1 小时提前量、清单与关注人照抄、两条事件）、`rec-g1`、`rec-remove-assignee`、`rec-switch-mode`；不翻转不派生：`rec-no-flip` |
| reopen 再完成不派生 | `rec-reopen-again` |
| `until` / `count` 用尽 | `rec-until-end`、`rec-count-end` |
| 不派生但完成照常 200（三种形状 × 三个调用点与 G1） | `rec-no-due`（12 格；前两种形状经 `PATCH` 清日期，即 `[a-27]` 的允许路径） |
| `9999-12-31` ⇒ 200、`series_ended` | `rec-9999`（16 格：截止 9999-12-31；西于 UTC 的全天截止 9999-12-30；开始日晚于截止；提醒晚于截止，各 × 四条路径） |
| 详情 `nextOccurrenceId` | `rec-detail` |
| 系列删除：只动更晚且仍 open 的期 | `rec-delete-later-open`（含最晚存活一期清规则、`recurrence_cleared` 与删除同一时刻）、`rec-delete-not-series` |
| 系列删除：更晚一期的关注人收到 `deleted` 通知行 | `rec-delete-notify` |
| 系列删除与评论写互斥（两种先后） | `rec-delete-comment-first`、`rec-delete-first`、`rec-delete-first-target`（目标本身） |
| 有界行锁 ⇒ 409 `TASK_BUSY` | `rec-delete-busy` |
| 子任务整体拒绝、非创建人 404 | `rec-delete-children`、`rec-delete-non-creator` |
| `[a-15]` 派生的人员 | `rec-people-follower`（含在职关注人正控）、`rec-people-member-many`、`rec-people-member-only`、`rec-people-assignee` |
| `[a-16]` 序号沿链计数 | `rec-ordinal`、`rec-delete-first-deleted`（第一期已软删） |
| S14 无漂移、S16 照抄集合与提醒 | `rec-monthly-anchor`、`rec-subtask-carried`、`rec-remind-policy` |
| `[a-37]` 时刻 | `rec-instant`、`rec-instant-paths`（2 格） |
| 清规则的「最新」 | `rec-clear-latest`、`rec-clear-seeded`、`rec-clear-done-latest` |
| §6.2.1 `PUT /recurrence` 授权格（设、清各一组） | `rec-put-auth`、`rec-put-auth-clear` |
| §3.2 的码与判定顺序、空操作 | `rec-put-codes`、`rec-put-noop` |
| §6.4 门 26 系列删除格与回滚 | `rec-gate26`、`rec-gate26-rollback` |

## 6. 另一台机器（PostgreSQL 16.15，RAN）

三个一次性工作树：开发（`80f47afe7e`，其后两个修复逐文件同步；同步后四个关键文件的 md5 与本地最终提交相同）、最终（`b51d7f4844` 本身）与对照（`5822434947`，只用于 §6 第 4 条的计时格对照）。库都是新建的空库，`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项，环境变量照 `tasks-realdb.yml`。

1. **迁移**：空库全量迁移 433 条 executed successfully。
2. **开发工作树上的单文件轮**：第一遍 46/47：`rec-people-member-many` 的完成得到 500。原因是派生写取值的 `jsonb_to_recordset` 按 `field_id` / `value` 取列，而代码传的是 `fieldId`，任何照抄的取值都会让插入失败、整次完成回滚。修复 `80602b312a` 之后同库连跑两遍各 47/47；跑完后本文件 org 前缀的任务、字段定义、孤立事件与失败触发器都是 0 行。
3. **最终工作树的 lane 第一次（在 `80602b312a` 上）**：24 个文件，1 failed / 928 passed。红的是 `rec-delete-later-open`：同一次系列删除的两期 `deleted` 时刻不同（相差 158 微秒）。原因：`UPDATE … FROM (SELECT clock_timestamp() AS at)` 里的 `clock_timestamp()` 对每个连接行重新求值。这是真缺陷，不是回环 HTTP 的偶发：断言比的是库里两行的时刻。修复 `b51d7f4844` 改为锁后读一次（以文本绑定，保留微秒）再写进每一期。那一次 lane 在第 1 遍之后中止，第 2、3 遍与鉴权门没有在旧提交上跑。
4. **最终工作树（`b51d7f4844`）**：新建库，lane 3 遍，再跑鉴权门：

| 运行 | 结果 |
|---|---|
| lane 第 1 遍 | 24 files / 929 passed (929) |
| lane 第 2 遍 | 24 files：1 failed / 928 passed（见下） |
| lane 第 3 遍 | 24 files / 929 passed (929) |
| 鉴权门（`vitest.tasks-auth.config.ts`，`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`） | 1 file / 86 passed (86) |

三遍里新文件的收集与通过都是 47（门 17 ②：静态展开 47 = 收集 47）；929 = 切片 2 记录 §11 之后的 882 + 47，其余 23 个文件的格数与切片 2 相同。三遍日志里 `socket hang up` / `ECONNRESET` 都是 0。门 19：`tsx tests/helpers/gate19-identities.ts <lane 第 3 遍日志> <锁>` ⇒ `gate19: passed identities equal the i-m2 list`。

第 2 遍红的一格是 `task-m4-scheduler` 的 leader 会话上限格（「扫描超过空闲上限、靠页间心跳保住」的那一半得到 `leader_client_lost`）。这一格按真实时钟比较心跳与服务器的空闲上限；本切片没有改 `task-scheduler.ts`、`src/db/` 任何文件（相对 `5822434947` 的 diff 为空）。对照：同一台机器上，切片 2 的头 `5822434947`（对照工作树，新建库）与本切片最终提交各单独跑这个文件 5 遍，两边都是 5/5、每遍 25/25；两边都没有复现。没有在对照提交上跑整条 lane，所以「计时偶发」是依据「本切片没有碰调度器与取锁文件」与「第 1、3 遍同一格是绿的」作出的判断，不是在对照上观察到同样的红。

## 7. 变异（RAN，另一台机器的开发工作树与开发库）

做法：驱动脚本（不入库）逐个执行：断言 needle 在文件里恰出现一次 → 备份 → 写入变异 → 跑真库文件（JSON reporter）→ 写回备份并核对 md5 相同。顺序执行，不与别的测试并发；没有用 `git checkout` / `reset` / `stash` / `clean`。MU2 另在开发库上删掉 `uq_tsk_previous_occurrence`、跑完再按迁移原文重建。

**17 个变异全部至少被一格杀死，17 次还原全部逐字节相同。**

| # | 出处 | 文件 | 变异 | 红的格 |
|---|---|---|---|---|
| MU1 | §6.2 M5-a 负控 | records | 去掉 `recurrence_spawned` 存在性检查 | `rec-reopen-again`（第二次派生撞唯一索引 ⇒ 500） |
| MU2 | §6.2 M5-a 负控 | records + 库 | 检查与 `uq_tsk_previous_occurrence` 都去掉 | `rec-reopen-again`（派生出第二期） |
| MU3 | §6.2 M5-a 负控 | records | 去掉关注人的在职过滤 | `rec-people-follower` |
| MU4 | §6.2 M5-a 负控 | records | 去掉成员型取值的过滤 | `rec-people-member-many`、`rec-people-member-only` |
| MU5 | §6.2 M5-a 负控 | records | 去掉负责人的在职过滤 | `rec-people-assignee` |
| MU6 | §6.2 M5-a 负控 | records | 序号改按 `created_at` 计数 | `rec-ordinal` |
| MU7 | §6.2 M5-a 负控 | records | 新一期的 `created` 改用 `clock_timestamp()` | `rec-instant` |
| MU8 | §6.2 M5-a 负控 | recurrence | 「最新」把已软删的后继也算上 | `rec-clear-seeded` |
| MU9 | §6.2.1 | recurrence | `can(roles,'edit')` 换成 `'view'` | `rec-put-auth`、`rec-put-auth-clear`（F、LR 得 200）、`rec-put-codes`（F 带坏请求体得 422） |
| MU10 | §6.2.1 | recurrence | 只认直接角色（去掉清单身份） | `rec-put-auth`、`rec-put-auth-clear`（LE 得 404） |
| MU11 | §3.8 第 2 步 | structure | 系列删除不取行锁 | `rec-delete-busy`、`rec-delete-comment-first`、`rec-delete-first` |
| MU12 | §3.8 第 4 步 | structure | 只为目标入队一次 | `rec-delete-notify` |
| MU13 | §3.8 第 5 步 | structure | 只为目标 `note` | `rec-gate26` |
| MU14 | §3.2 | records | `completeTask` 不调用派生 | 27 格（凡经完成造出系列的格） |
| MU15 | §3.2 | structure | `removeAssignee` 不调用派生 | `rec-remove-assignee` |
| MU16 | §3.2 | structure | `switchCompletionMode` 不调用派生 | `rec-switch-mode` |
| MU17 | §3.2 第 2、3 步 | records | 去掉「本期无截止日」与「锚点为空」两步 | `rec-no-due` 全部 12 格（`planSpawn` 抛 `TypeError`，完成 500） |

文件简称：records = `src/services/task-records.ts`，structure = `src/services/task-structure.ts`，recurrence = `src/services/task-recurrence-records.ts`。每个变异都跑整个新文件（47 格），未红的格都是绿的。

## 8. 回归行（§1.3 切片 3）

| 行 | 承载 | 本次运行 | 结果 |
|---|---|---|---|
| `M2\|3\|存活六格` | `task-completion-grid` | lane ×3 | 6/6 ×3 |
| `M3\|3\|增删人切模式` | `task-m3-membership` | lane ×3 | 45/45 ×3 |
| `M3\|6\|整门` | `task-m3-tree`（含按原文匹配取锁函数体的文件内负控） | lane ×3 | 25/25 ×3 |
| `M4\|24\|整门` | `task-m4-outbox`、`task-m4-delivery`、`task-m4-dingtalk`，以及本文件的 `rec-delete-notify` | lane ×3 | outbox 21、delivery 30、dingtalk 11，×3 全绿；`rec-delete-notify` ×3 绿 |
| `M4\|26\|整门` | `task-m4-realtime`，以及本文件的 `rec-gate26` 两格 | lane ×3 | 21/21 ×3；`rec-gate26` 两格 ×3 绿 |
| PR-3c 单测 `task-counts-touchpoints` | §4 | 本地 | 绿 |
| 其余 `M2\|` / `M3\|` / `M4\|` 行 | lane 的其余文件、鉴权门 | lane ×3；鉴权门 | 见 §6 第 4 条 |
| 前端行（`M2\|11`、`M2\|12`、`M2\|21`、`M2\|22`、`M4\|21`、`M4\|22`） | `apps/web` | NOT RUN | 本切片不改 `apps/web`；删除成功体多一个键，前端的判定只看 `id` 与 `deleted`，不受影响（未跑前端测试） |
| `M2\|14\|整门` | PR 首段声明 | 没有开 PR | NOT RUN（PR 正文首段须写「含 DDL，未应用、未合并」） |

## 9. owner 问题与待办

1. **#6249 的改动**：`10a4813bb0` 与 `d0c80dea1f`（`claude/tasks-e-pure-9999`）需要进 #6249 本身（#6249 先于 PR-4a 合入）。本切片以两个合并提交带入，没有推送。
2. **设 / 清规则是否写 `updated_at`**（§3 第 4 条）：本件写；不写的话列表的排序键不随改规则移动。
3. ~~系列删除的读先于行锁~~：闸审第 2 轮指出设计 §3.8 第 1、2 步已经定了「先读系列、再加锁」，这不是待裁问题，撤回（§3 第 5 条已改写）。
4. **候选门 27 的入锁修订**：仍按设计 §7.3 待 owner 点名；本文件的格在那之前不计分。
5. **门 1 / 2 逐路由格**：新路由的逐路由鉴权格归切片 6。

## 10. 清理

另一台机器上本次的工作树（开发、最终）、两个库与临时文件都已删除，以及对照工作树与它的库；删除后核对过：那台机器的工作树列表、库列表与临时目录里都不再有本次的条目。推过去的引用留在那台机器的克隆里。中途有一次推错了引用（推成了本机主检出当时的 HEAD，而不是本切片的提交），在它建出的工作树上起的那次 lane 因为抽取不到文件清单而跑成了全部集成测试；发现后当即停掉，那次的结果全部作废、没有计入本记录，工作树、库与那个推错的引用都删掉了，之后的工作树都按提交号重建并先核对 `git log`。

## 11. 闸审第 2 轮修复（2026-10-12）

闸审第 2 轮确认 P2 三条（其中两条是同一个缺陷：日历末端的判定只看下一期截止日本身）、P3 七条、NIT 六条（含并发视角的一组）。本轮按「确认项全改、明显正确的 P3 / NIT 改、owner 问题不裁」处理。提交：任务 E 分支 `d0c80dea1f`，以合并提交 `b4a9e7518e` 带进本切片；本切片修复 `07e468e42a`；本记录的本轮更新。合并之前核过 `git diff f384e3368b b9cd053dd3` 对 `task-recurrence.ts` 与它的单测为空，第二次合并无冲突。

### 11.1 改了的

| 发现（转述） | 改动 | 承载 |
|---|---|---|
| P2（两条）：下一期截止日不越界时，派生的值仍可能越界，翻转 500 并回滚：西于 UTC 的全天截止 9999-12-30 ⇒ 下一期截止时刻落在 10000 年（数据库拒绝绑定）；开始日晚于截止日（[own-07] 允许）⇒ 顺延的开始日越过 9999-12-31（`addCivilDays` 抛 `RangeError`）；提醒晚于截止（[own-30] 允许）⇒ 顺延的提醒落在 10000 年 | 任务 E `d0c80dea1f`：`planSpawn` 在建行之前依次判三处，任一越界即返回 `series_ended`，不抛错：顺延天数大于开始日到 9999-12-31 的天数；下一期截止时刻的 UTC 年份大于 9999（与 [own-38] 同一谓词）；顺延的提醒的 UTC 年份大于 9999（[own-30] 的上界）。服务层不加判断、不加 `catch`（设计 §3.2 第 4 步、PR-3c 规则 ③）。按缺省提醒策略算出的提醒不晚于截止时刻，受截止时刻的判断约束，不另判：本机一次纯调用核过，截止 9999-12-30，五个时区（UTC、`Pacific/Kiritimati`、`Asia/Shanghai`、`America/New_York`、`Etc/GMT+12`）× 全天 / 00:00 / 23:59，`computeDefaultRemindAt` 的结果都不晚于对应的 `computeDueAt`（有时刻的提前 30 分钟，全天的是当地 18:00）。提醒越界取「结束系列」是本件的 `ASSUMPTION(task-e)`，列为 owner 问题（§11.5 第 1 条） | 单测 1 格（三种越界加四个正控，见 §11.3）；真库 `rec-9999` 由 4 格扩到 16 格（四种形状 × 四条翻转路径） |
| P2：§4 的测试文件类型检查行是空检查 | 重跑并更正，§4 原行作废；新文件里的诊断不改代码（§11.2 第 2 条） | §11.3 |
| P3：没有格钉住 `NOT_CURRENT_OCCURRENCE` 的「仍未完成」那一半 | 新格 `rec-clear-done-latest`：`count` 2 的系列走到底，第二期已完成、保留规则、没有后继；截止 9999-12-31 的有规则任务完成后同样如此；对二者清规则都是 422 `NOT_CURRENT_OCCURRENCE`、无任何写入；第二期 reopen 后清规则 200 | 真库 1 格；变异 MU18 |
| P3：三个派生变异在 47 格下存活；几项照抄的字段没有断言 | 新格：`rec-monthly-anchor`（按月、从 01-31 起走到第 4 期：02-28、03-31、04-30）；`rec-remind-policy`（源任务无提醒：系列创建人的缺省提醒策略生效、完成人的不生效，两个方向各一次）；`rec-delete-first-deleted`（`count` 2 的系列走完、经系列删除软删第一期、第二期 reopen 并重设 `count` 3 后完成 ⇒ 仍派生第三期，锚点与序号都读到已软删的第一期；第三期完成不再派生）；`rec-subtask-carried`（有规则的子任务：父任务、深度、描述、里程碑标志都照抄）；`rec-instant-paths`（删负责人与切模式两条路径上，被翻转一期的 `completed_at`、`recurrence_spawned`、新一期的 `created` 与新行的 `created_at` / `updated_at` 是同一时刻） | 真库 6 格（`rec-instant-paths` 2 格）；变异 MU20–MU24 |
| P3：系列删除对目标本身的行锁没有格 | 新格 `rec-delete-first-target`：照 `rec-delete-first` 的做法，评论写在目标上 ⇒ 等待后 404、零条评论 | 真库 1 格；变异 MU19 |
| P3：任务 E 的单测文件数与格数 | §2 改为 11 个文件 481（本轮之后 482，见 §11.3） | §2 |
| P3：没有全量单测行 | 补上，head 与起点对照，见 §11.3 | §11.3 |
| P3：注释把设 / 清规则写 `updated_at` 说成设计 §4.4 的规定，且头注说本模块只写 `recurrence` 一列 | 头注改为「写 `recurrence`，并随之写 `updated_at`」；JSDoc 只把事件时刻归 §4.4，`updated_at` 的写入另标 `ASSUMPTION(task-m5a)`，指向 §9 第 2 条的 owner 问题 | 注释 |
| NIT：记录说非系列删除路径「逐字照 M3」 | §1 与 §3 第 5 条改写：M3 的原有语句不变，但前面多了一次结构锁内只读系列列的读，并写明它为什么不削弱 M3R2-CONC-1 | §1、§3 |
| NIT：行锁 helper 的注释「先于一切读」不再准确 | 只改注释：写明单删路径上唯一先于它的读是系列列读、系列路径按设计 §3.8 第 1–2 步先读系列，以及最坏等待是期数 × 3 s。函数体逐字节不变（`git diff` 只有注释行） | 注释 |
| NIT：系列删除的时刻以文本往返 | 改为在 SQL 里一次取值：`WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS at) UPDATE tasks SET deleted_at = clock.at, updated_at = clock.at FROM clock WHERE …`；不再依赖会话的 `DateStyle`。事件与清规则仍从行上复制 | `rec-delete-later-open`（两期 `deleted` 时刻相等）在本轮 lane 各遍都绿 |
| NIT：注释里写了缺陷是怎么发现的 | 删掉那句括注 | 注释 |
| NIT：`tasks-auth-gate.ts` 的改动行号不对 | 正确的是第 231–238 行与第 1243–1275 行（`git diff -U0 5822434947`：+231..238、1243、1256..1258、1261、1273..1275）；§4 原行已作废，行号在 §11.3 | §11.3 |
| NIT：把「先读系列再加锁」写成偏离并列为 owner 问题 | §3 第 5 条改为照设计；§9 第 3 条撤回 | §3、§9 |
| NIT：结构锁持有期间的累计等待是期数 × 3 s | 记在 §3 第 5 条与 helper 注释里，不改代码 | §3 |

### 11.2 没有改的（附理由）

1. **冻结设计的修订**：两条 P2 都建议改设计 §3.2 第 4 步、§4.1 的 `task-recurrence.ts` 一行与 §7.2。设计是 `origin/claude/tasks-m5-pr4a` 上的冻结稿，以往各切片都没有改过它（本分支相对它对该文件的 diff 为空），本件也不改。建议的修订文字（待 owner 点名）：
   - §3.2 第 4 步，在「下一期截止日越过民用日期上限（`9999-12-31`）⇒ 按 `series_ended` 处理、不派生」之后加：「由下一期截止日派生的值越出直接写入接受的范围时同样按 `series_ended` 处理：顺延后的开始日越过 `9999-12-31`；下一期的截止时刻越过 9999 年末（[own-38]）；顺延后的提醒越过 9999 年末（[own-30]；取结束系列而不是丢弃或夹钳提醒，`ASSUMPTION`）。这些判定也只在 `planSpawn` 里做。」
   - §4.1 的 `task-recurrence.ts` 一行：「`planSpawn`：下一期截止日越过 `9999-12-31`，或派生的开始日、截止时刻、提醒越界时返回 `series_ended`，不抛错（§3.2 第 4 步）」。
   - §7.2「任务 E 的 `planSpawn` 两处失败形」第 ② 条末尾加：「只改截止日一处不够，派生的三个值同样要判（切片 3 闸审第 2 轮）」。
2. **新测试文件里的 7 条类型诊断**（`holder.processID` 的 TS2339、`import.meta` 的 TS1343）不改代码：`task-m3-comments-deletion`、`task-p0a`、`task-m3-membership` 用的是同样的写法（`processID` 的 TS2339 共 24 条），本包的 `tsc --noEmit` 与 CI 都不编译测试文件。本轮如实记数（§11.3）。新加的 `rec-delete-first-target` 沿用同样写法，所以新文件的 TS2339 从 6 条变成 9 条。

### 11.3 本地（RAN）

| 项 | 命令 / 做法 | 结果 |
|---|---|---|
| 任务 E 单测（`d0c80dea1f` 的工作树） | 11 个文件：`task-civil-date`、`task-dependencies`、`task-milestone`、`task-recurrence`、`task-fields`、`task-attachments`、`task-projection`、`task-export`、`task-m5-probe`、`task-m5-time-zone`、`task-pure-no-io` | 11 files / 482 passed（`task-recurrence` 95 = 94 + 1）；`tsc --noEmit` 0 错 |
| 任务 E 单测（`10a4813bb0`，核对 §2 的更正） | 同上 11 个文件，在该提交的导出副本上跑 | 11 files / 481 passed |
| 任务 E 新格的负控 | 逐一删去三处判断之一（备份 → 改写 → 跑 → 复制回并核 md5 相同） | 三次都是这一格红（1 failed / 94 passed），还原后绿 |
| type-check | `tsc --noEmit -p .`（`07e468e42a` 的工作树） | 0 errors |
| 测试文件的类型（更正 §4 原行） | 临时 tsconfig（不入库）：`extends` 本包配置，`include` 为 `src/**/*` 加本切片新增与改动的 9 个测试文件，**`exclude` 改为只含 `node_modules`、`dist`**；先用 `--listFilesOnly` 核对 9 个文件都在程序里（连同它们引入的 `task-m4-fixtures.ts`、`tasks-http-harness.ts`）；同一做法在起点 `5822434947` 的导出副本上再跑一次对照 | 新文件：`task-m5-recurrence.db.test.ts` 9 条 TS2339（都是 `holder.processID`），`task-field-access.test.ts` 1 条 TS1343（`import.meta`）。改动的 7 个文件及其辅助文件在 head 与起点完全相同：`task-m3-comments-deletion` 4 TS1343 + 10 TS2339、`task-m3-membership` 4 TS2339、`task-p0a` 10 TS2339、`tasks-auth-gate` 6 TS1343、`task-access` 1 TS1343、`task-m4-fixtures` 1 TS1343，`task-counts-touchpoints`、`task-records-guards`、`tasks-http-harness` 0 条；按 `git diff -U0` 的改动行逐条核，没有一条落在本切片改动的行上（`tasks-auth-gate.ts` 改动的是第 231–238 行与第 1243–1275 行）。没有新的诊断类别 |
| 任务单测子集 + 绊线 | 同 §4 | 51 files / 2103 passed（= 2102 + 1，`task-recurrence` 的新格） |
| PR-3c 普查、门 17 ④ | 上一行里 | 绿 |
| 门 7 | 同 §4 的 ERE | 恰 3 行，仍在 `src/db/task-advisory-locks.ts`；本切片对 `src/db/` 的 diff 仍为空 |
| 门 15 | 本轮新增的 26 行生产注释（`b9cd053dd3..07e468e42a` 的 `src` diff，含任务 E 的合并），记号表同 PR-3c 验证记录 §6 | 0 命中 |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录、任务 E 的 `d0c80dea1f` 与本切片 `07e468e42a` 的提交说明 | 都 exit 0 |

### 11.4 另一台机器（PostgreSQL 16.15，Node 20，RAN）

两个一次性工作树：最终（`07e468e42a` 本身，推过去后建，先核 `git log`）与对照（起点 `5822434947`）；库都是新建的空库，环境同 §6。

| 运行 | 结果 |
|---|---|
| 最终工作树，lane 第 1 次（1 遍） | 迁移 433 条；24 files / 949 passed (949)；鉴权门 86/86 |
| 最终工作树，lane 第 2 次（新建库，2 遍） | 迁移 433 条；第 1 遍 1 failed / 948 passed，第 2 遍 949 passed (949)；鉴权门 86/86 |
| 对照工作树，lane（新建库，2 遍） | 迁移 433 条；23 files，两遍各 1 failed / 881 passed（882），红的是两个不同文件的计时格：`task-m3-comments-deletion` 的 404 时延格（1954 ms，上限 1000 ms）与 `task-m4-paging-settings` 的 `badge\|no row` 格（87640 ms）；鉴权门 86/86 |
| `task-m4-list-items` 单文件，最终与对照各 5 遍 | 两边都是 5 遍各 25/25 |
| 全量单测（CI 单测任务的同一命令：本包默认配置 `vitest run`），最终与对照各 1 遍 | 最终：1319 files，7 failed / 1140 passed / 172 skipped；22269 格，47 failed / 20480 passed / 1742 skipped。对照：1318 files，7 failed / 1139 passed / 172 skipped；22263 格，47 failed / 20474 passed / 1742 skipped。两边失败的格逐行相同（95 行失败标记，`diff` 为空），都在恢复保管存储 / 归档的四个文件与审批、任务的三个 CI 接线文件里；本轮只核了两边失败集合相同，没有查失败原因。最终多 1 个文件（`task-field-access.test.ts`）、6 格（本切片自 `5822434947` 以来的单测新格，含任务 E 两个提交各 1 格） |

949 = §6 的 929 + 本轮新增 20 格；三遍里新文件的收集与通过都是 67（静态展开 67：普通 `it` 37 格，`it.each` 三组 30 格 = `rec-no-due` 12 + `rec-9999` 16 + `rec-instant-paths` 2；门 17 ②），其余 23 个文件的格数不变。三遍日志里 `socket hang up` / `ECONNRESET` 都是 0。门 19：`tsx tests/helpers/gate19-identities.ts <lane 第 2 次第 2 遍日志> <锁>`（锁与 main 版相同）⇒ `gate19: passed identities equal the i-m2 list`。

第 2 次 lane 第 1 遍红的一格是 `task-m4-list-items` 的 `items|add` 无效 `taskId` 格：30 s 用例超时，随后该文件的 `afterAll` 15 s 超时。本轮没有改清单项的路由与服务；同一台机器上该文件单独跑，最终与对照各 5 遍全绿，而对照的整条 lane 两遍也各有一个不同文件的计时红。所以判为那台机器负载下的计时偶发，不是本轮的回归；依据是对照上观察到同类的计时红与单文件 5 + 5 遍全绿，不是在对照上复现了同一格。

### 11.5 变异（RAN，另一台机器的最终工作树与它的库）

做法同 §7：驱动脚本（不入库）逐个执行「断言 needle 在文件里恰出现一次 → 备份 → 写入变异 → 跑新真库文件（JSON reporter）→ 写回并核对 md5 相同」，顺序执行；跑完工作树 `git status` 只有驱动脚本与 `node_modules` 链接。**本轮 10 个变异全部被至少一格杀死，10 次还原逐字节相同**；每次 67 格，未红的格都是绿的。

| # | 出处 | 文件 | 变异 | 红的格 |
|---|---|---|---|---|
| MU18 | 闸审 P3 | recurrence | 「最新」去掉 `status === 'open'` 那一半 | `rec-clear-done-latest` |
| MU19 | 闸审 P3 | structure | 行锁循环跳过目标（`candidates.slice(1)`） | `rec-delete-first-target` |
| MU20 | 闸审 P3（MD4） | records | 锚点改为本期自己的截止日 | `rec-monthly-anchor`，以及 `rec-no-due` 中「第一期截止日已清空」的 4 格 |
| MU21 | 闸审 P3（MD7） | records | 缺省提醒策略改读完成人的 | `rec-remind-policy` |
| MU22 | 闸审 P3（MD13） | recurrence | 系列装载只读未软删的第一期 | `rec-delete-first-deleted` |
| MU23 | 闸审 P3（S16） | records | 派生不带描述 | `rec-subtask-carried` |
| MU24 | 闸审 P3（`[a-37]`） | structure | 删负责人路径的派生改用另一个时刻 | `rec-instant-paths`（删负责人那一格） |
| MU25 | 闸审 P2 | 任务 E | 去掉开始日的判断 | `rec-9999` 开始日形状 × 4 条路径 |
| MU26 | 闸审 P2 | 任务 E | 去掉截止时刻的判断 | `rec-9999` 西于 UTC 形状 × 4 条路径 |
| MU27 | 闸审 P2 | 任务 E | 去掉提醒的判断 | `rec-9999` 提醒形状 × 4 条路径 |

文件简称同 §7；任务 E = `src/tasks/task-recurrence.ts`。MU25–MU27 各红 4 格，都是对应形状 × 四条翻转路径；驱动只记下红格的名字与数目，没有记录失败信息，所以红的具体形态（500 与回滚）本轮没有观察，以闸审的复现为准。

### 11.6 owner 问题（本轮新增）

1. **顺延的提醒越界时怎么办**：本件取「结束系列」（`ASSUMPTION(task-e)`，`d0c80dea1f`）；备选是丢弃提醒照常派生，或把提醒夹到 9999 年末。只有提醒晚于截止、且截止在日历末端时才会碰到。
2. **设计修订**：§11.2 第 1 条的三处文字，待 owner 点名后进冻结设计；在那之前本切片的行为以 §11.1 为准。

§9 第 1 条（两个任务 E 提交进 #6249）、第 2 条（设 / 清规则写 `updated_at`）、第 4、5 条不变；第 3 条已撤回。

### 11.7 清理

另一台机器上本轮的两个工作树（最终、对照）、两个库、日志、变异报告与两个临时脚本都已删除；删除后核对过：那台机器的工作树列表、库列表与临时目录里都不再有本轮的条目。推过去的两个引用留在那台机器的克隆里。本机用于类型检查对照与任务 E 旧提交单测的两个导出副本也已删除。
