# 任务功能 M3 后端设计（2026-09-28，实现提交 2026-09-30 amended）

- 分支：`grok/tasks-m3-backend` 起草本契约；实现改在新分支 `claude/tasks-m3-backend`（新 PR，不推 `grok/tasks-m3-backend`），按 PR #6126 「分工调整通知(2026-09-30)」。
- 基线：写这份契约时，#5845、#6062、#6092、#6123 都还没合进 `main`。实现分支基于合入后的 `main`（`4f19aa0b91`）。
- 锁：`docs/development/task-feature-design-lock-20260917.md`。§12 门表仍是 PROPOSED。
- 纯函数来源：任务 C（#6123）的 `packages/core-backend/src/tasks/task-tree.ts`、`task-membership.ts`、`task-comments.ts`、`task-deletion.ts`。服务层只调用这些函数，不另写树、成员、评论、删除规则。
- 前端对接以本节的路径、请求体、成功形状和错误码为准。必须改形状时先改本文件，再改实现。
- **闸方第二轮修订（2026-09-30）**：U+0000 与非可打印 id 的处理（§2「id 与错误体」、§3.1、§3.6）、成员 id 长度上限（§4）、评论写与软删的行锁方案（§2、§3.7）。各处标注「闸方第二轮」。
- **闸方第五轮修订（2026-10-07）**：§2、§3.6、§3.7 的行锁与 404 措辞只保留规则本身（限时 3 秒、409 `TASK_BUSY`、客户端退避重试；跨任务的评论 id 与评论不存在同一个 404）；§3.8 补一条成员 id 校验规则（`isValidMemberId`，§4）。不改接口形状与错误码。
- **闸方第三轮修订（2026-10-01）**：软删行锁改为整条语句限时（§2、§3.7）；软删在取任何锁之前先按 `created_by` 快照判定删除能力（§3.7）；`deleted_at`/`updated_at`/事件时间在 SQL 内一次取值（§3.7）；`POST /api/tasks` 执行人上限、标题非法字符（§3.8）；评论正文的非法字符扩到不成对的 UTF-16 代理项（§3.6）。各处标注「闸方第三轮」。
- **本次修订**吸收 PR #6126 两轮闸方审阅意见（「闸方对 M3 接口契约的自核」2026-09-28、「闸方对 M3 接口契约的第二轮意见」2026-09-29）的全部 P2 项与本节列出的 P3/NIT 项；每处改动标注来源。未采纳的 P3/NIT 项在文末「未采纳/推迟」列出并说明理由。

M2 已经钉死的形状保持不变：列表项 snake_case；详情在 M2 字段上追加本节的 `parentId`、`depth`、`children`（以及本次新增的 `followers`、能力标志、`version`，见 §3.2）；不存在、不可见、他 org 仍是 404 `{ error: { code: 'NOT_FOUND' } }`；写操作缺 org 仍是 422 `{ error: { code: 'ORG_MISSING' } }`。

## 1. 范围

M3 后端是 P0-B：子任务树、执行人与关注人的增删、切换完成模式、评论、软删。

本片不做：附件、清单、投影读、通知调度、硬删、评论的回复线程、`resolved` 列。`TASKS_ENABLED` 仍是精确字符串 `'true'` 才挂路由，默认关闭。

## 2. 共性

路由工厂仍是 `tasksRouter()`。新路径和 M2 一样，静态段写在 `/:id` 之前（本片新路径都在 `/:id` 之后再加一段或以不同 HTTP 方法区分，因此与既有 `/api/tasks/:id` 不冲突，见实现里的说明注释）。org 只取 `req.authenticatedTenantId`。

权限码仍是 `tasks:read`、`tasks:write`、`tasks:admin`。非管理员还要有 `user_namespace_admissions(user_id, 'tasks', enabled=true)`。只有码、没有这行，是 403 `{ error: 'Insufficient permissions' }`，与 M2 相同。过了码之后，行级能力用任务 B 的 `can(resolveTaskRoles(...), ability)`：

| 能力 | 谁有 |
|---|---|
| `view` | creator、assignee、follower、list-editor、list-reader |
| `edit` | creator、assignee、list-editor |
| `comment` | 上表里除 `none` 以外的角色（与 `view` 的角色集恰好相同——真相表里两列在闭集上逐行相等） |
| `delete` | 只有 creator |
| `leave` | 只有 follower |

看不到、不能做、他 org、已软删，写操作和读操作都回 404 `{ error: { code: 'NOT_FOUND' } }`，不区分原因。校验失败回 422，冲突回 409。成功体一律 camelCase。时间是 ISO-8601 字符串，没有值时是 `null`。

