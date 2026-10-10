# 任务功能 M4 后端 PR-3c 验证记录（2026-10-08）

- 设计：`docs/development/task-m4-pr3c-backend-design-20261008.md`（DRAFT，修订 4；修订 3 只改文字，修订 4 是闸修复）。锁：`docs/development/task-feature-design-lock-20260917.md`。上游：`docs/development/task-m4-pr3a-backend-design-20260930.md`。
- 分支：`claude/tasks-m4-pr3c`，从 PR-3a 重建前的 head `03a6527061` 开出（Draft #6266 是把同一棵树重建成单个提交）。不推送、不开 PR、不合并、不应用 DDL、不打开 `TASKS_ENABLED`。本 PR 不含迁移。
- 2026-10-08：分支重建为叠在 #6266 的 head `68e40323bd` 上的单个提交 `3edd133ae0`（树与重建前的最后一个提交相同），以 Draft #6269 推送，基分支 `claude/tasks-m4-pr3a`；#6269 正文首段声明本 PR 不含迁移（门 14 的 PR 正文一半，2026-10-09 核过）。上一条与 §1–§10 里关于基点、推送与 PR 正文的说法是重建之前的记录，原样保留。
- 代码最终 head：闸修复之后是 `e432881344`，它的提交、格数、绿线与变异记在 §10；闸修复只改测试与 `task-counts-realtime.ts` 的一段注释。§1–§6 是闸修复之前的记录（提交表到 `d9a1402810` 为止，格数、绿线与 R01 (iii) 都在 `d9a1402810` 上），原样保留（`d9a1402810` 到 `3587ea8f7c` 的提交只改设计与本文件）。
- 2026-10-09：第二轮修复之后的代码 head 是 `68acef59f5`（设计到修订 5），它的提交、绿线与变异记在 §11；上一条的最终 head 是那时的记录，原样保留。
- 2026-10-09（第三轮）：PR-3a 重建为 main `8f90307d5a` 上的单个提交，本分支随之重建为叠在它之上的单个提交，基是重建后的 PR-3a（设计到修订 6）。本轮的改动、绿线与变异记在 §12；上面几条里的基点、head 与推送是当时的记录，原样保留。
- 2026-10-09（第三轮，修订 7）：发送失败的日志改为固定码 `TASK_COUNTS_SEND_FAILED`（审阅发现，设计修订 7），本分支再次重建为叠在同一个 PR-3a 提交上的单个提交。§12.2、§12.4–§12.6 按这一版改写，第三轮第一稿（`b801bd53da`）的码规则、绿线与变异作为历史留在那几节里。§3、§10.3、§11.2 的文本扫描一行改用通用名称。
- 2026-10-09（第三轮，设计修订 8）：设计 §12 第 4 条改写为前端按门 26 的固定信号窗口合并重拉（owner 2026-10-09 裁定）；`task-counts-realtime` 单测里 getter 两格的未处理拒绝监听器改为排在最前面登记（12.2 末条、12.5 末段）；§0、§3、§6、§10 几处脚本、配置与清单的存放位置改写为「不入库」；12.4 另一台机器那一段写明运行所在的提交与本版还差这个单测文件。`src` 不变。
- 裁定只按条目 id 引用：R16、R01（2026-10-07），缺省实现约束 D10。

## 0. 本地环境

- PostgreSQL 15.17（本机）。CI 的 `tasks-realdb` 用 postgres:16，本机没有，见 §8。
- Node 20.20.2。没有跑 `pnpm install`：各 `node_modules` 是指向主检出的符号链接。
- 一次只留一个一次性库：`pr3c_1`（S2–S6 的开发与变异轮），`pr3c_2`（`188087acda` 上的第一轮最终运行；接线移位之后 M31、M32 与控件复核），`pr3c_3`（`d9a1402810` 上的绿线与 R01 (iii)）。三个库都从空库全量迁移（`MIGRATION_EXCLUDE` 取 `tasks-realdb.yml` 的六项），各 426 条 executed successfully，最后一条是 M4 迁移；用完即删（§3 末行）。
- 所有命令在 `packages/core-backend` 下（ops 与 web 命令在仓库根或 `apps/web`）。真库环境：`DATABASE_URL=postgresql://postgres@<本机>:5432/<库> EXPECT_DB=1 TASKS_ENABLED=true JWT_SECRET='tasks-rbac-trust-jwt-secret-min-32b!' CI=true`。鉴权门的环境照 `plugin-tests.yml` 的那一步：`DATABASE_URL`、`RBAC_BYPASS=false`、`RBAC_TOKEN_TRUST=false`、`PRODUCT_MODE=plm-workbench`、`RBAC_OPTIONAL=''`、`TASKS_ENABLED=true`，不给 `JWT_SECRET`（由 `tests/tasks-auth/setup.ts` 补）。
- 变异驱动、控件复核与 R01 控件的脚本不入库。

## 1. 提交

| 提交 | 内容 |
|---|---|
| `ab9c847751` | S0 设计 |
| `3d89bafed2` | S1 `task-counts-realtime.ts`（发送端口、每次写入一个的收集器）与单测 |
| `772fb50e7c` | S2 八个触点接入；`patchChangesPendingInputs`；触点单测（提交顺序、普查格） |
| `bc015287e7` | S3 真库文件 `task-m4-realtime.db.test.ts` 与三处登记 |
| `8eeaf54b3e` | S4 `index.ts` 接线与 `MetaSheetServer` 格（接线位置后来在 `d9a1402810` 移动） |
| `afe53c7f27` | S5 门 26 的四个文件内负控 |
| `1ef5904403` | 设计修订 1 |
| `188087acda` | S6 提交时回滚格扩到全部写入（含创建） |
| `d9a1402810` | 接线移到构造函数、经 `coreAPI.websocket.broadcastTo`；设计修订 2 |

## 2. 交付文件

| 文件 | 内容 |
|---|---|
| `src/services/task-counts-realtime.ts`（新） | 事件名常量、发送端口（缺省空操作）、收集器 `taskCountsSignal()`：`note` 只记录，`publish` 在事务之后对写前写后负责人的并集每人发一次，房间 `buildAuthenticatedUserRoom`，载荷 `{}`，逐人 `try/catch` |
| `src/services/task-records.ts` | `createTask`、`completeTask`、`reopenTask` 接入；导出 `assigneeIds` |
| `src/services/task-structure.ts` | `addAssignee`、`removeAssignee`、`switchCompletionMode`、`deleteTaskById` 接入；`deleteTaskById` 改调 `loadRowRoles`（`loadRoles` 包着的同一调用，语句不变） |
| `src/services/task-patch.ts` | `patchTask` 接入 |
| `src/tasks/task-realtime.ts` | 文件末尾追加 `patchChangesPendingInputs`（`countsUpdateRecipients` 不动） |
| `src/index.ts` | 构造函数在绑定 `ICoreAPI` 之后一行：`setTaskCountsBroadcaster((room, event, payload) => coreAPI.websocket.broadcastTo(room, event, payload))`（`index.ts:683`） |
| `tests/unit/task-counts-realtime.test.ts`（新） | 17 格 |
| `tests/unit/task-counts-touchpoints.test.ts`（新） | 53 格（13 个普通 `it` 加四张 8 行的触点表与一张 8 行的纯函数表） |
| `tests/integration/task-m4-realtime.db.test.ts`（新） | 19 格，候选门 26 |
| `vitest.config.ts`、`.github/workflows/tasks-realdb.yml` | 新真库文件的登记 |

上表的格数是闸修复之前的；闸修复之后的格数见 §10.4。

## 3. 绿线（代码 head `d9a1402810`）

