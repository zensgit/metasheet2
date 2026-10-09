# 任务功能 M3 后端验证记录（2026-09-30）

- 分支：`claude/tasks-m3-backend`，基于 `origin/main` `4f19aa0b91`。以单提交 PR 推送；不合并；DDL 不应用到共享库；`TASKS_ENABLED` 保持关闭。
- 契约：`docs/development/task-m3-backend-design-20260928.md`（本次连同实现一起改，吸收 PR #6126 两轮闸方审阅意见，见该文件顶部说明与文末「未采纳/推迟」小节）。
- 实现：`packages/core-backend/src/services/task-structure.ts`（新文件）、`packages/core-backend/src/routes/tasks.ts`（追加 M3 路由）、`packages/core-backend/src/services/task-records.ts`（导出结构锁事务 helper 供 `task-structure.ts` 复用、`getTask` 加 M3 字段）、`packages/core-backend/src/services/task-ids-runtime.ts`（`newTaskCommentId`）、迁移 `packages/core-backend/src/db/migrations/zzzz20260930090000_create_task_comments.ts`。
- 本 PR 不应用 DDL 到共享库或生产库；不合并；不启用 `TASKS_ENABLED`。
- **闸方第五轮修订（2026-10-07）**：处置闸方第五轮 6 项（0 P1、1 P2）与另四处措辞，逐项见 §24。生产代码零语义改动（只改 `task-structure.ts` 一处注释）；交接链格的断言改为只计删除挂起期间的交接（原「总次数 ≥ 6」按墙钟计数，负载下会红）；契约与本文件的措辞按规则式表述收口。§2、§4、§5 已追加本轮数字。
- **闸方第四轮修订（2026-10-01）**：处置闸方第四轮后端 5 项（0 P1、1 P2，全部是测试缺口），逐项见 §21，变异见 §22，NOT RUN 见 §23。**生产代码零改动**：软删的取锁前预检本来就在结构锁与行锁之前回答（含不存在的 id），本轮只补测试把它钉住。前端三项（IN-1/IN-3/IN-4）在 #6159 另行处理；IN-2 在推送时改写提交信息。§2–§5 的数字已更新为本轮结果。
- **闸方第三轮修订（2026-10-01）**：处置闸方第三轮 15 项（0 P1），逐项见 §17，变异见 §18，锁探针见 §19，NOT RUN 见 §20。生产代码改：软删行锁整条语句限时（`statement_timeout`，57014/55P03 ⇒ 409）；软删在取锁前按 `created_by` 快照判删除能力；软删时间戳在 SQL 内一次取值；`POST /api/tasks` 执行人超过 50 ⇒ 422 `LIMIT`、执行人一条语句写入；标题/评论正文含 U+0000 或不成对代理项 ⇒ 422。§2–§5 的数字已更新为本轮结果。
- **闸方第二轮修订（同日）**：处置闸方第二轮 36 项（CF-8 属前端，另行处理），逐项见 §13。生产代码改五处：U+0000 与非可打印 id 在发 SQL 前拦下（404/422），`sendError` 不再回显驱动错误码；成员 id 长度上限 255；评论写对任务行改取 `FOR KEY SHARE`、软删改取 `FOR UPDATE` 并给这一步的等待设 3 秒上限（超时 409 `TASK_BUSY`）；软删在拿到锁之后才取时间戳；子孙 `depth` 一条语句写回；重复/数组形分页参数 422。其余是测试补齐、HTTP 传输夹具与文档。变异证明见 §14，偶发 `socket hang up` 的处理与证据见 §15。§2–§5 的数字已更新为本轮结果。
- **闸方第一轮修订（同日）**：处置闸方第一轮 25 项（逐项见 §11），生产代码改两处（M3-CF-1 分页上界、M3-CONC-6 评论写的任务存活行锁），其余为测试补齐与文档措辞；关键守卫逐一做了变异证明（§12）。§2–§5 的数字已更新为本轮结果；首轮数字保留在各节末尾作对照。

## 1. 本地环境

- 本地 PostgreSQL **15.17**（CI 用 postgres:16 服务容器；未在 16 上跑，风险记在 §7）。
- 库：首轮 `ms2_tasks_m3be_test`；闸方第二轮修订用 `m3fix2_lane`（新建，同样按 `MIGRATION_EXCLUDE` 跑全部迁移），结构变异另用由它复制出的 `m3fix2_mut`（每个变异重建一次），工作结束后都已 `DROP DATABASE`；闸方第一轮修订用 `m3fix_lane`（新建库，按 `tasks-realdb.yml` 的 `MIGRATION_EXCLUDE` 跑全部迁移，共 421 条，含 `zzzz20260930090000_create_task_comments`）。两个库在各自工作结束后均已 `DROP DATABASE`，不留存。
- 迁移：`pnpm` 不可用，直接 `tsx src/db/migrate.ts`，`MIGRATION_EXCLUDE` 与 `tasks-realdb.yml` 一致（六项标准列表）。
- Node 20.20.2。

## 2. `tsc --noEmit -p .`（`packages/core-backend`）

**0 errors**（首轮、闸方第一轮、第二轮、第三轮、第四轮、第五轮修订后各跑一遍）。`tsconfig.json` 是 `"strict": false`，`exclude` 含 `**/*.test.ts`，`include` 不含 `tests/**`——`tests/tasks-auth/tasks-auth-gate.ts` 因此不在 tsc 范围内，靠 vitest 本身跑通。

遇到一处非显而易见的 TS 行为，记在这里避免下次重踩：在 `strict:false`（本仓库 `tsconfig.json` 的实际设置）下，`if (!result.ok) { … }` 对 `{ ok: true; … } | { ok: false; reason: … }` 形状的判别式联合**不总能正确收窄**（对 `validateSetParent`/`validateClearParent` 的三方合并联合、`normalizeCommentBody`、`planDeleteTask` 均复现），必须写成 `if (result.ok === false) { … }`。`task-structure.ts` 里所有这类判别式检查已统一用 `=== false` 形式。

## 3. 全量单测（`./node_modules/.bin/vitest run --config vitest.config.ts`）

闸方第四轮修订后，独立跑一遍：**Test Files 1062 passed | 173 skipped (1235)；Tests 17788 passed | 1665 skipped (19453)；0 failed**。新增 `tests/unit/task-deletion-lock-errors.test.ts`（6 格，桩掉 `db/pg`，HTTP 一格经 `usePinnedServer`）；`tasks-route-errors.test.ts` 加 1 格（`status` 恰为 500）。

闸方第三轮修订后，独立跑一遍：**Test Files 1061 passed | 173 skipped (1234)；Tests 17781 passed | 1665 skipped (19446)；0 failed**。新增 `tests/unit/tasks-route-errors.test.ts`（5 格，经 `usePinnedServer`，满足 supertest app-mode 零容忍检查——首次写成 `request(app)` 时该检查变红，已改）；`task-create.test.ts` 加 4 格。

闸方第二轮修订后，独立跑一遍：**Test Files 1060 passed | 173 skipped (1233)；Tests 17772 passed | 1665 skipped (19437)；0 failed**。比第一轮多 2 个用例，都在 `tests/unit/task-create.test.ts`（255/256 长度边界、`isPrintableId`）。本轮没有新增 `task-*.db.test.ts`，覆盖枚举与 gate 接线两条单测仍绿；gate 文件里仍直接调用 `tasksRouter()`（接线静态检查要求的字面量）。

闸方第一轮修订后，独立跑（不与任何其他进程并发）一遍：**Test Files 1060 passed | 173 skipped (1233)；Tests 17770 passed | 1665 skipped (19435)；0 failed**。本轮没有新增或改动单测文件，数字与首轮第三遍一致。`tests/unit/task-ci-coverage-enumeration.test.ts`（磁盘集合、`vitest.config.ts` exclude、`tasks-realdb.yml` 三者相等）与 `tests/unit/tasks-auth-ci-wiring.test.ts`（含 `scripts/ops/tasks-auth-ci-wiring.test.mjs`，对 `tasks-auth-gate.ts` 的静态接线检查）均绿；本轮没有新增 `task-*.db.test.ts` 文件，所以 `vitest.config.ts` 与 `tasks-realdb.yml` 不需要改。

首轮记录：跑了三遍。第一遍（`task-create.ts` 收紧之前）17769 passed；第二遍与真库 lane、`tasks-auth-gate` 并发跑时，`tests/unit/multitable-recovery-local-startup.test.ts` 一个起真实子进程判退出码的用例收到 `null`（期望 `1`），单独重跑 20/20 全绿；第三遍独立跑 17770 passed、0 failed。门 20 无 I/O harness（`tests/unit/task-pure-no-io.test.ts`）绿，本片未改 `src/tasks/` 下任何文件。

## 4. 真库 lane（`vitest.integration.config.ts`），闸方第二轮跑 8 遍

命令（每一遍相同；与 `tasks-realdb.yml` 的调用一致，只是库名不同）：

```
EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' \
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m3fix_lane \
./node_modules/.bin/vitest --config vitest.integration.config.ts run \
  tests/integration/task-p0a.db.test.ts \
  tests/integration/task-read-path.db.test.ts \
  tests/integration/task-completion-grid.db.test.ts \
  tests/integration/task-rbac-trust.db.test.ts \
  tests/integration/task-m3-tree.db.test.ts \
  tests/integration/task-m3-membership.db.test.ts \
  tests/integration/task-m3-comments-deletion.db.test.ts \
  --reporter=verbose
```

闸方第五轮修订后（库 `m3fix5_lane`），独立跑 3 遍：第 2、3 遍全绿，每遍 **7 files / 196 tests**，`socket hang up` 0 次；第 1 遍在机器 1 分钟负载 55 以上（来自本机其他进程）时，`task-rbac-trust.db.test.ts`（本分支未改的既有文件）两格因 `socket hang up`（ECONNRESET；一格直接，一格在它派生的 `tsx` 探针子进程里）变红，194/196，日志里 `socket hang up` 4 次，同一遍其余 194 格（含交接链格）全绿；同类现象与处置见 §15。按文件：数字与第四轮相同（本轮只改交接链格的断言）。

闸方第四轮修订后（库 `m3fix4_lane`），连续 5 遍独立跑，全绿，每遍 **7 files / 196 tests**，`socket hang up` 0 次。按文件：既有 93、tree 25、membership 45 未改；comments **33**（新增事务内恢复格；流式格改为交接链；预检格加持结构锁，并把不存在的 id 钉在同一界内）。流式格另在 12 个 `yes > /dev/null` 负载下单独连跑过 12 遍（第四轮的旧断言 12/12；第五轮改断言后的负载结果见 §24）。

闸方第三轮修订后（库 `m3fix3_lane`），连续 5 遍独立跑，全绿，每遍 **7 files / 195 tests**，`socket hang up` 0 次。按文件：既有 93 未改；tree **25**、membership **45**、comments **32**（comments 去掉 `INTERNAL` 兜底格，改为标题 422 格，另加代理项、流式锁、预检、精度四格）。

闸方第二轮修订后（库 `m3fix2_lane`），连续 8 遍独立跑，全绿，每遍 **7 files / 189 tests**，日志里 `socket hang up` 出现 0 次。另外对 HTTP 最多的两个文件（membership + comments）连续跑 20 遍，每遍 72/72，0 次 hang up（见 §15）。

按文件拆分（闸方第二轮后）：p0a 13、read-path 57、completion-grid 6、rbac-trust 17（既有 93，未改）；tree **24**（第一轮 17）、membership **44**（第一轮 31）、comments **28**（第一轮 14）。M3 三个文件合计 96。新增格的内容见 §13。

闸方第一轮修订后，三遍都独立跑（不与单测或其他 lane 并发），全绿：