**id 与错误体**（闸方第二轮 M3R2-AUTHZ-4 等）：路径里的任务 id（`:id`）与评论 id（`:commentId`）若含可打印 ASCII（`[!-~]`）以外的任何字符（包括 U+0000），在发任何 SQL 之前就按 404 `NOT_FOUND` 处理——库里每个 id 列都有可打印 CHECK，这样的值匹配不到任何行。M2 的 `GET /api/tasks/:id`、`/complete`、`/reopen` 走同一个检查。请求体里的 `parentId` 见 §3.1，成员 id 见 §4，评论正文见 §3.6。服务层以 `fail(4xx, code)` 抛出的错误原样回 `{ error: { code } }`；其余任何错误（数据库驱动错误、程序缺陷）记日志后一律回 500 `{ error: { code: 'INTERNAL' } }`，不再把驱动的 `code`（例如 SQLSTATE）回给客户端。

所有改结构的写操作（树、成员、切模式、软删）走同一个事务：

1. `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 是事务里的第一条语句。
2. `acquireTaskStructureLock(client, orgId)`。
3. 锁后再读任务行、执行人、关注人、以及本 org 未软删的树节点。
4. 把锁后读到的 `status === 'done'` 当作 `wasDone`。本片的纯函数不接收 `wasDone`；完成态以锁后的 `status` 传入 `applyAddAssignee` / `applyRemoveAssignee` / `applySwitchCompletionMode`。
5. 调用下面点名的纯函数。纯函数返回的行集写回数据库。树事件和删除事件的纯函数不带执行人，服务层把当前操作者写入 `task_events.actor_id`。成员事件用纯函数给出的 `userId` 作为 `actor_id`。

评论的增删改（§3.6）**不**在这把结构锁里：`task_comments` 不是树/成员/完成态的一部分。POST、PATCH、DELETE 各用一个普通事务（第一条语句同样是 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`），事务内先对任务行取 `SELECT 1 FROM tasks WHERE id=:id AND org_id=:org AND deleted_at IS NULL FOR KEY SHARE`，0 行 ⇒ 404，再写评论（POST 另写 `commented` 事件）。PATCH/DELETE 的 `UPDATE ... WHERE deleted_at IS NULL` 谓词照旧处理评论本身的并发删除。GET 系读路径不经结构锁，也不取这把行锁。（这一段是实现提交对契约的补充，契约原文没写评论是否共用结构锁，此处澄清取舍。）

**评论写与任务软删的先后**（闸方第一轮 M3-CONC-6；闸方第二轮 M3R2-CONC-1 收窄）：任务级前置检查（取任务、`comment` 能力）是快照读，与写语句不在同一时刻。评论写对任务行取 `FOR KEY SHARE`；`DELETE /api/tasks/:id` 在结构锁之后、任何读之前对同一行取 `FOR UPDATE`（见 §3.7）。两者互斥，且只有这两者互斥：

- 软删在先且未提交时，评论写等待；软删提交后按新行版本重判 `deleted_at IS NULL`，得 0 行 ⇒ 404，不写评论也不写事件。
- 评论写在先时，软删的 `FOR UPDATE` 等评论事务提交后再进行，属于正常先后。
- 完成、重开、切模式、增删成员、设父等其他任务写只改非键列，取的是 `FOR NO KEY UPDATE`，与 `FOR KEY SHARE` 不冲突，这些写不会因评论写而等待。（第一轮用的 `FOR SHARE` 与非键列更新取的 `FOR NO KEY UPDATE` 冲突，第二轮收窄为 `FOR KEY SHARE`。）
- 软删的这一条 `SELECT … FOR UPDATE` 在持有 org 结构锁时执行，所以整条语句限时 3 秒：语句前用 `set_config('statement_timeout', '3s', true)`（事务内有效），语句成功后恢复为语句前的值；超时（SQLSTATE 57014，或 55P03）回 409 `{ error: { code: 'TASK_BUSY' } }`（可重试），事务回滚并释放结构锁。客户端收到 `TASK_BUSY` 后应退避重试。（闸方第三轮 M3R3-LOCK-1：第二轮用的 `lock_timeout` 只限制单次锁等待，不限制整条语句；第三轮改为对整条语句限时。）
- 只有创建者会走到这一步：软删在取任何锁之前先判删除能力（见 §3.7），没有删除能力的调用者不会等待行锁，也不会得到 `TASK_BUSY`。