| 项 | 命令 | 结果 |
|---|---|---|
| type-check | `tsc --noEmit -p .` | 0 errors |
| 新测试文件的类型 | 临时 tsconfig（`extends` 本包配置，`noUnusedLocals`，`include` 列三个新测试文件与两个 helper），不入库 | 这些文件与本 PR 改动的 `src` 行 0 条诊断；另有 367 条都在本 PR 没有改的 `src` 文件里（经 `index.ts` 进入这次编译：Express `Request` 的增补属性没有引入、`noUnusedLocals` 提示），与 PR-3a 记过的现象同类 |
| 任务单测子集 | `vitest run --config vitest.config.ts tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts` | 31 files / 1230 passed（PR-3a 的 29 / 1160 加本 PR 的 2 / 70） |
| 真库 lane | `tasks-realdb.yml` 的 17 个文件，`vitest.integration.config.ts --reporter=verbose`，新建的 `pr3c_3` | 三遍各 17 files / 727 passed；`socket hang up` 0；每遍之后 `git status --porcelain` 为空、`git diff -- packages/core-backend/src` 为空、包内没有 `.task-probe-*` 残留 |
| 鉴权门 | `vitest --config vitest.tasks-auth.config.ts run tests/tasks-auth/tasks-auth-gate.ts`，CI 的环境 | 86 passed (86)；跑后工作树干净 |
| 全量单测 | `vitest run --config vitest.config.ts`（不给 `DATABASE_URL`） | 5 failed / 1080 passed / 172 skipped（1257 files）；44 failed / 18759 passed / 1712 skipped（20515 tests）。失败的 5 个文件正是本机已知的：`multitable-recovery-archive-file-store`、`-archive-reader`、`-local-custody-store`、`-local-startup` 与 `attendance-admin-plugin-lib-dist-layout-boot`（`ELOOP`：本机 `plugins/plugin-attendance/node_modules` 的符号链接成环） |
| ops | `node --test scripts/ops/tasks-auth-ci-wiring.test.mjs scripts/ops/staging-tasks-smoke.test.mjs` | 22/22 |
| flag manifest | `node --test` 三个 manifest 测试文件（`verify:global-history-flag-manifest:test` 的内容） | 99/99 |
| 文本扫描 | 字面扫描器 v1/v2 与引号扫描器，对 `03a6527061..HEAD` 改动的每个文件 | 全部 exit 0 |
| 库 | `dropdb pr3c_3` | 已删；`pr3c_1`、`pr3c_2` 在各自用完时已删 |

**历史（不计入绿线）**：`188087acda` 上，`pr3c_2` 的 lane 三遍各 727、鉴权门 86 都绿，但全量单测多出第 6 个失败文件 `attendance-w6-group-effective-policy-authorization.test.ts`（3 格）：那时的接线放在 `setupMiddleware` 的任务路由挂载处、经 `this.injector` 取服务，新增了一处 `this` 用法，那份单测把 `index.ts` 装配范围的 `this` 用法冻结成字面量清单。`d9a1402810` 把接线移到构造函数、只引用局部变量 `coreAPI`，那个文件 109/109 绿（单独跑过一遍，又在上表的全量里绿）。同一轮里 ops 的 `tasks-auth-ci-wiring` 有一格因 `spawnSync python3 ETIMEDOUT` 失败：它与全量单测同时跑，机器负载高；单独重跑 22/22，上表是 `d9a1402810` 上的重跑。

## 4. 格数（门 17 ②：收集数 = 展开后的静态计数）

`d9a1402810` 上 lane 第三遍的 verbose 日志逐文件计 ✓ 行：

| 文件 | 静态展开数 | 收集并通过（三遍） |
|---|---|---|
| `task-p0a` | 13 | 13 |
| `task-read-path` | 57 | 57 |
| `task-completion-grid` | 6 | 6 |
| `task-rbac-trust` | 17 | 17 |
| `task-m3-tree` | 25 | 25 |
| `task-m3-membership` | 45 | 45 |
| `task-m3-comments-deletion` | 33 | 33 |
| `task-m4-schema` | 59 | 59 |
| `task-m4-list-roles` | 50 | 50 |
| `task-m4-paging-settings` | 77 | 77 |
| `task-m4-dates` | 107 | 107 |
| `task-m4-lists` | 66 | 66 |
| `task-m4-list-members` | 44 | 44 |
| `task-m4-list-items` | 25 | 25 |
| `task-m4-groups` | 38 | 38 |
| `task-m4-org-members` | 46 | 46 |
| `task-m4-realtime`（新） | 19（19 个普通 `it`，没有 `.each`） | 19 |
| 合计 | 727 | 727 |
| 鉴权门 | 86 | 86 |

前 16 个文件相对 `03a6527061` 逐字节未改（`git diff --stat 03a6527061 HEAD -- packages/core-backend/tests/` 只列本 PR 的三个新文件），静态展开数与 PR-3a 验证记录「最终 head 的格数」一节相同。单测：`task-counts-realtime` 17 个普通 `it`；`task-counts-touchpoints` 13 个普通 `it` 加 `it.each` 五张表共 40 行（四张触点表各 8 行，空操作表的过滤留下全部 8 行；纯函数表 8 行），合 53，与收集数相同。

## 5. 变异轮

做法：每个变异对一个源文件做一次精确替换（先断言命中恰一次），`cp` 备份，跑两个新单测文件与真库文件 `task-m4-realtime.db.test.ts`，从备份复制回去并 `cmp` 逐字节相同；顺序执行，不与其他测试并发；没有用 `git checkout` / `reset` / `stash` / `clean`。批次前后六个被变异文件（`task-counts-realtime.ts`、`task-records.ts`、`task-structure.ts`、`task-patch.ts`、`task-realtime.ts`、`index.ts`）的 md5 一致。M01–M30 在 `afe53c7f27` 的代码上跑（`1ef5904403` 只改文档）；回滚格扩展之后，M14、M19、M26 重跑、M33–M37 新跑，在 `188087acda` 上；接线移位之后，M31、M32 按新的接线行重跑，在 `d9a1402810` 上。这些变异碰到的其余文件在它们跑过之后没有再改（`task-counts-realtime.ts` 在 `d9a1402810` 只改了一段注释）。

**37 个变异全部被杀，37 次还原全部逐字节相同。**「真库格」列只列行为上抓住它的格；文件内负控因 needle 被变异改掉而报的红是附带的，标「附带」。

| # | 文件 | 变异 | 单测红 | 真库格（行为） | 说明 |
|---|---|---|---|---|---|
| M01 | realtime | 房间改成裸用户 id | 22 | 每个检查房间的格（13），含正控、载荷格 | |
| M02 | realtime | 事件名拼错 | 2 | 11（`sendsOf` 的事件名检查） | |
| M03 | realtime | 载荷带 `count` | 1 | 11（载荷 `{}` 检查） | |
| M04 | realtime | 载荷带任务字段 | 1 | 11 | |
| M05 | realtime | 整个循环一个 `try/catch` | 2 | 失败隔离格（B 没收到） | 附带：负控 (a)(b) |
| M06 | realtime | 不 `try/catch` | 2 | 失败隔离格（500 而不是 200） | 附带：负控 (a)(b) |
| M07 | realtime | 不接住返回 promise 的拒绝 | 1 | — | 只有单测抓得到：真库里的端口是同步的 |
| M08 | realtime | 不取并集去重 | 13 | 10（创建 `[A, B, A]`、完成等） | |
| M09 | realtime | `publish` 不是一次性的 | 1 | — | 只有单测：路由里每次写入只 `publish` 一次 |
| M10 | realtime | 收件人只取写后集合（负控甲） | 9 | 正控（A 那一半）、回滚格的提交尾段 | 附带：负控 (a)(b)(follower) |
| M11 | realtime | 收件人只取写前集合（负控乙） | 11 | 正控（B 那一半）、创建格 | 附带：负控 (a)(b) |
| M12 | realtime | `note` 当场发送，即在事务内（负控丙） | 33 | 两个回滚格（提交失败仍有发送）；其余格因重复发送也红 | |
| M13 | records | `createTask` 不 `note` | 3（含普查格） | 创建格 | |
| M14 | records | `createTask` 在事务内 `publish` | 4 | 回滚格（其余写入，创建那一段） | |
| M15 | records | `createTask` 记创建人而不是负责人 | 2 | 创建格、零负责人格 | |
| M16 | records | `completeTask` 空操作也 `note` | 1 | 完成与重启格（重复完成） | |
| M17 | records | `completeTask` 只在翻转时 `note` | 1 | 4（完成与重启、载荷、失败隔离、租户） | |
| M18 | records | `reopenTask` 从不 `note` | 1 | 完成与重启格 | |
| M19 | records | `completeTask` 在事务内 `publish` | 3 | 回滚格（其余写入） | |
| M20 | structure | 加负责人两边都记写前行 | 2 | 正控（B 那一半） | |
| M21 | structure | 删负责人两边都记写后行 | 2 | 正控（A 那一半）、回滚格的提交尾段 | 附带：负控 (c)(follower) |
| M22 | structure | 删负责人空操作也 `note` | 1 | 负责人空操作格 | 附带：负控 (follower) |
| M23 | structure | 切模式只在状态变时 `note` | 1 | 切换完成方式格（`any → all`） | 钉住 `[own-3c-02]` |
| M24 | structure | 切模式从不 `publish` | 3（含普查格） | 切换完成方式格 | |
| M25 | structure | 删除从不 `note` | 2（含普查格） | 删除格 | |
| M26 | structure | 删除在事务内 `publish` | 3 | 回滚格（其余写入） | |
| M27 | realtime（纯） | `PATCH` 判定不看时区 | 4 | `PATCH` 格（无截止日只改时区） | 钉住 `[own-3c-03]` |
| M28 | realtime（纯） | `PATCH` 判定不看截止日期 | 2 | — | 只有单测：截止日期一变 `due_at` 必变，HTTP 上看不出来 |
| M29 | realtime（纯） | `PATCH` 判定恒真 | 4 | `PATCH` 格（只改标题也发） | |
| M30 | patch | `patchTask` 从不 `note` | 2 | `PATCH` 格 | |
| M31 | index | 删掉接线行 | 0 | 接线格 | 附带：接线负控；在 `d9a1402810` 上重跑 |
| M32 | index | 接线改用 `websocket.sendTo` | 0 | 接线格 | 附带：接线负控；在 `d9a1402810` 上重跑 |
| M33 | records | `reopenTask` 在事务内 `publish` | 3 | 回滚格（其余写入） | |
| M34 | structure | `addAssignee` 在事务内 `publish` | 4 | 回滚格（其余写入） | |
| M35 | structure | `removeAssignee` 在事务内 `publish` | 4 | 两个回滚格 | |
| M36 | structure | `switchCompletionMode` 在事务内 `publish` | 4 | 回滚格（其余写入） | |
| M37 | patch | `patchTask` 在事务内 `publish` | 4 | 回滚格（其余写入） | |

