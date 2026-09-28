# 任务功能 M3 后端设计（2026-09-28）

- 分支：`grok/tasks-m3-backend`。本文件是该分支的第一个提交，只钉接口契约。
- 基线：写这份契约时，#5845、#6062、#6092、#6123 都还没合进 `main`。实现提交等这四份按序合入之后，rebase 到当时的 `main` 再写。本文件不授权合并，不授权应用 DDL，也不打开 `TASKS_ENABLED`。
- 锁：`docs/development/task-feature-design-lock-20260917.md`。§12 门表仍是 PROPOSED。
- 纯函数来源：任务 C（#6123）的 `packages/core-backend/src/tasks/task-tree.ts`、`task-membership.ts`、`task-comments.ts`、`task-deletion.ts`。服务层只调用这些函数，不另写树、成员、评论、删除规则。
- 前端对接以本节的路径、请求体、成功形状和错误码为准。必须改形状时先改本文件，再改实现。

M2 已经钉死的形状保持不变：列表项 snake_case；详情在 M2 字段上追加本节的 `parentId`、`depth`、`children`；不存在、不可见、他 org 仍是 404 `{ error: { code: 'NOT_FOUND' } }`；写操作缺 org 仍是 422 `{ error: { code: 'ORG_MISSING' } }`。

## 1. 范围

M3 后端是 P0-B：子任务树、执行人与关注人的增删、切换完成模式、评论、软删。

本片不做：附件、清单、投影读、通知调度、硬删、评论的回复线程、`resolved` 列。`TASKS_ENABLED` 仍是精确字符串 `'true'` 才挂路由，默认关闭。

## 2. 共性

路由工厂仍是 `tasksRouter()`。新路径和 M2 一样，静态段写在 `/:id` 之前。org 只取 `req.authenticatedTenantId`。

权限码仍是 `tasks:read`、`tasks:write`、`tasks:admin`。非管理员还要有 `user_namespace_admissions(user_id, 'tasks', enabled=true)`。只有码、没有这行，是 403 `{ error: 'Insufficient permissions' }`，与 M2 相同。过了码之后，行级能力用任务 B 的 `can(resolveTaskRoles(...), ability)`：

| 能力 | 谁有 |
|---|---|
| `view` | creator、assignee、follower、list-editor、list-reader |
| `edit` | creator、assignee、list-editor |
| `comment` | 上表里除 `none` 以外的角色 |
| `delete` | 只有 creator |
| `leave` | 只有 follower |

看不到、不能做、他 org、已软删，写操作和读操作都回 404 `{ error: { code: 'NOT_FOUND' } }`，不区分原因。校验失败回 422，冲突回 409。成功体一律 camelCase。时间是 ISO-8601 字符串，没有值时是 `null`。

所有改结构的写操作走同一个事务：

1. `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` 是事务里的第一条语句。
2. `acquireTaskStructureLock(client, orgId)`。
3. 锁后再读任务行、执行人、关注人、以及本 org 未软删的树节点。
4. 把锁后读到的 `status === 'done'` 当作 `wasDone`。本片的纯函数不接收 `wasDone`；完成态以锁后的 `status` 传入 `applyAddAssignee` / `applyRemoveAssignee` / `applySwitchCompletionMode`。
5. 调用下面点名的纯函数。纯函数返回的行集写回数据库。树事件和删除事件的纯函数不带执行人，服务层把当前操作者写入 `task_events.actor_id`。成员事件用纯函数给出的 `userId` 作为 `actor_id`。

`task_events.event_type` 不新增词。本片只用闭集里已有的 `parent_set`、`parent_cleared`、`assignee_added`、`assignee_removed`、`completion_mode_changed`、`completed_by_any`、`follower_added`、`follower_removed`、`left`、`commented`、`deleted`。空操作不写事件。

## 3. 接口

### 3.1 `PATCH /api/tasks/:id/parent`