没有采用「把 `deleted_at IS NULL` 并进写语句」（`INSERT … SELECT`、`AND EXISTS (…)`）的做法：那是快照读，不等待未提交的软删，只能缩小窗口。

范围：这把行锁只管任务存活。删执行人/关注人（除非状态翻转）不改 `tasks` 行，所以它不对「评论写」与「同时进行的成员移除」排序；评论写用的是事务开始前刚检查过的 `comment` 能力。这一点记为已知残留，不在本片处理。

`task_events.event_type` 不新增词。本片只用闭集里已有的 `parent_set`、`parent_cleared`、`assignee_added`、`assignee_removed`、`completion_mode_changed`、`completed_by_any`、`follower_added`、`follower_removed`、`left`、`commented`、`deleted`。空操作不写事件。

**成员事件带 `targetUserId`**（PR #6126 第二轮 P2 第 6 条）：成员函数（`applyAddAssignee` / `applyRemoveAssignee` / `applyAddFollower` / `applyRemoveFollower`）返回的事件除 `userId`（映射到 `actor_id`）外还带 `targetUserId`（被加入/移出的人）。服务层把 `targetUserId` 写进 `task_events.payload`（该列已在 P0-A 迁移里以 `jsonb NOT NULL DEFAULT '{}'::jsonb` 存在，本片直接使用，不加 DDL）：`{"targetUserId": "usr_…"}`。树事件（`parent_set`/`parent_cleared`）和删除事件（`deleted`）的纯函数不带 `targetUserId`，`payload` 维持默认 `{}`。

**`tasks.version` 何时 +1**（实现提交对契约的补充，契约原文没写；回应 PR #6126 第一轮 P3 第 3 条与第二轮 P2 第 5 条）：只在 `tasks.status` 真的翻转（`open` ⇄ `done`）时 `version + 1`，与 `task-records.ts` 既有的 `writeTaskDoneState`（M2 的完成写入器）同一写法——`status`、`completed_at`、`updated_at`、`version + 1` 一次写。增删执行人、切换完成模式都遵守这条规则：

- 增删执行人：调用成员函数后，若返回的 `status` 和写前不同，调用与 `writeTaskDoneState` 同形的写入（M3 直接复用该函数，见 §3.3）。
- 切换完成模式：若同一次调用里 `completion_mode` 变了 **且** `status` 也翻转了（例如 `all → any` 且已有人完成 ⇒ 任务变 done），两者在**同一条** `UPDATE` 里一起写，只 `version + 1` 一次，不会因为两件事都发生就加两次。若只有 `completion_mode` 变、`status` 不变，只更新 `completion_mode` 和 `updated_at`，不碰 `version`。
- 设父 / 转独立 / 移动（§3.1）：**不**碰 `version`（只写 `parent_id`、`depth`、`updated_at`）——父子关系的变化不算「任务本身」的版本变化。这是本片的取舍，M4 若要给结构写也接上 `version`/`expectedVersion`（PR #6126 第二轮 P2 第 3 条提到的 M4 裁决包 R03），届时再改。
- 评论的增删改：不碰 `tasks.version`（评论不是 `tasks` 行的字段）。

## 3. 接口

### 3.1 `PATCH /api/tasks/:id/parent`

权限：`tasks:write`，然后：任务本身、**当前父（如果有）**、**新父（如果是设父）** 三边都要 `edit` 且同 org（PR #6126 第二轮 P2 第 4 条——原契约只写了子任务和（新）父任务两边，转独立/移动时漏了「当前父」）。任一边失败是 404。

**顺序**（PR #6126 第二轮 P2 第 4 条也要求写明顺序）：

1. 按 `:id` 取本 org、未软删的任务；不存在 ⇒ 404。
2. 任务本身 `can(...,'edit')`；不通过 ⇒ 404。这一步不需要请求体。
3. 若任务当前有父，取该父（本 org、未软删），`can(...,'edit')`；不通过 ⇒ 404。这一步也不需要请求体（父 id 来自数据库当前行，不是请求体）。
4. **到这里才校验请求体**：`{ parentId: string | null }`。缺字段、类型不对、或字符串不是可打印 id（空串，或含 `[!-~]` 以外的字符，包括 U+0000）：422 `{ error: { code: 'INVALID_PARENT' } }`（闸方第二轮：此前空串与非可打印字符串会走到第 5 步按 404 处理，非可打印字符串还会把 U+0000 送进数据库；现在统一在这一步判成 422）。不能编辑任务本身或当前父的调用者在第 2、3 步已经是 404，不会看到这个 422。
5. 若请求体是设父（字符串），取新父（本 org、未软删），`can(...,'edit')`；不通过 ⇒ 404。这是唯一需要请求体内容（新父 id）才能做的权限检查，所以排在校验之后。
6. `parentId === null`：调用 `validateClearParent`。字符串：调用 `validateSetParent`。