文件简称：realtime = `src/services/task-counts-realtime.ts`（M27–M29 是 `src/tasks/task-realtime.ts`），records = `task-records.ts`，structure = `task-structure.ts`，patch = `task-patch.ts`，index = `src/index.ts`。

**控件的控件**（在 `d9a1402810` 上，`pr3c_2`）：把五个文件内负控各自的改写换成恒等改写（替换串等于 needle），只跑那一格，五格都必须红——证明子进程看到的是真行为，不是恒真：

| 负控 | 恒等改写下子进程的观测 | 结果 |
|---|---|---|
| 接线 | `pushes: 2` | 红 |
| (a) 只取写后集合 | `toA: 1` | 红 |
| (b) 只取写前集合 | `toB: 1` | 红 |
| (c) 事务内发送 | `rejected: true, toA: 0` | 红 |
| 关注人 | `toF: 0` | 红 |

测试文件随后逐字节还原。

## 6. R01 (iii)：`M2|` 与 `M3|` 门行重跑

- 在哪个 head：`d9a1402810`，即 PR-3a 加 PR-3c。它没有 PR-3b，也没有 M4 前端；`apps/web` 是 main 上 M3 前端的状态（`cc6ca96ac2`）。四件合在一起的最终 head 现在不存在，那一遍 NOT RUN（§8）。
- 2026-10-09 改正：R01 的 ①–③ 是合并之前的判定，③ 的那一遍在合并之前的最终候选集成树上跑，那棵树在合并之前就能建出来（设计 §2.5）。本节在 PR-3a 加 PR-3c 的 head 上跑的这一遍是预备，不代替那一遍判定（§12.3）。
- 锁 `arm-set` 的 `M2|` 27 行、`M3|` 2 行，逐行如下。「控件」列：「文件内」= 控件是测试文件里的一格，随上面那一遍运行一起跑过；「手工，本次」= 本次在 `d9a1402810` 上用不入库的脚本改写、运行、逐字节还原；NOT RUN 写原因。
- 下表的 lane 指 §3 的三遍 lane，鉴权门指 §3 的那一遍，前端指 `apps/web` 下按 `tasks-web-guard.yml` 那一步的 14 个 spec 跑的一遍（`vitest run --watch=false <14 files>`：14 files / 502 passed）。

| 行 | 承载 | 本次运行 | 控件 | 结果 |
|---|---|---|---|---|
| `M2\|1\|整门` | 鉴权门 `gate 1:` 四格（无租户读写、`x-tenant-id` 头、他 org 与停用 org 的写、org 隔离读）；`task-rbac-trust` 的 `predicate_error` 与 `org_missing` 两格 | 鉴权门、lane | 文件内：鉴权门的隔离读格在子进程里把 `task-access.ts` 的 org 子句改成恒真，两读面都出现 B | 绿 |
| `M2\|2\|整门` | `task-rbac-trust` 的六格（200 对照、缺角色、缺准入、只有另一码、23503、直授加准入） | lane | 格本身即对照 | 绿 |
| `M2\|3\|存活六格` | `task-completion-grid` 六格 | lane | 门体不要求 | 绿 |
| `M3\|3\|增删人切模式` | `task-m3-membership` 的门 3 与切模式两组 | lane | 门体不要求 | 绿 |
| `M2\|4\|整门` | `task-read-path` 的门 4 正反两格与未定日一格 | lane | 格本身即正反 | 绿 |
| `M2\|5\|整门` | `task-read-path` 的跨时区字节格；`task-records-guards` 的待办项三格；`task-dates` 的门 5 | lane、任务单测子集 | 手工，本次：`listPending` 把全天任务的 `dueAt` 改按查看者时区算（清掉 `due_at`、时区换成查看者的），跨时区字节格红 | 绿 |
| `M3\|6\|整门` | `task-m3-tree` 的深度、自身与子孙、交叉移动、正控、负控、删父竞态 | lane | 文件内：负控注释掉 `acquireTaskStructureLock` 的取锁行，生产操作在界内返回 | 绿 |
| `M2\|7\|src/tasks` | 扫描根 19 个 `.ts` 文件，命中 0 | 门 7 脚本（`find` + ERE + 向上最近的导出名） | 正控：同一 ERE 命中 `approval-record-projection-service.ts:246`；手工，本次：在扫描根里插入第四处字面量，多重集不等，红 | 绿 |
| `M2\|7\|src/services/task-*` | 10 个文件（本 PR 加了 `task-counts-realtime.ts`），命中 0 | 同上 | 同上（第四处字面量就插在本 PR 的新文件里） | 绿 |
| `M2\|7\|src/routes/tasks*` | 4 个文件，命中 0 | 同上 | 同上 | 绿 |
| `M2\|7\|src/db/task-*` | 1 个文件，3 处命中，分属三个登记导出，多重集恰为三者各一 | 同上；任务单测子集里的 `task-advisory-locks` | 同上 | 绿 |
| `M2\|8\|生产路径回退` | `task-rbac-trust` 的待办数路由两格；`task-read-path` 的回退两格；`task-access` 的 `COALESCE` 文本格；`task-dates` | lane、任务单测子集 | 文件内：路由回退改 `'UTC'`（rbac-trust 子进程）、helper 回退改 `'UTC'`（read-path 子进程） | 绿 |
| `M2\|10\|标题子集` | `task-records-guards` 的门 10 两格；`task-ids` 的 `normalizeUserText` | 任务单测子集 | 手工，本次：`normalizeUserText` 不再修剪（`nfc.replace(EDGE_TRIM_RE, '')` 换成 `nfc`），门 10 格与 `task-ids` 的空白格红 | 绿 |
| `M2\|11\|整门`（前端） | `tasks-view`、`tasks-list-view`、`tasks-context` 的相关格；两点接线（门 21 的 D = T = G） | 前端 | 门体要求的组件变异是前端线的手工记录，本次未重做 | 绿（M3 前端状态） |
| `M2\|12\|整门`（前端） | `tasks-context`、`tasks-view`、`tasks-api`、`tasks-list-view` 的三触发与 `predicate_error` 不引导 | 前端 | 同上 | 绿（M3 前端状态） |
| `M2\|13\|整门` | `task-rbac-trust` 的 `MetaSheetServer` 挂载格与静态段先于 `/:id` 格 | lane | 手工，本次：`index.ts:1907` 的 `tasksRouter()` 换成 `null`，挂载格红 | 绿 |
| `M2\|14\|整门` | 含 DDL 的 PR 首段声明 | 文档核对：本 PR 不含迁移（`03a6527061..HEAD` 的改动文件没有迁移）；本分支带着的 M4 迁移由 PR-3a 的 PR 正文声明 | — | 本 PR 没有写 PR 正文（不推送），PR 正文这一半 NOT RUN |
| `M2\|15\|整门` | 生产源码注释不点名其他线的符号 | 本 PR 新增的 82 行生产注释（行首注释与行尾 `//`），记号表：`approval todo attendance multitable elearning e-learning dingtalk stock-prep stockprep plm kanban workflow after-sales aftersales directory feishu k3 census`，不区分大小写 | — | 0 命中。本 PR 之外的既有注释未重扫 |
| `M2\|16\|整门` | 专属配置与 setup 的五个守卫；接线单测与 ops；鉴权门的判别格（只有 `tasks:read` 声明、库里只授 `tasks:write` ⇒ 403）与对照格（写 200） | 鉴权门、任务单测子集、ops | 手工，本次，逐层：① 配置里 `RBAC_TOKEN_TRUST` 改 `'true'` ⇒ ops 的配置钉与单测的接线格红；② setup 的赋值改 `'true'` ⇒ setup 守卫抛错，整个文件红；③ 同时让 setup 守卫放行 ⇒ 门文件自己的导入守卫抛错；④ 再让门文件的导入守卫放行 ⇒ 判别格 200 ≠ 403 红，对照格仍 200 | 绿 |
| `M2\|17\|①` | 17 个 `task-*.db.test.ts` 在 `vitest.config.ts` 下逐个跑 | 不给库的环境，逐文件 | 正控：同样的文件在 `vitest.integration.config.ts` 下被收集（lane 727） | 17/17 报 `No test files found`（exit 1），不是 skipped |
| `M2\|17\|②` | lane 的 verbose 日志 | §4 | — | 收集 727 = 展开 727 |
| `M2\|17\|④` | `task-ci-coverage-enumeration` 四格 | 任务单测子集 | 手工，本次：删掉新文件第一行的 `assert-rbac-optional-off` import，「每个文件都 import 哨兵」格红 | 绿 |
| `M2\|18\|整门` | manifest 测试的源码扫描（`TASKS_*_ENABLED`）与 `TASKS_ENABLED` 条目 | flag manifest 99/99 | 手工，本次：从 `globalHistoryFlagsInSource()` 的并集里去掉 `tasks` 那一段，完整性格红 | 绿 |
| `M2\|19\|网格` | `task-read-path` 的 49 格 | `tsx tests/helpers/gate19-identities.ts <lane 第三遍日志> <锁>` | 集合 diff 本身是控件 | `gate19: passed identities equal the i-m2 list`（49）。锁里写的形 A（整个 `tests/integration` 加 `-t`）本次未跑，用的是形 B 读整个 lane 日志 |
| `M2\|19\|探针①` | `task-read-path` 的探针一 | lane | 文件内：assigned 臂换成 `FALSE`，三端红 | 绿 |
| `M2\|19\|探针②` | `task-read-path` 的探针二 | lane | 文件内：置反 `assignee.complete`，complete 404、列表三端仍在 | 绿 |
| `M2\|20\|整门` | `task-pure-no-io` 的行为 harness（含本 PR 追加的纯函数） | 任务单测子集 | 静态，本次：`src/tasks` 19 个文件；(A) 0 命中、(B) 0 命中（本机 grep 对缺路径与零命中同为 exit 1，所以与文件数一起记）；持池 ERE 恰三行（`connection-pool.ts:76`、`PostgresAdapter.ts:81`、`sharded-pool-manager.ts:191`）；(A)(B) 各三个正控文件各 ≥1 命中 | 绿 |
| `M2\|21\|整门` | D、T、G 三个集合 | 门 21 的三条命令 | 本次：D = T = G = 13，两个 diff 为空；`[^[:space:]*]` 只抽出逐文件名，放宽成 `[^[:space:]]` 时 glob 行也被抽出；yml 的 `on.paths` glob 抽出 0；把 workflow 的一份拷贝里逐文件参数换成一个 glob，G = 0 而 D = 13，diff 非空（红） | 绿 |
| `M2\|22\|整门`（前端） | `tasks-routes.spec.ts` 的允许、重定向、两个焦点、焦点反格与真实 `useAuth` 的 admin 格（R-28 之后的投影） | 前端 | 手工，本次：删掉 `useAuth.ts` 的 admin 短路行，admin 格红 | 绿（M3 前端状态） |