权限：`tasks:write`，然后 `canReparent`：子任务和父任务都要 `edit`，并且同 org。失败是 404。

请求体：`{ parentId: string | null }`。缺字段或类型不对：422 `{ error: { code: 'INVALID_PARENT' } }`。

- `parentId === null`：调用 `validateClearParent`。
- 字符串：调用 `validateSetParent`。

| 纯函数结果 | HTTP |
|---|---|
| `not_found` | 404 `NOT_FOUND` |
| `self`、`descendant` | 422 `INVALID_PARENT` |
| `depth_exceeded` | 422 `DEPTH_EXCEEDED` |
| `noop: true` | 200，不写事件 |
| 成功 | 200 `{ id, parentId, depth }`，`depth` 是移动后的这一行。子孙的 `depth` 按 `depthChanges` 同事务写回 |

`depth` 最大是 4，含根。父完成不改子任务的状态。

### 3.2 `GET /api/tasks/:id`

权限：`tasks:read`，并且 `can(..., 'view')`。否则 404。

在 M2 详情字段之外增加：

```json
{
  "parentId": "tsk_… | null",
  "depth": 0,
  "children": [
    { "id": "tsk_…", "title": "…", "status": "open", "completionMode": "all", "depth": 1 }
  ]
}
```

`children` 只含直接子任务，且未软删，且调用者对那一行 `can(..., 'view')`。看不见的子任务直接省略，不因此把父任务变成 404。顺序按 `id` 字节序。

### 3.3 `POST /api/tasks/:id/assignees` 与 `DELETE /api/tasks/:id/assignees/:userId`

权限：`tasks:write`，并且对这条任务 `edit`。否则 404。

`POST` 请求体 `{ userId: string }`。`userId` 不是可打印 id 时 422 `{ error: { code: 'INVALID_ASSIGNEES' } }`，与创建任务相同。

调用 `applyAddAssignee` / `applyRemoveAssignee`。已是执行人或本来就不是执行人，是空操作，200，不写事件。超过 50 人：422 `{ error: { code: 'LIMIT' } }`。

成功：`{ id, status, completionMode, assignees: [{ userId, completedAt }] }`。

`all` 模式给已完成任务加人会把任务 reopen 成 `open`。`any` 模式加人不动状态。删到剩下的人全都已完成时，`all` 模式会把状态推进到 `done`；不会因为删人把 `done` 改回 `open`。

### 3.4 `PATCH /api/tasks/:id/completion-mode`

权限与 3.3 相同。

请求体 `{ completionMode: "all" | "any" }`。别的值：422 `{ error: { code: 'INVALID_COMPLETION_MODE' } }`。

调用 `applySwitchCompletionMode`。相同模式是空操作。`all` 改 `any` 时，若任务仍是 `open` 且已有人完成，其余未完成行的 `completedAt` 写成同一个 `now`，并追加 `completed_by_any`。`any` 改 `all` 不改各人的完成戳，已完成的任务保持完成。

成功体与 3.3 相同。

### 3.5 `POST /api/tasks/:id/followers`、`DELETE /api/tasks/:id/followers/:userId`、`POST /api/tasks/:id/leave`

加人和删别人：`tasks:write` 且 `edit`，否则 404。`POST` 请求体 `{ userId }`，id 非法是 422 `INVALID_ASSIGNEES`。调用 `applyAddFollower` / `applyRemoveFollower`。超过 50 人：422 `LIMIT`。删别人的事件是 `follower_removed`。

`POST /leave` 没有请求体。调用者必须 `can(..., 'leave')`，否则 404。服务层用调用者自己的 id 调用 `applyRemoveFollower`，事件是 `left`。

成功：`{ id, followers: ["usr_…"] }`。已在列表里或本来就不在，是空操作，200，不写事件。

### 3.6 `GET /POST /api/tasks/:id/comments`，`PATCH /DELETE /api/tasks/:id/comments/:commentId`

