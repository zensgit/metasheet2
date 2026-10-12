# 任务功能 M5 PR-4a 切片 4（里程碑与依赖）验证记录（2026-10-12）

- 设计：分支 `claude/tasks-m5-pr4a`，文件 `docs/development/task-m5-pr4a-backend-design-20261010.md`（冻结稿 v4 及其后两次文档修订）。本切片按其 §1.3 切片 4、§3.0、§3.3、§3.4、§3.8（详情的 `isMilestone` 与 `dependencies`、两条列表读的 `is_milestone`、待办不改）、§4.1（`task-dependency-records.ts`）、§4.2、§4.4、§4.7（两个新 builder）、§6.1 的 `M5|7` 与 `M5|10`、§6.2 候选 M5-c、§6.2.1 的里程碑、依赖、候选、读依赖与 `DepItem` 五行、§6.4 的待办不变格实现。锁：`docs/development/task-feature-design-lock-20260917.md`（main 版）。
- 裁定只按日期与条目号引用：owner 2026-10-12（从切片 2 起继续实现 PR-4a，叠在 #6249 上，每片单独过闸，只开 Draft，未裁的问题取设计缺省，不合并，不对任何环境应用 DDL）；S09、S11、S12、S13、S31（M5-c 候选格：自依赖、重复、成环都是 422）（2026-10-09）。本文自选的取舍按设计 §7.1 的 `[a-NN]` 缺省执行；D4、D17、D18 是缺省约束（`ASSUMPTION`）；候选排除成环任务按设计缺省（X3，任务 E 的自选，§7.2 的 owner 问题）。
- 分支：`claude/tasks-m5-pr4a-s4`，起点 `4554b5012b`（切片 1–3 叠在 #6249 上）。提交：代码与单测 `09e4e7fd9e`、真库文件与登记 `56baecedcb`、软删格补后置一端 `353f8ea0dd`、本记录。不推送、不开 PR、不合并；没有新开关、没有新的 `TASKS_*` 读点、没有新挂载点；迁移仍是切片 2 的 Draft，没有对任何共享环境应用。
- 任务 E（#6249）本切片**没有改动**：`task-dependencies.ts` 与 `task-milestone.ts` 的导出按设计 §4.1 的对照表原样调用，没有建 `claude/tasks-e-pure-s4`。
- 本地环境：Node 25.9.0，`node_modules` 是指向主检出的符号链接（未提交）。真库在另一台机器上跑（PostgreSQL 16，Node 20），一次性工作树与库，用完即删（§10）。变异驱动与临时 tsconfig 都不入库。

## 1. 文件

| 文件 | 内容 |
|---|---|
| `src/services/task-dependency-records.ts`（新） | `setTaskMilestone`；`addTaskDependency`、`removeTaskDependency`；`getTaskDependencies`；`getDependencyCandidates`；详情与读路由共用的 `loadDependencyItems`（`DepItem`）。写都在 `withOrgStructure` 里；不写任何待办输入（任务行只写 `is_milestone` 与 `updated_at`）；没有 `catch` / `.then` / `.catch` / 会吞错的组合子（它被 `task-records.ts` 导入，落在 PR-3c 规则 ③ 的遍历里，普查单测绿） |
| `src/routes/tasks-entity.ts` | 六条新路由：`PATCH /api/tasks/:id/milestone`、`GET` / `POST /api/tasks/:id/dependencies`、`DELETE …/dependencies/predecessors/:otherId`、`DELETE …/dependencies/successors/:otherId`、`GET /api/tasks/:id/dependency-candidates`。四条写缺 org ⇒ 422 `ORG_MISSING`；两条读挂在任务 id 下，缺 org ⇒ 404（设计 §3.0） |
| `src/tasks/task-access.ts` | `buildOrgDependencyEdgesCondition`（`$1` = 任务 id 或 `null`，`$2` = org）与 `buildDependencyCandidateTasksCondition`（`$1` = 本任务、排除，`$2` = org），都经模块唯一的 org 子句（§3 第 1 条） |
| `src/services/task-records.ts` | 详情加 `isMilestone`、`dependencies`（`view` 判定之后组装）；`GET /api/tasks` 的列表读在既有列之后加 `is_milestone` |
| `src/services/task-list-records.ts` | 清单任务项读加 `is_milestone`（同上一行） |
| `tests/integration/task-m5-dependencies.db.test.ts`（新） | 真库 33 格（§5） |
| `tests/unit/task-access.test.ts` | 两个新 builder 的钉文、参数、占位符集合；并入「每个 builder 输出恰含一次 org 子句」那一格 |
| `tests/unit/task-records-guards.test.ts` | 清单任务项读的 SQL 前缀钉加 `is_milestone` |
| `tests/integration/task-p0a.db.test.ts`、`task-m4-list-items.db.test.ts`、`task-m4-paging-settings.db.test.ts` | 详情整体钉加两键（`isMilestone: false`、`dependencies` 两个空数组）；列表项整体钉与键集钉加 `is_milestone` |
| `tests/tasks-auth/tasks-auth-gate.ts` | 路由人口格的 M5 表由 1 行加到 7 行，计数 `[8, 13, 30, 7]`，每行同样做分派绑定 |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新真库文件的登记（锁 §5.2.1 ①②；④ 由既有的发现式单测核三集合相等） |

