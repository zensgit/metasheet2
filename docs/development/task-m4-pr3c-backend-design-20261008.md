# 任务功能 M4 后端 PR-3c 设计（红点实时失效，2026-10-08）

> **状态：DRAFT。** 本件的基是 PR-3a 重建前的 head `03a6527061`（Draft #6266 是把同一棵树重建成单个提交）。PR-3c 只作 Draft，不合并、不部署、不含迁移、不打开任何 `TASKS_*` 开关。所依据的裁定是 owner 2026-10-07 按 M4 回复模板落槌的 R16 与 R01，另有裁决包的缺省实现约束 D10；裁决包与闸裁决书不公开，本文只按条目 id 引用，不引原文。
>
> **2026-10-08**：本件重建为叠在 #6266 的 head `68e40323bd` 上的单个提交，以 Draft #6269 推送；上一段的基点是重建之前的记录。
>
> **2026-10-09**：PR-3a 重建为 main `8f90307d5a` 上的单个提交，本件随之重建为叠在它之上的单个提交，基是重建后的 PR-3a；上面两段的基点是那之前的记录。

- **锁**：`docs/development/task-feature-design-lock-20260917.md` §13-30（socket 扇出）。R16 取代了该题的建议段。
- **上游设计**：PR-3a 设计 `docs/development/task-m4-pr3a-backend-design-20260930.md`（§1 把 socket 与 M2/M3 门行回归划给 PR-3c，§4.2 是结构锁事务协议，§10.9 是回归的分工）。
- **下游**：前端设计（分支 `claude/tasks-m4-frontend`）`docs/development/task-m4-frontend-design-20261007.md` §8.2、§8.3 的 FE-c 订阅本件的事件。§12 给出 FE-c 需要核对的点。
- **纯函数**：`src/tasks/task-realtime.ts` 的 `countsUpdateRecipients`（任务 D）。本件只调用，不改它。
- **并行分支**：PR-3b（`claude/tasks-m4-pr3b`）在其中六个服务回调（完成、重启、加负责人、删负责人、切换完成方式、删除）里加了 outbox 写入，见 §10。
- **修订 8**（2026-10-09）：§12 第 4 条改写为前端按门 26 的固定信号窗口合并重拉（owner 2026-10-09 裁定），不再说由 `refresh()` 的 generation 合并：generation 只丢弃较早那次读取晚到的结果，不减少请求。抬头状态段一句改了措辞，内容不变。触点、收件人与发送时机不变。
- **修订 7**（2026-10-09，审阅发现）：发送失败的日志改为固定说明加固定码 `TASK_COUNTS_SEND_FAILED`，不再从错误对象读任何东西（§4.3、§4.3.1、§7.1、`[own-3c-10]`）。修订 6 的码取自错误自带的 `code` 或类名：这两者本身可能带上取值，读它们还可能抛出（`code` 或 `name` 是会抛错的 getter 时，同步那一路的异常从 `publish()` 抛出，异步那一路变成未处理的拒绝）。§7.1 的日志单测由两格改为四格。触点、收件人与发送时机不变。
- **修订 6**（2026-10-09）：发送失败的日志只记一个固定码，不记错误的 message 与 stack（§4.3、§4.3.1、`[own-3c-10]`），§7.1 补两格日志单测；R01 第 (iii) 部分的时点改正为合并之前的判定，在最终候选集成树上做（§1 第 5 条、§2.5、§7.5、§11 第 6 条）。触点、收件人与发送时机不变。
- **修订 5**（2026-10-09）：§4.2 的规则改写为：离开 `catch` 的每一条路径都抛出，并且没有任何写法吞掉语句的错误；§7.1 的前提格写全它认得的写法（`catch` 里的 `return`、`break`、`continue`，`finally` 里的这三者，`Promise.allSettled`、`Promise.race`、`Promise.any`）；§7.1 的普查格补读 `UPDATE` 与 `DELETE FROM` 之后的 `ONLY` 和带括号的 `SET` 列清单。触点、收件人与发送时机不变。
- **修订 4**（闸修复）：§1 第 3 条按 §4.4 改写；§2.2 改正 `badge_scope` 的读法与时区一行；§2.4 与 §11 写明触点集合是 R16 裁定的、不再请 owner 确认（§11 第 1 条改为陈述，第 3 条收紧，第 5 条移为给锁 PR 的备注）；§4.2 写明提交之后才发送的前提（回调不吞语句错误）并在单测里钉住；§4.4 的接线历史改为「修订 2 之前」；§7.1、§7.2 补闸修复加的格（操作者本身是负责人、已完成的负责人、只改开始或描述、普查读到的更多写法、前提那一格）；§10 写明冲突的是六个回调，以及其中唯一不机械的一步；§12 第 3 条改正，补第 9 条（socket 认证与路径）。规则、触点与收件人不变。
- **修订 3**（文字）：§4.3.1 写明与仓库里既有做法的对照；§7.1 的标题列全两个单测文件。规则不变。
- **修订 2**（全量单测之后）：接线从任务路由挂载处移到构造函数、改经 `coreAPI.websocket.broadcastTo`（§4.4、`[own-3c-06]`）。原写法在 `setupMiddleware` 里新增了一处 `this` 用法，全量单测里另一条线冻结 `index.ts` 装配范围 `this` 用法的普查因此变红；任务单测子集与真库 lane 都碰不到那道普查。规则、触点与收件人不变。
- **修订 1**（S1–S5 实现之后）：§5 补进程范围（socket 服务是进程内 adapter）；§7.1 的普查格人口改为 `src` 全部文件；§7.2 的格表按实现写全（回滚格扩到其余写入、零负责人格、接线格的细节）；§12 补第 8 条。规则与触点不变。

---

## 1. 范围

**做**：

1. 新服务模块 `src/services/task-counts-realtime.ts`：事件名常量、发送端口（模块级 seam，缺省为空操作）、每次写入一个的信号收集器（事务内记录、提交后发送）。
2. 改变红点输入的八个服务函数在事务内、读完锁后的行之后记录写入前后的负责人集合，在事务提交之后发送（§3、§4）。
3. `src/index.ts` 的 `MetaSheetServer` 构造函数在绑定 `ICoreAPI` 之后，把发送端口经 `coreAPI.websocket.broadcastTo` 接到注入器里的 `CollabService.broadcastTo`（§4.4）。
4. 测试：单测（发送端口、收集器、八个触点的提交顺序），一个新的真库文件 `task-m4-realtime.db.test.ts`（候选门 26 的格），三处登记（§7）。
5. R01 第 (iii) 部分的预备：在本分支的 head 上把锁里全部 `M2|`、`M3|` 门行重跑一遍并记录（§7.5）。R01 的 ①–③ 是合并之前的判定，在最终候选集成树上做，不在本分支上做（§2.5）。