| 纯函数结果 | HTTP |
|---|---|
| `not_found` | 404 `NOT_FOUND` |
| `self`、`descendant` | 422 `INVALID_PARENT` |
| `depth_exceeded` | 422 `DEPTH_EXCEEDED` |
| `noop: true` | 200，不写事件 |
| 成功 | 200 `{ id, parentId, depth }`，`depth` 是移动后的这一行。子孙的 `depth` 按 `depthChanges` 同事务用一条 `UPDATE … FROM unnest(…)` 写回（闸方第二轮 M3R2-CONC-4：不随子孙数增加往返次数） |

`depth` 最大是 4，含根。父完成不改子任务的状态。移动/设父/转独立不碰 `tasks.version`（见 §2）。

### 3.1.1 `GET /api/tasks/:id/parent-candidates`（PR #6126 第二轮 P3/NIT 第 8 条新增）

权限：`tasks:read`，且调用者对 `:id` 这条任务 `can(...,'edit')`（候选列表是为了给这条任务挑新父，没有编辑权限看候选没有意义，与 §3.1 子任务这一边的权限口径一致）；不通过 ⇒ 404。

调用纯函数 `parentCandidates({ taskId, nodes })`（`nodes` = 本 org 未软删的任务集合），再按调用者对每个候选 `can(...,'edit')` 过滤（「限于调用者能编辑的任务」，PR 原话）。成功 200 `{ items: [{ id, title }] }`。

（原契约 §1 没有声明本期做/不做这条路由；本次按第二轮意见直接实现，不再留作 P1 空白。）

### 3.2 `GET /api/tasks/:id`

权限：`tasks:read`，并且 `can(..., 'view')`。否则 404。

在 M2 详情字段之外增加：

```json
{
  "parentId": "tsk_… | null",
  "depth": 0,
  "children": [
    { "id": "tsk_…", "title": "…", "status": "open", "completionMode": "all", "depth": 1 }
  ],
  "followers": ["usr_…"],
  "canEdit": true,
  "canDelete": false,
  "canComment": true,
  "canLeave": false,
  "version": 1
}
```

`followers`、`canEdit`、`canDelete`、`canComment`、`canLeave`、`version` 是本次修订新增（PR #6126 第二轮 P2 第 3 条：原契约的详情缺 `followers`、能力标志、`version`，前端只能复刻角色矩阵或试探）。四个能力标志直接来自 `can(resolveTaskRoles(...), ability)`，与 §2 表格同一份真相。`version` 是 `tasks.version`。

`children` 只含直接子任务，且未软删，且调用者对那一行 `can(..., 'view')`。看不见的子任务直接省略，不因此把父任务变成 404。顺序按 `id` 字节序。

**`children` 与 `HAS_CHILDREN`（§3.7）的关系**（PR #6126 第二轮 P3/NIT 第 9 条，实现提交澄清）：`children` 按可见性过滤；`DELETE`（§3.7）的 `HAS_CHILDREN` 判定按**全部**未软删子任务（不管调用者是否看得见）。也就是说，调用者可能在详情里看到 `children: []`（因为唯一的子任务对他不可见），却在尝试删除父任务时被 409 拒绝——响应体本身不解释原因（`{ error: { code: 'HAS_CHILDREN' } }` 不带列表），前端如需解释，只能提示「存在你可能看不到的子任务」这类通用文案；本片不为此新增字段。

### 3.3 `POST /api/tasks/:id/assignees` 与 `DELETE /api/tasks/:id/assignees/:userId`

权限：`tasks:write`，并且对这条任务 `edit`。否则 404。

`POST` 请求体 `{ userId: string }`。`DELETE` 的 `userId` 来自 URL 段。**两处 `userId` 都要求「可打印 id」（与创建任务同一校验），不得是 `.` 或 `..`，长度不超过 255**（PR #6126 第二轮意见延伸；见 §4 之后的「id 校验」小节）；不合法：422 `{ error: { code: 'INVALID_ASSIGNEES' } }`。

调用 `applyAddAssignee` / `applyRemoveAssignee`。已是执行人或本来就不是执行人，是空操作，200，不写事件。超过 50 人：422 `{ error: { code: 'LIMIT' } }`。