## 2. 判定顺序（照设计，逐条对照）

- `PATCH /milestone`：结构锁 → 任务取行（404）→ 完整角色集 `can(roles,'edit')`（404）→ 请求体 `isMilestone` 只收真布尔（422 `INVALID_MILESTONE`）→ 锁后一次 `clock_timestamp()` → `applySetMilestone`：同值空操作；否则写列与一条 `milestone_set` / `milestone_cleared`。
- `POST /dependencies`：结构锁 → 本任务取行与 `edit`（404）→ 请求体（422 `INVALID_DEPENDENCY`）→ 对端取行（同 org、未软删，404）→ `canManageDependency`（两端完整角色集、两行的 `org_id`，404）→ 锁内重读本 org 全部存活边 → `applyAddDependency`（内含 `validateAddDependency`：`cross_org` ⇒ 404，其余 reason 转大写 422，纯函数的先后是 self、duplicate、limit、cycle）→ 写边、两端各一条 `dependency_added`（payload 是对端 id），边的 `created_at` 与两条事件取同一个读数。
- 两条 `DELETE`：路径 id 不可打印 ⇒ 发 SQL 之前 404 → 结构锁 → 本任务与 `edit`（404）→ 对端（404）→ `canManageDependency`（404）→ `applyRemoveDependency`：边不存在 ⇒ 空操作；否则删行、两端各一条 `dependency_removed`。
- `GET /dependencies`：不取锁；本任务与 `view`（404）→ 两个 `DepItem` 数组。
- `GET /dependency-candidates`：不取锁；本任务与 `edit`（404）→ `direction`（422 `INVALID_DIRECTION`）→ `q`（422 `INVALID_QUERY`）→ 分页（422 `INVALID_LIMIT` / `INVALID_OFFSET`）。三个 query 码之间的先后是本件定的（§3 第 5 条）。
- 事件：同一次写的事件写在各自的任务上，每一端各调用一次 `enqueueTaskEventNotifications`，传那一端自己的 `created_by` 与只属于它的事件（与系列删除同一做法）。本切片的四个词都不在 `TASK_NOTIFIABLE_EVENTS` 里，producer 不写行（§5 `dep-notify`）。
- `tasks.version`：里程碑与依赖都不动（`[a-10]`）；依赖写不碰任务行。

## 3. 偏离与本件的取法