**不做**：

| 不做的事 | 去向 |
|---|---|
| 前端订阅、重拉、门 26 的前端格（负控丁） | FE-c |
| outbox、调度、钉钉投递、N1 | PR-3b |
| 设置 `PATCH /api/task-settings`（`badge_scope`）时发事件 | 不发，见 `[own-3c-04]`、§11-Q4 |
| 任务因时间推移变成逾期（没有写入）时发事件 | 不发，见 `[own-3c-11]` |
| 新 flag、新权限码、DDL、迁移 | 不需要（§6） |
| 改锁正文（门 26 的正文在 R01 的锁 Draft 里） | 锁 PR，合并另需 owner 点名 |
| 改 `countsUpdateRecipients` | 不改 |

---

## 2. 裁定与读法

### 2.1 R16（2026-10-07 裁定）

- 事件名 `tasks:counts-updated`。
- 房间：`buildAuthenticatedUserRoom(userId)`（`src/services/CollabService.ts:8`），即 `auth-user:<userId>`；`CollabService` 只在 token 验证通过之后让 socket 加入这个房间（`CollabService.ts:121`）。
- 收件人：本次写入之前与之后的负责人集合取并集（`countsUpdateRecipients`）。关注人不是收件人；一个人同时是负责人时按负责人收到。
- 载荷只是失效信号：不含计数，不含任何任务字段。客户端收到后用自己的 `x-viewer-time-zone` 重新请求 `/api/tasks/pending-count`（`overdue_or_today` 的计数取决于查看者时区，服务端发送时不知道它）。
- 只在写入事务提交之后发送；事务回滚则不发送（D10 是同一条约束）。
- 触点按谓词判定：一次已提交的写入，只要改变了 `buildTaskPendingCondition`（`src/tasks/task-access.ts:271-300`）的任一输入，就发送一次。

### 2.2 谓词的输入（从代码读出）

`buildTaskPendingCondition` 以 assigned 臂为底（`task_assignees.user_id = 我`），再加 `tasks.status = 'open'`、「我的那一行 `completed_at` 为空」与 scope 子句；org 与软删经 `taskOrgLiveClause`（`task-access.ts:192-194`）。所以输入是：

| 输入 | 列 |
|---|---|
| 负责人集合 | `task_assignees` 的行 |
| 各负责人的完成态 | `task_assignees.completed_at` |
| 任务状态 | `tasks.status` |
| 软删 | `tasks.deleted_at` |
| 截止 | `tasks.due_date`、`tasks.due_time`、`tasks.due_at` |
| 时区 | `tasks.time_zone`（只在 `COALESCE(查看者时区, tasks.time_zone)` 里，即没有查看者时区时才读到：全天任务的「今天」，以及 overdue_or_today 下有截止时间的任务的「今天结束」） |
| org | `tasks.org_id`（没有任何写入改它） |

`badge_scope` 也会到达这个谓词：`countPending` 自己读出查看者的 `badge_scope`（`loadBadgeScope`），经 `pendingScopeForBadge` 变成谓词的 `scope` 参数，决定取 overdue 还是 overdue_or_today 子句（`off` 时根本不查）。它和查看者时区一样是查看者一侧的参数，不是任务行的状态。R16 列举的输入都是任务行的状态（上表），它的收件人规则（写入前后的负责人）对设置写入给不出集合；所以设置写入不发送是本件的取舍（`[own-3c-04]`），留在 §11-Q4。`completion_mode` 不在谓词里；切换完成方式能改变的输入是 `status` 与各人的 `completed_at`。

### 2.3 写入者普查（从代码读出）

在 `packages/core-backend/src` 里写上表各列的语句只出现在三份服务文件里：

| 写入 | 函数 | 文件 |
|---|---|---|
| `INSERT INTO tasks`、`INSERT INTO task_assignees` | `createTask` | `services/task-records.ts` |
| `UPDATE task_assignees SET completed_at`、`UPDATE tasks SET status` | `completeTask`、`reopenTask`（经 `writeChangedAssignees`、`writeTaskDoneState`） | `services/task-records.ts` |
| `INSERT` / `DELETE task_assignees`，状态翻转 | `addAssignee`、`removeAssignee` | `services/task-structure.ts` |
| `completed_at` 与 `status`、`completion_mode` | `switchCompletionMode` | `services/task-structure.ts` |
| `UPDATE tasks SET deleted_at` | `deleteTaskById` | `services/task-structure.ts` |
| `UPDATE tasks SET due_date, due_time, time_zone, due_at …` | `patchTask` | `services/task-patch.ts` |

`setTaskParent` 也写 `tasks`，但只写 `parent_id`、`depth`、`updated_at`，都不是输入。清单、清单项、分组、设置、评论、关注人与退出都不写上表的列。所以触点恰是上表八个函数（§3）。单测里有一格把这张表钉在源码上（§7.1 的普查格），新增写入者而不发送时它变红。

### 2.4 触点集合是裁定的

R16 的裁定（2026-10-07）把触点从枚举改为 §2.1 末条的谓词，并逐项列出了写入种类；§3 的八个函数与这些种类一一对应：`createTask`（带负责人的创建）、`completeTask`、`reopenTask`、`addAssignee` 与 `removeAssignee`（负责人的加与删，裁定里算一类）、`switchCompletionMode`、`deleteTaskById`、`patchTask`（动到截止字段或时区时）。R01 锁 Draft 里门 26 的触发列表是同样七类。本 PR 任务说明列的五类（完成与重启、负责人的加与删、删任务、改截止日期的 `PATCH`）是 R16 落槌之前的建议清单，不完整；五类都在八个函数之中。所以触点集合不是本件的取舍，不再请 owner 确认（§11 第 1 条）。本件自己的取舍只在两个子情形：不改变谓词输入的模式切换（`[own-3c-02]`，§11-Q2）与只改时区的 `PATCH`（`[own-3c-03]`，§11-Q3）。

### 2.5 R01 与门 26

