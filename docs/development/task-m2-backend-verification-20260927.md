# 任务功能 M2 后端验证记录（2026-09-27）

- 分支：`grok/tasks-m2-backend`，Draft PR #6062。
- 设计：`docs/development/task-m2-backend-design-20260927.md`。
- 锁：#5845，head `117b1ce30`（评论 5856087200）。
- 结论：下面列出的本地命令都通过。**真实 staging / 生产环境 NOT RUN。** 本记录不构成合并授权，也不表示 `TASKS_ENABLED` 已打开。DDL 没有应用到共享库 `metasheet_v2`。

## 1. 过程

实现与闸分开。闸方评论里的审阅模型是 Opus（Fable 当天返回 429）。下表只记已经写在 PR 评论里的轮次。

| 轮 | 评论 | 当时 head | 结论 |
|---|---|---|---|
| 1 | 5839851560 | 早期三文件 | 片未完整。锁 helper 单测判别力不足 |
| 2 | 5846646603 | `c4f7b466ad` | CHANGES REQUESTED。2 P1 / 5 P2 |
| 3 | 5847465302 | `48310a131c` | CHANGES REQUESTED。0 P1 / 4 P2。上一轮两条 P1 在代码上已关 |
| 4 | 5848315117 | `f8bcfc66e2` | CHANGES REQUESTED。1 P1 / 1 P2。第 3 轮各项已关 |
| 5 | 5849141136 | `73b4cd4051` | provenance 本地 exit 0。闸方未再列新的 P1 |
| 6 | 5854641326 | `4f733b0334` | CHANGES REQUESTED。1 P1 / 2 P2。与含 #6102 的 main 合并后 `tsc` 失败 |
| 7 | 5855378235 | `edf5d75d56` | CHANGES REQUESTED。0 P1 / 1 P2。合并预览 `tsc` 已零输出 |
| 8 | 5856929772 | `8f920efca4` | 本轮增量 APPROVE。PR 整体仍因与当时 main 的 pin 冲突不可合并。1 P1 / 0 P2 / 1 P3 |
| 收尾 | 5856089258 | 本记录这一次提交 | owner「按建议执行」。见第 3 节 |

## 2. 各轮 findings 与关闭方式