1. **边 builder 的形状**：org 子句只出现一次，落在前置一端（`EXISTS (… tasks.id = task_dependencies.predecessor_id AND <org 子句与存活>)`）；后置一端只查存活。依据是两条组合外键 `(predecessor_id, org_id)`、`(successor_id, org_id)` 都指向 `tasks (id, org_id)`，边与两端必在同一 org。没有手写 `task_dependencies.org_id`，所以门 1 的单字面量变异仍覆盖这条读。代价：这种写法下查询计划大概率不走 `idx_tdep_org`（设计 §2.3 的用意是按 org 取边不落全表扫描）；本件**没有跑 EXPLAIN**（NOT RUN），按 org 取的是 `tasks` 上带 org 的索引再按主键连到边。为了把整图读与按单任务读合成一个 builder，`$1` 可为 `null`（`$1::text IS NULL OR … = $1`）；设计只点名了 builder 的名字与「选出」的语义，这一参数形状是本件的取法。
2. **里程碑写 `updated_at`**：与切片 3 的设 / 清规则同一取法（同一个锁后读数），列为同一个 owner 问题（切片 3 记录 §9 第 2 条）。依赖写不碰任务行，`updated_at` 不动。
3. **`POST /dependencies` 的「恰一个键」取严格读法**：请求体必须是对象且只有一个键，键是 `predecessorId` 或 `successorId`，值过 `isValidTaskDomainId`；多出任何别的键也是 422 `INVALID_DEPENDENCY`（格 `dep-invalid-body`，变异 MU19）。`PATCH /milestone` 只看 `isMilestone`，别的键忽略。
4. **候选的读法**：照 M3 `parent-candidates` 的先例，按候选 builder 读出本 org 全部存活任务（带 `q` 时在 SQL 里先按标题过滤），在 TS 里逐行判 `edit`，再交给 `dependencyCandidates` 排除已连与成环，按 SQL 的 `TASK_PAGE_SORT_KEY` 顺序保留，最后才切页；`total` 是过滤后的数。代价是每次调用与本 org 任务数成正比，没有压测。
5. **`q` 的细节**：字面子串用 `strpos(lower(title), lower(q)) > 0`（不解释 `%`、`_`）；长度按请求里原样字符串的 UTF-16 码元数判（> 200 ⇒ 422），去空白后为空视同未传；同名参数出现多次（数组）⇒ 422。三个 query 码的先后（方向、`q`、分页）设计没有定，本件按此顺序。
6. **`M5|7` 正向格的位置**：设父、依赖增删、派生、里程碑的正向格与三组两两并发格放在新文件（`lock-…` 五格）；切片 2 放在 `task-m5-schema.db.test.ts` 的设父、建任务、调度 tick 与反序 / leader 共存格不动。fence（rank 2）按设计 §4.2、§6.1 归 PR-4c，本切片不加方法、不改 `TASK_LOCK_RANKS`；本切片对 `src/db/` 的 diff 为空。切片 2 记录留下的「第一个在一个事务里取两把任务锁的切片要处理实例模型」没有被触发：依赖写只取结构锁一把。
7. **通知入队的可检出性**：本切片的四个事件词都不通知，所以「没有投递行」在调用与不调用 `enqueueTaskEventNotifications` 两种情况下一样；`dep-notify` 只证明打开投递后这些写不产生行、同一任务的完成会产生（正控）。仓库里没有对事件写入点的静态普查能检出漏掉的入队调用；本件如实记下，不另造检查。
8. **鉴权门**：只做路由人口格与分派绑定；新路由的门 1 / 2 逐路由格（缺 org、准入、码、403）归切片 6（§1.3）。真库文件里的缺 org 读格（`dep-read-auth`）用租户声明为空的令牌，在 `RBAC_TOKEN_TRUST=true` 下跑。
9. **并发格的轮询范围**：`waitForLockWaiters` 数的是本库所有等锁的后端（除持锁连接），依据是 lane 按文件串行（`vitest.integration.config.ts` 的 `fileParallelism: false`），与 g1、切片 3 同一写法。
10. **详情的成本**：每次详情读多两组查询（边加对端、对端的角色），没有分页（D18 每任务至多 50）。

## 4. 本地（RAN）

命令在 `packages/core-backend` 下（ops 在仓库根），在 `353f8ea0dd` 的内容上跑（其后只有本记录）。

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `tsc --noEmit -p .` | 0 errors |
| 新真库文件的类型 | 临时 tsconfig（不入库）：`extends` 本包配置，`include` 为 `src/**/*` 与新文件，`exclude` 只含 `node_modules`、`dist` 与 `src` 下的测试目录 | 新文件 0 条；唯一一条诊断在既有的 `tests/helpers/task-m4-fixtures.ts`（`import.meta` 的 TS1343，切片 3 记录 §11.3 已记） |
| 任务单测子集 + 绊线 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts tests/unit/supertest-app-mode-tripwire.test.ts` | 51 files / 2105 passed / 0 failed（切片 3 末为 2103；`task-access` 加 2 格） |
| PR-3c 普查 | 上一行里的 `task-counts-touchpoints.test.ts` | 绿：人口仍是三个服务文件；写入者集合不变；规则 ③ 的遍历含新模块，没有吞错点 |
| 门 17 ④ | 上一行里的 `task-ci-coverage-enumeration.test.ts` | 绿 |
| 门 17 ① | `vitest run --config vitest.config.ts tests/integration/task-m5-dependencies.db.test.ts` | `No test files found`，exit 1，不是 skipped |
| ops | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs scripts/ops/staging-tasks-smoke.test.mjs` | 194/194 |
| 门 7 | ERE `pg_advisory_xact_lock[[:space:]]*\([[:space:]]*hashtext[[:space:]]*\(` 扫 `src/tasks`、`src/services/task-*`、`src/routes/tasks*`、`src/db/task-*` | 恰 3 行，`src/db/task-advisory-locks.ts` 第 17、25、29 行；本切片对 `src/db/` 的 diff 为空 |
| 新 `TASKS_*` 读点 | `grep TASKS_` 两个改动的源文件 | 只有 `tasks-entity.ts` 头注里的一句说明 |
| 门 15 | 本切片新增与改动的 132 行生产注释，记号表同 PR-3c 验证记录 §6 | 0 命中 |
| 文本扫描 | 两个字面扫描器与引号扫描器，对本记录、新服务文件、新真库文件与全部提交说明 | 都 exit 0 |