**落库**（PR #6126 第二轮 P2 第 5 条——原契约没写增删执行人怎么落库）：

- `applyAddAssignee` 真的新增一行时（非空操作），`INSERT INTO task_assignees (task_id, user_id, completed_at, assigned_by) VALUES (…, NULL, :actorId)`；`applyRemoveAssignee` 真的移除一行时，`DELETE FROM task_assignees WHERE task_id=… AND user_id=…`。
- 若纯函数返回的 `status` 和写前不同（`all` 模式加人使已完成任务 reopen；`all` 模式删到只剩已完成行使任务 done），按 §2 的 `version` 规则写 `status`/`completed_at`/`updated_at`/`version+1`。
- 成员事件（`assignee_added`/`assignee_removed`）连同 `targetUserId` 一起写（见 §2）。

成功：`{ id, status, completionMode, assignees: [{ userId, completedAt }] }`。

`all` 模式给已完成任务加人会把任务 reopen 成 `open`。`any` 模式加人不动状态。删到剩下的人全都已完成时，`all` 模式会把状态推进到 `done`；不会因为删人把 `done` 改回 `open`。

**删人促成完成时的事件空白**（PR #6126 第二轮 P3/NIT 第 12 条 / 任务 C 的 N1 窄问）：`all` 模式删掉唯一未完成的人会让任务随之 `done`，但成员纯函数只发 `assignee_removed`，不发额外的「完成」事件——这是任务 C 已记录、M4 裁决包 N1 待 owner 裁定的空白，本片**不**自行发明一个新事件名去填。留白的位置：`writeMembershipEvents` 只写纯函数给出的事件表，服务层在这一步之后没有再插一条推断出来的事件。

### 3.4 `PATCH /api/tasks/:id/completion-mode`

权限与 3.3 相同。

请求体 `{ completionMode: "all" | "any" }`。别的值：422 `{ error: { code: 'INVALID_MODE' } }`（**不是** `INVALID_COMPLETION_MODE`——PR #6126 第二轮 P3/NIT 第 11 条：M2 的 `POST /api/tasks` 已经用 `INVALID_MODE` 表示同一个字段的校验失败，本片沿用同一个码，不引入第二个名字）。

调用 `applySwitchCompletionMode`。相同模式是空操作（不碰 DB，见 §2）。`all` 改 `any` 时，若任务仍是 `open` 且已有人完成，其余未完成行的 `completedAt` 写成同一个 `now`，并追加 `completed_by_any`；这种情况下 `status` 也变成 `done`，`completion_mode` 与 `status` 在同一条 `UPDATE` 里写，`version` 只 +1 一次（见 §2）。`any` 改 `all` 不改各人的完成戳，已完成的任务保持完成，`status` 不变，只更新 `completion_mode`，不碰 `version`。

成功体与 3.3 相同，`completionMode` 是请求里的新模式。

### 3.5 `POST /api/tasks/:id/followers`、`DELETE /api/tasks/:id/followers/:userId`、`POST /api/tasks/:id/leave`

加人和删别人：`tasks:write` 且 `edit`，否则 404。`POST` 请求体 `{ userId }`，id 非法（非可打印、是 `.`/`..`、或超过 255 个字符，见 §4）是 422 `INVALID_ASSIGNEES`。`DELETE` 的 `userId` 同样校验。调用 `applyAddFollower` / `applyRemoveFollower`。超过 50 人：422 `LIMIT`。删别人的事件是 `follower_removed`，带 `targetUserId`。

`POST /leave` 权限：`tasks:write`（PR #6126 第二轮 P2 第 1 条也要求写明本路由的权限码；原契约只写了能力检查，没点名 RBAC 码）。没有请求体。调用者必须 `can(..., 'leave')`，否则 404。服务层用调用者自己的 id 调用 `applyRemoveFollower`，事件是 `left`，`targetUserId` 是调用者自己。

成功：`{ id, followers: ["usr_…"] }`。已在列表里或本来就不在，是空操作，200，不写事件。

### 3.6 `GET /POST /api/tasks/:id/comments`，`PATCH /DELETE /api/tasks/:id/comments/:commentId`