## 7. 与设计、任务说明的偏差

1. **触点按 R16 的裁定**：任务说明列的五类写入是 R16 落槌之前的建议清单，不完整。R16 的裁定是谓词（改变 `buildTaskPendingCondition` 任一输入的已提交写入），并逐项列出了写入种类，与八个服务函数一一对应（设计 §2.4）。这不是本件的取舍，不再请 owner 确认（设计 §11 第 1 条，修订 4）；本件的取舍只在两个子情形：`[own-3c-02]` 与 `[own-3c-03]`（设计 §11-Q2、Q3）。
2. **接线位置（设计修订 2）**：最初写在 `setupMiddleware` 的任务路由挂载处，经 `this.injector` 取服务；全量单测里另一条线冻结 `index.ts` 装配范围 `this` 用法的单测因此红了三格。任务单测子集与真库 lane 都碰不到那份单测，是全量单测抓到的。现在的接线在构造函数里，只引用局部变量 `coreAPI`，那份单测全绿，没有改它。
3. **日志噪声**：lane 里其他构造真实 `MetaSheetServer` 的文件会把发送端口绑到那台服务器的 websocket API 上；那台服务器没有启动 socket 服务，此后同一文件里的任务写入会记一条「broadcastTo before initialization」的 warn。不是失败；`task-m4-realtime` 自己在 `beforeAll` 设记录器、接线格之后重设。
4. **只有单测抓得到的变异**：M07（异步端口的拒绝）、M09（第二次 `publish`）、M28（`PATCH` 判定里的截止日期一项：真实数据里截止日期一变 `due_at` 必变）。
5. **门 26 的格是候选**：门 26 的正文与 `M4|26|整门` 行在 R01 的锁 Draft 里，合并之前不计分；裁决包的候选门名 M4-f 就是它。
6. **基点**：本分支建在 PR-3a 重建前的 head 上；要叠到 #6266 上需要把这些提交重放一遍，本次按指令没有 rebase。
7. **与 PR-3b 的冲突**：冲突在六个回调（完成、重启、加负责人、删负责人、切换完成方式、删除）与两份真库登记清单（`vitest.config.ts`、`tasks-realdb.yml`，两边的文件都留）。只有一步不机械：在前五个回调里保留 PR-3b 的 `const written = await write…Events(…)` 与入队，删掉本件一侧那行裸的 `await write…Events(…)`，再把 `counts.note` 块放在入队之后；`deleteTaskById` 里先放入队块，再放 `counts.note`。两行都留时 `tsc` 照样 0 错，事件却写两次（设计 §10，修订 4）。PR-3b 的 `addComment` 不冲突。

## 8. NOT RUN

- 四件合在一起的最终 head（PR-3a + PR-3b + PR-3c + M4 前端）上的 `M2|` / `M3|` 重跑：那个 head 不存在。（2026-10-09 改正：这一遍是合并之前的判定，在合并之前的最终候选集成树上跑，那棵树在合并之前就能建出来；还没有跑，见设计 §2.5 与 §12.3。）
- FE-c：前端订阅、重拉，门 26 的负控丁。
- 真实 socket 的端到端（浏览器收到事件）：接线格停在 `CollabService.broadcastTo`。多于一个后端进程时的投递（进程内 adapter，设计 §5）。
- CI：没有推送，`tasks-realdb`、`plugin-tests`、`web-tests` 都没有在 CI 上跑过本分支。
- 全量单测：闸修复那一轮没有跑（§10.3）；§3 那一遍在 `d9a1402810` 上。
- postgres:16（CI 的 lane）与 PG14：§3–§6 那一轮本机只有 15.17。闸修复那一轮的 lane 与鉴权门在另一台机器的 PostgreSQL 16.15 上跑过（§10.3），PG16 对 `e432881344` 算补上；CI 的 postgres:16 容器与 PG14 仍未跑。
- 门 19 形 A（整个 `tests/integration` 加 `-t 'gate19[|]'`）：用了形 B。
- 门 11、12 的组件变异：前端线的手工记录，本次未重做。
- 门 14 的 PR 正文、门 15 对本 PR 以外既有注释的重扫。
- staging 与生产：不触达。

## 9. 给 FE-c

见设计 §12（事件名与房间、载荷恒为 `{}`、触点与前端设计 §8.3 第 3 条相同、操作者本人也会收到、设置变更不发、多 org 用户、发送先于 HTTP 响应、进程范围、socket 认证与路径不变）。

## 10. 闸修复（2026-10-08，代码 head `e432881344`）

闸对 `3587ea8f7c` 的问题清单不入库。本节记修复、绿线与变异；§1–§6 不改。

### 10.1 提交

| 提交 | 内容 |
|---|---|
| `c0b4d94d8d` | 操作者本身是负责人的格：真库两格（创建人删除只有自己一名负责人的任务 ⇒ {C}；身为负责人的创建人改截止日期，另一名负责人已完成 ⇒ {A, B, C}）；单测五行表 |
| `efbe63b790` | `[own-3c-03]` 的反半：只改开始、只改描述 ⇒ 零次（真库 `PATCH` 格与单测）；删除格先让 A 完成；两次 `note` 的格分得出并集与只取最后一次 |
| `099b870cd2` | 写入者普查：带 schema、带引号的表名，关键字之间任意空白，硬删任务行；每个顶格声明或语句开一段；合成正控覆盖每种写法 |
| `c173b355e1` | 提交之后才发送的前提：设计 §4.2 与模块注释写明规则，单测一格钉住（`src` 只改注释） |
| `ccfd1c6ab2` | 设计修订 4 |
| `e432881344` | 那段注释的措辞（门 15 的记号表），只改注释 |
| 本提交 | 本节；§7 第 1、7 条，§8，§9 |