| 遍数 | Test Files | Tests | 结果 |
|---|---|---|---|
| 1 | 7 passed | 155 passed | 全绿 |
| 2 | 7 passed | 155 passed | 全绿 |
| 3 | 7 passed | 155 passed | 全绿 |

按文件拆分的用例数（三遍一致）：

| 文件 | 用例数 | 备注 |
|---|---|---|
| `task-p0a.db.test.ts` | 13 | 既有 M2；首轮改过一处 `toEqual`（补 M3 新增详情字段），本轮未改 |
| `task-read-path.db.test.ts` | 57 | 既有 M2，未改 |
| `task-completion-grid.db.test.ts` | 6 | 既有 M2，未改 |
| `task-rbac-trust.db.test.ts` | 17 | 既有 M2，未改 |
| `task-m3-tree.db.test.ts` | 17（首轮 12） | 深度 0..4 边界 + `depth_exceeded`、self/descendant 422、任务本身/当前父/新父三边 `edit`、跨 org 404、body 校验顺序、noop、`parent-candidates`（叶子格对不可编辑任务的断言 + 同深度可编辑任务正控；他 org 同一创建者的任务不出现）、子树整体移动后子孙 `depth` 落库、转独立后本行与子孙 `depth` 落库、`parent_set`/`parent_cleared` 事件（含 `actor_id`）、`DEPTH_EXCEEDED` 时相关行不变、门 6：交叉移动、删父与设父竞态（恰一方成功、无悬空父指针）、正控、负控（负控在启动子进程前按持锁方 `(classid, objid)` 断言 `granted=true`，子进程返回后断言该键 `granted=true` 仍在且无 `granted=false` 行） |
| `task-m3-membership.db.test.ts` | 31（首轮 22） | 门 3 增删执行人 all/any×done/open 经 HTTP；每个增删执行人与切模式格子在每次操作之后、以及每次种子 `complete` 之后都断言组织范围的 any 不变量，状态翻到 done 的格子另断言 `status='done' ⇔ completed_at IS NOT NULL`；每个增删执行人格回读 `task_assignees` 与响应比对；删执行人后被删者 GET 详情 404；all→any 回读：原本未完成的两行都被写成同一时刻且等于 `tasks.completed_at`，已完成行的时间不变；关注人增删与 leave 回读；执行人/关注人软上限 422（执行人格断言行与事件都不变）；五条成员/模式写路由各一格：同 org 外人、只读关注人 404 且成员行/`version`/模式不变，已软删任务 404，创建者 200；`parent-candidates` 经 HTTP：外人、只读关注人、已软删任务 404，创建者 200；成员 id 校验；详情新字段、软删子任务不在 `children`、他 org 行即便 `parent_id` 指向本任务也不在 `children` |
| `task-m3-comments-deletion.db.test.ts` | 14（首轮 9） | 评论增删改查；跨任务评论 id 对作者与非作者都 404 且库内评论不变；非作者 404；已是墓碑时 404；作者被移出任务后改/删自己的评论 404 且评论不变；分页（含 `offset='100000000000000000000'`、`'1e3'`、`'2147483648'`、`limit='2147483648'` 为 422，`offset='2147483647'` 通过）；并发：任务被未提交软删时，POST/PATCH/DELETE 评论各一格——先确认写在等行锁，软删提交后 404 且库内无新评论、无改动、无多余事件；持评论行锁的一方把评论改成墓碑后提交，等待中的 PATCH/DELETE 404 而不是 500；软删 `HAS_CHILDREN`/creator-only/二次删除 404 |

**合计 155 个用例**：M3 新文件 62 个（17+31+14，首轮 43 个），既有 93 个（13+57+6+17）不受影响。

首轮记录：7 files / 136 tests，三遍全绿（后两遍与全量单测并发）。

## 5. `tests/tasks-auth/tasks-auth-gate.ts`（独立 harness，`vitest.tasks-auth.config.ts`）

```
DATABASE_URL=postgresql://postgres@127.0.0.1:5432/m3fix_lane \
RBAC_BYPASS=false RBAC_TOKEN_TRUST=false PRODUCT_MODE=plm-workbench RBAC_OPTIONAL='' TASKS_ENABLED=true \
./node_modules/.bin/vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts --reporter=verbose
```

闸方第五轮修订后 1 遍，**23 passed (23)**（库 `m3fix5_lane`）。本轮只改 gate 文件里的两处注释（gate 1 租户来源格、gate 2/16 的夹具说明），不改任何断言。

闸方第四轮修订后连续 2 遍，每遍 **23 passed (23)**；每遍前后查 gate 夹具留存（用户、`tasks_*` 角色与 role_permissions、user_roles、user_orgs、admissions、任务），前后全为 0。本轮未改 gate 文件。

闸方第三轮修订后连续 3 遍，每遍 **23 passed (23)**；每遍前后按 `leftover.sh` 查 gate 夹具留存（`@tasks-auth-gate.test` 用户、`tasks_*` 角色与 role_permissions、user_roles、user_orgs、admissions、任务），前后全为 0（留存复现与清扫见 §17 R3-TAM-2）。

闸方第二轮修订后连续 3 遍，每遍 **23 passed (23)**（新增 `gate 1: an x-tenant-id header cannot supply the org when the token has no tenant claim`，见 §13 M3R2-AUTHZ-3）；文件改用共享监听端口与 `Connection: close`（§15）。

闸方第一轮修订后 **22 passed (22), 0 failed**（首轮 9）。闸方第一轮修订期间，在未变异的源码上共跑 11 遍（含最终一遍），均 22/22。与 M3 相关的格子：

- 文件内一张 13 条 M3 路由的表（11 条写、2 条读），下面几格都按这张表逐条跑，不再是「每类挑一条代表」。
- `gate 1: a read with no tenant is org_missing and a write is 422`：无 org 时 11 条写路由逐条 422 `ORG_MISSING`，2 条读路由逐条 404 `NOT_FOUND`；同一夹具用户补上 `user_orgs` 与带 `tenantId` 的 token 后，13 条路由在真实数据上逐条 200（每条路由单独建任务，`leave` 先把自己加为关注人，评论改/删先建一条评论）。
- 新增 `gate 2/16: every M3 route`（`it.each`，每条路由一个用例，共 13 个）：四个固定授权的用户（三种角色：无 admission、错码、对照；错码分只读与只写两个用户），整个块内不改授权，避免 RBAC 缓存干扰：
  - 有两个码、有 `user_orgs`、**无** namespace admission ⇒ 403；
  - 有 admission 与 `user_orgs`，但只有另一个码（写路由只给 `tasks:read`，读路由只给 `tasks:write`）⇒ 403，用来发现路由挂错码；
  - 两个码、admission、`user_orgs` 齐全 ⇒ 在自己建的数据上 200。
- 保留首轮的 `an M3 write route is 403 without namespace admission and 200 once it is granted`（POST followers）与跨 org 的 `gate 1: a write whose tenant claim is a different org is 422`（PATCH completion-mode）。

## 6. 迁移 `down()`/`up()` 往返

**部署顺序（闸方第二轮 M3R2-MIG-2）**：迁移 `zzzz20260930090000_create_task_comments` 用不带 `IF NOT EXISTS` 的 `CREATE TABLE` / `CREATE INDEX`（与 P0-A 迁移同形）。`scripts/ops/staging-migration-alignment-report.mjs` 会把它归为 `do_not_run_full_migrate`；而 staging window-runner 的 `action=deploy` 是先换镜像（`compose up -d backend web`）、等健康检查，之后才在对齐门上失败。所以含本迁移的 SHA 在 staging 上**必须先跑 `action=migrate`（备份、克隆演练、应用），再跑 `action=deploy`**；顺序反过来，staging 会运行 M3 代码而没有 `task_comments` 表，`TASKS_ENABLED=true` 时评论路由全部失败。本片保持与 P0-A 相同的裸 `CREATE`，不改迁移；DDL PR 的正文需要写同样的顺序说明。

本迁移在闸方第二轮也没有改动；新增的 DDL 钉子格（§13 M3R2-MIG-3）在真库上逐条验证了三条 CHECK、外键及其 `ON DELETE CASCADE`、索引列。

首轮手动验证（不在自动化测试里，作为 DDL PR 的例行检查）：`tsx src/db/migrate.ts --rollback` 成功回滚 `zzzz20260930090000_create_task_comments`（`task_comments` 表消失，`kysely_migration` 记录清除），再次 `tsx src/db/migrate.ts` 成功重建，表结构与列/CHECK/索引/FK 与迁移源码一致。闸方第一轮修订没有改迁移，本轮未重做往返。

## 7. 未能验证 / NOT RUN

- **CI 用 postgres:16，本地只有 15.17**：未在 16 上跑过；两版本在本片用到的特性上（`jsonb`、`CHECK`、`pg_advisory_xact_lock`、`FOR SHARE`/`FOR UPDATE` 行锁、`pg_blocking_pids`、`ANY($1)`）预期无差异，但未实测。`task-*.db.test.ts` 未针对 postgres 16 的 `pg_locks`/`hashtext` 输出做交叉核验。
- 门 9（deny 注错，P2 投影）：契约 §7 注明「首个可跑 = M5」，M3 不涉及，NOT RUN，不计分。
- 锁序控件（结构 → canonical fence → 投影 三步顺序的包装器）：契约与锁 §6.4 注明 P2 前 NOT RUN，本片未实现。
- `RBAC_TOKEN_TRUST`/`RBAC_OPTIONAL` 残留披露：按 §13-1d 既定不加固，未在本片重新评估。
- 迁移往返本轮未重做（迁移未改，见 §6）。
- **已知残留（M3-CONC-6 的范围之外）**：评论写的任务行锁只对「任务软删」排序。删执行人/关注人（除非状态翻转）不改 `tasks` 行，所以「评论写」与「同时进行的成员移除」之间没有排序；评论写用的是事务开始前刚检查过的 `comment` 能力。契约 §2 已记。
- **传输层偶发（已处理，见 §15）**：下面这段是闸方第一轮的记录。其中「未改源码时未再现」的说法不成立：闸方第二轮在未改动的 `9015f9eec0` 上 6 遍完整 lane 有 1 遍出现两格 `socket hang up`（M3R2-CONC-6）。本轮已改为每个文件一个监听端口、每个请求 `Connection: close`，证据见 §15。原记录：闸方第一轮的约 70 次变异运行中，出现过 2 次 supertest 请求 `socket hang up`（`ECONNRESET`），一次在 `task-m3-membership` 的 `POST assignees rejects "." and ".."` 格，一次在 `tasks-auth-gate` 的 gate 1 格。两次都不影响变异判定（前者该变异另有真实断言失败；后者该变异按预期应存活，重跑后 22/22 通过，见 §12）。未改源码时，`task-m3-membership`+`task-p0a`+`task-read-path` 连续 15 遍、`tasks-auth-gate` 共 11 遍、完整 lane 3 遍，均未再现。原因未深究（疑似 Node 20 keep-alive 连接复用与 supertest 每请求一个临时端口的组合），记在这里供 CI 出现同类红时对照。

