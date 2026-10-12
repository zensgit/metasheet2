# 任务功能 M5 PR-4a 切片 3（重复任务）验证记录（2026-10-12）

- 设计：分支 `claude/tasks-m5-pr4a`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`（冻结稿 v4 及其后两次文档修订）。本切片按其 §1.3 切片 3、§3.2、§3.8（详情的系列字段与系列删除）、§4.1（`task-recurrence-records.ts`、两处写入 helper、PR-3c 普查的登记与 mock 应答）、§4.4、§4.7、§6.2 候选 M5-a、§6.2.1 第一行、§6.4 门 26 的系列删除格实现。锁：`docs/development/task-feature-design-lock-20260917.md`（main 版）。
- 裁定只按日期与条目号引用：owner 2026-10-12（从切片 2 起继续实现 PR-4a，叠在 #6249 上，每片单独过闸，只开 Draft，未裁的问题取设计缺省，不合并，不对任何环境应用 DDL）；S14–S17、S33、S35（2026-10-09）；R16、R17、N2（2026-10-07）。本文自选的取舍按设计 §7.1 的 `[a-NN]` 缺省执行。
- 分支：`claude/tasks-m5-pr4a-s3`，起点 `5822434947`（切片 1–2 叠在 #6249 上）。提交：任务 E 的合并 `f384e3368b`、代码与单测 `b4b1f18f38`、真库文件 `80f47afe7e`、两次真库发现的修复 `80602b312a` 与 `b51d7f4844`，以及本记录。不推送、不开 PR、不合并；没有新开关，没有新的 `TASKS_*` 读点；迁移仍是切片 2 的 Draft，没有对任何共享环境应用。
- 任务 E 的改动在它自己的分支：`claude/tasks-e-pure-9999`，从 `origin/claude/tasks-e-pure`（`39a2a29be9`，#6249 的远端头）起，一个提交 `10a4813bb0`，再以合并提交带进本切片（§2）。本地同名分支 `claude/tasks-e-pure` 指向远端压缩之前的旧历史，没有用它。
- 本地环境：Node 25.9.0，`node_modules` 是指向主检出的符号链接。真库在另一台机器上跑（PostgreSQL 16.15，Node 20），用的都是一次性工作树与库，用完即删（§6 末段）。变异驱动与临时 tsconfig 都不入库。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `src/routes/tasks-entity.ts`（新） | `registerTaskEntityRoutes`：`PUT /api/tasks/:id/recurrence`（`authenticate` + `rbacGuard('tasks','write')`，缺 org ⇒ 422 `ORG_MISSING`） |
| `src/routes/tasks.ts` | `tasksRouter()` 里一行 `registerTaskEntityRoutes(router)` |
| `src/services/task-recurrence-records.ts`（新） | 设 / 清规则（`setTaskRecurrence`）；系列读：`loadSeries`、`orderSeriesChain`、`occurrenceOrdinal`（沿链计数）、`liveSuccessorId`、`loadTaskSeriesFacts`（删除时判定是否属于系列）、`canonicalRecurrence`。不写任何待办输入，没有 `catch` / `.then` / `.catch` / 会吞错的组合子 |
| `src/services/task-records.ts` | `loadTask` 在既有列之后读 `recurrence`、`recurrence_series_id`、`previous_occurrence_id`、`due_date`（缺列一律 `?? null`）；`writeEvents` 的入参放宽为带可选 `payload` 的事件；写入 helper `spawnNextOccurrenceIfDue`；`completeTask` 调用它；详情加 `recurrence`、`seriesId`、`previousOccurrenceId`、`nextOccurrenceId` |
| `src/services/task-structure.ts` | `removeAssignee`、`switchCompletionMode` 调用 `spawnNextOccurrenceIfDue`；系列删除：只读加行锁的 `lockAndPlanSeriesDelete`、写入 helper `softDeleteSeriesOccurrences`；`deleteTaskById` 先判是否属于系列，属于则走系列路径，否则 M3 路径逐字不变；成功体加 `deletedIds` |
| `src/tasks/task-access.ts` | 新 builder `buildTaskSeriesMembersCondition`（含已软删）与 `buildLiveChildrenOfTasksCondition`，都经模块唯一的 org 子句；`[own-3b-17]` 注释改写为两个读者及各自理由 |
| `src/tasks/task-field-access.ts`（新） | 私有 `taskFieldOrgClause` 与 `buildTaskFieldByIdCondition`（偏离 1，§3） |
| `src/services/task-org-members.ts` | 只改头注：调用方清单加上派生 |
| `tests/integration/task-m5-recurrence.db.test.ts`（新） | 真库 47 格（§5） |
| `tests/unit/task-counts-touchpoints.test.ts` | `WRITE_HELPERS` 与写入者集合各加两个 helper；`respondWith` 在 `SELECT 1` 通配之前为三条新读补应答；人口、`TOUCHPOINTS`、`TOUCHPOINT_NAMES`、`WRITER_FILES` 与三条规则不变 |
| `tests/unit/task-records-guards.test.ts` | 通知 producer 那组的 mock 对系列成员读答空（它对每条 `FROM tasks WHERE` 都答同一行，否则删除会被当成系列） |
| `tests/unit/task-access.test.ts`、`tests/unit/task-field-access.test.ts`（新） | 两个新 builder 的钉文、参数与「org 子句恰一次」；字段 builder 的钉文与源文里 org 列只出现在生成器的模板字面量 |
| `tests/tasks-auth/tasks-auth-gate.ts` | 路由人口格加一张 M5 表（一行 `PUT /api/tasks/:id/recurrence`），计数 `[8, 13, 30, 1]`，并做同样的分派绑定（偏离 2） |
| `tests/integration/task-p0a.db.test.ts`、`task-m3-comments-deletion.db.test.ts`、`task-m3-membership.db.test.ts` | 详情的整体钉加四个系列键（都为 `null`）；单删成功体的整体钉加 `deletedIds: [id]`（8 处） |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新真库文件的登记（锁 §5.2.1 ①②；④ 由既有的发现式单测核三集合相等） |

## 2. 任务 E 的一处改动（#6249，设计 §4.1、§7.2）

`planSpawn` 在下一期截止日越过 `9999-12-31` 时返回 `{ ok: false, reason: 'series_ended' }`，不再让 `nextOccurrenceDueDate` 抛 `RangeError`。做法：把步进逻辑移进模块私有的 `stepOccurrenceDueDate`，越界时返回 `null`（按天、按周先用 `civilDayDiff` 比较剩余天数，按月、按年比较年份）；`planSpawn` 用它，`null` ⇒ `series_ended`；`nextOccurrenceDueDate` 仍在 `null` 时抛 `RangeError`，导出集合不变（任务 E 的 `'x'` 探针按导出逐个探，计数不变）。服务层没有任何 `catch`。

单测：`tests/unit/task-recurrence.test.ts` 新增一格，覆盖按天、按周（下一周越界）、按月、按年四种越界，按周同一周内仍能落在 `9999-12-31` 的正格，按天落在 `9999-12-31` 的正格，以及 `nextOccurrenceDueDate` 本身仍抛 `RangeError`。负控：把 `planSpawn` 改回调用 `nextOccurrenceDueDate` ⇒ 这一格红（1 failed / 93 passed），还原后绿。任务 E 的 10 个单测文件 457/457（含门 20 的 `task-pure-no-io` 与 `task-m5-probe`），`tsc --noEmit` 0 错。

## 3. 偏离与本件的取法

1. **字段 builder 提前到本切片**：§1.3 把 `task-field-access.ts` 放在切片 5，但 §3.2 / §4.7 写明派生要经 `buildTaskFieldByIdCondition` 读出字段定义来判断哪些取值是成员型，派生是它的第一个调用者。本切片只建这一个 builder 与私有 org 子句；`buildTaskFieldsOfOrgCondition` 留给切片 5。
2. **鉴权门**：新路由会让门 1 / 2 / 16 的路由人口格变红，所以本切片在那一格加了 M5 表与分派绑定；新路由的门 1 / 2 逐路由格（缺 org、准入、码）归切片 6（§1.3），本切片没有做。
3. **详情**：只加系列四键。`isMilestone`、`dependencies`、`fieldValues` 归切片 4、5。
4. **设 / 清规则写 `updated_at`**：设计只规定事件时刻取锁后的一次 `clock_timestamp()`；本件让同一次读数也写进 `updated_at`（与 M3 设父写 `updated_at` 的先例一致），`version` 不动（`[a-10]`）。列为 owner 问题（§9）。
5. **系列删除的读与行锁的先后**：§3.8 第 2 步要求对目标与链上更晚、未软删且未完成的各期按 id 升序取有界 `FOR UPDATE`。要知道这个集合，必须先在结构锁内读出系列，所以系列路径是「结构锁 → 读系列 → 按 id 升序逐行加锁 → 读角色、负责人与子任务 → `planSeriesDelete`」，目标行不像 M3 单删那样在一切读之前先锁。完成态与系列列只在结构锁内改，集合在锁内不变（设计同段已写明）；评论写只持 `FOR KEY SHARE`、不改任务行。非系列路径（含读不到行时）逐字照 M3。
6. **派生事件的 actor**：`recurrence_spawned` 与新一期的 `created` 记在这次翻转的调用者名下（`planSpawn` 的 `actorId`）：完成的人、G1 的创建人、删负责人或切模式的人。
7. **既有测试的改动**：只改期望值里新增的键（详情四键、删除的 `deletedIds`）与两处 mock 应答，见 §1。

## 4. 本地（RAN）

命令在 `packages/core-backend` 下（ops 在仓库根），都在最终提交 `b51d7f4844` 的内容上跑。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `tsc --noEmit -p .` | 0 errors |
| 新测试文件的类型 | 临时 tsconfig（`extends` 本包配置，加 `noUnusedLocals`，`include` 新真库文件、新单测与 `src`），不入库 | 本切片新增与改动的文件 0 条诊断；其余诊断都在本切片没有碰的文件里 |
| 任务单测子集 + 绊线 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/supertest-app-mode-tripwire.test.ts` | 51 files / 2102 passed / 0 failed。比切片 2 多 1 个文件、5 格：`task-recurrence` 1、`task-access` 2、`task-field-access` 2 |
| PR-3c 普查 | 上一行里的 `task-counts-touchpoints.test.ts` | 绿：人口仍是三个服务文件；写入者恰为八个写入点之五加五个 helper；两个新 helper 只被写入点直接调用；规则 ③ 的模块遍历含 `task-recurrence-records.ts`，没有吞错点 |
| 门 17 ④ | 上一行里的 `task-ci-coverage-enumeration.test.ts` | 绿 |
| 门 17 ① | `vitest run --config vitest.config.ts tests/integration/task-m5-recurrence.db.test.ts` | `No test files found`，exit 1，不是 skipped |
| ops | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs scripts/ops/staging-tasks-smoke.test.mjs` | 194/194 |
| 门 7 | ERE `pg_advisory_xact_lock[[:space:]]*\([[:space:]]*hashtext[[:space:]]*\(` 扫 `src/tasks`、`src/services/task-*`、`src/routes/tasks*`、`src/db/task-*` | 恰 3 行，都在 `src/db/task-advisory-locks.ts` 的三个登记导出里 |
| 新 `TASKS_*` 读点 | `grep TASKS_` 三个新源文件 | 只有 `tasks-entity.ts` 头注里的一句说明，没有读点 |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录、新真库文件与全部提交说明 | 都 exit 0 |

## 5. 真库文件 `task-m5-recurrence.db.test.ts`（47 格）

静态展开 47：普通 `it` 31 格，`it.each` 两组展开 16 格（三种不派生形状 × 四条翻转路径 12 格，`9999-12-31` × 四条路径 4 格）。格名以 `rec-` 开头；对照设计：

| 设计条目 | 格 |
|---|---|
| 三个调用点与 G1 各派生恰一期；日期步进、时刻与时区、系列两列、负责人行未完成 | `rec-complete`（截止日加 2 天、开始日同移、时刻与时区照抄、`due_at` 重算、提醒保持 1 小时提前量、清单与关注人照抄、两条事件）、`rec-g1`、`rec-remove-assignee`、`rec-switch-mode`；不翻转不派生：`rec-no-flip` |
| reopen 再完成不派生 | `rec-reopen-again` |
| `until` / `count` 用尽 | `rec-until-end`、`rec-count-end` |
| 不派生但完成照常 200（三种形状 × 三个调用点与 G1） | `rec-no-due`（12 格；前两种形状经 `PATCH` 清日期，即 `[a-27]` 的允许路径） |
| `9999-12-31` ⇒ 200、`series_ended` | `rec-9999`（4 格） |
| 详情 `nextOccurrenceId` | `rec-detail` |
| 系列删除：只动更晚且仍 open 的期 | `rec-delete-later-open`（含最晚存活一期清规则、`recurrence_cleared` 与删除同一时刻）、`rec-delete-not-series` |
| 系列删除：更晚一期的关注人收到 `deleted` 通知行 | `rec-delete-notify` |
| 系列删除与评论写互斥（两种先后） | `rec-delete-comment-first`、`rec-delete-first` |
| 有界行锁 ⇒ 409 `TASK_BUSY` | `rec-delete-busy` |
| 子任务整体拒绝、非创建人 404 | `rec-delete-children`、`rec-delete-non-creator` |
| `[a-15]` 派生的人员 | `rec-people-follower`（含在职关注人正控）、`rec-people-member-many`、`rec-people-member-only`、`rec-people-assignee` |
| `[a-16]` 序号沿链计数 | `rec-ordinal` |
| `[a-37]` 时刻 | `rec-instant` |
| 清规则的「最新」 | `rec-clear-latest`、`rec-clear-seeded` |
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

第 2 遍红的一格是 `task-m4-scheduler` 的 leader 会话上限格（「扫描超过空闲上限、靠页间心跳保住」的那一半得到 `leader_client_lost`）。这一格按真实时钟比较心跳与服务器的空闲上限；本切片没有改 `task-scheduler.ts`、`src/db/` 任何文件（相对 `5822434947` 的 diff 为空）。对照：同一台机器上，切片 2 的头 `5822434947`（对照工作树，新建库）与本切片最终提交各单独跑这个文件 5 遍，两边都是 5/5、每遍 25/25。判为负载下的计时偶发，不是本切片的缺陷；第 1、3 遍同一格是绿的。

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

1. **#6249 的改动**：`10a4813bb0`（`claude/tasks-e-pure-9999`）需要进 #6249 本身（#6249 先于 PR-4a 合入）。本切片以合并提交带入它，没有推送。
2. **设 / 清规则是否写 `updated_at`**（§3 第 4 条）：本件写；不写的话列表的排序键不随改规则移动。
3. **系列删除的读先于行锁**（§3 第 5 条）：本件按设计同段「锁内集合不变」的理由先读系列再按 id 升序加锁；若要「目标先锁」再读，需改设计 §3.8 第 2 步的顺序。
4. **候选门 27 的入锁修订**：仍按设计 §7.3 待 owner 点名；本文件的格在那之前不计分。
5. **门 1 / 2 逐路由格**：新路由的逐路由鉴权格归切片 6。

## 10. 清理

另一台机器上本次的工作树（开发、最终）、两个库与临时文件都已删除，以及对照工作树与它的库；删除后核对过：那台机器的工作树列表、库列表与临时目录里都不再有本次的条目。推过去的引用留在那台机器的克隆里，推错的一个（指向本机主检出当时的 HEAD）当场删掉了。