### 10.2 逐条结果

| 闸条目 | 级别 | 处理 | 提交 |
|---|---|---|---|
| 门 26 没有一格让操作者本身是负责人（加、删、切模式、删除、`PATCH`） | P2 | 修：真库两格（删除、`PATCH`）加单测五行表；T01–T05 各自只把自己那一格变红（§10.5） | `c0b4d94d8d` |
| 提交之后才发送依赖一条没写出来的规则（回调不吞语句错误） | P3 | 规则写进设计 §4.2 与模块注释，单测一格钉住；不改生产行为（不加探测语句、不改共享的 `transaction()`，理由见设计 §4.2） | `c173b355e1` |
| §11 第 1 条请 owner 再确认已裁定的触点集合 | P3 | 改为陈述：八个函数与 R16 列举的写入种类一一对应；第 2、3 条保留为本件的取舍，第 3 条按闸的意见收紧（带查看者时区时，只改时区而 `due_at` 不变的写入不改变任何计数）；第 5 条移为给锁 PR 的备注；§2.4 与本文 §7 第 1 条同改 | `ccfd1c6ab2`、本提交 |
| §2.2 说 `badge_scope` 不是谓词的输入 | P3 | 改正：它经 `scope` 参数进入谓词，是查看者一侧的参数；§11 第 4 条的前提同改 | `ccfd1c6ab2` |
| 普查漏掉 schema、硬删、函数表达式、带类型标注的箭头 | P3 | 修，加正控；T50–T56 被杀，T47–T49 仍被杀 | `099b870cd2` |
| `[own-3c-03]` 的反半只钉了标题与提醒 | P3 | 修：只改开始（带回库里的时区）、只改描述 ⇒ 零次，版本都前进；T41 与它的两半各自被杀 | `efbe63b790` |
| 两次 `note` 的格分不出并集与只取最后一次 | NIT | 修；T30 被杀 | `efbe63b790` |
| 删除与 `PATCH` 没钉已完成的负责人 | NIT | 修：真库删除格与 `PATCH` 的操作者格、单测删除行与 `PATCH` 操作者行都有已完成的负责人；T20、T21 被杀 | `efbe63b790`、`c0b4d94d8d` |
| 设计 §1 第 3 条（两条：保真与合并两个视角）还是修订 2 之前的接线 | NIT | 改为构造函数、经 `coreAPI.websocket.broadcastTo` | `ccfd1c6ab2` |
| §4.4 把接线历史记成「修订 1 之前」 | NIT | 改为「修订 2 之前」 | `ccfd1c6ab2` |
| §12 第 3 条说触点比前端设计 §8.3 多 | NIT | 改为相同、两个子情形在其中；补第 9 条（socket 认证与路径不变）；本文 §9 同改 | `ccfd1c6ab2`、本提交 |
| §11 第 5 条（门 26 怎么分行）没有动机、属于锁 PR | NIT | 移为给锁 PR 的备注 | `ccfd1c6ab2` |
| §10 漏了与 PR-3b 合并时唯一不机械的一步 | NIT | 补上；本文 §7 第 7 条同改 | `ccfd1c6ab2`、本提交 |
| 「五个回调」应为六个 | NIT | 改为六个（设计抬头、§10、本文 §7 第 7 条）；`git merge-tree` 在 `c173b355e1` 与 PR-3b 当前 head 上复核：冲突文件是两份服务文件加两份真库登记清单 | `ccfd1c6ab2`、本提交 |

### 10.3 绿线（`e432881344`）

| 项 | 结果 |
|---|---|
| type-check `tsc --noEmit -p .` | 0 errors |
| 新测试文件的类型（§3 那份临时 tsconfig，不入库） | 三个新测试文件、两个 helper 与本 PR 改的 `src` 行 0 条诊断。共 367 条，与 §3 那一轮逐条相同（去掉行列号比较）；其中 9 条在 `src/index.ts` 本 PR 没有改的行上（Express `Request` 的增补属性、`noUnusedLocals` 等，本 PR 在这个文件只改了第 251 行与第 680–683 行），其余在本 PR 没有改的文件里。§3 那句「都在本 PR 没有改的 src 文件里」应读作「都在本 PR 没有改的行上」 |
| 任务单测子集（31 个文件） | 31 files / 1239 passed（§3 的 1230 加闸修复的 9 格） |
| 全量单测 | 本轮没有跑。上一次是 §3 在 `d9a1402810` 上（那一遍抓到过修订 2 的接线问题）；此后 `src` 只多了一段注释，测试只改了本 PR 的三个文件 |
| 真库 lane（另一台机器，PostgreSQL 16.15；新建的一次性库，426 条迁移；`tasks-realdb.yml` 的 17 个文件） | 三遍各 17 files / 729 passed；`socket hang up` 0；跑后远端工作树除依赖的符号链接外没有改动、`src` 无 diff、没有 `.task-probe-*` 残留 |
| 鉴权门（`plugin-tests.yml` 那一步的环境） | 86 passed (86) |
| 门 15（本 PR 新增的生产注释，§6 的记号表） | 87 行，0 命中（`c173b355e1` 的注释用了表里的一个词，`e432881344` 改掉） |
| 文本扫描（字面扫描器 v1/v2 与引号扫描器）对 `03a6527061..HEAD` 改动的每个文件 | 全部 exit 0 |
| diff 与提交信息里的机器名、局域网 IP、本机路径 | 0 命中 |
| 远端工作树与一次性库 | 用完已删 |

`c173b355e1` 上先跑过一遍（同一台机器、同样的步骤）：lane 第 1、3 遍 729 passed，第 2 遍 728 passed、1 failed，鉴权门 86 passed。那一格是未改的 `task-m3-comments-deletion` 里的计时上限（「outsider missing id」用了 1142 ms，要求 < 1000 ms），当时机器的 1 分钟负载约 6；`e432881344` 只比它多改一行注释。

### 10.4 格数（门 17 ②）

| 文件 | 静态展开数 | 收集并通过 |
|---|---|---|
| `task-m4-realtime`（真库） | 21（19 加操作者两格；删除格与 `PATCH` 格原地加强） | 21（三遍） |
| lane 合计（17 个文件） | 729（727 + 2） | 729（三遍；逐文件计 ✓ 行，其余 16 个文件与 §4 相同） |
| `task-counts-realtime`（单测） | 17（两次 `note` 的格原地改写） | 17 |
| `task-counts-touchpoints`（单测） | 62：15 个普通 `it`（原 13 加前提的两格）加七张表 47 行（原五张 40 行，加操作者五行、开始与描述两行）；合成普查格原地改写 | 62 |

前 16 个真库文件相对 `03a6527061` 仍逐字节未改。

### 10.5 变异

做法同 §5：needle 恰一次，`cp` 备份，跑，复制回去，`cmp` 逐字节相同；新建文件的变异跑完即删；批次前后被变异的八个源文件（`task-counts-realtime.ts`、`task-realtime.ts`、`task-records.ts`、`task-structure.ts`、`task-patch.ts`、`index.ts`、`task-org-members.ts`、`task-group-records.ts`）md5 一致。驱动是闸那份驱动的副本（不入库），闸的工件未改。单测变异在本机跑两个单测文件（79 格）；真库变异在另一台机器的一次性库上跑 `task-m4-realtime`，去掉文件内的子进程负控（它们自己改写同几份源码）。编号沿用闸的清单，S1–S4 与 T54–T56 是本轮新加的。