- **闸方第二轮新增的 NOT RUN / 未处理**：
  - ~~M2 `POST /api/tasks` 的 `title` 含 U+0000 时仍会落到数据库报错~~：闸方第三轮已改为 422 `INVALID_TITLE`（M3R3-IN-3，见 §17）；`sendError` 兜底改由单测 `tests/unit/tasks-route-errors.test.ts` 触发。
  - 软删的行锁语句有上限且可重试；同一任务上评论写持续不断时，**创建者**的每次重试都会在约 3 秒后得到 `TASK_BUSY`（闸方第三轮起是整条语句限时，见 §17 M3R3-LOCK-1；第二轮这里写的「重试会得到 `TASK_BUSY`」在第二轮的 `lock_timeout` 方案下并不成立）。
  - 成员 id 长度上限只在应用层；没有加对应的表级 CHECK（需要新迁移，留给以后）。
  - 软删行锁等待上限（3 秒）与 409 `TASK_BUSY` 只在本地 PG 15.17 上验证；「`FOR KEY SHARE` 在 `FOR UPDATE` 排队时仍被立即授予」这一行为也只在 15.17 上实测（§13 M3R2-CONC-1 的探针），未在 16 上跑。
  - 前端：`COMMENT_INVALID_CHAR` 与 `TASK_BUSY` 已由前端 PR #6159 的提交 `169b7f6906`（分支 `claude/tasks-m3-frontend`，「handle COMMENT_INVALID_CHAR and TASK_BUSY」）映射成中文提示。**这两个码上，本后端分支与 #6159 必须成对合并**：只合其一，前端会对这两个码显示通用失败文案，或映射一个后端从不返回的码。本分支不碰 `apps/web`。闸方第三轮新增或扩大的前端相关项见 §17 末尾。
  - M3R2-AUTHZ-7（评论写与同时进行的成员移除之间没有排序）按 §16 记录，不改代码。

## 8. 任务 C 遗留措辞（契约 §5 要求本片改）

- `docs/development/task-c-m3-pure-functions-design-20260928.md` §6 标题与首句：`待 owner 裁定` → `A1–A7 已于 2026-09-28 接受`，引用来源改为 `task-c-m3-pure-functions-verification-20260928.md`（该文件末段已有「A1–A7 已由 owner 于 2026-09-28 接受」原话，本次只是把设计文档本身的措辞与之对齐，不是新裁决）。
- `packages/core-backend/tests/unit/task-completion.test.ts`：A7 那组 `describe` 标题从 `"…records the flip"` 前缀 `"…with all-null rows…"` 改为 `"…whose recompute no longer counts as done…"`，不再暗示条件是「全空行」。

## 9. 本片做出的、契约原文未写的取舍（决策清单）

逐条见 `task-m3-backend-design-20260928.md` 正文里对应位置的行内说明，此处汇总：

1. **`tasks.version` 只在 `status` 真翻转时 +1**（§2、§3.3、§3.4）。设父/转独立/移动不碰 `version`。切模式若同时改 `completion_mode` 与 `status`，一条 `UPDATE` 一次 `version+1`，不会算两次。
2. **评论的增删改不经结构锁，但各自在一个事务里先对任务行取 `FOR KEY SHARE`；软删在结构锁之后对任务行取 `FOR UPDATE`**（§2，闸方第一轮 M3-CONC-6 引入、闸方第二轮 M3R2-CONC-1 收窄）：只有树/成员/完成态改动共用 `acquireTaskStructureLock`。评论 POST/PATCH/DELETE 各用一个 READ COMMITTED 事务，先 `SELECT … FROM tasks WHERE id AND org_id AND deleted_at IS NULL FOR KEY SHARE`（0 行 ⇒ 404），再写评论；PATCH/DELETE 的 `UPDATE … WHERE deleted_at IS NULL` 仍处理评论本身的并发删除。这两种锁只互相冲突，完成/重开/切模式/成员/设父等只改非键列的写与评论写不冲突。软删等这一行锁最多 3 秒，超时 409 `TASK_BUSY`。没有采用「把存活条件并进写语句」：那是快照读，不等待未提交的软删。
3. **`GET /api/tasks/:id/parent-candidates` 用 `tasks:read` + 对目标任务 `edit`**（不是 `view`）：候选列表是为了挑新父，没有编辑权限看它没有意义，与设父端的口径一致。这是一个未在两轮审阅评论里点名、由本片自行决定的取舍。
4. **成员 id 校验（可打印、非 `.`/`..`）是单一共享校验器，应用在每一个成员 id 入口**：导出为 `task-create.ts` 的 `isValidMemberId`，`POST /api/tasks` 的 `assignees` 字段（含省略时插入的 creator 行）与 M3 的加执行人/加关注人路由都调这一个函数。这是对既有 M2 端点 `POST /api/tasks` 的一个行为变更：此前 `.`/`..` 能通过该端点的校验，现在不能。
5. **`user_orgs` 目标用户跨 org 校验（M4 裁决包 R17）未实现**：不在闸方点名的两条评论范围内，owner 未裁决，契约文末「未采纳/推迟」已记。
6. **`toCommentView` 未加 `editedAt`**：维持六字段，`edited_at` 列仍写入但不对外暴露，契约文末已记理由。
7. **删人促成完成时缺一个「完成」事件（任务 C 的 N1 窄问）**：未自行发明新事件名去填，留给 owner 在 M4 裁决包表态，契约 §3.3 已记录空白的位置。
8. **署名行**：提交信息以 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` 结尾，按本任务的书面指令。
9. **评论分页 `offset` 上界取 2^31−1**（闸方第一轮 M3-CF-1）：`limit`/`offset` 只接受十进制数字、且是 JS 安全整数、且不超过 2147483647，否则 422 `INVALID_PAGE`。Postgres 把 `LIMIT`/`OFFSET` 参数按 `bigint` 处理；上界取在 `Number()` 精确范围之内，JS 侧比较可靠。
10. **非可打印 id 一律在 SQL 之前拦下**（闸方第二轮）：路径 id ⇒ 404，请求体 `parentId` ⇒ 422 `INVALID_PARENT`（空串也从原来的 404 变成 422），评论正文含 U+0000 ⇒ 422 `COMMENT_INVALID_CHAR`（新码，选择拒绝而非剥除）。`sendError` 只原样回 4xx 的服务错误，其余 500 `INTERNAL` 并记日志。
11. **成员 id 上限 255**（闸方第二轮）：`isValidMemberId` 一处生效于所有入口，包括 `POST /api/tasks` 省略 `assignees` 时插入的 creator 行——token `sub` 超过 255 的调用者建任务变成 422（M2 行为变更）。

## 10. 变更文件清单

- `docs/development/task-m3-backend-design-20260928.md`（新增，契约 + 本次修订；闸方第一轮修订改 §2 评论事务说明与 §3.6 分页上界）
- `docs/development/task-m3-backend-verification-20260930.md`（本文件）
- `docs/development/task-c-m3-pure-functions-design-20260928.md`（§6 措辞）
- `packages/core-backend/src/db/migrations/zzzz20260930090000_create_task_comments.ts`（新增）
- `packages/core-backend/src/services/task-structure.ts`（新增；闸方第一轮修订：分页上界、评论写的任务行锁）
- `packages/core-backend/src/services/task-records.ts`（导出复用 helper、`getTask` 加 M3 字段、新增 `loadVisibleChildren`/`groupUserIdsByTask`）
- `packages/core-backend/src/services/task-create.ts`（`isValidMemberId` 导出，`resolveCreateAssigneeIds` 改用它）
- `packages/core-backend/src/services/task-ids-runtime.ts`（`newTaskCommentId`）
- `packages/core-backend/src/routes/tasks.ts`（M3 路由）
- `packages/core-backend/vitest.config.ts`（exclude 三条新文件）
- `.github/workflows/tasks-realdb.yml`（run-list 三条新文件）
- `packages/core-backend/tests/tasks-auth/tasks-auth-gate.ts`（M3 org-missing/admission 用例；闸方第一轮修订：13 条路由逐条的门 1/门 2/门 16 格子）
- `packages/core-backend/tests/integration/task-m3-tree.db.test.ts`（新增；闸方第一轮修订补格）
- `packages/core-backend/tests/integration/task-m3-membership.db.test.ts`（新增；闸方第一轮修订补格）
- `packages/core-backend/tests/integration/task-m3-comments-deletion.db.test.ts`（新增；闸方第一轮修订补格）
- `packages/core-backend/tests/integration/task-p0a.db.test.ts`（一处 `toEqual` 补 M3 字段）
- `packages/core-backend/tests/unit/task-ids-runtime.test.ts`（新增）
- `packages/core-backend/tests/unit/task-create.test.ts`（`.`/`..` 拒绝用例；闸方第二轮：255/256 长度边界、`isPrintableId`）
- `packages/core-backend/tests/helpers/tasks-http-harness.ts`（闸方第二轮新增：每个文件一个监听端口、`Connection: close` 的 HTTP 客户端、原样发送路径的 `rawRequest`、会在 `afterAll` 清理的 RBAC 夹具）。不是 `task-*.db.test.ts`，不需要登记进 `vitest.config.ts` 与 `tasks-realdb.yml`；本轮也没有新增 db 测试文件。
- `packages/core-backend/tests/unit/task-completion.test.ts`（A7 `describe` 标题措辞）
- `packages/core-backend/tests/unit/tasks-route-errors.test.ts`（闸方第三轮新增：`sendError` 兜底的单测，桩掉服务层；第四轮加 `status:500` 一格）
- `packages/core-backend/tests/unit/task-deletion-lock-errors.test.ts`（闸方第四轮新增：软删行锁语句的错误码收窄，桩掉 `db/pg`）

## 11. 闸方第一轮 25 项处置

| 项 | 级别 | 处置 | 落点 |
|---|---|---|---|
| M3-AUTHZ-1 | P1 | 修测试：叶子格断言不可编辑任务不在候选里（深度不排除它，只有编辑过滤能排除），并加同深度可编辑任务的正控 | tree：`parent-candidates excludes self/descendants/depth-violators…` |
| M3-AUTHZ-2 | P2 | 补测试：五条成员/模式写路由各一格，外人、只读关注人 404 且行不变，已软删任务 404，创建者 200 | membership：`row-level 404 on the five membership/mode writes` |
| M3-AUTHZ-3 | P2 | 补测试：作者被移出任务后改/删自己的评论 404，评论不变 | comments：`an author who has since lost access…` |
| M3-AUTHZ-4 | P2 | 补测试：`parent-candidates` 经 HTTP，外人、只读关注人、已软删任务 404，创建者 200 | membership：`GET /api/tasks/:id/parent-candidates row-level guard over HTTP` |
| M3-AUTHZ-5 | P2 | 补测试：软删一个可见子任务后它不在 `children` | membership：`a soft-deleted child disappears from children…` |
| M3-AUTHZ-6 | P2 | 补测试：13 条路由逐条的无 org 422/404、无 admission 403、错码 403、200 对照 | tasks-auth-gate：gate 1 + `gate 2/16: every M3 route` |
| M3-CONC-1 | P2 | 补测试：删父与设父竞态，第三方连接持结构锁、两条生产调用都确认在等锁后放锁；恰一方成功、无悬空父指针 | tree：`gate 6: a race between deleting a parent and reparenting its child…` |
| M3-CONC-2 | P2 | 补测试：每个增删执行人/关注人格回读行并与响应比对；删执行人后被删者 GET 404 | membership：门 3 各格、followers/leave 格 |
| M3-CONC-3 | P2 | 补测试：all→any 回读每行时间与 `tasks.completed_at`；新增组织范围 `status='done' ⇔ completed_at IS NOT NULL` 断言 | membership：`all -> any while open with someone already complete…` |
| M3-CONC-4 | P2 | 补测试：带子孙的子树移到更深的父下，子孙 `depth` 落库；中层节点转独立，本行 `parent_id IS NULL`、`depth=0`、子孙 `depth` 落库 | tree：`moving a subtree…`、`clearing the parent of a mid-level node…` |
| M3-CONC-5 | P3 | 补测试：持评论行锁的一方改墓碑后提交，等待中的 PATCH/DELETE 404；原先「顺序墓碑」格改标题，不再声称覆盖该谓词 | comments：`a concurrent tombstone makes an in-flight PATCH/DELETE 404…` |
| M3-CONC-6 | P3 | **改生产代码**：评论 POST/PATCH/DELETE 在事务内先对任务行取 `FOR SHARE`（理由见 §9 第 2 条与契约 §2）；补测试：三条评论写各一格竞态 | `task-structure.ts` `lockLiveTaskForShare`；comments：`… waits behind a concurrent uncommitted soft delete…` |
| M3-CONC-7 | P3 | 修测试：负控按持锁方 `(classid, objid)` 先断言 `granted=true`，子进程后断言该键无 `granted=false` 行 | tree：`gate 6 negative control…` |
| M3-CONC-8 | NIT | 补测试：`parent_set`/`parent_cleared` 事件各一条，`actor_id` 是操作者 | tree：移动与转独立两格 |
| M3-CF-1 | P2 | **改生产代码**：`limit`/`offset` 须是十进制、JS 安全整数且 ≤ 2^31−1，否则 422 `INVALID_PAGE`；补坏输入 | `task-structure.ts` `parseBoundedInt`；comments：分页格 |
| M3G-1 | P2 | 同 M3-AUTHZ-2（外人与只读关注人两格另断言成员行、`version`、模式不变） | 同上 |
| M3G-2 | P2 | 同 M3-AUTHZ-6（gate 1 覆盖全部 11 条写路由，同夹具换有效 org 逐条 200） | 同上 |
| M3G-3 | P2 | 同 M3-CONC-3 | 同上 |
| M3G-4 | P2 | 同 M3-CONC-4；另补「高 2 的子树挂到深度 2 的节点下 ⇒ 422 `DEPTH_EXCEEDED`，相关行不变」 | tree：`DEPTH_EXCEEDED leaves every row … unchanged` |
| M3G-5 | P2 | 补测试：他 org 同一创建者的任务不在候选里；外人/只读关注人 404 同 M3-AUTHZ-4 | tree：`parent-candidates excludes another org's tasks…` |
| M3G-6 | P2 | 同 M3-AUTHZ-3；跨任务格改为作者与非作者各试一次，并回读库内评论不变，标题不再声称可观察到检查先后（两者都是同一个 404，先后不可观察） | comments：`a comment id from another task is 404 for its author and for a non-author…` |
| M3G-7 | P3 | 同 M3-CONC-7 | 同上 |
| M3G-8 | P3 | 同 M3-AUTHZ-5；另补他 org 行指向本任务时不在 `children` | membership：`a row in another org that points at the task…` |
| M3G-9 | P3 | 同 M3-CONC-8；补执行人软上限（已有 50 行时加人 422 `LIMIT`，行与事件不变） | membership：`assignee soft limit is 422 LIMIT and writes nothing` |
| M3G-10 | NIT | 补断言：每次种子 `complete` 之后都断言 any 不变量（含 `any -> all` 格与两次种子 `complete` 之间）；§4 表格措辞同步 | membership：门 3 与切模式各格 |