- R01 第 (iii) 部分要求在 M4 的最终 head 上把全部 `M2|` 与 `M3|` 行重跑。R01 的 ①–③ 是合并之前的判定，只有 ④（staging 真投递一次）在合并之后，所以这里的最终 head 是合并之前的最终候选集成树：含锁 PR（#6248）的 main，加上按合并顺序叠好的 PR-3a、PR-3b、PR-3c 与 M4 前端，冲突按各 PR 写明的解法解好（与 PR-3b 的冲突见 §10）。② 的新行在锁 PR 合并之前不计分，所以这棵树以合并了锁 PR 的 main 为基；判定在 M4 的任何一张 PR 合并之前做完并留下记录。
- 本分支是 PR-3a 加 PR-3c，没有 PR-3b，也没有 M4 前端；`apps/web` 是 main 上 M3 前端的状态。本 PR 在自己的 head 上把这些行全部重跑一遍并记在验证 MD，那一遍是预备，不代替最终候选集成树上的判定（§7.5、§11-Q6）。
- 裁决包把 socket 列为候选门 M4-f；R01 把它改为新门 26，行键 `M4|26|整门`。门 26 的正文在 R01 的锁 Draft 里，锁 PR 合并之前，本 PR 的门 26 格是候选、未计分（与 PR-3a 设计 §10.0 同一处理）。锁 Draft 里门 26 的正控与负控标着起草方设计、不是 R01 原文；本件按它们实现，见 §7.2。

---

## 3. 触点

八个函数，每个都在结构锁（`createTask` 是它自己的事务，同样先取结构锁）之后读行、在同一个事务里写，然后：

| 路由 | 函数 | 发送条件（全部是本次写入真的改了的东西） | 写前集合 | 写后集合 |
|---|---|---|---|---|
| `POST /api/tasks` | `createTask` | 写入成功（负责人为空时收件人为空，不发送） | 空集 | 落库的负责人（去重后的 `assignees`；省略时是创建人本人） |
| `POST /api/tasks/:id/complete` | `completeTask` | 任务状态翻转，或至少一个负责人的 `completed_at` 变了 | 锁后读到的负责人 | 同左 |
| `POST /api/tasks/:id/reopen` | `reopenTask` | 同上 | 锁后读到的负责人 | 同左 |
| `POST /api/tasks/:id/assignees` | `addAssignee` | 纯函数给出了事件（真的加了人），或任务状态变了 | 锁后读到的负责人 | 纯函数给出的 `rows` |
| `DELETE /api/tasks/:id/assignees/:userId` | `removeAssignee` | 同上（真的删了人，或状态变了） | 锁后读到的负责人 | 纯函数给出的 `rows` |
| `PATCH /api/tasks/:id/completion-mode` | `switchCompletionMode` | 请求的模式与库里的不同（`[own-3c-02]`） | 锁后读到的负责人 | 纯函数给出的 `rows` |
| `DELETE /api/tasks/:id` | `deleteTaskById` | 写入成功（它总会写 `deleted_at`） | 锁后读到的负责人 | 同左 |
| `PATCH /api/tasks/:id` | `patchTask` | `due_date`、`due_time`、`time_zone`、`due_at` 任一与锁后读到的值不同（`[own-3c-03]`） | 锁后读到的负责人 | 同左 |

- 空操作（200、不写行、不写事件）不发送：上表的条件在空操作时都为假（加已在的负责人、删不在的负责人、对已完成的再完成、同模式切换、`PATCH` 内容与现值相同）。
- 失败的写入不发送：404、422（含 `INACTIVE_ORG_MEMBER`、`LIMIT`）、409（`VERSION_CONFLICT`、`TASK_BUSY`、`HAS_CHILDREN`）与 500 都在事务里抛出或在开事务之前抛出，发送那一行到不了。
- 收件人只来自锁后在本事务连接上读到的行与纯函数的结果，不另发 SQL。`deleteTaskById` 把 `loadRoles` 换成它内部调用的 `loadRowRoles`（同样的语句、同样的顺序），拿到角色的同时拿到负责人行；`patchTask` 从已经调用的 `loadRowRoles` 多取 `assignees`。所以既有单测里钉住的语句序列都不变。
- 零负责人的任务（R09：不进任何人的红点）：收件人为空，不发送；只有负责人才有红点。
- 操作者不排除：操作者在写前或写后的负责人集合里就收到（`[own-3c-09]`）。门 26 有两格、单测有一张五行表让操作者本身是负责人（§7.1、§7.2）。
- 已完成的负责人也在写前写后集合里：删除与 `PATCH` 同样发给他（他的红点不计这条任务，收到的只是一次多余的重拉）。

---

## 4. 发送机制

### 4.1 模块 `src/services/task-counts-realtime.ts`

| 导出 | 内容 |
|---|---|
| `TASK_COUNTS_UPDATED_EVENT` | `'tasks:counts-updated'` |
| `TaskCountsBroadcaster` | `(room: string, event: string, payload: Record<string, never>) => void` |
| `setTaskCountsBroadcaster(fn)` | 设置发送端口（生产只在 `index.ts` 设一次，§4.4） |
| `resetTaskCountsBroadcasterForTests()` | 恢复缺省的空操作 |
| `taskCountsSignal()` | 每次写入新建一个收集器：`note({ before, after })` 在事务内调用，记录两个用户 id 列表；`publish()` 在事务提交之后调用，按 `countsUpdateRecipients(before, after)` 的结果每个收件人发一次。没有 `note` 过的收集器 `publish()` 不发任何东西；同一次写入 `note` 多次时取所有记录的并集，仍是每人一次 |

每次发送：房间 `buildAuthenticatedUserRoom(userId)`，事件名 `TASK_COUNTS_UPDATED_EVENT`，载荷是新建的空对象 `{}`（`[own-3c-01]`）。

模块在 `src/services/`，不在 `src/tasks/`（门 20：`src/tasks` 无 I/O；本模块要 import `CollabService` 与日志）。

### 4.2 提交之后才发送

八个函数的形状相同：

```ts
const counts = taskCountsSignal()
const result = await withOrgStructure(input.orgId, async (db) => {
  // …锁后读行、调纯函数、写行（不变）…
  if (/* §3 的条件 */) counts.note({ before, after })
  return /* 原来的返回值（不变） */
})
counts.publish()
return result
```

