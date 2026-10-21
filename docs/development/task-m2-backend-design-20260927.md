# 任务功能 M2 后端设计（2026-09-27）

- 分支：`grok/tasks-m2-backend`，Draft PR #6062。基线是当时的 `origin/main`。
- 锁：#5845 `docs/development/task-feature-design-lock-20260917.md`。§12 门表仍是 PROPOSED。本文件不 ratify 门表，也不授权合并。
- 验证记录：`docs/development/task-m2-backend-verification-20260927.md`。
- 前端 #6092 已按下面的响应形状对接。改这些形状时必须在 PR 里写明。

## 范围

M2 后端是 P0-A：任务行、执行人、关注人、事件、三条权限码、七个 HTTP 路由，以及结构锁下的创建、完成、重开。

本片不做：增删执行人 API、切换完成模式、任务树、投影读、通知调度。增删执行人与切换完成模式的首个可跑点是 M3。`TASKS_ENABLED` 保持默认关闭。本 PR 不把迁移应用到共享库或生产库。

纯函数留在任务 B（已合入 main 的 `packages/core-backend/src/tasks`）。本 PR 只调用它们，不改那一目录的语义。

## 表结构与迁移

两个 Kysely 迁移，都在 `packages/core-backend/src/db/migrations/`：

| 文件 | 作用 |
|---|---|
| `zzzz20260926120000_create_task_p0a_tables.ts` | `tasks`、`task_assignees`、`task_followers`、`task_events` |
| `zzzz20260926120100_add_task_permissions.ts` | 向 `permissions` 插入 `tasks:read`、`tasks:write`、`tasks:admin`。不写 `role_permissions`，不建 `tasks_user` 角色 |

`tasks` 的 org、标题、状态（`open`/`done`）、完成模式（`all`/`any`）、截止（`due_date` / `due_time` / `time_zone` / `due_at`）、`created_by`、`version`、`deleted_at` 按锁 §4.1。事件 id 用 `tev_` 前缀。`down()` 按相反顺序删表，并删这三枚权限码。

`POST /api/tasks` 不接收截止日。截止日只由测试用 SQL 写入。

## 路由与权限

工厂 `tasksRouter()` 只在 `process.env.TASKS_ENABLED === 'true'` 时返回路由器，否则返回 `null`。`src/index.ts` 在审批路由和待办中心之后挂载：`if (taskRoutes) this.app.use(taskRoutes)`。静态路径 `/context`、`/pending`、`/pending-count` 写在 `/:id` 之前。

org 只取 `req.authenticatedTenantId`。写操作没有 org 时返回 422 `{ error: { code: 'ORG_MISSING' } }`。读操作没有 org 时列表降级为 `{ items: [], degraded: true, reason: 'org_missing' }`，红点降级为 `{ count: 0, degraded: true, reason: 'org_missing' }`，详情返回 404 `{ error: { code: 'NOT_FOUND' } }`。

| 方法与路径 | 权限 | 成功形状 |
|---|---|---|
| `GET /api/tasks/context` | `tasks:read` | `{ orgId: string \| null }` |
| `GET /api/tasks?view=` | `tasks:read` | `{ items: [{ id, title, status, completion_mode, created_by, due_at }] }`。非法 view：`{ items: [], degraded: true, reason: 'predicate_error' }` |
| `GET /api/tasks/pending` | `tasks:read` | `{ items }`。每项有 `source`、`id`、`title`、`href`、`updatedAt`；有截止时多一个 `dueAt` |
| `GET /api/tasks/pending-count` | `tasks:read` | `{ count }` |
| `GET /api/tasks/:id` | `tasks:read` | `{ id, title, status, completionMode, createdBy, dueAt, dueDate, dueTime, timeZone, assignees: [{ userId, completedAt }], canComplete, canReopen }`。不存在、不可见、他 org 都是 404 `{ error: { code: 'NOT_FOUND' } }` |
| `POST /api/tasks` | `tasks:write` | 200 `{ id }`。非法执行人 id：422 `{ error: { code: 'INVALID_ASSIGNEES' } }` |
| `POST /api/tasks/:id/complete` 与 `/reopen` | `tasks:write` | 完成体可带 `{ scope }` |

列表字段是 snake_case，详情字段是 camelCase。这是前端已经对接的形状。

`/pending` 用 `all_open`：未完成的指派都在列表里，没有截止日也在。`/pending-count` 用默认 `badge_scope=overdue`：只数已经过期的未完成指派。门 4 的两格本身都已过期，所以那两格不会把这两个范围收成同一个数。无截止日的未完成指派留在列表里，红点是 0。

非管理员要同时有两样东西：角色上的 `tasks:read` 或 `tasks:write`，以及 `user_namespace_admissions(user_id, 'tasks', enabled=true)`。只有权限码、没有 admission 行，返回 403 `{ error: 'Insufficient permissions' }`。本迁移不给任何角色绑这三枚码，也不把 `tasks` 放进豁免名单。

## 锁与事务

创建、完成、重开走同一个结构：

1. 打开事务。
2. 第一条语句是 `SET TRANSACTION ISOLATION LEVEL READ COMMITTED`。
3. `acquireTaskStructureLock(client, orgId)`，键来自 `taskStructureLockKey`。
4. 在这把锁里读取任务行。`wasDone` 取 `task.status === 'done'`，传给 `applyComplete` / `applyReopen`。
5. 只更新 `completed_at` 真的变了的执行人行。状态没变时不改 `status`，也不增加 `version`。

零执行人任务重复完成或重开时，`wasDone` 让第二次调用不再写事件。取值必须来自加锁之后的那一行，不能在加锁前另读一次。

## 部署前提

生产启用要同时满足下面几条，缺一条都不算上线：

1. 锁 §5.4 的五段是分开的：合并、构建、发布、部署、迁移。合并本 PR 不会发布，不会部署，也不会跑迁移。
2. 迁移只在部署 job 的 Remote deploy 步骤里执行。本 PR 不授权那一步。
3. `TASKS_ENABLED` 必须是精确字符串 `'true'`。默认关闭。打开它是另一次 owner 授权。
4. 非管理员除了权限码，还要有 `user_namespace_admissions(user_id, 'tasks', enabled=true)`。管理员短路不依赖这行。
5. 把 `tasks-realdb` 加进 main 的 required checks 是合并之后的 owner 步骤。那个 job 要先在 main 上跑过。这一步不挡住 M2 的代码退出。