`GET`：`tasks:read` 且能 `view` 这条任务，否则 404。支持分页（PR #6126 第二轮 P3/NIT 第 7 条）：query `limit`（1–100，默认 100）与 `offset`（0–2147483647，默认 0），非法（非十进制整数、越界、负数）422 `{ error: { code: 'INVALID_PAGE' } }`。同一参数出现多次（`?limit=5&limit=abc`）或写成数组/对象形（`?limit[]=5`）也是 422 `INVALID_PAGE`，不取第一个值（闸方第二轮 M3R2-CF-9）。`offset` 的上界 2^31−1 是实现选定的上限（闸方第一轮 M3-CF-1）：Postgres 把 `LIMIT`/`OFFSET` 参数按 `bigint` 处理，超出范围或被 JS `Number()` 序列化成 `1e+21` 形式的值会在数据库端报错；上界取在 `Number()` 精确范围之内，先在服务端判成 422，不让它落到数据库成为 500。成功 200 `{ items: [Comment], total }`，`total` 是这条任务全部评论数（不受分页影响），`items` 按 `(created_at, id)` 稳定排序（先按创建时间，同一时间戳按 id 打破平局）。墓碑也返回、也计入 `total`。

`Comment` 来自 `toCommentView`：

```json
{
  "id": "tcmt_…",
  "taskId": "tsk_…",
  "authorId": "usr_…",
  "body": "… | null",
  "deleted": false,
  "createdAt": "2026-09-28T00:00:00.000Z"
}
```

已删除的评论 `deleted: true` 且 `body: null`。

`POST` 请求体 `{ body: string }`。权限：`tasks:write`，并且 `canComment`。不能评论是 404。`normalizeCommentBody` 失败：空白 422 `{ error: { code: 'COMMENT_BLANK' } }`，超过 5000 个 Unicode 码点 422 `{ error: { code: 'COMMENT_TOO_LONG' } }`。规范化后的正文含 U+0000，或不是合法的 UTF-16（含不成对的代理项，例如单独的 `\ud800`）：422 `{ error: { code: 'COMMENT_INVALID_CHAR' } }`（闸方第二轮 M3R2-AUTHZ-4：`text` 列存不了 U+0000，此前会以 500 落到数据库；闸方第三轮 M3R3-IN-4：不成对的代理项在编码成 UTF-8 时会被替换成 U+FFFD，存下的正文与提交的不同）。选择拒绝而不是删掉或替换：那样会存下一段与作者提交的不同的正文。成对的代理项（例如表情符号）照常接受、原样存储。这条检查在服务层（`task-structure.ts` 的 `requireCommentBody`），任务 C 的纯函数 `normalizeCommentBody` 不变。成功 200 返回一条 `Comment`，并写一条 `commented` 事件，`actor_id` 是作者。

**`PATCH`/`DELETE` 的前置条件**（PR #6126 第二轮 P2 第 1 条——原契约只写了「仅作者」，漏了任务级前置和跨任务校验）：

1. 与其他单任务写路由相同的前置：`rbacGuard('tasks','write')`；按 `:id` 取本 org、未软删的任务；调用者对该任务 `can(...,'comment')`（`comment` 与 `view` 在真相表上是同一角色集，见 §2）；任一步不通过 ⇒ 404。
2. **并且**要求 `task_comments.task_id = :id`——`:commentId` 存在但属于另一条任务，一律 404（与评论不存在时同一个 404）。
3. 作者判定（`canEditComment` / `canDeleteComment`）放在第 1、2 步**之后**：不是作者，或已经是墓碃，404。
4. `PATCH` 的校验失败码与 `POST` 相同。`UPDATE` 语句带 `WHERE id=:commentId AND task_id=:id AND deleted_at IS NULL`；受影响行数为 0（并发中评论已被删除）按 404 返回，不是撞墓碑 CHECK 变成 500（PR #6126 第二轮 P3/NIT 第 10 条）。
5. `DELETE` 同样先过第 1、2、3 步，`UPDATE ... SET deleted_at=now(), body=NULL WHERE id=:commentId AND task_id=:id AND deleted_at IS NULL`，0 行同样 404。

`PATCH` 成功 200 返回更新后的 `Comment`。`DELETE` 成功 200 返回墓碑形的 `Comment`。两者都不写 `task_events`。

### 3.7 `DELETE /api/tasks/:id`

权限：`tasks:write`，然后 `planDeleteTask`。

| 原因 | HTTP |
|---|---|
| `not_found`、`forbidden` | 404 `NOT_FOUND` |
| `has_children` | 409 `{ error: { code: 'HAS_CHILDREN' } }` |
| 调用者是创建者，且取任务行锁的语句超过 3 秒 | 409 `{ error: { code: 'TASK_BUSY' } }`，可重试，不写任何东西（闸方第二轮；闸方第三轮改为整条语句限时，且只对创建者可能出现，见 §2） |
| 成功 | 200 `{ id, deleted: true }`，写 `deleted_at` 和一条 `deleted` 事件，`actor_id` 是操作者 |