| # | 变异 | 单测红（79 格中） | 真库红 | 结果 |
|---|---|---|---|---|
| T01 | `addAssignee` 两边去掉操作者 | 操作者表：自己加自己 | 不跑（单测已抓） | 杀 |
| T02 | `removeAssignee` 两边去掉操作者 | 操作者表：负责人删自己 | 不跑 | 杀 |
| T03 | `switchCompletionMode` 两边去掉操作者 | 操作者表：负责人切模式 | 不跑 | 杀 |
| T04 | `deleteTaskById` 去掉操作者 | 操作者表：删除只有自己的任务 | `gate26|operator (delete)` | 杀 |
| T05 | `patchTask` 去掉操作者 | 操作者表：负责人改截止日期 | `gate26|operator (PATCH)` | 杀 |
| T06–T08 | 对照：创建、完成、重启去掉操作者 | 各自原有的格 | 不跑 | 杀 |
| T20 | 删除只发给未完成的负责人 | 触点表删除行（种子有已完成者） | `gate26|delete` | 杀 |
| T21 | `PATCH` 只发给未完成的负责人 | 操作者表：负责人改截止日期 | `gate26|operator (PATCH)` | 杀 |
| T26–T29 | 回归：收集器与纯函数的并集（写前写后对调、丢写后、纯函数丢写后、不去重） | 各 11–18 格 | 不跑 | 杀 |
| T30 | 后一次 `note` 覆盖前一次 | 两次 `note` 的格 | 不跑 | 杀 |
| T41 | `PATCH` 改开始或描述也发送 | 开始格、描述格 | `gate26|PATCH` | 杀 |
| T41s | 只改开始也发送 | 开始格 | `gate26|PATCH` | 杀 |
| T41d | 只改描述也发送 | 描述格 | `gate26|PATCH` | 杀 |
| T47 | 对照：`setTaskParent` 的 `UPDATE` 也写 `deleted_at` | 写入者格 | — | 杀 |
| T48 | 对照：`setTaskParent` 调 `writeTaskDoneState` | 写入者格 | — | 杀 |
| T49 | 对照：新服务文件写 `task_assignees` | 人口格 | — | 杀 |
| T50 | 同上，带 schema（`public.task_assignees`） | 人口格 | — | 杀 |
| T51 | `task-structure.ts` 末尾的函数表达式写入者 | 写入者格 | — | 杀 |
| T52 | 带类型标注的箭头写入者 | 写入者格 | — | 杀 |
| T53 | 硬删任务行 | 写入者格 | — | 杀 |
| T54 | 新服务文件里表名换到下一行的插入 | 人口格 | — | 杀 |
| T55 | 带引号的 `"tasks"` 更新 `status` | 写入者格 | — | 杀 |
| T56 | 顶格语句（不是声明）里的写入 | 写入者格 | — | 杀 |
| S1 | `removeAssignee` 的回调在删除之后吞掉一条语句的错误 | 前提格 | — | 杀 |
| S2 | `lockTaskRowForDelete` 的 `catch` 不再以 `throw` 结束 | 前提格 | — | 杀 |
| S3 | `findActiveOrgMembers`（写入文件 import 的模块）给查询接 `.catch(` | 前提格 | — | 杀 |
| S4 | 对照：写入文件不 import 的任务模块里吞错 | 0 | — | 存活（按设计：不在人口里） |

单测这一批在 `e432881344` 上跑：32 个变异（含 S4），31 个被杀，32 次还原逐字节相同。真库这一批在同一个 head、同一个一次性库上跑：`-t` 跳过 5 个子进程负控，执行 16 格（verbose 报告 `16 passed | 5 skipped`）；不变异的基线 H0 全绿，7 个变异全部被杀、各自只红上表那一格，7 次还原逐字节相同，批次前后 md5 一致。

### 10.6 R01 (iii) 与其余

- `d9a1402810..e432881344` 在 `src` 下只改了 `task-counts-realtime.ts` 头注释（逐行核对：改动行都是注释）。§6 里由 lane、鉴权门、任务单测子集承载的 `M2|`、`M3|` 行，由本节的 lane 三遍、鉴权门与单测子集在 `e432881344` 上重新承载；§6 的手工控件没有重跑，它们改写的源码本轮没动。门 15 见 §10.3。
- 门 26 的格仍是候选：锁 PR 未合。
- NOT RUN：§8 各项不变，只有 PG16 一项对 `e432881344` 补上；另加一项，本轮没有跑全量单测（§10.3）。

## 11. 第二轮修复（2026-10-09，代码 head `68acef59f5`）

本节记 2026-10-09 在 `3edd133ae0` 之上的修复、绿线与变异；§1–§10 不改。

### 11.1 提交

| 提交 | 内容 |
|---|---|
| `7735ce68c3` | 提交之后才发送的前提：规则写为离开 `catch` 的每一条路径都抛出，并且没有任何写法吞掉语句的错误（模块注释、设计 §4.2）。前提格另读 `catch` 块里任何位置的 `return`、`break`、`continue`，`finally` 块里的这三者，以及注释行以外的 `Promise.allSettled`、`Promise.race`、`Promise.any`；合成正控逐一带上这些写法，并带上每条路径都抛出的 `catch`、只做清理的 `finally`、`Promise.all` 与注释行这些对照。设计 §7.1、§10 与修订 5 同改 |
| `68acef59f5` | 写入者普查：`UPDATE` 与 `DELETE FROM` 之后可以有 `ONLY`（两张表都是），带括号的 `SET` 列清单里有输入列就算写入；合成正控带上四种 `ONLY` 写法、一条含输入列的列清单，以及一条不含输入列的列清单作对照。设计 §7.1 与修订 5 同改 |
| `3cab4ae108` | 本文抬头与设计状态段各加一行带日期的说明：分支重建为叠在 #6266 head 上的单个提交，以 Draft #6269 推送 |
| 本提交 | 本节与抬头一行 |

### 11.2 绿线（在 `3cab4ae108` 上跑；它与代码 head `68acef59f5` 只差文档）

| 项 | 结果 |
|---|---|
| type-check `tsc --noEmit -p .` | 0 errors |
| 测试文件的类型（§10.3 那份临时 tsconfig） | 两个单测文件 0 条诊断；共 367 条，与 §10.3 逐条相同（去掉行列号比较），都在本 PR 没有改的文件里 |
| 两个单测文件 | 79 passed（`task-counts-realtime` 17、`task-counts-touchpoints` 62） |
| 任务单测子集（31 个文件） | 31 files / 1239 passed |
| 真库 lane（另一台机器，PostgreSQL 16.15；新建的一次性库，426 条迁移；`tasks-realdb.yml` 的 17 个文件） | 一遍：17 files / 729 passed，其中 `task-m4-realtime` 21；`socket hang up` 0；跑后远端工作树没有改动、`src` 无 diff、没有 `.task-probe-*` 残留 |
| 鉴权门（同上，`plugin-tests.yml` 那一步的环境） | 86 passed (86) |
| 合并后的树 | 把本轮的 `task-counts-touchpoints.test.ts` 放进 PR-3a、PR-3b、本 PR 与 M4 前端合在一起的本地合并树（未推送）：两个单测文件 79 passed；前提格的人口在那棵树上是 11 个模块，含 PR-3b 的 `task-notification-producer.ts` 与 `task-notification-flags.ts` |
| PR-3b 的 head `2974ba5363` 与 main `fc139c868e` | `src` 里没有 `UPDATE ONLY`、`DELETE FROM ONLY`，也没有带括号列清单的 `UPDATE tasks … SET (…)`；PR-3b 加进前提格人口的两个模块（`task-notification-producer.ts`、`task-notification-flags.ts`）里没有 `catch`、`finally`、`.catch(`、`.then(`，也没有 `Promise.allSettled`、`Promise.race`、`Promise.any`。PR-3b 的调度与投递模块不在写入文件的 import 链上，不在这一格的人口里（设计 §10） |
| 门 15（本轮改动的生产注释两行，§6 的记号表） | 0 命中 |
| 文本扫描（字面扫描器 v1/v2 与引号扫描器）对本轮改动的每个文件与每条提交信息 | 全部 exit 0 |
| diff 与提交信息里的机器名、局域网 IP、本机路径 | 0 命中 |
| 远端工作树、一次性库与日志 | 用完已删 |

### 11.3 格数（门 17 ②）

不变：真库 lane 729（`task-m4-realtime` 21），两个单测文件 17 + 62。本轮没有新增或删除格，只改了 `task-counts-touchpoints` 里两格合成正控的内容和前提那两格的标题。

### 11.4 变异

做法同 §10.5：needle 恰一次，`cp` 备份，跑两个单测文件（79 格），复制回去，`cmp` 逐字节相同且 `git hash-object` 等于 HEAD 的 blob；新建文件跑完即删，批次前后 `git status` 相同。源码变异在 `68acef59f5` 上跑；S18–S31 变异的是本轮提交的单测文件自己的扫描器。编号接 §10.5 的 S1–S4。