## 12. 变异证明（闸方第一轮修订）

做法：每个变异对源文件做一次精确字符串替换（先断言恰好命中 1 处），先备份，再跑最窄的那个 lane 文件（或 `tasks-auth-gate`），跑完从备份复制回去并用 `cmp` 确认与备份逐字节相同。全程顺序执行，不与其他测试并发；没有用 `git checkout`/`reset`/`stash`/`clean`。68 个变异结束后，五个被变异过的源文件（`task-structure.ts`、`task-records.ts`、`routes/tasks.ts`、`task-tree.ts`，以及门 6 负控自己改写的 `task-advisory-locks.ts`）的 md5 与开跑前一致。

变异跑完之后，`task-m3-membership.db.test.ts` 的 noop 格又补了两条断言（第一次空操作后的 any 不变量、两次空操作都不写成员事件），只增不减，不影响下表的判定；最终的 lane 三遍与 gate 是在这之后跑的。

结果：预期变红的 66 个全部变红；预期存活的 2 个都存活（其中一个首跑遇到 §7 的传输层偶发而红，重跑后存活）。

| # | 守卫 | 变异 | 跑的文件 | 变红的用例（失败断言） |
|---|---|---|---|---|
| 1–5 | 五条成员/模式写路由的行级 `edit`（`addAssignee`/`removeAssignee`/`switchCompletionMode`/`addFollower`/`removeFollower`） | 删掉 `assertRowAbility(…'edit')` 那一行，每条单独跑 | membership | 各自路由的 `row-level 404 …` 格（外人 200≠404） |
| 6–10 | 同上 | `'edit'` 改 `'view'`，每条单独跑 | membership | 各自路由的 `row-level 404 …` 格（只读关注人 200≠404） |
| 11 | `parent-candidates` 任务级 `edit` | 删掉该行 | membership | `GET … parent-candidates row-level guard over HTTP`（外人 200≠404） |
| 12 | 同上 | `'edit'` 改 `'view'` | membership | 同上（只读关注人 200≠404） |
| 13 | `parent-candidates` 逐候选 `edit` 过滤 | `'edit'` 改 `'view'` | tree | `parent-candidates excludes self/descendants/depth-violators…`（叶子格出现不可编辑任务） |
| 14 | 同上 | 过滤恒真 | tree | 同上 |
| 15 | `parent-candidates` 的 org 谓词 | `org_id = $1` 改恒真 | tree | `parent-candidates excludes another org's tasks…` |
| 16 | 评论 PATCH 的任务级 `comment` 能力 | 删掉该行 | comments | `an author who has since lost access…`（PATCH 成功） |
| 17 | 评论 DELETE 的任务级 `comment` 能力 | 删掉该行 | comments | 同上（DELETE 成功） |
| 18 | 详情 `children` 的 `deleted_at IS NULL` | 删掉该条件 | membership | `a soft-deleted child disappears from children…` |
| 19 | 详情 `children` 的 org 谓词 | `org_id = $2` 改恒真 | membership | `a row in another org that points at the task…` |
| 20 | 加执行人 `INSERT` | 换成不写的 `SELECT` | membership | 门 3 加执行人 4 格（回读行数不符） |
| 21 | 删执行人 `DELETE` | 换成不写的 `SELECT` | membership | 门 3 删执行人 5 格 |
| 22 | 加关注人 `INSERT` | 换成不写的 `SELECT` | membership | 关注人增删格、leave 格 |
| 23 | 删关注人 `DELETE` | 换成不写的 `SELECT` | membership | 关注人增删格 |
| 24 | leave 的 `DELETE` | 换成不写的 `SELECT` | membership | leave 格（同次运行另有 1 格为 §7 传输层偶发） |
| 25 | 执行人软上限 | `fail(422,'LIMIT')` 条件恒假 | membership | `assignee soft limit is 422 LIMIT…` |
| 26 | all→any 写各行完成时间 | 删掉 `writeChangedAssignees` 调用 | membership | `all -> any … ONE shared instant`（B 行仍为 null） |
| 27 | all→any 成 done 时写 `tasks.completed_at` | done 分支写成 NULL | membership | 同上（`tasks.completed_at` 为 null） |
| 28 | 子孙 `depth` 写回 | 删掉该 `UPDATE` | tree | 子树移动格、转独立格 |
| 29 | 转独立写 `parent_id = NULL` | 改成保留原父 | tree | 转独立格 |
| 30 | `parent_set`/`parent_cleared` 事件 | 条件恒假 | tree | 子树移动格、转独立格 |
| 31 | `validateSetParent` 的子树高度项（`src/tasks/task-tree.ts`） | 去掉 `+ height` | tree | `DEPTH_EXCEEDED leaves every row … unchanged`（撞 `tasks_depth_chk`，不是 422） |
| 32 | `DELETE /api/tasks/:id` 的结构锁 | `withOrgStructure` 换成不取锁的普通事务 | tree | `gate 6: a race between deleting a parent and reparenting…`——红在「两条生产调用都在等锁」这一步超时（删除不再等锁），不是红在悬空指针断言；该竞态在有锁时两种先后都被断言 |
| 33 | 评论 PATCH 的 `deleted_at IS NULL` | 删掉该条件 | comments | `a concurrent tombstone makes an in-flight PATCH/DELETE 404…`（撞墓碑 CHECK，非 404） |
| 34 | 评论 DELETE 的 `deleted_at IS NULL` | 删掉该条件 | comments | 同上（对墓碑再写一次，返回成功而非 404） |
| 35–37 | 评论 POST/PATCH/DELETE 的任务行锁 | 各自删掉 `lockLiveTaskForShare` 调用，每条单独跑 | comments | 各自的 `… waits behind a concurrent uncommitted soft delete…` 格（写不再等待） |
| 38 | 任务行锁的锁强度 | `FOR SHARE` 改 `FOR KEY SHARE` | comments | 上面三格同时变红（`FOR KEY SHARE` 不与软删的行锁冲突） |
| 39 | 评论与任务的绑定（`loadCommentForTask` 的 `task_id` 比较），**单独** | 删掉 `task_id` 比较 | comments | **存活（预期）**：`UPDATE … AND task_id = $2` 仍然让跨任务的写命中 0 行 ⇒ 404，两处互为冗余，单独去掉一处观察不到 |
| 40 | 同上，**两处一起** | 删掉 `task_id` 比较，且 PATCH 的 `task_id = $2` 改恒真 | comments | `a comment id from another task is 404 for its author and for a non-author…`（作者经他任务 URL 改成功） |
| 41 | 分页上界 | 删掉安全整数/上界检查 | comments | 分页格（`offset='100000000000000000000'` 落到数据库报 bigint 越界，不是 422） |
| 42–54 | 13 条 M3 路由各自的 `rbacGuard` | 删掉该路由的 `rbacGuard(...)`，每条单独跑 | tasks-auth-gate | 各自路由的 `gate 2/16: every M3 route` 格（无 admission 用户不再 403）；POST followers 另使首轮的 admission 格变红 |
| 55–67 | 同上 | 该路由的码换成另一个（写→`read`，读→`write`），每条单独跑 | tasks-auth-gate | 各自路由的 `gate 2/16` 格（错码用户不再 403）；PATCH completion-mode 另使跨 org 格变红 |
| 68 | `GET /api/tasks/:id/comments` 的无 org 分支 | 删掉 `if (!org) … 404` | tasks-auth-gate | **存活（预期）**：无 org 时 `orgId` 是空串，`loadTask` 的 org 条件找不到行，同样 404。首跑遇到一次传输层 `socket hang up`（§7）而红，重跑 22/22 通过。两条读路由的无 org 404 格因此只能证明行为，不能单独证明这个分支 |

## 13. 闸方第二轮 36 项处置

文件简称：tree = `task-m3-tree.db.test.ts`，membership = `task-m3-membership.db.test.ts`，comments = `task-m3-comments-deletion.db.test.ts`，gate = `tests/tasks-auth/tasks-auth-gate.ts`。「变异」列指 §14 的编号。