`GET`：`tasks:read` 且能 `view` 这条任务，否则 404。200 `{ items: [Comment] }`，按 `createdAt` 升序。墓碑也返回。

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

`POST` 请求体 `{ body: string }`。权限：`tasks:write`，并且 `canComment`。不能评论是 404。`normalizeCommentBody` 失败：空白 422 `{ error: { code: 'COMMENT_BLANK' } }`，超过 5000 个 Unicode 码点 422 `{ error: { code: 'COMMENT_TOO_LONG' } }`。成功 200 返回一条 `Comment`，并写一条 `commented` 事件，`actor_id` 是作者。

`PATCH` 请求体同样是 `{ body }`。`canEditComment` 为假（不是作者，或已经是墓碑）是 404。校验失败的码与 `POST` 相同。成功 200 返回更新后的 `Comment`。不写 `task_events`。

`DELETE`：`canDeleteComment` 为假是 404。成功 200 返回墓碑形的 `Comment`。不写 `task_events`。

### 3.7 `DELETE /api/tasks/:id`

权限：`tasks:write`，然后 `planDeleteTask`。

| 原因 | HTTP |
|---|---|
| `not_found`、`forbidden` | 404 `NOT_FOUND` |
| `has_children` | 409 `{ error: { code: 'HAS_CHILDREN' } }` |
| 成功 | 200 `{ id, deleted: true }`，写 `deleted_at` 和一条 `deleted` 事件，`actor_id` 是操作者 |

不级联删除子任务。先删子任务，再删父任务。之后 `GET` 这条任务是 404。

## 4. 表

`tasks.parent_id`、`tasks.depth`、`tasks.deleted_at` 已在 P0-A。本片不重建这三列，也不改它们的 CHECK 和 `idx_tsk_parent`。

只新增 `task_comments`。形照 `zzzz20260822120000_create_approval_comments.ts`，没有 `resolved`，没有 `mentions`，没有回复用的 `parent_id`。

| 列 | 约束 |
|---|---|
| `id` | `text` 主键，`tcmt_` + UUID，`generateTaskDomainId('comment', …)` |
| `task_id` | `text NOT NULL`，引用 `tasks(id)` `ON DELETE CASCADE` |
| `author_id` | `text NOT NULL`，可打印 CHECK |
| `body` | `text`，可空 |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` |
| `edited_at` | `timestamptz` |
| `deleted_at` | `timestamptz` |

墓碑 CHECK：`(deleted_at IS NULL AND body IS NOT NULL) OR (deleted_at IS NOT NULL AND body IS NULL)`。

索引：`idx_tcmt_task_time (task_id, created_at)`。不设 `org_id`。`down()` 先删索引再删表。

迁移文件放在 `packages/core-backend/src/db/migrations/`，时间戳名字不与现有文件相撞。本 PR 不把这条 DDL 应用到共享库或生产库。

## 5. 测试要点

实现提交再补验证记录。计划中的门：

- 门 6：`depth` 0 到 4、无环、两个独立连接做交叉移动。持锁的那条连接由测试直接发 `pg_advisory_xact_lock`，不经过 `acquireTaskStructureLock`。负控是注释掉该函数里的取锁行，生产操作必须不再阻塞。
- 门 3 的增删人与切模式：`all` / `any` × 增删人 × 已完成 / 未完成。每次操作后断言 §6.2：`open` 且 `any` 时没有非空 `completed_at`。这些格子经 HTTP。
- 新的写路由补进门 1（无 org 是 422、跨 org）、门 2（非管理员的权限格）和门 16 的鉴权文件。
- 新的 `task-*.db.test.ts` 同时登记进 `vitest.config.ts` 的 exclude 和 `tasks-realdb.yml`，文件顶部 import `assert-rbac-optional-off`。

任务 C 留下的两处措辞在实现提交里改：设计文档 §6 的「待 owner 裁定」改为 A1–A7 已于 2026-09-28 接受；`task-completion.test.ts` 里 A7 那组 `describe` 不再写成 “all-null rows”。