顺序（闸方第二轮 M3R2-CONC-1/CONC-5；闸方第三轮 M3R3-IN-1/LOCK-1/LOCK-2 修订）：

1. **预检（不取锁）**：`:id` 不是可打印 id ⇒ 404；快照读本 org、未软删的这一行的 `created_by`，按任务 B 的真相表判 `can(…,'delete')`（`delete` 只看 `created_by`，而 `created_by` 写入后不变）；没有这一行或没有删除能力 ⇒ 404，与不存在的 id 同一个响应，不等任何锁、不取任何锁。
2. 结构锁。
3. `SELECT 1 FROM tasks WHERE id AND org_id AND deleted_at IS NULL FOR UPDATE`，整条语句限时 3 秒（见 §2）；0 行 ⇒ 404；超时 ⇒ 409 `TASK_BUSY`。
4. 锁后重读任务、角色、子任务 → `planDeleteTask`（预检之后状态可能已变，这里照常再判一次）。
5. 在锁都拿到之后，一条 `UPDATE … FROM (SELECT clock_timestamp() AS at)` 把同一个值写进 `deleted_at` 与 `updated_at`，`deleted` 事件的 `occurred_at` 从该行读取。时间值不离开 SQL，保留微秒。此前用 `now()`（事务开始时间，早于排队等锁），排队期间被接受的评论会显得晚于删除；第二轮取回 JS 再写回会丢掉毫秒以下的部分。

不级联删除子任务。先删子任务，再删父任务。之后 `GET` 这条任务是 404。`has_children` 按**全部**未软删子任务判定，见 §3.2 的说明。

**给 owner 的说明**：取任务行锁的这条语句限时 3 秒，超时回 409 `TASK_BUSY`；客户端收到 `TASK_BUSY` 后应退避重试。是否改成 1 秒待 owner 定。

### 3.8 M2 `POST /api/tasks` 的输入校验（闸方第三轮新增）

- `assignees` 在逐个校验成员 id（§4）并去重之后，超过 50 个不同的 id：422 `{ error: { code: 'LIMIT' } }`，与加执行人路由（§3.3）同一个软上限、同一个码（M3R3-IN-2）。校验先于计数：51 项里有一个非法 id 是 `INVALID_ASSIGNEES`；51 项里有一个重复、去重后 50 个，照常创建。执行人行用一条 `INSERT … SELECT … FROM unnest(…)` 写入。
- `assignees` 的每一项，以及省略 `assignees` 时插入的 creator 行，都经 `isValidMemberId`（§4）校验：`.`、`..`，或超过 255 个字符 ⇒ 422 `{ error: { code: 'INVALID_ASSIGNEES' } }`（此前接受）。
- `title` 规范化后含 U+0000，或不是合法的 UTF-16（不成对的代理项）：422 `{ error: { code: 'INVALID_TITLE' } }`，与空白标题同一个码（M3R3-IN-3/IN-4）。此前 U+0000 会以 500 落到数据库，不成对的代理项会被存成 U+FFFD。
- 这三条都是对 M2 端点的行为变更（此前分别是 200、200 与 500/200）。

## 4. 表

`tasks.parent_id`、`tasks.depth`、`tasks.deleted_at` 已在 P0-A。本片不重建这三列，也不改它们的 CHECK 和 `idx_tsk_parent`。

只新增 `task_comments`。形照 `zzzz20260822120000_create_approval_comments.ts`，没有 `resolved`，没有 `mentions`，没有回复用的 `parent_id`。

| 列 | 约束 |
|---|---|
| `id` | `text` 主键，`generateTaskDomainId('comment', …)`（`tcmt_…`），CHECK 与 `tasks.id`/`task_events.id` 同形四合取：`^[!-~]+$ ∧ !~ '__' ∧ !~ '^_' ∧ !~ '_$'`（PR #6126 第二轮 P2 第 2 条：原契约写的是「`tcmt_` + UUID」，与 main 上 `generateTaskDomainId` 的实际用法不一致，也缺了锁 §4.1 的四合取 CHECK；`task-ids.ts` 的 `TASK_ID_PREFIXES` 本来就含 `comment: 'tcmt'`，本片新增 `newTaskCommentId()` 到 `task-ids-runtime.ts`） |
| `task_id` | `text NOT NULL`，引用 `tasks(id)` `ON DELETE CASCADE` |
| `author_id` | `text NOT NULL`，可打印 CHECK `^[!-~]+$`（与 `tasks.created_by`/`task_events.actor_id` 同形单合取，**不是** `approval_comments.author_id` 那种只要求字符串里有一个可打印字符的 `~ '[!-~]'`） |
| `body` | `text`，可空 |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `edited_at` | `timestamptz` |
| `deleted_at` | `timestamptz` |