| 项 | 级别 | 处置 | 落点 | 变异 |
|---|---|---|---|---|
| M3R2-AUTHZ-4 / CONC-3 / CF-5 / TM-5 / MIG-1 | P2 | **改生产代码**：`loadTask`、`getTask`、`loadCommentForTask`、软删的行锁函数在 SQL 前对 id 做可打印检查，不合格 404；`parseParentBody` 对非可打印字符串 422 `INVALID_PARENT`；评论正文含 U+0000 422 `COMMENT_INVALID_CHAR`（契约 §3.6 新码）；`sendError` 只回显 4xx 服务错误，其余 500 `INTERNAL` 并记日志。补测试：22 条路由/路径格经 `node:http` 发 `%00`，三条正文格，服务层 `parentId`/任务 id/正文格，`INTERNAL` 兜底格 | `task-records.ts`、`task-structure.ts`、`routes/tasks.ts`；comments `U+0000 in any task id…`、`POST rejects a body containing U+0000…`、`an unexpected error is 500…`；tree `422 INVALID_PARENT on a parentId that is not a printable id…`、`a task id containing U+0000…`；membership `PATCH /api/tasks/:id/parent over HTTP` | A1–A7 |
| M3R2-AUTHZ-5 / CF-6 / TM-10 | P2/P3 | **改生产代码**：`isValidMemberId` 加长度上限 255（契约 §4）。补测试：POST assignees/followers、POST /api/tasks、DELETE assignees/followers 的 256 与 3000 字符格（422、行不变），255 字符正控（写入/删除成功）；单测 255/256 与 creator 行 | `task-create.ts`；membership `member ids must be printable ids of at most 255 characters, other than "." and ".."`；`tests/unit/task-create.test.ts` | B1 |
| M3R2-CONC-1 | P2 | **改生产代码**：评论写改 `FOR KEY SHARE`；`deleteTaskById` 在结构锁后、任何读之前 `SELECT … FOR UPDATE`，这一步 `SET LOCAL lock_timeout = '3s'`，55P03 ⇒ 409 `TASK_BUSY`。探针（PG 15.17，原始 SQL，四个会话）：A 持 `FOR KEY SHARE`、D 的 `FOR UPDATE` 排队时，B 的 `FOR KEY SHARE` 立即授予，A 提交后 D 仍被 B 挡住（`FOR SHARE` 结果相同）；A 持 `FOR KEY SHARE` 时非键列 `UPDATE` 不等待，A 持 `FOR SHARE` 时等待。软删的行锁等待因此设了上限。补测试：删在先（持锁方按软删的两条语句）三格改写；评论在先用**生产** `deleteTaskById`（持锁方锁住评论行，让真实 `updateComment` 停在事务里）；评论停在事务里时完成、重开、再完成、加人（重开）、切模式（成 done）、设父、同 org 新建各在 2 秒内完成且都真的改了 `tasks` 行；软删超时 409 且随后同 org 新建 2 秒内完成 | `task-structure.ts` `lockLiveTaskForComment`、`lockTaskRowForDelete`；comments 并发各格 | C1–C8 |
| M3R2-CONC-4 | P3 | **改生产代码**：子孙 `depth` 一条 `UPDATE … FROM unnest($1::text[], $2::int[])`。评论写的等待现在只剩「排在未提交的软删之后」，不再加评论事务的 `lock_timeout`（软删自身的行锁等待已有上限） | `task-structure.ts` `setTaskParent`；tree 既有子树移动/转独立格 | C14、C15 |
| M3R2-CONC-5 | P3 | **改生产代码**：软删在锁都拿到之后取一次 `clock_timestamp()`，写 `deleted_at`、`updated_at` 与 `deleted` 事件 `occurred_at`（数据库时钟，与评论 `created_at` 同源）。补测试：持结构锁，软删排队，期间写一条评论，放锁后断言评论时间 ≤ 删除时间、事件按时间是 `commented` 在 `deleted` 之前、事件时间等于 `deleted_at` | comments `a comment accepted while the delete waits…` | C9、C10 |
| M3R2-CONC-7 | NIT | 补测试：子进程以 `PGOPTIONS='-c default_transaction_isolation=repeatable\ read'` 运行三条评论写的删在先竞态，先断言连接的默认隔离级别确是 `repeatable read`，再断言三条都 404 | comments `with the session default forced to REPEATABLE READ…` | C11–C13 |
| M3R2-AUTHZ-1 / TM-1 | P1→P2 | 修测试：原格换成五格，只有子任务这一边能拒绝——调用者能编辑新父，只关注或无角色于子任务；根任务上关注人/外人清父 404；当前父可编辑时关注人移动/清父 404；非编辑者发非法体 404 而非 422；均断言 `parent_id`/`depth` 不变 | tree `requires edit on the task itself, else 404 (child side only)` | D1、D2 |
| M3R2-AUTHZ-2 / CF-4 / TM-4 | P2 | 补测试：POST followers 与 POST assignees 各一格（`it.each`），`.`、`..`、空串、含空格、含 U+0000、非 ASCII、数字、`null`、数组、缺字段、超长均 422，成员行/任务行/成员事件不变 | membership `member ids must be printable ids…` | E1、E2 |
| M3R2-AUTHZ-3 | P2 | 补测试：gate 1 新格，token 无 tenant 声明、无 `user_orgs`，带 `x-tenant-id` 与 `x-org-id` 指向真实 org；调用者在该 org 的真实任务上是执行人、关注人、评论作者。11 条 M3 写路由与 `POST /api/tasks`、`/complete`、`/reopen` 422 `ORG_MISSING`，两条 M3 读路由与详情 404，列表/待办/待办数 degraded，`/api/tasks/context` 回 `{orgId:null}`，任务行与成员/评论/事件计数不变 | gate `gate 1: an x-tenant-id header cannot supply the org…` | F1 |
| M3R2-CONC-2 / TM-2 | P2 | 补测试：六条成员/模式写各一格（`it.each`），持锁方取组织结构锁，生产调用必须在同一 `(classid, objid)` 上 `granted=false` 排队且未完成，放锁后结果正确；另一格 `all → any` 与 `completeTask` 竞态，断言 any 不变量、`done ⇔ completed_at`、最终 `done/any/version 2` | membership `gate 6: the six membership/mode writes take the org structure lock` | G×6 |
| M3R2-CF-1 / TM-7 | P1→P2 / P3 | 补测试：按乱序插入（两条同一时间戳、按 id 反序插入，其中一条墓碑），断言默认页与 `limit=2` 三页拼接都等于 `(created_at, id)` 序，删除一条后 `total` 不变；CRUD 格标题去掉「order」说法，补墓碑后 `total` 仍为 1 | comments `orders items by (created_at, id) across pages…`、CRUD 格 | H1–H4 |
| M3R2-CF-2 | P2 | 补测试：经 HTTP 复刻前端循环（`limit=100&offset=rowsRead`，`rowsRead >= total` 停），205 条含 20 条墓碑，断言每页 200、`total` 为整数 205、共 3 页、并集按序等于全部 id | comments `the frontend paging loop reads every row…` | H4–H6、H8 |
| M3R2-CF-3 | P2 | 补测试：PATCH 空白、零宽、数字、`null`、数组、对象、缺字段、5001 码点、含 U+0000 各自的码，库内评论（含 `edited_at`）不变 | comments `PATCH rejects blank, over-length…` | H9 |
| M3R2-CF-7 / TM-3 | P3/P2 | 补测试：关注人列出、发表、编辑并删除自己的评论成功，改他人评论 404；同 org 外人四条路由 404 且评论不变 | comments `a follower can list, post, edit and delete…` | H10–H13 |
| M3R2-CF-9 | NIT | **改生产代码**：分页参数不是字符串（数组、对象）即 422 `INVALID_PAGE`，契约 §3.6 写明。补服务层与 HTTP 格（`limit=5&limit=abc`、`limit[]=5`、`offset=1&offset=0`） | `task-structure.ts` `parsePaginationParam`；comments 分页格与 HTTP 接线格 | H14 |
| M3R2-AUTHZ-6 | P3 | 补测试：非关注人的创建者与执行人 `POST /leave` 404，成员不变，无 `left` 事件 | membership `leave by the creator or an assignee who is not a follower…` | I1 |
| M3R2-TM-6 | P3 | 补测试：HTTP 设父后清父，响应与库内一致；HTTP 发表评论回原文且入库；`limit=1&offset=1` 取到第二条 | membership `PATCH /api/tasks/:id/parent over HTTP`；comments `GET comments?limit=1&offset=1…` | H5、H7、H15、I2 |
| M3R2-TM-8 | P3 | 补测试：子孙全为软删的任务按叶子移动（S4）；创建者/执行人 leave 404（S14，同 AUTHZ-6）；真实增删执行人写 `assignee_added`/`assignee_removed`，含 `actor_id` 与 `payload.targetUserId`（S15/S16）；嵌套任务完成后详情的 `parentId`/`depth`/`version`，父详情 `children` 的 `status`/`completionMode`/`depth`（R4/R9/R7/X6）；PATCH 后 `edited_at` 非空（S22） | tree `a task whose only descendants are soft-deleted…`；membership `assignee events`、`detail fields on a nested task…`；comments CRUD 格 | I3–I12 |
| M3R2-MIG-3 | P3 | 补测试：真库上逐条违例 INSERT（四种 id、作者、墓碑两向、外键）断言 SQLSTATE 与约束名；外键 `confdeltype='c'` 指向 `tasks` 且硬删任务后评论消失；索引列为 `(task_id, created_at)`；约束名集合 | comments `task_comments DDL` | S1–S7 |
| M3R2-TM-11 | NIT | 修注释：说明该格的 403 与 200 用同一用户、依赖 admission 读取不走缓存；独立用户的纪律在下面的逐路由块 | gate | — |
| M3R2-CONC-6 | P3 | 修测试夹具：新增 `tests/helpers/tasks-http-harness.ts`，membership、comments、gate 三个文件各起一个监听端口（`beforeAll` 起、`afterAll` 关），每个请求 `Connection: close` + `keepAlive:false` 的 agent，`rawRequest` 同样；§7 的错误说法已更正 | 见 §15 | — |
| M3R2-TM-9 | P3 | 修测试夹具：`createActorFixture` 记录每个建过的用户，`afterAll` 删除 admission、user_roles、user_orgs、users、role_permissions、roles。验证：清掉之前留下的 88 个用户后跑 membership 文件，`@tasks-m3mem.test` 用户、`role_usr*` 角色、对应 role_permissions/admission 都是 0 | membership、comments | — |
| M3R2-MIG-2 | P3 | 只改文档：§6 写明 staging 必须先 `action=migrate` 再 `action=deploy`；迁移保持与 P0-A 同形 | §6 | — |
| M3R2-AUTHZ-7 | NIT | 不改代码，见 §16 | §16 | — |

## 14. 变异证明（闸方第二轮修订）

做法同 §12：精确字符串替换（先断言恰好命中 1 处）→ 备份 → 跑最窄的 lane 文件（或 gate）→ 从备份复制回去 → `cmp` 逐字节相同。顺序执行，不与其他测试并发；没有用 `git checkout`/`reset`/`stash`/`clean`。62 个源码变异全部按预期变红，62 次还原全部逐字节相同；批次前后 `task-structure.ts`、`task-records.ts`、`task-create.ts`、`routes/tasks.ts`、`task-advisory-locks.ts`、`task-access.ts` 的 md5 一致。结构变异（S 组）不改源码：每个变异从 `m3fix2_lane` 以模板复制出 `m3fix2_mut`，在副本上改 DDL，再对副本跑 comments 文件；未改动的副本（S0）28/28 通过。