- `withOrgStructure` 与 `createTask` 用的都是 `transaction()`（`src/db/pg.ts` → `src/integration/db/connection-pool.ts:174-212`）：`BEGIN`（`:182`）、跑回调、`COMMIT`（`:195`）、返回；回调抛错或 `COMMIT` 失败都会走 `ROLLBACK`（`:199`）并把错误抛出。所以在下一条规则成立时，`await` 正常返回就是事务已经提交；`await` 抛出时 `publish()` 那一行执行不到。
- **规则（提交之后才发送的前提）**：上一条只在回调不吞语句错误时成立。一条语句失败会让事务进入中止状态；回调若接住这个错误而照常返回，`transaction()` 照样发 `COMMIT`，PostgreSQL 对中止的事务回 `ROLLBACK` 而不报错，`transaction()` 也不看命令标签（`:194-196`），于是 `await` 正常返回，`publish()` 为一次已经回滚的写入发送。所以，八个函数的回调里、以及它们运行到的每个任务模块里（三个写入文件与它们逐层 import 的 `services/task-*`、`db/task-*`；`src/tasks` 没有 I/O，不含语句），离开 `catch` 的每一条路径都抛出（可以先换成别的错误，如 `fail(409, 'TASK_BUSY')`），并且没有任何写法吞掉语句的错误；唯一的例外是提交之后才运行的 `sendOne`（`[own-3c-10]`）。今天这些模块里只有 `lockTaskRowForDelete` 一处 `catch`，它的每一条路径都以抛出离开。单测里的一格把这条规则钉在源码上（§7.1）。本件不在共享的 `transaction()` 里检查命令标签，也不在回调末尾加一条探测语句：前者改的是各条线共用的连接池；后者让每次写入多一条语句，而既有单测钉着这些语句序列（§3）。
- 回调的返回值与各函数的对外返回值都不变（既有格用 `toEqual` 钉着这些形状）。
- 发送在服务返回之前完成，因此也在路由写出 HTTP 响应之前。
- 每次写入一个收集器，`publish()` 对收件人去重：每次写入每个收件人恰一次。

### 4.3 失败隔离

- `publish()` 从不抛出：每个收件人的发送各在自己的 `try/catch` 里，一个收件人失败不影响其余的人；发送端口若返回 promise，它的拒绝也被接住。失败只记一条 `warn` 日志：固定说明 `task counts signal not sent` 加 meta `{ code: 'TASK_COUNTS_SEND_FAILED' }`，此外什么都不记。本件不从错误对象读任何东西：它的 message、stack、`code` 与类名都可能带上取值，读属性本身也可能抛出（修订 7）。载荷也不记（载荷本来就是空对象）。写入的结果照常返回。
- 错误与日志只带码、不带取值（values-free），这是本件必须满足的规则，不是可选的加固；仓库里别处把错误对象交给日志的写法（§4.3.1）不改变这一点。
- 发送端口是同步调用，不等待网络；`CollabService.broadcastTo` 在 socket 服务初始化之前被调用时只记日志并返回（`CollabService.ts:483-489`）。
- 不重试，不进 outbox（`[own-3c-10]`）：socket 是尽力而为；前端保留 60 秒轮询作为回退（前端设计 §8.2）。

### 4.3.1 与仓库里既有做法的对照

- 审批的计数推送（`src/services/approval-realtime.ts` 的 `publishApprovalCountsUpdate`、`src/services/todo-realtime.ts` 的 `publishTodoCountsUpdate`，经 `src/routes/approvals.ts` 的 `publishApprovalCountsForUsers`）在路由里、事务 `COMMIT` 之后发送，失败只记 `warn` 并丢弃，房间同样是 `buildAuthenticatedUserRoom`。
- 审批评论的提及投递（`src/services/approval-comment-service.ts` 的 `setApprovalCommentMentionDelivery`）是一个模块级端口，缺省为空操作，在 `index.ts` 里设一次；路由在服务返回之后调用它。
- 本件沿用三点：提交之后才发送、失败只记日志并丢弃、模块级端口加空操作缺省。不同的一点是发送放在服务里、事务 `await` 之后，而不是路由里（`[own-3c-05]`）：八个服务的对外返回值保持不变（既有格用 `toEqual` 钉着这些形状），服务的每个调用方都会发送。另一点不同是载荷：审批的推送带计数，本件按 R16 不带。第三点不同是失败日志：既有做法把错误对象交给日志，本件只记固定说明与固定码 `TASK_COUNTS_SEND_FAILED`，不读错误对象（§4.3）。既有做法不是放宽这一点的理由：values-free 是规则，不是可选的加固（修订 7）。
- 这一段只写在设计里；生产源码的注释按门 15 不点名其他线的符号。

### 4.4 生产接线

`src/index.ts` 的 `MetaSheetServer` 构造函数在把 `coreAPI` 绑定为 `ICoreAPI` 之后加一行：

```ts
setTaskCountsBroadcaster((room, event, payload) => coreAPI.websocket.broadcastTo(room, event, payload))
```

- `coreAPI.websocket.broadcastTo` 是同一文件 `createCoreAPI()` 里给插件用的 websocket API，原样转给注入器里的 `CollabService.broadcastTo`（不加房间前缀、不分插件命名空间），并且每次调用时才向注入器取它（`[own-3c-06]`），所以不依赖 socket 服务初始化的先后。
- 接线写在构造函数里、而且不出现 `this`：`index.ts` 的装配范围（构造函数与 `setupMiddleware`）里每一处 `this` 用法都被另一条线的单测冻结成字面量清单（`tests/unit/attendance-w6-group-effective-policy-authorization.test.ts` 的四分桶普查），新增一处就变红。修订 2 之前的写法放在任务路由挂载处、经 `this.injector` 取服务，正是被这道普查拦下的（见修订 2）。本行只引用局部变量 `coreAPI`，普查不变。
- 接线不放进 `tasksRouter()`：路由工厂仍只建路由，门 1 / 2 / 16 的路由人口格与门 13 的改写点不受影响；任务路由挂载处的既有两行文本不动。
- 在构造时执行，所以不 `listen`、不 `start()` 的 `MetaSheetServer`（门 13 与本件接线格的做法）也已接好。
- 这一行不读任何环境变量。`TASKS_ENABLED` 不为 `'true'` 时路由不挂载，任务写入不会发生，也就不会发送。

---

## 5. 房间与租户