墓碑 CHECK：`(deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL)`。

索引：`idx_tcmt_task_time (task_id, created_at)`。不设 `org_id`。`down()` 先删索引再删表。

迁移文件：`packages/core-backend/src/db/migrations/zzzz20260930090000_create_task_comments.ts`。本 PR 不把这条 DDL 应用到共享库或生产库。

### id 校验补充（成员 id，非表结构）

增删执行人/关注人的 `userId`（无论来自请求体还是 URL 段）除了「可打印 id」外，还要求不是 `.` 或 `..`，且长度不超过 **255**（闸方第二轮 M3R2-AUTHZ-5：此前没有上限；255 远低于索引行与 URL 的长度限制）。255 按 UTF-16 码元计；id 只含可打印 ASCII，所以也是字节数与字符数。不合法一律 422 `INVALID_ASSIGNEES`。上限同样作用于 `POST /api/tasks` 省略 `assignees` 时插入的 creator 行：token 的 `sub` 超过 255 的调用者建任务会得到 422（对 M2 端点的行为变更）。本片不加对应的表级 CHECK（留给以后的迁移）。实现上是单一共享校验器（`task-create.ts` 的 `isValidMemberId`），`POST /api/tasks` 的 `assignees` 字段（含省略时插入的 creator 行）与本片新增的加执行人/加关注人路由用同一个函数，不是各自一份正则。

## 5. 测试要点

- 门 6：`depth` 0 到 4、无环、两个独立连接做交叉移动。持锁的那条连接由测试直接发 `pg_advisory_xact_lock`，不经过 `acquireTaskStructureLock`。负控是注释掉该函数里的取锁行，生产操作必须不再阻塞。
- 门 3 的增删人与切模式：`all` / `any` × 增删人 × 已完成 / 未完成。每次操作后断言 §2 的不变量：`open` 且 `any` 时没有非空 `completed_at`（对整个测试 org 断言，不止目标任务）。这些格子经 HTTP。
- 新的写路由补进门 1（无 org 是 422、跨 org）、门 2（非管理员的权限格）和门 16 的鉴权文件（`tests/tasks-auth/tasks-auth-gate.ts`，独立 config/lane，不在 `tasks-realdb` 三文件 ×3 的范围内，单独跑）。
- 新的 `task-*.db.test.ts` 同时登记进 `vitest.config.ts` 的 exclude 和 `tasks-realdb.yml`，文件顶部 import `assert-rbac-optional-off`。

任务 C 留下的两处措辞在实现提交里改：设计文档（`task-c-m3-pure-functions-design-20260928.md`）§6 的「待 owner 裁定」改为 A1–A7 已于 2026-09-28 接受（来源：`task-c-m3-pure-functions-verification-20260928.md`）；`task-completion.test.ts` 里 A7 那组 `describe` 不再写成 "all-null rows"。

## 未采纳 / 推迟的 P3/NIT 项（各附理由）

- **第一轮 P3 第 1 条（加人是否要求目标用户属于本 org, `user_orgs`）**：不实现。这是 M4 裁决包 R17 的题（跨 org 负责人/关注人），锁 §13-1c 明确「未设独立验收门（仅建议；不由门 1 覆盖）」，owner 尚未就 R17 裁决；本片只吸收「闸方对 M3 接口契约的自核」与「第二轮意见」两条评论里的内容，不吸收另一条提醒性评论（「两条待裁的 M4 题」）里「建议在本 PR 直接实现」的说法——那不是这两条被点名的评论。
- **第一轮 P3 第 2 条（评论视图加 `editedAt`）**：不实现。`toCommentView` 保持六个字段不变（与「闸方对 M3 接口契约的自核」里确认的「与 main 上的签名吻合（包括 `toCommentView` 的六个字段）」一致）；`edited_at` 列仍写入数据库（`PATCH` 会 `SET edited_at = now()`），只是不通过视图暴露。
- **第二轮 P3/NIT 第 12 条的事件缺口（删人促成完成不写事件）**：见 §3.3 「删人促成完成时的事件空白」，明确不填这个洞，留给 owner 在 M4 裁决包里对 N1 表态。