| # | 守卫 | 变异 | 文件 | 变红的用例 |
|---|---|---|---|---|
| A1 | `loadTask` 的 id 检查 | 删除 | comments+tree | `U+0000 in any task id…`；tree `a task id containing U+0000…` |
| A2 | `getTask` 的 id 检查 | 删除 | comments | `U+0000 in any task id…`（`GET /api/tasks/<id>%00`） |
| A3 | `loadCommentForTask` 的 id 检查 | 删除 | comments | 同上（`:commentId` 含 `%00`） |
| A4 | 软删行锁函数的 id 检查 | 删除 | comments | 同上（`DELETE /api/tasks/a%00b`） |
| A5 | `parseParentBody` 可打印检查 | 改回 `typeof === 'string'` | tree+membership | tree `422 INVALID_PARENT on a parentId that is not a printable id…`；membership `PATCH … parent over HTTP` |
| A6 | 评论正文 U+0000 检查 | 删除 | comments | `U+0000 in any…`、`PATCH rejects…`、`POST rejects a body containing U+0000…` |
| A7 | `sendError` 兜底 | 回显原 `code` | comments | `an unexpected error is 500 { code: INTERNAL }…` |
| B1 | 成员 id 长度上限 | 删除该条件 | membership | 成员 id 块 5 格 |
| C1 | 评论写锁强度 | `FOR KEY SHARE` → `FOR SHARE` | comments | `an in-flight comment write does not block complete…` |
| C2–C4 | POST/PATCH/DELETE 评论的任务行锁（第一轮 #35–37 在新方案下重跑） | 各自删除调用 | comments | 各自的 `… waits behind a concurrent uncommitted soft delete…`；C2/C4 另使 REPEATABLE READ 格变红，C3 另使评论在先、`TASK_BUSY` 与 REPEATABLE READ 三格变红 |
| C5 | 软删行锁强度（取代第一轮 #38：方向反过来，现在软删一侧必须是 `FOR UPDATE`） | `FOR UPDATE` → `FOR NO KEY UPDATE` | comments | `a comment write in flight makes the production deleteTaskById wait…`、`… 409 TASK_BUSY…` |
| C6 | 软删行锁 | 删除调用 | comments | 同上两格 |
| C7 | 软删等待上限 | 删除 `SET LOCAL lock_timeout` | comments | `… 409 TASK_BUSY…`（8 秒内未返回） |
| C8 | 55P03 映射 | 条件不再命中 | comments | 同上（得到原始错误而非 409） |
| C9 | 软删时间戳 | `deleted_at = now()` | comments | `a comment accepted while the delete waits…` |
| C10 | `deleted` 事件时间 | 用默认 `now()` | comments | 同上 |
| C11–C13 | 三条评论写的 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` | 各自删除 | comments | `with the session default forced to REPEATABLE READ…` |
| C14 | 子孙 depth 单语句写回（第一轮 #28） | 条件恒假 | tree | 子树移动格、转独立格 |
| C15 | 转独立写 `parent_id = NULL`（第一轮 #29） | 保留原父 | tree | 转独立格 |
| D1 | 子任务一侧 `edit`（S1） | 删除该行 | tree | 根任务清父格、非编辑者非法体格 |
| D2 | 同上（X1：子任务角色在任何地方都不检查） | 删除该行，且两处 `canReparent` 的 `childRoles` 换成 `['creator']` | tree | child-side 块 5 格全部 |
| E1 | POST followers 成员 id 校验 | 换成 `String(...)` | membership | `'POST followers': …` |
| E2 | POST assignees 成员 id 校验 | 同上 | membership | `'POST assignees': …` |
| F1 | 路由 org 来源 | 改取 `req.user.tenantId` | gate | `gate 1: an x-tenant-id header cannot supply the org…` |
| G×6 | 六条成员/模式写的结构锁 | `withOrgStructure` 换成不取锁的普通事务，每条单独跑 | membership | 各自的 `… queues on the org structure lock…`；切模式另使竞态格变红 |
| H1 | 评论排序 | `created_at DESC, id DESC` | comments | 排序格、分页循环格、`limit=1&offset=1` 格 |
| H2 | 同上 | 去掉 `ORDER BY` | comments | 同上三格 |
| H3 | 同上 | `ORDER BY id DESC` | comments | 同上三格 |
| H3b | 同一时间戳的 id 决胜 | 只按 `created_at` | comments | 排序格 |
| H4 | `total` 含墓碑 | 计数加 `deleted_at IS NULL` | comments | 分页循环格、CRUD 格、排序格 |
| H5 | 路由转发 `offset` | 丢掉 | comments | 分页循环格、`limit=1&offset=1` 格 |
| H6 | 路由转发 query | 传 `{}` | comments | 同上 |
| H7 | 路由转发 `limit` | 丢掉 | comments | `limit=1&offset=1` 格 |
| H8 | `limit` 上界 100 | 改 99 | comments | 分页循环格（前端的 `limit=100` 变 422） |
| H9 | PATCH 正文校验 | 跳过 | comments | `PATCH rejects…`、`U+0000 in any…` |
| H10–H13 | 评论四条路由的能力（`view`/`comment`） | 各自改成 `edit` | comments | `a follower can list, post, edit and delete…` |
| H14 | 数组形分页参数 | 恢复「取第一个」 | comments | 分页格、HTTP 接线格 |
| H15 | 路由转发评论正文 | 换成常量 | comments | HTTP 接线格、`U+0000 in any…` |
| I1 | leave 能力 | `leave` → `view` | membership | `leave by the creator or an assignee…` |
| I2 | 路由转发设父请求体 | 换成 `{ parentId: null }` | membership | `PATCH … parent over HTTP`、嵌套详情格 |
| I3/I4 | 加/删执行人写成员事件 | 删除调用 | membership | `assignee events` |
| I5 | 树节点只取未软删 | 去掉 `deleted_at IS NULL` | tree | `a task whose only descendants are soft-deleted…` |
| I6–I8 | 详情 `parentId`/`depth`/`version` | 写成 `null`/`0`/`1` | membership | 嵌套详情格 |
| I9–I11 | `children` 的 `status`/`completionMode`/`depth` | 写成常量 | membership | 嵌套详情格 |
| I12 | PATCH 写 `edited_at` | 去掉 | comments | CRUD 格、评论在先格 |
| S1 | `task_comments_id_generated_chk` | 删除 | comments（副本库） | `task_comments DDL` |
| S2 | `task_comments_author_printable_chk` | 删除 | 同上 | 同上 |
| S3 | `task_comments_tombstone_body_cleared_chk` | 删除 | 同上 | 同上 |
| S4 | `task_comments_task_fk` 的 `ON DELETE CASCADE` | 改成无动作 | 同上 | 同上 |
| S5 | `idx_tcmt_task_time` | 删除 | 同上 | 同上 |
| S6 | 同上 | 只留 `(task_id)` | 同上 | 同上 |
| S7 | id CHECK | 弱化为 `id ~ '[!-~]'` | 同上 | 同上 |

第一轮 §12 的 #38（`FOR SHARE` → `FOR KEY SHARE` 应变红）在新方案下方向相反：`FOR KEY SHARE` 现在就是生产代码，由 C1（改回 `FOR SHARE` 应变红，因为它会挡住其他写）与 C5/C6（软删一侧必须 `FOR UPDATE`）取代。

## 15. 偶发 `socket hang up`（M3R2-CONC-6）

- 现象（闸方第二轮复现）：未改动的 `9015f9eec0` 上 6 遍完整 lane 有 1 遍 153/155，membership 文件两格 `socket hang up`（`ECONNRESET`）。这些格用 `supertest(app)`，每个请求临时起一个监听端口再关闭。
- 处理：`tests/helpers/tasks-http-harness.ts`。membership、comments、gate 三个文件各在 `beforeAll` 起一个监听端口、`afterAll` 关闭；每个 supertest 请求设 `Connection: close` 并走 `keepAlive:false` 的 agent；需要原样路径字节的请求走同一端口上的 `rawRequest`（同样 `Connection: close`）。没有一个 socket 活过它的响应，也没有跨请求复用。
- 证据（均在修复后的源码上、顺序执行、不与其他测试并发）：完整 lane 8 遍全绿（189/189 ×8）；membership + comments 20 遍全绿（72/72 ×20）；gate 3 遍全绿（23/23 ×3）；日志里 `socket hang up` 共 0 次。
- 这组证据的强度：按闸方观察到的基线（6 遍完整 lane 出 1 遍），若修复无效，8 遍完整 lane 全绿的概率约 (5/6)^8 ≈ 23%；加上 20 遍 HTTP 最密的两个文件（这两格正在其中）全绿，若失败率不变，28 遍全绿约 (5/6)^28 ≈ 0.6%。这不是证明原因已消除，只说明在本机负载下修复后没有再现；CI 上若再出现同类红，应先看是否仍是传输层。

## 16. M3R2-AUTHZ-7（K 组，记录，不改代码）

评论写只与任务软删排序，不与同时进行的执行人/关注人移除排序（契约 §2「范围」一段）；这在锁 §6.4 的模型之内（lock-then-reread 只要求结构写），契约已记为已知残留，不在本片范围。本轮把评论写的行锁从 `FOR SHARE` 收窄到 `FOR KEY SHARE`，对这一点没有影响。

## 17. 闸方第三轮 15 项处置（2026-10-01）

本轮库：新建 `m3fix3_lane`（按 `MIGRATION_EXCLUDE` 跑全部迁移），变异也在它上面跑；工作结束后已 `DROP DATABASE`。数字见 §2–§5 与本节末尾。

| 项 | 级别 | 处置 | 落点 | 变异（§18） |
|---|---|---|---|---|
| M3R3-LOCK-1 | P2 | **改生产代码**：软删取行锁那一条 `SELECT … FOR UPDATE` 前先读出当前 `statement_timeout`，用 `set_config('statement_timeout','3s',true)` 限时整条语句，成功后恢复为读出的值；57014 与 55P03 都映射 409 `TASK_BUSY`。失败时事务回滚，事务内设置随之丢弃。补测试：流式短持锁格（独立连接池，1 秒一个 `FOR KEY SHARE` 持锁者、每 400 ms 新起一个，持续最多 9 秒）断言 2500–5000 ms 内 409、等待期间结构锁确由软删持有（正控）、409 之后该 org 的结构锁 0 持有者、同 org 新建 2 秒内完成、任务未删、连接池各连接 `statement_timeout` 与测前一致；成功路径另在精度格里断言 `statement_timeout` 不残留到连接池。16/24 个评论写循环的探针保留为脚本（见 §19），不进 lane：它的结果依赖机器负载，lane 用上面这一格覆盖同一机制 | `task-structure.ts` `lockTaskRowForDelete`；comments `under a stream of overlapping comment-write row locks…`、`keeps sub-millisecond precision…` | L1–L6 |
| M3R3-IN-1 / M3R3-DOC-1 | P2 | **改生产代码**：`deleteTaskById` 在结构锁与行锁之前先做一次快照读：`created_by`（本 org、未软删），按任务 B 的真相表判 `can(…,'delete')`；无此行或无能力 ⇒ 404，不取任何锁。锁后的重读与 `planDeleteTask` 不变。补测试：评论写停在事务里（持 `FOR KEY SHARE`）时，同 org 外人与执行人各自 `DELETE`，响应（状态、正文原文、content-type、etag）与不存在 id 的响应逐项相等，且 1 秒内返回；服务层同两人 404 且 1 秒内。契约 §2、§3.7 已改顺序与 `TASK_BUSY` 行 | `task-structure.ts` `precheckDeleteAbility`；comments `a same-org outsider and an assignee get the nonexistent-id 404 at once…` | P1、P2、P2b |
| M3R3-IN-2 | P2 | **改生产代码**：`resolveCreateAssigneeIds` 逐个校验、去重后超过 `TASK_ASSIGNEE_SOFT_LIMIT`（50）⇒ 422 `LIMIT`；执行人行改为一条 `INSERT … SELECT … FROM unnest($2::text[])`。补测试：HTTP 51 与 200 个不同 id ⇒ 422 `LIMIT` 且不建任务；50 个非法 + `..` ⇒ `INVALID_ASSIGNEES`（先校验后计数）；50 个 ⇒ 200 且 50 行；51 项含一个重复 ⇒ 200 且 50 行、`assigned_by` 全是创建者。单测三格 | `task-create.ts`、`task-records.ts`；membership `POST /api/tasks: more than 50 distinct assignees…`；`task-create.test.ts` | Q1–Q3、Q1u、Q5 |
| M3R3-IN-3 | P2 | **改生产代码**：`createTask` 对规范化后含 U+0000 的标题 422 `INVALID_TITLE`（契约 §3.8）。原先用这个 500 触发 `sendError` 兜底的格改为断言 422；兜底改由新单测 `tests/unit/tasks-route-errors.test.ts` 覆盖：桩掉 `createTask`，分别抛 pg 形错误（`code:'22021'`，带 message/detail）、`status:503`、`status:422` 而 `code` 非字符串、普通 `TypeError`，四格都断言正文恰为 `{error:{code:'INTERNAL'}}` 且不含 SQLSTATE/消息；另一格 4xx 原样透传作对照 | `task-records.ts`、`tests/unit/tasks-route-errors.test.ts`；comments `POST /api/tasks with U+0000 or a lone surrogate in the title…` | T1、R1、R2 |
| M3R3-IN-4 | P3 | **改生产代码**：新增 `isStorableText`（无 U+0000，且无不成对的 UTF-16 代理项），评论正文不满足 ⇒ 422 `COMMENT_INVALID_CHAR`，标题不满足 ⇒ 422 `INVALID_TITLE`（契约 §3.6、§3.8）。补测试：POST/PATCH 评论 `\ud800`、`a\udc00b`、`x\ud83d`、`\ude00y` 均 422 且评论与事件不变；标题同样；正控：含表情（成对代理项）的评论与标题原样入库。单测覆盖边界 | `task-create.ts`、`task-structure.ts`、`task-records.ts`；comments 两格 | T2–T4 |
| R3-TAM-1 | P2 | 补测试：`r → a → {b1 → c, b2, b3}`，把 `a` 从深度 1 移到深度 2 的 `x` 下，逐行断言 `parent_id` 与 `depth`（a=2、b1=3、c=4、b2=3、b3=3）。子孙深度序列 `[3,4,3,3]` 只有一个位置不同，反转、排序、错位都会让某一行错 | tree `moving a branching subtree…` | D1 |
| R3-TAM-2 | P3 | 修测试：gate 文件的顶层 `afterAll` 按 `stamp` 统一清扫（tasks、admissions、user_roles、user_orgs、users、role_permissions、roles），每条语句独立执行。复现：修复前用变异 M17（org 回退到 `x-tenant-id` 头）跑 gate，header-tenant 格变红，库里留下 users=1、roles=1、role_permissions=2、user_roles=1、admissions=1；修复后同一变异再跑，留存全为 0 | gate | M17pre、M17post |
| R3-TAM-3 | P3 | 补断言：软删后在 SQL 内断言 `updated_at = deleted_at` 与事件 `occurred_at = deleted_at`；子树移动格断言每个子孙的 `updated_at` 等于被移动行的 `updated_at` 且比移动前晚 | comments `a comment accepted while the delete waits…`、`keeps sub-millisecond precision…`；tree 分叉格 | S2、D2 |
| R3-TAM-4 | P3 | 补测试：HTTP 坏分页参数循环加 `limit=`、`offset=`、`limit=&offset=0` | comments `GET comments?limit=1&offset=1…` | G1 |
| R3-TAM-5 | NIT | 同 M3R3-IN-3 | 同上 | R1、R2 |
| R3-TAM-6 | NIT | 修测试：`TASK_BUSY` 格上界从 8000 ms 收紧到 5000 ms（`within(…, 5000)` 且断言耗时 < 5000） | comments `deleteTaskById gives up with 409 TASK_BUSY…` | L4、L5 |
| M3R3-LOCK-2 | NIT | **改生产代码**：`UPDATE tasks AS t SET deleted_at = s.at, updated_at = s.at FROM (SELECT clock_timestamp() AS at) AS s`，事件 `occurred_at` 用 `INSERT … SELECT … deleted_at FROM tasks`；时间值不经过 JS。补测试：删三条任务，断言至少一条 `deleted_at` 的微秒部分不是 000（经 JS 往返的值全部是 000；三条都恰好是 000 的概率约 1e-9），且 `updated_at = deleted_at` | `task-structure.ts`；comments `keeps sub-millisecond precision…` | S1–S4 |
| M3R3-DOC-2 | P3 | 措辞中性化（测试标题、注释、契约文字）；整分支扫描完成 | — | — |
| M3R3-DOC-3 | P3 | 改文档：§7 该条改为指向前端 #6159 的 `169b7f6906`，并写明这两个码上前后端必须成对合并 | §7 | — |

**前端需要知道的码（本轮新增或触发条件变化）**：
- `POST /api/tasks` 新增 422 `LIMIT`（超过 50 个不同执行人）。
- `POST /api/tasks` 的 422 `INVALID_TITLE` 新增两种触发：标题含 U+0000、含不成对的代理项（此前分别是 500 与 200）。
- `COMMENT_INVALID_CHAR` 新增触发：正文含不成对的代理项。前端 `checkCommentBody`（`169b7f6906`）只预检 U+0000，这种输入会由后端回 422，前端已有的码表会显示「评论包含无法保存的字符」。
- `TASK_BUSY` 只会出现在创建者的删除上；非创建者一律是 404。
- 前端创建任务的失败提示目前是通用文案（不按码区分）；`LIMIT` 与新的 `INVALID_TITLE` 会显示为通用失败，是否细分由前端决定。

## 18. 变异证明（闸方第三轮修订）

做法同 §12/§14：精确字符串替换（先断言恰好命中 1 处）→ 备份 → 跑最窄的文件 → 从备份复制回去 → 逐字节比对。顺序执行，不与其他测试并发；没有用 `git checkout`/`reset`/`stash`/`clean`。批次前后 `task-structure.ts`、`task-records.ts`、`task-create.ts`、`routes/tasks.ts` 的 md5 一致。

| # | 守卫 | 变异 | 文件 | 结果 |
|---|---|---|---|---|
| L1 | 整条语句限时 | `statement_timeout` → `lock_timeout`（第二轮方案） | comments | 红：流式格（单个长持锁者的 `TASK_BUSY` 格仍绿——`lock_timeout` 只对单次等待有效，这正是本项的缺陷） |
| L2 | 57014 映射 | 忙码集合只留 55P03 | comments | 红：`TASK_BUSY` 格、流式格 |
| L3 | 限时 | 删掉 `set_config` | comments | 红：同上两格 |
| L4 | 3 秒上界 | `'7s'` | comments | 红：同上两格（上界 5000 ms） |
| L5 | 3 秒下界 | `'1s'` | comments | 红：同上两格（下界 2500 ms） |
| L6 | 事务内设置 | 第一个 `set_config` 的 `true` → `false`（会话级） | comments | 红：精度格（成功路径后连接池出现 `3s`）、`TASK_BUSY` 格 |
| P1 | 预检 | 删掉 `precheckDeleteAbility` 调用 | comments | 红：外人/执行人格（等 3 秒得 409） |
| P2 | 预检的能力 | `'delete'` → `'view'` | comments | **存活（等价变异）**：预检只传 `created_by`、不传执行人/关注人，所以非创建者在预检里的角色都是 `none`，`view` 与 `delete` 在这里结果相同。改用 P2b |
| P2b | 预检的能力 | 删掉能力判定那一行（只留存在性） | comments | 红：外人/执行人格 |
| S1 | 时间值不经 JS | 两列都写 `date_trunc('milliseconds', s.at)`（模拟经 JS 往返） | comments | 红：精度格 |
| S2 | `updated_at` 同值 | `updated_at = now()` | comments | 红：删除排队格、精度格 |
| S3 | 事件时间取自行 | `occurred_at` 写 `now()` | comments | 红：删除排队格 |
| S4 | 一次取值 | 两列各自 `clock_timestamp()` | comments | **存活**：同一行里两次 `clock_timestamp()` 在本机几乎总是同一微秒（单独测量：1000 行里 991 行两值相等），断言分辨不出。生产代码按一次取值写 |
| T1 | 标题可存储检查 | 删掉 `!isStorableText(title)` | comments | 红：标题格 |
| T2 | 正文可存储检查 | 改回只查 U+0000 | comments | 红：代理项格 |
| T3 | 不成对代理项的判定 | 正则放宽为任何代理项 | comments | 红：标题格与代理项格的正控（表情被拒） |
| T4 | U+0000 检查 | `isStorableText` 去掉 U+0000 一项 | comments | 红：U+0000 的四格（含标题格） |
| G1 | 空分页参数 | 空串按缺省 | comments | 红：HTTP 接线格 |
| D1 | 子孙 id/深度配对 | 深度数组 `.reverse()` | tree | 红：分叉格 |
| D2 | 子孙 `updated_at` | 保留旧 `updated_at`（M12） | tree | 红：分叉格 |
| Q1 | 创建执行人上限 | 条件恒假 | membership | 红：创建上限格 |
| Q1u | 同上 | 同上 | unit | 红：`rejects 51 distinct ids as 422 LIMIT` |
| Q2 | 上限边界 | `>` → `>=` | membership | 红：创建上限格（50 个被拒） |
| Q3 | 按去重后计数 | 用去重前的数组计数 | membership | 红：创建上限格（51 项含重复被拒） |
| Q5 | 单条 INSERT 写全部行 | `… LIMIT 1` | membership | 红：创建上限格与三格 gate 3 / 切模式格 |
| R1 | `sendError` 不回显 | 500 时回显原 `code` | unit | 红：pg 形错误、503 两格 |
| R2 | 只透传 4xx | 去掉 `status < 500` | unit | 红：503 格 |
| M17pre / M17post | gate 清扫（R3-TAM-2） | org 回退到 `x-tenant-id` 头 | gate | 两次都红（header-tenant 格）；修复前留存 users=1 等，修复后全 0 |

## 19. M3R3-LOCK-1 探针（脚本，不进 lane）

脚本 `stream-probe.mts`（本地 scratchpad，未入库）：同一任务上 N 个并发循环交替调用真实的 `addComment`/`updateComment`，0.5 秒后调用真实的 `deleteTaskById`，记录结果与耗时、紧接着该 org 结构锁的持有者数（`pg_locks`）、同 org `createTask` 耗时、以及连接池每个连接测前测后的 `statement_timeout`。PG 15.17，库 `m3fix3_lane`：

| 代码 | 循环数 | 结果（每行一次） |
|---|---|---|
| 本轮修复后 | 16 | 5 次均 409 `TASK_BUSY`，耗时 3005/3003/3002/3001/3005 ms；结构锁持有者 0；同 org 新建 1–2 ms；`statement_timeout` 前后均 `30s` |
| 本轮修复后 | 24 | 5 次均 409 `TASK_BUSY`，耗时 3004/3003/3006/3013/3006 ms；持有者 0；同 org 新建 2–11 ms；前后均 `30s` |

变异 L1（`lock_timeout` 方案）的结果以 §18 / §22 的变异行为准（lane 的流式格变红）；探针日志不进本文件。

## 20. 闸方第三轮的 NOT RUN / 未处理

- PG 16 仍未跑（同 §7）。`statement_timeout` 的事务内设置与 57014 的行为只在 15.17 上验证。
- S4（两次 `clock_timestamp()`）与 P2（预检里 `delete`→`view`）两个变异存活，理由见 §18；P2 由 P2b 替代。
- `TASK_BUSY` 的 3 秒是否改为 1 秒、客户端是否须退避重试，待 owner 定（契约 §3.7 末尾）。
- 16/24 循环探针不进 lane（见 §17 M3R3-LOCK-1）。

## 21. 闸方第四轮后端 5 项处置（2026-10-01）

本轮库：新建 `m3fix4_lane`（按 `MIGRATION_EXCLUDE` 跑全部迁移），变异也在它上面跑；工作结束后已 `DROP DATABASE`。生产代码（`src/`）零改动，只改测试与本文件。

| 项 | 级别 | 处置 | 落点 | 变异（§22） |
|---|---|---|---|---|
| M3R4-TAM-1 | P2 | **补测试，不改生产代码**。先核实现状：`precheckDeleteAbility` 在 `withOrgStructure` 之前执行，不存在的 id 在预检里就 404，不会走到结构锁——所以「不存在的 id 会卡在结构锁上」在当前代码里不成立，缺的只是能发现它被改坏的测试。预检格现在同时持有两样东西：评论写停在事务里（任务行 `FOR KEY SHARE`），以及另一个连接上的 `pg_advisory_xact_lock(hashtext(taskStructureLockKey(orgId)))`（正控：持有者数 = 1）。在这个状态下断言：HTTP 上外人与执行人各自 `DELETE` 不存在的 id 与 `DELETE` 现有任务，两个响应（状态、正文原文、content-type、etag）逐项相等，且**各自** 1 秒内返回（此前只给现有任务计时）；服务层五组（外人/执行人 × 现有任务、外人/执行人/创建者 × 不存在 id）均 404 且 1 秒内；结束时结构锁持有者仍恰为 1（这些 404 都没有取锁）。每个调用外包 5 秒 `within`，被锁住时快速变红而不是挂到用例超时 | comments `a same-org outsider, an assignee, and a missing id all get the same 404 at once while a comment write holds the row and the org structure lock is held` | K10、K09 |
| M3R4-TAM-2 | P3 | **修测试**：流式格改为交接链。第 i+1 个持锁者的 `SELECT … FOR KEY SHARE` 返回之后，才放行第 i 个持锁者 `COMMIT`（且第 i 个至少持 400 ms）；每 400 ms 起一个新的，最多 9 秒。任务行在两个持锁者之间从不空闲——这一条不取决于调度；3 秒界内换手多少次仍取决于机器。删除在第一个持锁者确认持锁之后才发出（原先是固定等 600 ms）。本轮新增的断言「交接次数 ≥ 6」按墙钟计数，闸方第五轮在负载下见到它变红；第五轮改为只断言删除等待期间至少再授予 2 个持锁者（见 §24）。负载验证（第四轮，旧断言）：12 个 `yes > /dev/null`（12 核机器），该格连跑 12 遍，12/12 绿；跑完 `yes` 已全部杀掉（`pgrep -x yes` 为 0）。L1（`lock_timeout` 方案）在新格上仍然变红 | comments `under a stream of overlapping comment-write row locks…` | L1 |
| M3R4-TAM-3 | P3 | **补测试**：新单测桩掉 `db/pg`（预检读到调用者自己建的任务；事务里那条 `FOR UPDATE` 按指定 SQLSTATE 抛错）。断言：08006、40001、57P01 原样抛出（保留原 `code`、没有 `status`，锁之后的语句没有执行）；57014 与 55P03 是 409 `TASK_BUSY`（对照）；经真实路由 `DELETE /api/tasks/:id`，08006 是 500 `{error:{code:'INTERNAL'}}` 且正文不含 SQLSTATE、消息、`TASK_BUSY`，57014 是 409 | `tests/unit/task-deletion-lock-errors.test.ts` | K24 |
| M3R4-TAM-4 | NIT | **补测试**：`internalCases` 加 `{status:500, code:'X'}`，断言 500 `INTERNAL` 且不回显。事务内恢复见下一行 | `tests/unit/tasks-route-errors.test.ts` | K22 |
| M3R4-DEL-1 | NIT | **补测试，钉住恢复**：真库格给 `tasks` 加一个只对这一条任务生效的 `BEFORE UPDATE` 触发器（`WHEN (NEW.id = … AND NEW.deleted_at IS NOT NULL)`，函数体 `pg_sleep(3.5)`），让取锁之后写 `deleted_at` 的那条 `UPDATE` 超过 3 秒。断言软删仍成功、耗时 ≥ 3500 ms（正控：触发器确实跑了）、行已软删；`finally` 里删掉触发器与函数。没有恢复那一行时，这条 `UPDATE` 在 3 秒被取消（57014）。没有往生产代码里加测试钩子 | comments `a post-lock statement that runs past the 3 s row-lock bound still succeeds…` | K03 |
| M3R4-IN-1 / IN-3 / IN-4 | P3/P3/NIT | 前端，不在本分支，#6159 另行处理 | — | — |
| M3R4-IN-2 | P3 | 推送时改写提交信息；本轮新写的提交信息不含所列措辞 | — | — |

## 22. 变异证明（闸方第四轮修订）

做法同 §12/§14/§18：精确字符串替换（先断言恰好命中 1 处）→ 备份 → 跑最窄的目标 → 从备份复制回去 → 逐字节比对（六次均一致）。顺序执行，不与其他测试并发；没有用 `git checkout`/`reset`/`stash`/`clean`。

| # | 守卫 | 变异 | 文件 | 结果 |
|---|---|---|---|---|
| K10 | 预检对不存在 id 的 404 | `if (!row) fail(404, 'NOT_FOUND')` → `if (!row) return`（不存在的 id 落入结构锁路径） | comments（预检格） | 红：`outsider missing id: still waiting after 5000 ms` |
| K09 | 预检在任何锁之前 | 把 `precheckDeleteAbility` 挪进 `withOrgStructure`（结构锁之后、行锁之前） | comments（预检格） | 红：同上 |
| K03 | 事务内恢复 `statement_timeout` | 删掉恢复那一行 | comments（恢复格） | 红 |
| L1 | 整条语句限时（在交接链格上重跑） | `statement_timeout` → `lock_timeout` | comments（流式格） | 红 |
| K24 | 忙码收窄 | catch 里无条件 `fail(409, 'TASK_BUSY')` | unit `task-deletion-lock-errors` | 红：6 格里 4 格（三个非忙码格与 HTTP 格） |
| K22 | 只透传 4xx | `status < 500` → `status <= 500` | unit `tasks-route-errors` | 红：`status exactly 500` 格 |

闸方第四轮审阅时在第三轮代码上存活的五个变异（K03、K09、K10、K22、K24）本轮全部被杀。

## 23. 闸方第四轮的 NOT RUN / 未处理

- PG 16 仍未跑（同 §7、§20）。本轮新增的两格（触发器里 `pg_sleep`、交接链）只在 15.17 上验证。
- 流式格的负载验证是本机 12 个 `yes` 下单格连跑 12 遍；整条 lane 没有在负载下重跑，也没有在 CI runner 上跑过。
- 负载没有隔离：结束时 1 分钟负载 76.8，高于 12 个 `yes` 本身能造成的量，说明机器上同时还有别的负载；这只会让条件更苛刻，但数值不可复现。
- K09/K10 的「1 秒内」断言本身没有单独做边界变异（例如改成 10 秒）；两个变异是靠 5 秒 `within` 变红的。
- M3R4-TAM-3 是桩测试：真库上没有构造「`FOR UPDATE` 以非忙码失败」的场景。
- 前端 IN-1/IN-3/IN-4 与 IN-2 的提交信息改写不在本分支本轮范围内，未做。
- S4、P2 两个等价/存活变异状态同 §20，未变。

## 24. 闸方第五轮处置（2026-10-07）

本轮库：新建 `m3fix5_lane`（按 `MIGRATION_EXCLUDE` 跑全部迁移，410 张表，含 `task_comments`），变异也在它上面跑；工作结束后已 `DROP DATABASE`。生产代码（`src/`）只改 `task-structure.ts` 里 `DELETE_ROW_LOCK_TIMEOUT` 的说明注释，零语义改动；其余是交接链格的一处断言与文档措辞。

| 项 | 级别 | 处置 | 落点 | 变异 |
|---|---|---|---|---|
| M3R5-TST-1 | P2 | **修测试**：交接链格原断言「交接总次数 ≥ 6」按墙钟计数（从第一个持锁者计到用例收尾），依赖每次迭代的延迟；闸方在负载下 20 遍里见到 1 遍变红（`expected 4 to be greater than or equal to 6`），同一遍里 409 的上下界断言都是绿的。改为：调用 `deleteTaskById` 之前记一次交接计数，在它落定那一刻（无论结果）再记一次，断言两者之差 ≥ 2——删除挂起期间至少再授予了 2 个持锁者，也就是至少有 1 个持锁者在排队的 `FOR UPDATE` 之下提交，等待确实重新开始过。格注释改为只对「行从不空闲」这一条说不取决于调度，换手多少次取决于机器。负载验证：12 个 `yes > /dev/null`（12 核机器；起跑时机器上另有负载，1 分钟负载 9.1，结束时 82.0），该格连跑 10 遍，**10/10 绿**；删除挂起期间的交接次数为 5–7（阈值 2）；删除耗时 3107–3505 ms；格耗时 3.6–5.4 s；跑完 `yes` 已全部杀掉（`pgrep -x yes` 为 0）。L1 在新断言上重跑仍红（见下） | comments `under a stream of overlapping comment-write row locks…` | L1 |
| M3R5-PUB-3 | P3 | 措辞：契约 §2、§3.7 与 `task-structure.ts` 的注释只保留规则本身——取行锁的语句整条限时 3 秒，超时 409 `TASK_BUSY`，客户端退避重试；§19 只保留修复后的结果，探针日志不进本文件 | 契约、`task-structure.ts`、本文件 §19 | — |
| M3R5-PUB-4 | P3 | 本文件第 3 行改为实际交付状态：以单提交 PR 推送；不合并；DDL 不应用到共享库；`TASKS_ENABLED` 保持关闭 | 本文件 | — |
| M3R5-PUB-6 | P3 | 预检格的标题与注释已是规则式表述，不改；提交信息在推送时改写（同 M3R4-IN-2） | — | — |
| M3R5-PUB-7 | NIT | §22 末句改为「闸方第四轮审阅时在第三轮代码上存活的五个变异」 | 本文件 §22 | — |
| M3R5-PUB-8 | NIT | 契约 §3.6 跨任务评论 id 的 404 括注改为「与评论不存在时同一个 404」 | 契约 | — |
| 另四处措辞 | — | gate 1 租户来源格的注释只写该格断言的内容；§16 缩为范围陈述并指向契约 §2；契约 §3.8 补一条成员 id 校验规则（`assignees` 各项与 creator 行都经 `isValidMemberId`，§4）；§1 的 Node 行只写版本。另把 tree 与 gate 文件里两处夹具注释改为直述做法 | gate、tree、本文件、契约 | — |

变异 L1（在新断言上重跑）：精确字符串替换（恰好命中 1 处：限时那一条 `set_config('statement_timeout', …)` → `lock_timeout`）→ 备份 → 跑交接链格 → 从备份复制回去 → 逐字节比对一致。结果：红，`bounded delete under a stream: still waiting after 3666 ms`，没有 409。

本轮验证：`tsc --noEmit -p .` 0 errors（§2）；真库 lane 3 遍，第 2、3 遍 196/196、`socket hang up` 0 次，第 1 遍 194/196（既有文件 `task-rbac-trust.db.test.ts` 两格 `socket hang up`，当时机器 1 分钟负载 55 以上，见 §4）；gate 1 遍 23/23（§5）。

NOT RUN / 未处理：PG 16 仍未跑（同 §7、§20、§23）；整条 lane 没有在负载下重跑；负载验证时机器上另有负载，数值不可复现，只会让条件更苛刻；全量单测本轮未重跑（本轮没有改单测文件与任何 `src/` 语义）；第 1 遍 lane 的两格 `socket hang up` 在第 2、3 遍没有复现，没有进一步定位，该文件不在本分支改动范围内。