- 房间按用户、不按 org：`auth-user:<userId>`。一个在两个 org 都在职的用户，任一 org 里他作为负责人的任务被写入时都会收到信号。载荷不带 org，也不带任何任务字段；客户端重拉 `/pending-count` 时得到的是它会话 org（token 的租户）的计数，所以最坏是一次多余的请求，计数与任务数据不会跨 org 流出（`[own-3c-12]`，§11-Q7）。
- 收件人是写入方 org 里这条任务的负责人；任务行先经 `buildTaskByIdCondition` 按调用者的 org 取出，取不到就是 404，不发送。
- 被移除的负责人在写前集合里，照样收到；他之后可能看不到这条任务，但载荷里没有可泄露的内容。
- 关注人：不是收件人。门 26 的格逐一断言关注人收到零次。
- 不加入或离开任何房间：`CollabService` 在认证时让 socket 加入本人房间，本件只发送。
- 进程范围：socket 服务用的是进程内的 adapter（`CollabService.ts:369-379`，`WS_REDIS_ENABLED` 只打一条日志），一次发送只到达处理这次写入的后端进程上连着的 socket。部署多于一个后端进程时，连在其他进程上的客户端要等下一次轮询。所有 `broadcastTo` 的调用方都是这样，本件不改。

---

## 6. Flag

不新增 flag，不新增权限码。`packages/core-backend/src` 里不出现新的 `TASKS_*_ENABLED` 记号，flag manifest 测试不受影响。`TASKS_ENABLED` 对路由的控制不变。

---

## 7. 测试计划

### 7.1 单测（`tests/unit/task-counts-realtime.test.ts` 与 `tests/unit/task-counts-touchpoints.test.ts`，都是新文件，不进真库 lane）

- 发送端口：缺省空操作；设置后每个收件人一次调用，房间是 `buildAuthenticatedUserRoom(id)`，事件名是常量，载荷 `JSON.stringify` 恰为 `{}`；重置之后回到空操作。
- 收集器：只 `note` 不 `publish` 发零次；`publish` 而没有 `note` 发零次；写前写后的并集、去重、关注人不在其中（收集器只收负责人列表）；`note` 两次取并集、每人一次（第一次 `note` 的人第二次没有，分得出并集与只取最后一次）；一个收件人发送抛错时其余人照发、`publish` 不抛；发送端口返回被拒绝的 promise 时不产生未处理的拒绝。失败日志四格（修订 7）：同步抛错一格、返回被拒绝的 promise 一格，两格的错误都带标记 message 与标记 `code`；另有一个 `code` 与 `name` 都是会抛错的 getter 的错误，同步抛出与被拒绝各一格（`it.each` 两行，两名收件人）。四格都监视日志器的 `warn`，断言全部调用恰为一次、参数恰为固定说明加 `{ code: 'TASK_COUNTS_SEND_FAILED' }`（断言里写字面量，不引常量）；前两格另断言把记下的参数连同错误对象的自有属性写成文本之后没有标记；后两格另断言 `publish()` 不抛、另一名收件人照常收到、没有未处理的拒绝。
- 八个触点的提交顺序：照 `task-records-guards.test.ts` 的做法 mock `src/db/pg` 的 `transaction`，在回调返回之后记 `COMMIT`，发送端口记 `EMIT`。每个触点三格：提交成功 ⇒ 每个 `EMIT` 都排在 `COMMIT` 之后、收件人等于 §3 的集合；`COMMIT` 失败（mock 在回调之后抛出）⇒ 零次 `EMIT` 且错误照常抛出；回调里抛出（404 或 422）⇒ 零次 `EMIT`。删除那一行的种子里有一名已完成的负责人，仍是收件人。
- 操作者本身是负责人（`[own-3c-09]`，五行表）：创建人把自己加为负责人、身为负责人的创建人删掉自己、身为负责人的创建人切换完成方式、创建人删除只有他一名负责人的任务、身为负责人的创建人改截止日期（另一名负责人已完成）：操作者都在收件人里，关注人不在。
- `[own-3c-03]` 的反半：只改描述、只改开始日期与时间（带回库里的时区）⇒ 提交、版本前进（mock 的 `UPDATE` 回 2）、零次 `EMIT`。
- 普查格（`tests/unit/task-counts-touchpoints.test.ts` 末尾）：人口取 `src` 下全部 `.ts` 文件，找出写 §2.2 各列的语句：`task_assignees` 的增删改、`INSERT INTO tasks`、`DELETE FROM tasks`（硬删任务行，负责人行随外键级联删除），以及 `SET` 子句含输入列的 `UPDATE tasks`。表名可以带 schema、带引号，`UPDATE` 与 `DELETE FROM` 之后可以有 `ONLY`，关键字之间可以是任何空白（含换行）；`SET` 子句可以逐列赋值，也可以是带括号的列清单（`SET (a, b) = (…)`），清单里有输入列就算；关键字只认大写，这是 src 的写法，不分大小写会把权限说明之类的散文当成写入。每一行顶格的声明或语句开一段：`function`、`class`、`const|let|var`（不论初值是箭头函数还是函数表达式、带不带类型标注）按名字记，其余顶格语句记为「顶层」，写入落在那里就单独报出，不会算到上面那个函数头上。断言：这样的文件恰是三份服务文件；在任务服务文件里，含这些语句的段恰是 §3 的五个直接写入者加三个写入 helper（`writeChangedAssignees`、`writeTaskDoneState`、`writeCompletionModeState`），每个 helper 只被 §3 的八个函数调用；八个函数各自 `taskCountsSignal()`、`note`，并在事务之后、函数顶层恰调用一次 `publish()`。扫描器自己有一格正控：合成源码里每一种写法都被找出（函数表达式、带类型标注的箭头、类方法、顶层语句、带 schema 与带引号的表名、硬删、跨行、两张表各自的 `UPDATE ONLY` 与 `DELETE FROM ONLY`、带括号的 `SET` 列清单），跟在一个触点名字后面的写入算在自己名下；只改 `parent_id` 的 `UPDATE`、改非输入列（逐列或带括号的列清单）、其他表都不算。新增一个写这些列的函数而不接信号，这格变红。
- 提交之后才发送的前提（§4.2 规则）：从三个写入文件出发、沿 import 逐层走到的 `services/task-*` 与 `db/task-*` 模块里，每个 `catch` 的最后一条语句是 `throw` 或 `fail(…)`，块里任何位置都没有 `return`、`break`、`continue`；`finally` 块里也没有这三者；没有 `.catch(`、`.then(`，也没有 `Promise.allSettled`、`Promise.race`、`Promise.any`（注释行里的不算）。唯一的例外是 `task-counts-realtime.ts` 的 `sendOne`，而且这处例外必须仍然存在。这一格认得的就是上面这些写法；§4.2 的规则本身不以这些写法为限。正控：合成源码里吞错的 `catch`、条件性重抛、含 `return`、`break` 或 `continue` 的 `catch`、含 `return` 的 `finally`、`.catch(`、`.then(`、换行接着的 `.catch(`、`Promise.allSettled`、`Promise.race`、`Promise.any` 都被找出；每条路径都以 `throw` 或 `fail(…)` 离开的 `catch`、只做清理的 `finally`、`Promise.all`、注释里的散文（包括 `catch` 块里提到这几个关键字的注释行）不算。