## 5. 真库文件 `task-m5-dependencies.db.test.ts`（33 格）

静态展开 33：普通 `it` 33 格，没有 `it.each`。格名前缀：`ms-` 里程碑、`dep-` 依赖、`cand-` 候选、`lock-` 锁序。对照设计：

| 设计条目 | 格 |
|---|---|
| §3.3：设、清、同值空操作、不要求截止日、`version` 不动、事件 | `ms-set-clear` |
| §3.3：只收真布尔；无 `edit` 者先 404 | `ms-invalid` |
| §6.2.1 里程碑行（C、A、LE 200；F、LR、O 404，逐字节同不存在） | `ms-auth` |
| §3.8 两条列表读的 `is_milestone`（`[a-18]`） | `ms-lists` |
| §6.4 待办不变格（五键 / 六键） | `ms-pending-unchanged` |
| M5-c：两种请求形、边行、两端事件与时刻、任务行不动 | `dep-add-both-forms` |
| M5-c：自依赖、重复、成环各 422（S31 采纳的格） | `dep-self`、`dep-duplicate`、`dep-cycle` |
| M5-c：菱形合法 | `dep-diamond` |
| M5-c：删边、删不存在的边为空操作 | `dep-remove`、`dep-remove-missing` |
| §3.4 请求体形状（`[a-12]`、`[a-32]`）与 404 先于 422 | `dep-invalid-body` |
| `M5\|10` 写路径的 id 两格（前导 / 尾随 `_` ⇒ 422 `INVALID_DEPENDENCY`） | `dep-m5-10-ids` |
| M5-c：跨 org ⇒ 404；对端不存在 / 已软删 ⇒ 404 | `dep-counterpart` |
| §6.2.1 依赖加边、删边行（含「一端无 edit ⇒ 404」） | `dep-auth` |
| D18 每任务 50 条 ⇒ 422 `LIMIT`（两端各一次，含正控） | `dep-limit` |
| D17 软删留边、不写 `dependency_removed`、读时过滤（两端） | `dep-soft-deleted` |
| M5-c：两个连接同时加 X→Y 与 Y→X，第三连接持 `task_dependencies` 的 `SHARE`、按门 6 的 settle 规则放开，恰一个成功、图无环 | `dep-concurrent-cross` |
| §6.2.1 读依赖行（C、A、LE、F、LR 200；O 404；缺 org 404） | `dep-read-auth` |
| §6.2.1 `DepItem` 行（看不见的对端不列不计；`canRemove` 两端都 `edit`）；详情同形 | `dep-item` |
| `[a-34]` `DepItem` 的顺序 | `dep-item-order` |
| §3.4 候选的结果集：调用者能 `edit` 的任务；本任务、已有边的任务与会成环的任务（X3）不在其中；`TASK_PAGE_SORT_KEY` 顺序；`total` | `cand-direction` |
| §6.2.1 候选行（只关注、只读的任务不在结果里） | `cand-direction` |
| `[a-32]` `q` 字面子串、不区分大小写、空白、长度与数组 | `cand-q` |
| 分页 | `cand-page` |
| §3.0：候选的 404 先于 `INVALID_DIRECTION`；F、LR 404 | `cand-order` |
| M5-c：同一用户在两个 org 在职，候选不含另一 org 的任务 | `cand-two-orgs` |
| §4.4 新词不通知（含完成的正控） | `dep-notify` |
| `M5\|7` 正向：依赖增删、里程碑、派生各一个序列 `[structure]`；设父 ∥ 加边、设父 ∥ 派生、加边 ∥ 派生，各两个序列 | `lock-dep-add`、`lock-dep-remove`、`lock-milestone`、`lock-spawn`、`lock-pairs` |