| # | 变异 | 红的格（79 格中） | 结果 |
|---|---|---|---|
| S5 | `lockTaskRowForDelete` 的 `catch` 在 `throw err` 之前多一个带 `return` 的分支 | 前提格（报 `lockTaskRowForDelete`） | 杀 |
| S6 | `removeAssignee` 的事件写入包进 `Promise.allSettled([…])` | 前提格（报 `removeAssignee`） | 杀 |
| S7 | 同上，换成 `Promise.race([…])` | 前提格 | 杀 |
| S8 | 同上，换成 `Promise.any([…])` | 前提格 | 杀 |
| S9 | `lockTaskRowForDelete` 的 `try` 加一个含 `return` 的 `finally` | 前提格（报 `lockTaskRowForDelete`） | 杀 |
| S10c | 对照：`removeAssignee` 的事件写入包进 `Promise.all([…])` | 0 | 存活（按设计） |
| S11c | 对照：`lockTaskRowForDelete` 的 `try` 加一个只求值的 `finally` | 0 | 存活（按设计） |
| S12 | 新服务文件：`UPDATE ONLY tasks SET status = …` | 人口格、写入者格 | 杀 |
| S13 | 新服务文件：`UPDATE tasks SET (status, version) = (…)` | 人口格、写入者格 | 杀 |
| S14 | 新服务文件：`DELETE FROM ONLY tasks` | 人口格、写入者格 | 杀 |
| S15 | 新服务文件：`UPDATE ONLY task_assignees SET completed_at = NULL` | 人口格、写入者格 | 杀 |
| S16 | 新服务文件：`DELETE FROM ONLY public.task_assignees` | 人口格、写入者格 | 杀 |
| S17c | 对照：新服务文件里 `UPDATE tasks SET (title, updated_at) = (…)` | 0 | 存活（按设计） |
| S18–S25 | 扫描器：不查 `catch` 块里的 `return`、`break`、`continue`；不查 `finally`；不查组合子；组合子不跳过注释行；`catch` 块不滤掉注释行；组合子的模式不容空白；关键字表少 `continue`；少 `break` | 前提格的合成正控，各 1 格 | 8 个全杀 |
| S26–S31 | 扫描器：`UPDATE tasks`、`DELETE FROM tasks`、`UPDATE task_assignees`、`DELETE FROM task_assignees` 各自不读 `ONLY`；不读带括号的列清单；列清单不要求输入列 | 普查格的合成正控，各 1 格 | 6 个全杀 |

27 个变异：24 个按预期变红，各自只红上表那一格（或那两格）；3 个对照按设计存活。27 次还原逐字节相同，批次前后 `git status` 相同。

### 11.5 R01 (iii) 与 NOT RUN

- `3edd133ae0..68acef59f5` 在 `src` 下只改了 `task-counts-realtime.ts` 头注释的两行。§6 里由 lane、鉴权门与任务单测子集承载的 `M2|`、`M3|` 行，由 §11.2 在 `3cab4ae108` 上重新承载；§6 的手工控件没有重跑。门 26 的格仍是候选。
- NOT RUN：CI（本轮的提交没有推送）；全量单测；lane 只跑了一遍（§10.3 是三遍）；CI 的 postgres:16 容器与 PG14；合并后的树上的真库 lane（那棵树上只跑了两个单测文件）；§8 其余各项不变。

## 12. 第三轮（2026-10-09，重建到 main 上的 PR-3a 之上）

本节记重建、发送失败日志的规则、R01 ③ 的时点改正，以及它们的绿线与变异；§1–§11 不改，只有 §6、§8 各加了一条日期注，§3、§10.3、§11.2 的文本扫描一行改用通用名称；修订 8 另把 §0、§3、§6、§10 几处脚本、配置与清单的存放位置改写为「不入库」，内容不变。

### 12.1 重建

- PR-3a 重建为 main `8f90307d5a` 上的单个提交，本分支随之重建为叠在它之上的单个提交，基是重建后的 PR-3a。与 main 没有冲突。
- 本 PR 的 13 个文件里，`packages/core-backend/vitest.config.ts` 的上下文行变了：main 在同一个 exclude 列表里新加了一项，自动合并；本 PR 增删的行相同。其余 12 个文件的差异在重建时与重建前逐行相同；之后本轮改了 `task-counts-realtime.ts`、它的单测与本 PR 的两份文档（12.2、12.3）。
- 本 PR 不含迁移；用到的表来自 PR-3a 的迁移 `zzzz20261009130000_create_task_m4_tables`。

### 12.2 发送失败的日志只记固定码

- 规则（设计 §4.3、`[own-3c-10]`，修订 7）：发送失败只记一条 `warn`，参数恰为固定说明 `task counts signal not sent` 与 `{ code: 'TASK_COUNTS_SEND_FAILED' }`，不从错误对象读任何东西。
- 2026-10-09 审阅发现：本轮第一稿（`b801bd53da`）的码由错误算出：错误自带的字符串 `code`，没有时取类名，再没有时为 `unknown`。错误自带的 `code` 与类名本身可能带上取值，读这两个属性还可能抛出：`code` 或 `name` 是会抛错的 getter 时，同步那一路的异常从 `publish()` 抛出，异步那一路变成未处理的拒绝（12.5 的 F4 在单测里重现了这两点）。现在只记固定码，从错误算码的函数已删掉。
- `src/services/task-counts-realtime.ts`：`warnSendFailed` 不带参数，只记固定说明与固定码；`sendOne` 的 `catch` 不再绑定错误（`catch {`），被拒绝的 promise 仍由 `.then(undefined, warnSendFailed)` 接住。`sendOne` 仍是设计 §4.2 前提格唯一的例外，那一格照常绿（它也断言这处例外仍然存在）。
- 单测四格（`task-counts-realtime` 17 → 21；第一稿的两格是 17 → 19，那两格换成下面的 1、2）：
  1. 发送端口同步抛出带标记 message 与标记 `code` 的 `Error`；
  2. 发送端口返回被拒绝的 promise，错误是带标记 message 与标记 `code` 的 `TypeError`；
  3. 错误的 `code` 与 `name` 都是会抛错的 getter，发送端口同步抛出它；
  4. 同一种错误，发送端口返回被拒绝的 promise（3、4 是 `it.each` 的两行，两名收件人里只有一人的发送失败）。

  四格都监视日志器的 `warn`，断言全部调用恰为 `[['task counts signal not sent', { code: 'TASK_COUNTS_SEND_FAILED' }]]`（断言里写字面量，不引常量）。1、2 另断言：把记下的参数连同错误对象的自有属性写成文本之后，文本里没有标记（错误的 message 与 stack 不可枚举，直接 `JSON.stringify` 只得到 `{}`）。3、4 另断言：`publish()` 不抛，另一名收件人照常收到，没有未处理的拒绝。
- 修订 8（2026-10-09）：3、4 两格的未处理拒绝监听器改用 `process.prependListener` 登记，排在 Vitest 自己的监听器之前；断言改为调用次数为 0（`toHaveBeenCalledTimes(0)`）。原因：Vitest 的监听器要读拒绝原因的 `name`，对这种错误会抛出，而一次 emit 在第一个抛出的监听器处就中止，所以修订 7 用 `process.on` 追加在它后面的监听器看不到原因就是这种错误的未处理拒绝：这样的拒绝发生时，Vitest 另报一条未捕获异常，整次运行失败，但这两格本身仍是绿的（12.5 的 F6）。现在这两格看得到任何原因的未处理拒绝，包括这种错误本身；断言只比次数，因为打印调用参数同样会读到 getter。覆盖面：被拒绝的 promise 只出现在格 4 那一路；格 3 是同步抛出，这条断言在格 3 只防失败路径上另起一个被拒绝的 promise。失败隔离那一组的第二格（发送端口返回被拒绝的 promise，原因是普通 `Error`）仍用追加的监听器：Vitest 读普通错误不会抛出，追加的监听器看得到它，所以不改。

### 12.3 R01 ③ 的时点

- R01（2026-10-07）的 ①–③ 是合并之前的判定，只有 ④（staging 真投递一次）在合并之后。
- 原来的写法：设计 §11 第 6 条问 PR-3b 与 M4 前端合入之后的那一遍由谁在何时跑；设计 §2.5、§7.5 与本文 §6、§8 说四件合在一起的最终 head 不存在、记为 NOT RUN；设计 §1 第 5 条把 ③ 写成在本分支的最终 head 上跑。
- 改正后（设计修订 6）：③ 在合并之前的最终候选集成树上跑。这棵树是含锁 PR（#6248）的 main，加上按合并顺序叠好的 PR-3a、PR-3b、PR-3c 与 M4 前端，冲突按各 PR 写明的解法解好；判定在 M4 的任何一张 PR 合并之前做完并留下记录。本文 §6 在 PR-3a 加 PR-3c 的 head 上跑的那一遍，以及 §10.6、§11.5 的重新承载，都是预备，不代替这一遍。
- 设计 §11 第 6 条只剩由谁跑：R01 没有定，本件不替 owner 定。

### 12.4 绿线

本机，Node 20.20.2（命令在 `packages/core-backend` 下）：

