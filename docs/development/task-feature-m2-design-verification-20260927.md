# 任务 M2 设计验证（2026-09-27）

对照 `docs/development/task-feature-design-lock-20260917.md`（锁 PR #5845，head `f2f095d0f`）与后端 PR #6062。本文件只记录已经跑过的命令和还没做的门。不构成合并授权，也不表示 `TASKS_ENABLED` 已打开。

## 范围

- 后端分支 `grok/tasks-m2-backend`，基线为当时的 `origin/main`。
- 验证库是一次性的 `metasheet_tasks_gate_tmp`。迁移只打在这个库上，跑完已 `DROP DATABASE`。共享库 `metasheet_v2` 没有迁移。
- 前端实现在 #6092，不在本文件的执行范围内。#6090 已关闭。

## 本轮新增的证据

| 文件 | 覆盖 |
|---|---|
| `tests/integration/task-gate19.db.test.ts` | 锁内 `i-m2` 49 个名字。每格独立 org。列表结果与 `taskMatchesView` 一致 |
| `tests/integration/task-completion-grid.db.test.ts` | 门 3 存活六格：`all×0`、`any×0`、`all×1`、`any×1`、`all×n`、`any×n` |
| `tests/integration/task-read-path.db.test.ts` | 门 4 正反格，以及门 5：同一全天任务在 `Pacific/Kiritimati` 与 `Pacific/Pago_Pago` 下 `dueAt` 逐字节相同，且为 `2026-09-28T15:59:59.999Z` |
| `tests/tasks-auth/tasks-auth-gate.ts` | 门 1：无租户时读路径 `org_missing`，写路径 422 `ORG_MISSING` |
| `tests/unit/task-pure-no-io.test.ts` | 门 20：`acquireTaskStructureLock(pg.query)` 抛出 `TASK_DB_STUB` |

两个新库测文件已同时写进 `vitest.config.ts` 的 exclude 和 `tasks-realdb.yml`。覆盖枚举单测 4/4。

## 实跑

一次性库迁移 exit 0，包含 `zzzz20260926120000_create_task_p0a_tables` 与 `zzzz20260926120100_add_task_permissions`。

```bash
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.integration.config.ts \
  tests/integration/task-gate19.db.test.ts \
  tests/integration/task-completion-grid.db.test.ts \
  tests/integration/task-read-path.db.test.ts \
  tests/integration/task-p0a.db.test.ts \
  --reporter=dot
```

exit 0。72 passed（49 + 6 + 4 + 13）。

```bash
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.tasks-auth.config.ts --reporter=dot
```

exit 0。5 passed。

```bash
pnpm --filter @metasheet/core-backend exec vitest run --config vitest.config.ts \
  tests/unit/task-pure-no-io.test.ts \
  tests/unit/task-ci-coverage-enumeration.test.ts \
  --reporter=dot
```

exit 0。9 passed。

## 门状态

| 门 | 结论 | 依据 |
|---|---|---|
| 1 | 部分 | 无租户读/写两格已跑。九项前置 a–i 的逐格矩阵还没有 |
| 2 | 部分 | trust-off 下「令牌有 `tasks:read`、库只有 `tasks:write`」读 403、写 200 已在上一轮。缺角色、缺 admission 的独立用户格还没有 |
| 3 存活六格 | 已跑 | 上表 6/6。增删人与切模式在 M3，本轮不跑 |
| 4 | 已跑 | 正格 count=1，反格 count=0，且仍留在 `assigned` |
| 5 | 部分 | 跨时区 `dueAt` 字节相同已跑。无截止日五键、定时六键在单测里；全天六键本轮用待办列表核对了 `dueAt`，没有再单独断言「恰五键/恰六键」的 HTTP 体 |
| 8 | 已有单测 | `tests/unit/task-dates.test.ts` 钉了 `now=2026-09-15T12:30Z`、甲乙 fallback、`Not/AZone`、Kiritimati 与 Pago_Pago。本轮没有新跑这一文件 |
| 13 | 部分 | 非 admin 且库授 `tasks:write` 的 `POST /api/tasks` 返回 200。不是从 `setup.integration.ts` 起的整站 |
| 19 网格 | 已跑 | 49/49，名字与锁内 `i-m2` 一致 |
| 19 探针①② | 未跑 | 要在跑的时候改 `task-access.ts` 再还原。本轮没有做这个 mutation |
| 20 | 部分 | `src/tasks` 导出不碰到 stub，且 `acquireTaskStructureLock(pg.query)` 碰到 stub。持池三行 ERE 没有在本轮重跑 |

## 明确没做

- 不合并 #6062。
- 不把 `tasks-realdb` 加进 `main` 的 required checks。那是合并之后的 owner 步骤。
- 不打开生产 `TASKS_ENABLED`。
- 不改 `packages/core-backend/src/tasks`（任务 B 的纯模块）。
- 门 6、7 的 `src/multitable` 根、门 9、门 10 的 P2 子集不在 M2 退出集合里。