### 7.2 真库文件 `tests/integration/task-m4-realtime.db.test.ts`（新）

- 三处登记：`vitest.config.ts` 的 exclude 字面量、`.github/workflows/tasks-realdb.yml` 的文件清单、文件顶部 `import '../helpers/assert-rbac-optional-off'`；模块顶层 `EXPECT_DB !== '1'` 即抛。
- 发送端口在 `beforeAll` 里设成记录器（记下 `room`、`event`、`payload`），`afterAll` 重置。HTTP 走 `tests/helpers/tasks-http-harness.ts` 的监听与 `rawRequest`。
- 用例名前缀 `gate26|`（候选门 26，`[own-3c-13]`）。

| 格 | 内容 |
|---|---|
| 正控（锁 Draft 的起草方设计） | `all` 模式任务，创建人 C 既不是负责人也不是关注人，负责人只有 A（未完成），关注人 F。C 先 `DELETE …/assignees/A`（提交），再 `POST …/assignees` 加 B（提交，B 是本 org 在职成员）。第一次写入的收件人恰为 {A}，第二次恰为 {B}；A、B 各一次，F 与 C 零次 |
| 回滚格 | 同一条删 A 的写入，用延迟到提交时检查的约束触发器（只对这一条任务的 `task_events` 插入开火，名字带本格的 stamp，`finally` 里删除，`afterAll` 再清扫一次）让 `COMMIT` 失败：HTTP 500，零次发送，库里 A 仍是负责人、事件不变；删掉触发器之后同一条写入提交并发给 {A}（本格自己的正控） |
| 回滚格（其余写入） | 同一个触发器下，完成、重启、切换完成方式、改截止日期的 `PATCH`、加负责人、删负责人、删除各发一次：都是 500、零次发送，任务行、负责人行与事件数逐字节不变；创建在发生之前没有任务 id，它的触发器改按创建人与 `created` 事件开火：500、零次发送、没有多出任务行 |
| 逐触点 | 创建（显式负责人 `[A, B, A]` ⇒ A、B 各一次；省略 ⇒ 创建人；`[]` ⇒ 零次；含不在职者的 422 ⇒ 零次）；完成与重启（`all` 模式两名负责人中一人 ⇒ 二人；重复一次 ⇒ 零次）；切换完成方式（翻转的 `all → any` 与不翻转的 `any → all` ⇒ 二人；同模式 ⇒ 零次）；删除（A 先完成，仍 ⇒ 二人；再删 404 ⇒ 零次）；`PATCH` 改截止日期、改截止时间、改时区（无截止日与有截止日两种）⇒ 二人；只改标题、只改提醒、只改开始日期与时间（带回库里的时区）、只改描述（这两次版本都前进）、内容不变、409、422 ⇒ 零次 |
| 操作者是负责人 | 创建人省略负责人建任务（负责人恰为他自己），再删除 ⇒ 恰 {C}；创建人 C 与 A、B 同为负责人、A 已完成，C 改截止日期 ⇒ {A, B, C}（`[own-3c-09]`） |
| 空操作与失败（负责人写） | 再加已在的负责人、删一个只是关注人的人 ⇒ 200、零次；增不在职者 422、没有直接角色的调用者增删 404、坏 id 422 ⇒ 零次；负责人行不变 |
| 零负责人 | 创建人建一条 `assignees: []` 的任务，再完成、重启、删除：每次零次发送（事件照写） |
| 载荷、房间、事件名 | 一次完成的发送逐项等于 `{ room: buildAuthenticatedUserRoom(收件人), event: 'tasks:counts-updated', payload: {} }`；另外每个格里的每一次发送都检查事件名、`JSON.stringify(payload) === '{}'` 与房间形状 |
| 关注人 | 触点格都有一名关注人，断言零次 |
| 失败隔离 | 发送端口对 A 抛错：HTTP 200、响应体照常，A 的完成已入库，B 照常收到 |
| 租户 | 用户 U 在 org A、org B 都在职；两个 org 里 U 作负责人的任务各被完成一次 ⇒ U 的房间各收到一次，发送内容里没有任何 org |
| 生产接线 | 真实 `MetaSheetServer`（不 `listen`），把它注入器里 `ICollabService` 的 `broadcastTo` 换成记录器，经它的 `app` 发一次完成请求 ⇒ 两名负责人的房间各一次、事件名与 `{}`，本文件自己的记录器零次。负控：把 `index.ts` 的接线行注释掉（`runSourceMutant`），子进程里同样的写入 ⇒ 零次 |
| 负控甲 | `runSourceMutant`：收件人只取写后集合 ⇒ 正控的第一次写入无人收到，红 |
| 负控乙 | 收件人只取写前集合 ⇒ 第二次写入无人收到，红 |
| 负控丙 | 发送挪进事务（`note` 时立即发送）⇒ 回滚格收到发送，红 |
| 负控（关注人） | 删负责人时把关注人并进写前集合 ⇒ F 收到，红 |

负控用 PR-3a 的 `runSourceMutant`（先断言 needle 恰一次、`cp` 备份、子进程、恢复并断言逐字节相同）。它会原地改写 `src` 下的文件，只能在一次性检出里跑（CI 的检出或实现者自己的 worktree）。负控丁（前端去掉订阅）属 FE-c。

### 7.3 既有格

- 不改任何既有断言：八个函数的返回形状不变，不多发 SQL（§3）。
- 门 7：不新增咨询锁字面量；新服务文件在扫描根 `src/services/task-*` 内。
- 门 15：新代码的注释只引条目 id，不点名其他线的符号；§4.3.1 引用的既有做法只写在本文里。
- 门 17：新真库文件同片登记三处；收集数等于展开后的静态计数，写进验证 MD。
- 门 20：`src/tasks` 不改。