## 6. 另一台机器（PostgreSQL 16，RAN）

两个一次性工作树：开发（起先 `56baecedcb`，补格后切到 `353f8ea0dd`）与最终（`353f8ea0dd` 本身，推过去后建，先核 `git log`）。库都是新建的空库，`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项，环境变量照 `tasks-realdb.yml`。

1. **迁移**：空库全量迁移 433 条 executed successfully。
2. **开发工作树，单文件**：`56baecedcb` 上 33/33；切到 `353f8ea0dd` 后同库 33/33（变异之前的那一遍）。
3. **最终工作树，lane 3 遍 + 鉴权门**：见下表（§6.1）。

### 6.1 lane

| 运行 | 结果 |
|---|---|
| lane 第 1 遍 | 25 files / 982 passed (982) |
| lane 第 2 遍 | 25 files / 982 passed (982) |
| lane 第 3 遍 | 25 files / 982 passed (982) |
| 鉴权门（`vitest.tasks-auth.config.ts`，`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`） | 1 file / 86 passed (86) |

982 = 切片 3 记录 §11.4 的 949 + 本文件 33；三遍里新文件的收集与通过都是 33（静态展开 33 = 收集 33，门 17 ②）。三遍逐文件计数：`task-m5-dependencies` 33/33、`task-m3-tree` 25/25、`task-p0a` 13/13、`task-m4-list-items` 25/25、`task-m4-paging-settings` 77/77、`task-m5-schema` 53/53（三遍相同）。三遍日志里 `socket hang up` / `ECONNRESET` 都是 0。门 19：`tsx tests/helpers/gate19-identities.ts <lane 第 3 遍日志> <锁>` ⇒ `gate19: passed identities equal the i-m2 list`。本轮没有红格，所以没有起对照工作树（起点 `4554b5012b` 上的对照 NOT RUN）。

## 7. 变异（RAN，另一台机器的开发工作树与开发库，`353f8ea0dd`）

做法同切片 3：驱动脚本（不入库）逐个执行「断言 needle 在文件里恰出现一次 → 备份 → 写入变异 → 跑新真库文件（JSON reporter）→ 写回并核对 md5 相同」，顺序执行，不与别的测试并发；没有用 `git checkout` / `reset` / `stash` / `clean`。跑完工作树 `git status` 只有 `node_modules` 链接。

**21 个变异全部至少被一格杀死，21 次还原逐字节相同**；每次 33 格，未红的格都是绿的。

| # | 出处 | 文件 | 变异 | 红的格 |
|---|---|---|---|---|
| MU1 | §6.2 M5-c 负控 | deps | 加边路径不取结构锁（同一事务、同一隔离级别，只去掉取锁） | `dep-concurrent-cross`（两方都成功），以及 `lock-dep-add`、`lock-pairs` |
| MU2 | §6.2.1 | deps | 加边的 `canManageDependency` 只看 `:id` 一端 | `dep-auth` |
| MU3 | §6.2.1 | deps | 删边的 `canManageDependency` 只看 `:id` 一端 | `dep-auth` |
| MU4 | §6.2.1 | deps | `canRemove` 只看 `:id` 一端 | `dep-item` |
| MU5 | §6.2.1 | deps | 去掉对端的 `view` 过滤 | `dep-item` |
| MU6 | §6.2.1 | deps | 读依赖去掉 `view` 判定 | `dep-read-auth` |
| MU7 | §6.2.1 | deps | 候选去掉逐行 `edit` 过滤 | `cand-direction`、`cand-q`、`cand-page` |
| MU8 | §6.2.1 | deps | 里程碑 `edit` 换成 `view` | `ms-auth` |
| MU9 | §6.2.1 | deps | 里程碑只认直接角色（丢掉清单身份） | `ms-auth`、`ms-set-clear` |
| MU10 | §3.0 | deps | 候选的 `INVALID_DIRECTION` 挪到 404 之前 | `cand-order` |
| MU11 | X3 | deps | 候选只知道直接相连的边（成环排除失效） | `cand-direction`、`cand-q`、`cand-page` |
| MU12 | §4.7 | access | 候选 builder 去掉 org 子句 | `cand-two-orgs` |
| MU13 | §4.7、D17 | access | 边 builder 去掉后置一端的存活条件 | `dep-soft-deleted` |
| MU14 | §3.3 | deps | 里程碑同值不再是空操作 | `ms-set-clear` |
| MU15 | `[a-34]` | deps | `DepItem` 不按边的 `created_at` 排 | `dep-item`、`dep-item-order` |
| MU16 | `[a-34]` | deps | 候选改为页序的反序 | `cand-direction`、`cand-q` |
| MU17 | `[a-32]` | deps | `q` 改成 `ILIKE` 模式 | `cand-q` |
| MU18 | §6.1 `M5\|7` 负控 | records | `withOrgStructure` 改回直接调用取锁 helper | `lock-dep-add`、`lock-dep-remove`、`lock-milestone`、`lock-spawn`、`lock-pairs`（读到空序列） |
| MU19 | `[a-12]` | deps | 请求体多出的键不再拒绝 | `dep-invalid-body` |
| MU20 | `M5\|10` | deps | 请求体 id 不过四合取（只查非空字符串） | `dep-invalid-body`、`dep-m5-10-ids` |
| MU21 | §3.0 | deps | 加边先查请求体、后查 `edit` | `dep-invalid-body` |

文件简称：deps = `src/services/task-dependency-records.ts`，access = `src/tasks/task-access.ts`，records = `src/services/task-records.ts`。没有做的：S31 的自依赖 / 重复 / 成环三者的判定在任务 E 的纯函数里，由 #6249 的单测承载，本切片不在服务层变异它们；入队调用的漏调用检不出（§3 第 7 条）。

## 8. 回归行（§1.3 切片 4）

| 行 | 承载 | 本次运行 | 结果 |
|---|---|---|---|
| `M3` 设父格（同用结构锁） | `task-m3-tree`（含 `M3\|6\|整门` 的按原文匹配取锁函数体的文件内负控） | lane ×3 | 25/25 ×3 |
| `M2\|5\|整门`（待办键集） | `task-p0a` 等 lane 文件；本文件 `ms-pending-unchanged` | lane ×3 | lane 三遍全绿；`ms-pending-unchanged` ×3 绿 |
| PR-3c 单测 `task-counts-touchpoints` | §4 | 本地 | 绿 |
| 其余 `M2\|` / `M3\|` / `M4\|` 行 | lane 的其余文件、鉴权门 | lane ×3；鉴权门 | 见 §6.1 |
| 前端行 | `apps/web` | NOT RUN | 本切片不改 `apps/web`；详情多两个键、列表项多一列，前端未跑 |
| `M2\|14\|整门` | PR 首段声明 | 没有开 PR | NOT RUN |

## 9. owner 问题与待办

1. **里程碑写是否带 `updated_at`**（§3 第 2 条）：与切片 3 记录 §9 第 2 条同一问题，本件写。
2. **`q` 的长度口径与三个 query 码的先后**（§3 第 5 条）：本件的取法，设计未定。
3. **候选的规模**（§3 第 4 条）：逐行判权限、过滤后切页，与本 org 任务数成正比；若要 SQL 里预筛，需要把角色判定的一部分写进 SQL，与「行级规则只出自纯函数」（门 20）有张力。
4. **`idx_tdep_org` 是否被用到**（§3 第 1 条）：EXPLAIN 没有跑；若要它生效，需要在边 builder 里写 `task_dependencies.org_id`，那会是 org 子句之外的第二处 org 文本。
5. 设计 §7.2 已登记、本切片照缺省执行的：X3（候选排除成环任务）、两条有上限的读不分页（S34 / E22）、详情的 `dependencies` 不分页。
6. 候选门 29 的入锁修订仍按设计 §7.3 待 owner 点名；里程碑授权格挂在 M5-c 行（`[a-39]`，§7.4 Q4）。
7. 新路由的门 1 / 2 逐路由格归切片 6。

## 10. 清理

另一台机器上本次的两个工作树（开发、最终）、两个库、日志、变异驱动、变异清单与各次 JSON 报告都已删除；删除后核对过：那台机器的工作树目录与库列表里都不再有本次的条目。推过去的两个引用留在那台机器的克隆里。本机的临时 tsconfig 用完即删；本机工作树的 `node_modules` 符号链接未提交。