| 项 | 结果 |
|---|---|
| type-check `tsc --noEmit -p .` | 0 |
| 改动的单测文件的类型（临时 tsconfig，`extends` 本包配置、只含 `task-counts-realtime.test.ts`，用完删除） | 本轮改动的两个文件 0 条诊断；共 15 条，都在本 PR 没有改的文件里。另加 `noUnusedLocals` 时共 28 条，同样不在这两个文件里；改动前的同一单测文件在这个配置下也是这 28 条（去掉行列号逐条相同） |
| 两个单测文件 | 83 passed（`task-counts-realtime` 21、`task-counts-touchpoints` 62）；设计 §4.2 前提格与 §2.3 普查格在后者里，都绿 |
| 任务单测子集（31 个文件） | 31 files / 1243 passed（第二轮的 1239 加本轮 4 格） |
| 读文档的单测 | `task-gate19-identities` 9 / 9；`task-ci-coverage-enumeration` 4 / 4 |
| 门 15（本轮改动的生产注释：一段 5 行的块注释里的 3 行，§6 的记号表） | 0 命中 |
| 文本扫描（字面扫描器 v1/v2 与引号扫描器）对本轮改动的每个文件与提交信息 | 全部 exit 0 |
| diff 与提交信息里的机器名、局域网 IP、本机路径 | 0 命中 |

另一台机器，PostgreSQL 16.15，新建的一次性库，跑完删除；运行所在的提交与本节所在的提交只差两份文档（本文件与设计）和 `task-counts-realtime` 单测文件（修订 8；真库 lane 与鉴权门都不跑这个文件），`src` 相同：

| 项 | 结果 |
|---|---|
| 迁移 | 从空库全量迁移 427 条（CI 的排除清单） |
| 真库 lane（`tasks-realdb.yml` 的 17 个文件） | 一遍 729 / 729：`task-m4-realtime` 21，其余 16 个文件与 PR-3a 的格数表相同；`socket hang up` 与 `ECONNRESET` 都是 0；跑后那份检出的 `git status` 除依赖的符号链接外为空 |
| 鉴权门 | 两遍各 86 / 86：一遍带 `JWT_SECRET`、不带 `PRODUCT_MODE` 与 `RBAC_OPTIONAL`；一遍逐项照 `plugin-tests.yml` 那一步的环境（不给 `JWT_SECRET`，由 `tests/tasks-auth/setup.ts` 补） |

第一稿（`b801bd53da`）的树上那两遍记录保留：lane 第一遍 728 / 729，PR-3a 的 `task-m4-dates` 里一格 PATCH 422 格（只带开始时间、不带开始日期）超过 30 秒的格时限，同文件的一个钩子也超过 15 秒的时限，当时那台机器的 1 分钟负载约 5–6，本轮没有改那个文件，也没有改它走到的代码；重建一次性库之后第二遍 729 / 729；鉴权门两遍各 86 / 86。

修订 8（2026-10-09，本机，Node 20.20.2）。本版的 `src` 与上面两张表运行所在的提交相同，只改了两份文档与 `task-counts-realtime` 单测文件：

| 项 | 结果 |
|---|---|
| type-check `tsc --noEmit -p .` | 0 |
| 改动的单测文件的类型（同上的临时 tsconfig，用完删除） | 改动的单测文件 0 条诊断；共 15 条，加 `noUnusedLocals` 时 28 条，都不在这个文件里；与修订 7 的同一文件在同一配置下逐条相同（去掉行列号比较） |
| 两个单测文件 | 83 passed（`task-counts-realtime` 21、`task-counts-touchpoints` 62），格数不变 |
| 任务单测子集（31 个文件） | 31 files / 1243 passed |
| 读文档的单测 | `task-gate19-identities` 9 / 9；`task-ci-coverage-enumeration` 4 / 4 |
| 文本扫描（字面扫描器 v1/v2 与引号扫描器）对本版改动的三个文件与提交信息 | 全部 exit 0 |
| diff 与提交信息里的机器名、局域网 IP、本机路径 | 0 命中 |

### 12.5 变异

做法同 §11.4：每处替换先断言 needle 恰一次，`cp` 备份，跑 `task-counts-realtime` 单测文件（21 格），复制回去，`cmp` 逐字节相同且 `git hash-object` 等于运行所在提交的 blob；批次前后源文件的 md5 一致。F1–F3 还要在 `catch` 里重新绑定错误并传给 `warnSendFailed`，所以各是两处替换。

| # | 变异 | 格 1（同步） | 格 2（拒绝） | 格 3（getter，抛出） | 格 4（getter，拒绝） |
|---|---|---|---|---|---|
| F1 | 把原始错误交给日志 | 红：标记那条断言 | 红：标记那条断言 | 红：日志收到错误对象，比较参数时读到 `name` 的 getter | 红：同格 3 |
| F2 | 码取错误自带的 `code` | 红：标记那条断言 | 红：标记那条断言 | 红：`publish()` 抛出（`code` 的 getter） | 红：未处理的拒绝 |
| F3 | meta 另带错误的 message | 红：标记那条断言 | 红：标记那条断言 | 红：参数那条断言 | 红：参数那条断言 |
| F4 | 换回第一稿的整个文件（`code`，否则类名，否则 `unknown`） | 红：标记那条断言 | 红：标记那条断言 | 红：`publish()` 抛出（`code` 的 getter） | 红：未处理的拒绝 |
| F5 | 换一个固定码 | 红：参数那条断言 | 红：参数那条断言 | 红：参数那条断言 | 红：参数那条断言 |

5 个变异各让这四格全红，同一文件的其余 17 格都绿；5 次还原逐字节相同。F4 就是第一稿的代码，所以这四格在第一稿上全红。

第一稿上那一轮的 5 个变异测的是从错误算码的写法，原样保留如下；那个写法已经删掉，L4、L5 不再适用（第一稿的单测是 19 格）：

| # | 变异 | 同步格 | 异步格 |
|---|---|---|---|
| L1 | `warnSendFailed` 把原始错误交给日志（本轮之前的写法） | 红：message 那条断言 | 红：message 那条断言 |
| L2 | meta 另带错误的 message | 红：message 那条断言 | 红：message 那条断言 |
| L3 | meta 另带 stack 去掉首行之后的各帧 | 红：第一帧那条断言 | 红：第一帧那条断言 |
| L4 | 算码时不看错误自带的 `code` | 红：参数那条断言 | 绿 |
| L5 | 算码时不看类名 | 绿 | 红：参数那条断言 |

5 个变异：L1–L3 两格都红，L4、L5 各只红对应的一格；每个变异只红这两格之中的格，同一文件的其余 17 格都绿；5 次还原逐字节相同。L1 就是本轮之前的代码，所以这两格在本轮之前的代码上是红的。

修订 8（2026-10-09）：在改动后的单测文件上重跑 F1–F5，逐格结果与上表相同，同一文件的其余 17 格都绿（F2、F4 的格 4 仍红在未处理拒绝那条断言上：那条拒绝的原因是 `code` 的 getter 抛出的普通 `Error`）。另加两个变异，各在改动前（修订 7 的 `process.on`）与改动后（`process.prependListener`）的单测文件上跑一遍：

| # | 变异 | 改动前 | 改动后 |
|---|---|---|---|
| F6 | 被拒绝的 promise 的处理函数记完日志之后把原错误再抛出 | 四格都绿；整个文件只有失败隔离那一组的第二格红 | 格 4 红在未处理拒绝那条断言上（监听器被调用 1 次），格 1–3 绿；失败隔离那一格照旧红 |
| F7 | 去掉被拒绝的 promise 的处理函数 | 格 2、格 4 红在日志那条断言上；失败隔离那一格红 | 格 2 红在日志那条断言上，格 4 先红在未处理拒绝那条断言上；失败隔离那一格红 |

两个对照，都在 F6 下跑改动后的文件：只把 `prependListener` 换回 `process.on`，格 4 又是绿的，可见起作用的是登记顺序；只把次数断言换回 `not.toHaveBeenCalled()`，格 4 仍红，但报出的是打印调用参数时 `name` 的 getter 抛出的错误，不是次数。F6、F7 的每一遍里 Vitest 都另报 4 个未处理的错误（失败隔离那一格的两条拒绝、格 2 的一条拒绝，以及格 4 那条拒绝引出的一条未捕获异常），整次运行 exit 1。每次运行之后源文件都从备份还原：`cmp` 逐字节相同，`git hash-object` 等于本版提交里这个文件的 blob；批次前后源文件与单测文件的 md5 一致。

### 12.6 NOT RUN

- CI：本版没有推送，CI 没有跑过本版；CI 的 postgres:16 容器与 PG14。
- 全量单测；本版的真库 lane 只跑了一遍（12.4）。
- 修订 8 没有改 `src`，真库 lane 与鉴权门没有重跑；12.4 另一台机器上的那一遍跑在 `src` 相同的提交上。
- 真实 socket 的端到端（§8 不变）。
- R01 ①–③ 的判定：在合并之前的最终候选集成树上做（12.3），不在本分支上做；还没有做。
- staging 与生产：不触达。