### 7.4 变异轮

不少于 25 个源码变异，每个：精确替换（先断言命中恰一次）→ `cp` 备份 → 跑最窄的 lane 文件或单测 → 从备份复制回去 → `cmp` 逐字节相同。覆盖：发送端口（房间、事件名、载荷、去重、逐人 `try/catch`）、收集器（并集的两半、`note` 即发送）、八个触点各自的 `note` 与 `publish`、各自的发送条件、`index.ts` 的接线。结果表写进验证 MD。

### 7.5 R01 (iii)：`M2|` 与 `M3|` 门行重跑

锁 `arm-set` 里 `M2|` 27 行、`M3|` 2 行。验证 MD 逐行记录：承载（真库格、鉴权门格、单测、命令）、本次在哪个 head 上跑、结果；锁要求的控件（门 8 回退改 `'UTC'`、门 10 停掉归一、门 18 删正则扩展、门 19 两个探针与身份 diff、门 6 负控、门 13 挂载置空等）逐个重跑。依赖前端的行（门 11、12、21、22）在本分支的 `apps/web` 上跑，并写明它是 main 上 M3 前端的状态。这一遍是预备；判定那一遍在合并之前的最终候选集成树上跑（§2.5），逐行记录的格式同上，在 M4 的任何一张 PR 合并之前留下记录。

### 7.6 绿线

`tsc --noEmit` 0 errors；任务单测子集；真库 lane（全部 `task-*.db.test.ts`）在一个新建的一次性库上连跑三遍；鉴权门；全量单测一遍（已知的本机失败只有四个 `multitable-recovery-*` 与考勤的 ELOOP）。

---

## 8. `ASSUMPTION(task-m4)` 表（本件自选，owner 可点名推翻）

| 标签 | 内容 |
|---|---|
| `[own-3c-01]` | 载荷恰是空对象 `{}`，不是 `null`，不带 `reason`、`updatedAt`、org 或任何任务字段 |
| `[own-3c-02]` | 切换完成方式只要模式真的变了就发送，即使没有改变谓词的输入（门 26 把这类写入列为触点）；同模式是空操作，不发送 |
| `[own-3c-03]` | `PATCH` 在 `due_date`、`due_time`、`time_zone`、`due_at` 任一变化时发送，包括没有截止日的任务只改时区（照门 26 的字面：改截止字段或时区）；只改标题、描述、开始或提醒不发送 |
| `[own-3c-04]` | `PATCH /api/task-settings` 改 `badge_scope` 不发送：它不是任务写入，收件人规则（负责人集合）对它没有定义；本人的页面自己刷新，本人其他会话靠轮询 |
| `[own-3c-05]` | 在服务层发送（事务 `await` 之后），不在路由层：服务的每个调用方都会发送，八个服务的对外返回值不变 |
| `[own-3c-06]` | 接线在 `index.ts` 的 `MetaSheetServer` 构造函数里，经服务器自己的 websocket API（`coreAPI.websocket.broadcastTo`），每次发送时才从注入器取 `CollabService` |
| `[own-3c-07]` | 空操作与失败的写入不发送（由 §2.1 的谓词推出，§3 逐触点写明条件） |
| `[own-3c-08]` | 只有创建人一名负责人的创建也发送（创建人在写后集合里） |
| `[own-3c-09]` | 操作者不排除：在写前或写后负责人集合里就收到 |
| `[own-3c-10]` | 发送失败只记一条 `warn`：固定说明加固定码 `TASK_COUNTS_SEND_FAILED`，不读错误对象（§4.3）；不重抛、不重试、不进 outbox |
| `[own-3c-11]` | 没有写入、只因时间推移而逾期的任务不发送；前端轮询覆盖 |
| `[own-3c-12]` | 房间不分 org：多 org 用户收到另一 org 写入的信号，载荷为空、客户端按自己的会话 org 重拉 |
| `[own-3c-13]` | 候选门 26 的用例名前缀 `gate26|`；锁 PR 合并之前不计分 |

---

## 9. 部署与回退

- 不含迁移、不改 schema，没有部署顺序要求。
- 代码回退：revert 本 PR 的提交即可，没有残留状态（发送是即时的，不落库）。
- 业务补偿：没有。socket 消息不可撤回，但它只让客户端多请求一次计数。

---

## 10. 与 PR-3b 的关系

- PR-3b 在六个服务回调里、`return` 之前插入 outbox 写入：`task-records.ts` 的 `completeTask`、`reopenTask`，`task-structure.ts` 的 `addAssignee`、`removeAssignee`、`switchCompletionMode`、`deleteTaskById`。本件在同样六个回调里插入 `counts.note(…)`，并改写回调的外层，所以合并在这六个回调处冲突。另外两个冲突文件是真库文件的登记（`vitest.config.ts` 的 exclude 与 `tasks-realdb.yml` 的文件清单）：两边在同一处各加了自己的文件（PR-3b 四个，本件一个），全部保留。PR-3b 也改了评论的 `addComment`，本件不碰它，那里不冲突。
- 大部分是机械的：outbox 写入留在事务内（随写入一起提交），本件的 `publish()` 留在事务外。**唯一不机械的一步**：在完成、重启、加负责人、删负责人、切换完成方式这五个回调里，PR-3b 把事件写入改成 `const written = await write…Events(…)`，其后入队；冲突里本件一侧还是原来那行裸的 `await write…Events(…)`。保留 PR-3b 的 `const written = …` 与入队，**删掉**本件一侧那行裸的 `await write…Events(…)`，再把本件的 `counts.note` 块放在入队之后、回调之内。两行都留下时 `tsc` 照样 0 错，但每个完成事件与成员事件会写进 `task_events` 两次，第二份在 outbox 行之后、没有任何引用；守着「outbox 行带着事件写入时的 id」的单测（`task-records-guards.test.ts`）会变红。`deleteTaskById` 里先放 PR-3b 的入队块，再放 `counts.note`。
- 两边读的是同一批锁后的行，互不改变对方的输入。N1（PR-3b 在增删负责人引起状态翻转时补写事件）不改变本件的发送条件：状态翻转本来就算改变了输入。
- 合并之后，§4.2 规则那一格的人口（写入文件逐层 import 的任务模块）会多出 PR-3b 的 `task-notification-producer.ts` 与 `task-notification-flags.ts`。两份在 PR-3b 的 head 上都没有 `catch`、`finally`、`.catch(`、`.then(`，也没有 `Promise.allSettled`、`Promise.race`、`Promise.any`，那一格照常绿；PR-3b 的调度与投递模块不在这条 import 链上。§2.3 的写入者普查在 PR-3b 的树上仍只有三份服务文件。