| 轮 | 问题 | 关闭方式 |
|---|---|---|
| 2 P1 | reopen 清掉其他执行人；锁外读旧快照再写回 | 只更新有变化的执行人行；状态不变不改 version。读取移到结构锁之后。真库竞态用例在 `task-p0a.db.test.ts` |
| 2 P2 | 完成/重开无测试、标题未走 `normalizeUserText`、flag manifest、门 16 空、锁键未透传 | 第 3 轮闸方表：守卫、门 10、门 18、锁键透传已关。门 16 留到第 4 轮 |
| 3 P2 | reopen 的 no-op 与锁外读仍测不出；门 16 删掉 `rbacGuard` 仍绿；没有三集合枚举 | 第 4 轮闸方表：这三项 mutant 都变红 |
| 4 P1 | `plugin-tests.yml` 改了，provenance pin 仍是 main 的哈希 | 随后提交重算 `pluginTestsWorkflow`。本记录这一次本地 `sealed-export-package-provenance.test.cjs` exit 0 |
| 4 P2 | 只把 `loadAssignees` 移出 reopen 的锁，测试仍绿 | 补 `scope:'all'` 的排队用例。第 8 轮不再把它列为打开项 |
| 6 P1 | 未传 `wasDone`，与 main 合并后 `tsc` 失败 | `completeTask` / `reopenTask` 传入 `wasDone: task.status === 'done'`，取值来自加锁后的 `loadTask` |
| 6 P2 | `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 删了在 CI 的默认隔离级别下仍绿；详情路由的 `rbacGuard` 无测试 | 单测要求 SET 是事务第一条语句。tasks-auth 增加详情 403 格。第 7 轮闸方表标这两项已关 |
| 7 P2 | `wasDone` 硬编码 true/false 或在加锁前另读，测试仍绿 | `task-p0a.db.test.ts` 两条用例：`keeps one completed and one reopened event when a zero-assignee task is repeated`；`records one completed event when two creator completes wait on the structure lock`。第 8 轮闸方表标判据已关 |
| 8 P1 | 与当时 main 在 `s6a-package-provenance-pins.json` 冲突 | 分支已含当时的 main。本记录推送前再次 rebase 到更新的 `origin/main`，并重跑 provenance 与 `tsc` |
| 8 P3 | 没有「两个零执行人 reopen 在锁后排队」 | 闸方写明不阻断。本记录未补这一例 |
| 收尾 | `/pending` 用 `all_open`，`/pending-count` 用 `overdue` | 不改代码。锁 §13-4：列表是全部未完成指派，红点默认只数过期。门 4 两格本身已过期，不能代替这个差别。用例：`keeps an undated open assignment on the pending list and out of the overdue count` |
| 收尾 | 门 19 四十九格、探针、门 4/5/8、门 1/2/13 | 见第 4、5 节。本地 verbose 通过 |

## 3. 本记录这一次做的收尾

评论 5856089258 的顺序：

1. `wasDone` 真库用例名见上表第 7 轮那一行。
2. pending 与 count 的差别保留，理由见上。
3. `task-read-path.db.test.ts` 一次覆盖 49 个 `gate19|…` 名字、探针①②、门 4 两格、门 5 跨时区字节、门 8 甲乙与 fallback mutant。文件同时写进 `vitest.config.ts` 的 exclude 和 `tasks-realdb.yml`，顶部 import `assert-rbac-optional-off`。`task-gate19.db.test.ts` 已删，避免和这份文件重复登记。
4. 门 1 在 `tasks-auth-gate.ts`（`RBAC_TOKEN_TRUST=false`）：无 org 的写 422、同一夹具补上 org 后写 200、跨 org 写 422、org 隔离读，以及只有 `tasks:read`、没有 admission 时 403。门 2 六格与门 13 在 `task-rbac-trust.db.test.ts`（集成 setup 的 `RBAC_TOKEN_TRUST=true`）。
5. 门 3 存活六格各断言创建后的 `COUNT(task_assignees)`。`all×0` 与 `any×0` 断言非创建人 complete 得到 404，任务仍是 `open`。三个 any 格在完成前断言 §6.2：`open` 且 `any` 时没有非空 `completed_at`。门 20 正控是 `acquireTaskStructureLock(pg.query)`，错误码 `TASK_DB_STUB`。

接口形状没有改。

## 4. Mutation 证据（本机，2026-09-27 晚）

每一处都是：`cp` 备份、改源码、新进程重跑、`cp` 还原。还原后 `git diff -- packages/core-backend/src/tasks` 为空。

| 改动 | 绿（改之前） | 红（改之后） |
|---|---|---|
| 探针①：assigned 臂整段换成 `FALSE` | 同一形状的夹具：assigned、pending 都含该行，`countPending` 为 1 | `{"gate19probe1":"red","assignedRed":true,"pendingHasRow":false,"count":0}`。assigned 查询因 `$1` 不再出现而抛 `42P18`，测试把这个错误当成该端变红。pending 与 count 仍绑定 `$1`，行消失，count 为 0 |
| 探针②：`TASK_ROLE_ABILITY.assignee.complete` 改为 false | 改之前，同一执行人的 `completeTask` 成功 | `{"gate19probe2":"red","failed":true,"assigned":true,"pending":true,"count":1}`。完成后列表三端仍在，count 仍为 1 |
| 门 8：`resolveViewerTimeZone` 的回退从任务时区改成 `'UTC'` | 非法头 `Not/AZone` 和缺头都与显式 `Asia/Shanghai` 相同 | `{"gate8":"red","explicit":false,"invalid":true,"missing":true}` |
| 门 1：去掉 `tasks.org_id = $2` 这个等值（保留 `$2` 绑定，否则 Postgres 报 `42P18`） | `GET /api/tasks?view=any_role` 与 `GET /api/tasks/pending` 含 org A、不含 org B | `{"gate1org":"red","listed":true,"pending":true}`。两面都出现 org B |

更早轮次的 mutant 由闸方写在对应评论里，这里不重跑、不改写他们的红绿数字。

## 5. 本地命令与用例数

一次性库 `metasheet_tasks_m2_gate_20260927`（本机 Postgres，不是 `metasheet_v2`）。迁移 exit 0，含两个任务迁移。跑完后删除这个库。

真库（`vitest.integration.config.ts`，`EXPECT_DB=1`，`NO_COLOR=1`）exit 0：

| 文件 | 收集到的通过用例 |
|---|---|
| `tests/integration/task-p0a.db.test.ts` | 13 |
| `tests/integration/task-read-path.db.test.ts` | 57 |
| `tests/integration/task-rbac-trust.db.test.ts` | 7 |
| `tests/integration/task-completion-grid.db.test.ts` | 6 |
| 合计 | 83 |

上面这次跑在 `b27cf9208`。四个文件当时没有 `it.each` / `test.each`，但门 19 网格是 `for` 里的一个 `it(name)`，vitest 收集成 49 条。按锁的展开规则，静态 `it(` 是 35，不是 83。收集数不等于展开后静态计数。那句「静态计数等于收集数」不成立。

评论 5857450153 之后，同一台已有的一次性库 `metasheet_tasks_gate_tmp`（不是 `metasheet_v2`，这次没有建库、没有迁移）再跑四个文件，exit 0，89 通过：

| 文件 | 收集到的通过用例 |
|---|---|
| `tests/integration/task-p0a.db.test.ts` | 13 |
| `tests/integration/task-read-path.db.test.ts` | 57 |
| `tests/integration/task-rbac-trust.db.test.ts` | 13 |
| `tests/integration/task-completion-grid.db.test.ts` | 6 |
| 合计 | 89 |

`task-read-path.db.test.ts` 的 `it.each(cells)` 展开 49 行，没有表头。这 49 个名字就是 `cells` 里的 `gate19|…`，与 `i-m2` 相同。其余是普通 `it(`：p0a 13、read-path 8、rbac-trust 13、completion-grid 6，共 40。展开后静态计数 = 40 + 49 = 89，与收集数相同。

这一轮还做了：两个 `view` 的 HTTP 行集不同；未知 `view` 是 `predicate_error`；没有租户时 `/pending` 与 `/pending-count` 是 `org_missing`，不会去读 org `default`；门 8 的生产路径是 `/pending-count` 的全天 overdue（非法头和缺头与任务时区相同，路由回退改成 `UTC` 后 `{"gate8route":"red","explicit":1,"invalid":0,"missing":0}`）；门 13 用 `MetaSheetServer` 的 `index.ts` 挂载，把挂载改成 `null` 后这一格是 404 而不是 200，随后已还原。any 模式三格在 complete 和 reopen 之后都断言 §6.2。`src/tasks` 没有改。M2 仍没有写入 `time_zone` 的路由，非法 IANA ⇒ 422 还没有写路径。

`vitest.tasks-auth.config.ts` exit 0：8 通过。其中门 1 四格（无 org 写、跨 org 写、org 隔离读、无 admission 403）和原先的 401/403/200 对照。

同一会话里另外跑过、exit 0 的单测 22 个：`task-pure-no-io` 5、`task-advisory-locks` 5、`task-ci-coverage-enumeration` 4、`task-gate19-identities` 6、`tasks-auth-ci-wiring` 2。枚举测试确认磁盘上的 `task-*.db.test.ts`、exclude、lane 三份名单相等，且每个文件都 import 了 `assert-rbac-optional-off`。

`pnpm --filter @metasheet/core-backend exec tsc --noEmit --pretty false` 在 rebase 前的工作树上 exit 0，输出为空。rebase 到当时的 `origin/main` 之后再跑一次，结果写在 PR body。

`node plugins/plugin-integration-core/__tests__/sealed-export-package-provenance.test.cjs` exit 0。

门 19 自证（exit 0，stdout 只有这一行）：

```text
gate19: passed identities equal the i-m2 list
```

命令：

```bash
NO_COLOR=1 CI=true pnpm exec vitest run --config vitest.integration.config.ts \
  tests/integration/task-p0a.db.test.ts \
  tests/integration/task-read-path.db.test.ts \
  tests/integration/task-completion-grid.db.test.ts \
  tests/integration/task-rbac-trust.db.test.ts \
  --reporter=verbose
pnpm exec tsx tests/helpers/gate19-identities.ts /tmp/tasks-m2-db-verbose.txt \
  docs/development/task-feature-design-lock-20260917.md
```

第二条的锁路径用的是锁工作树里的那份文件。diff 为空，所以没有打印 missing/extra。

## 6. CI run id 与收集数

`b27cf9208` 的本地收集数是 83，但那不是展开后静态计数（见第 5 节）。当前工作树的本地收集数是 89，展开后静态计数也是 89：`it.each(cells)` 49 行，加上 40 个普通 `it(`。

`5362170a8` 的 `tasks-realdb` run [36329492872](https://github.com/zensgit/metasheet2/actions/runs/36329492872) 失败：`task-rbac-trust.db.test.ts` 在模块装载时要求 `JWT_SECRET` 至少 32 字符，这条 lane 没有设置它。同一日志里另外三个真库文件是通过的。这不是还开着的缺陷。探针②的红结果已经打出来。Plugin System Tests run [36329492901](https://github.com/zensgit/metasheet2/actions/runs/36329492901) 被下一笔只改文档的推送取消。

`b27cf9208` 把 lane 夹具 `JWT_SECRET` 写进 `tasks-realdb.yml`。那不是生产口令。`tasks-realdb` run [36329710616](https://github.com/zensgit/metasheet2/actions/runs/36329710616) 在这个 head 上成功，83 个测试。没有重跑。

Plugin System Tests run [36329710574](https://github.com/zensgit/metasheet2/actions/runs/36329710574) 已结束，结论 success。其中 job `test (20.x)` 也是 success。这一 job 里 `pnpm --filter @metasheet/core-backend test` 的收集数是 18200（16590 passed，1610 skipped）。同 job 的 tasks auth gate 步骤收集 8，8 passed。这是 `b27cf9208` 的日志，不是上面 89 这条本地结果。

`d1b76c711` 的 Plugin System Tests run [36333266243](https://github.com/zensgit/metasheet2/actions/runs/36333266243) 已结束，结论 success。job `test (20.x)` 也是 success。这一 job 里 `pnpm --filter @metasheet/core-backend test` 收集 18200（16590 passed，1610 skipped）。同 job 的 tasks auth gate 收集 8，8 passed。同一 head 的 `tasks-realdb` run [36333265859](https://github.com/zensgit/metasheet2/actions/runs/36333265859) 成功：4 个文件，89 个测试。这两次运行都在 `d1b76c711`，不在记录它们的后续文档提交上。评论 5858154058 的裁决是 APPROVE-with-hardening（0 P1 / 1 P2）。这一笔只补 CI 数字，不关闭那条 P2，也不声称 M2 退出。

门 17③（把 `tasks-realdb` 加进 main required checks）是合并后的 owner 步骤，本 PR 不做。

## 7. 未验证

- **staging / 生产：NOT RUN。**
- 共享库 `metasheet_v2` 没有迁移。
- 全量 `pnpm --filter @metasheet/core-backend test:unit` 这一次没有重跑。第 8 轮闸方在 `8f920efca4` 上记过 14470/14470；那不是本 head。
- 第 8 轮 P3 的双 reopen 排队用例：NOT RUN（闸方标了不阻断）。
- 浏览器端到端不在本 PR。闸方 2026-09-27 的本地联调用的是更早的 head `edf5d75d56`。
- 合并仍要 owner 另行授权。