---

## 11. 只有 owner 能答的问题

编号沿用修订 3；第 1、5 条不再是问题。

1. **触点集合（已裁定，不问）**：八个函数与 R16 列举的写入种类一一对应（§2.4），不请 owner 再确认。真正由本件取舍的只有第 2、3 条这两个子情形。
2. **切换完成方式**：没有改变谓词输入的模式切换（例如没有人完成时 `all` 换 `any`）也发送（`[own-3c-02]`）。是否改为只在状态或完成态真的变化时发送？
3. **只改时区**：本件对只改时区的 `PATCH` 一律发送（`[own-3c-03]`）。红点计数只用 overdue 或 overdue_or_today 子句，任务的时区只经 `COALESCE(查看者时区, tasks.time_zone)` 读到；前端重拉计数时带着查看者时区（浏览器报得出时区时总是带），这时任务的时区读不到，只改时区的写入只能经 `due_at` 改变计数。分三种：没有截止日的任务，`due_at` 为空、日期子句不成立，任何客户端的计数都不变；全天任务的 `due_at` 随时区移动，但谓词对全天任务读的是 `due_date`，只有不带查看者时区的客户端计数会变；有截止时间的任务，`due_at` 移动并被谓词读到，计数可能变。是否收窄到 `due_at` 真的变化时才发（去掉第一种），或只对有截止时间的任务发（再去掉第二种）？
4. **设置变更**：`badge_scope` 经谓词的 `scope` 参数起作用（§2.2），但它是查看者一侧的参数，R16 的收件人规则对设置写入给不出集合。`badge_scope` 变化时是否也给本人房间发一次（让本人其他会话即时刷新）？本件不发（`[own-3c-04]`）。
5. **（移出）**门 26 落锁时怎么分行不是 owner 问题，见本节末给锁 PR 的备注。
6. **R01 (iii) 的判定由谁跑**：何时跑已由 R01（2026-10-07）定下：合并之前，在最终候选集成树上（§2.5），而不是在 PR-3b 与 M4 前端合入之后。R01 没有定由谁跑，本件不替 owner 定。
7. **多 org 用户**：房间不分 org，另一 org 的写入也会让客户端重拉一次（`[own-3c-12]`）。是否接受？

**给锁 PR 的备注（不是 owner 问题）**：锁 Draft 把门 26 写成一行 `M4|26|整门`，正文同时含本 PR 的后端格与 FE-c 的前端 spec 与负控丁，所以本 PR 与 FE-c 任一单独合入时这一行都不能变绿。合并之前本 PR 的门 26 格是候选、不计分；要不要把后端格另列一行，由锁 PR 决定。

---

## 12. 前端（FE-c）需要核对的点

1. 事件名 `tasks:counts-updated`，房间 `auth-user:<userId>`，由服务端在 socket 认证时加入；客户端不发 join。
2. 载荷恒为 `{}`：前端设计 §8.2 的「不读载荷」成立。
3. 触点集合与前端设计 §8.3 第 3 条相同：带负责人的创建、完成与重启、负责人的增删、完成方式的切换、任务的删除，以及动到截止字段或时区的 `PATCH`。其中两个子情形也会发送：只改时区的 `PATCH`（含没有截止日的任务，`[own-3c-03]`）与不改变状态的模式切换（`[own-3c-02]`）。前端的本地总线条件（`onPatchTask` 只在 patch 含截止日期、时间或时区时通知）与之相容。
4. 操作者本人若是负责人，也会收到自己写入的信号。前端收到信号不立即重拉，而是按门 26 的固定窗口合并（owner 2026-10-09 裁定；前端设计 §8.2 的 `[fe-51]`、`[fe-52]`）：没有窗口开着时，一条信号打开一个 500 ms 的窗口，窗口从这条信号起算、不因后到的信号顺延，其间到达的信号都并入，到点读一次；窗口开着时开始的任何一次读取（本地总线触发的读取、60 秒轮询）都发在窗口里每条信号之后，算作回答了它们，窗口随即关闭，到点那一次不再读；一条信号只由在它到达之后才发出的读取回答，读取开始以后到达的信号打开新窗口，信号到达时已经发出、尚未返回的读取不回答它。所以操作者自己的一次写入：信号先到、本地总线触发的读取在窗口内开始 ⇒ 一次请求；本地总线触发的读取先开始、信号后到 ⇒ 两次请求，第二次在信号到达之后 500 ms。`refresh()` 的 generation 只丢弃较早那次读取晚到的结果，不合并请求。
5. 设置变更不发送：设置页保存后由前端自己刷新红点。
6. 多 org 用户会收到另一 org 写入的信号：重拉的是当前会话 org 的计数，结果不变。
7. 发送在写入提交之后、HTTP 响应之前：事件可能先于操作者自己的响应到达，两者都只触发重拉。
8. 只有连在处理这次写入的后端进程上的 socket 收得到（§5 进程范围）；多进程部署下轮询是另一半的保证，前端设计 §8.2「保留轮询」因此是必要的，不只是断线回退。
9. socket 的认证与路径不变：服务端仍从握手的 `auth.token` 取令牌，路径仍是缺省的 `/socket.io`（前端设计 §8.3 第 4 条）。本 PR 不改 `CollabService`。

---

## 13. 实现切片

| 片 | 内容 | 依赖 |
|---|---|---|
| S0 | 本设计 | — |
| S1 | `task-counts-realtime.ts`（端口、收集器、发送）与它的单测 | S0 |
| S2 | 八个触点接入；提交顺序单测与普查格 | S1 |
| S3 | 真库文件（正控、回滚格、逐触点、空操作与失败、载荷、关注人、失败隔离、租户）与三处登记 | S2 |
| S4 | `index.ts` 接线与 `MetaSheetServer` 格（含负控） | S3 |
| S5 | 文件内负控甲、乙、丙与关注人 | S3 |
| S6 | 变异轮 | S4、S5 |
| S7 | R01 (iii) 重跑、绿线、验证 MD | S6 |

每片结束：`tsc --noEmit`、任务单测子集、动到真库文件的片跑 lane。路径省略前缀 `packages/core-backend/`。
