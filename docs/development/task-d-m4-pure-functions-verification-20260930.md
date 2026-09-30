# 任务 D:M4 P1 纯函数验证记录(2026-09-30)

- 分支:`claude/tasks-d-pure`,基于 `origin/main`。只在本 worktree 写代码,不合并,不推送。
- 设计:`docs/development/task-d-m4-pure-functions-design-20260930.md`。
- Node:20.20.2。

## 1. 范围

七个新模块(`task-lists.ts`/`task-groups.ts`/`task-reminders.ts`/`task-notifications.ts`/`task-settings.ts`/`task-pagination.ts`/`task-realtime.ts`)+ 对 `task-ids.ts`(R23 两个新前缀)、`task-dates.ts`(一条注释修正,不改行为)的小改动。`task-access.ts` 未改(见设计文档 §6)。

## 2. 命令与结果

全部命令在 `packages/core-backend/` 下用 `./node_modules/.bin/...` 运行(不用 pnpm)。

### 2.1 新增/改动模块的单测

```
./node_modules/.bin/vitest run tests/unit/task-*.test.ts --reporter=dot
```

结果:**22 个文件、643 个用例,全部通过**(含七个新模块各自的测试文件,以及因 `task-ids.ts` 加前缀而更新的 `task-ids.test.ts`;`task-access.test.ts`/`task-dates.test.ts`/`task-completion.test.ts`/`task-membership.test.ts`/`task-tree.test.ts`/`task-comments.test.ts`/`task-deletion.test.ts`/`task-lock-keys.test.ts` 等任务 B/C 遗留测试原样通过,未受影响)。

### 2.2 门 20(`task-pure-no-io.test.ts`)

上面的 `task-*.test.ts` glob 已包含它;单独复核:

```
./node_modules/.bin/vitest run tests/unit/task-pure-no-io.test.ts --reporter=dot
```

结果:**5/5 通过**。harness 用 `readdirSync` 自动发现 `src/tasks/*.ts`(现为 12 个文件,含本次新增的 7 个),把每个文件的每个导出函数在 `pg`/连接池被替换成"调用即抛 `TASK_DB_STUB`"的桩之后逐一调用一遍——没有任何新模块的导出触达该桩,证明新代码在模块顶层和调用路径上都没有 I/O。

### 2.3 类型检查

```
./node_modules/.bin/tsc --noEmit
```

结果:**零输出,exit 0**(与任务 B/C 验证记录用的同一条命令 —— `package.json` 里 `type-check` 脚本的第一段)。

### 2.4 core-backend 全量单测

```
./node_modules/.bin/vitest run --reporter=dot
```

结果:**1239 个文件,1065 通过 / 1 失败 / 173 跳过;19623 个用例,17957 通过 / 1 失败 / 1665 跳过**。耗时约 219 秒。

唯一失败:`tests/integration/field-validation-flow.test.ts > Field validation — form submit > enum validation rejects unlisted value`,报 `ECONNRESET`/`socket hang up`。与本次改动无关(该测试文件不在 `src/tasks/` 依赖图内,任务 D 没有改过 `field-validation` 相关任何文件)——单独重跑该文件:

```
./node_modules/.bin/vitest run tests/integration/field-validation-flow.test.ts --reporter=dot
```

**15/15 全部通过**,坐实这是 `packages/core-backend/vitest.config.ts` 自己文档化的已知瞬时问题(supertest 每次请求起一个临时 `app.listen(0)`,高并发下偶发端口复用碰撞到另一个测试的 app 上;该文件的注释本身写明 CI 靠 `retry: 2` 吸收这类瞬时碰撞,本地默认不重试)。

## 3. Mutation 抽查(8 处关键守卫;备份 → 改 → 跑 → 还原 → 比对,不用 `git checkout --`)

每一条都用 `cp` 先备份到 `/tmp`,`python3` 做定点字符串替换,跑对应测试文件确认变红,再用原文件 `cp` 覆盖回来并用 `cmp` 逐字节核对还原。

| # | 模块 / 被改的守卫 | 改法 | 结果 |
|---|---|---|---|
| 1 | `task-lists.ts` `applyRemoveMember` 的 `created_by_immutable` 判据 | 删掉整个 `if (userId === createdBy) {…}` 分支 | 红 2(该场景断言 + 优先级断言),还原后 46/46 绿 |
| 2 | `task-lists.ts` `applyTransferOwner` 的 owner 判据 | `from.role !== 'owner'` 弱化为只判 `!from` | 红 2,还原后 46/46 绿 |
| 3 | `task-groups.ts` `applyDeleteGroup` 的默认组保护 | 删掉 `if (group.isDefault) return {…'is_default'}` | 红 1,还原后 20/20 绿 |
| 4 | `task-groups.ts` `applyMoveItem` 的 D2 scope 分支 | `!sameGroup && scope==='list'` 弱化为 `!sameGroup`(个人分组也发事件) | 红 1,还原后 20/20 绿 |
| 5 | `task-reminders.ts` `computeDefaultRemindAt` 的非法时区抛错 | 删掉 `isValidIanaTimeZone` 校验+抛错整段 | 红 1,还原后 51/51 绿 |
| 6 | `task-reminders.ts` 的 `SCHEDULED_REMIND_OFFSET_MS` | `30*60*1000` 改成 `0` | 红 2(常规格 + 00:10 跨日回退格),还原后 51/51 绿 |
| 7 | `task-notifications.ts` `resolveNotificationRecipients` 的 actor 排除 | 删掉 `if (id === input.actorId) continue` | 红 3,还原后 24/24 绿 |
| 8 | `task-pagination.ts` `parsePageParams` 的 `limit` 上界 | 去掉 `\|\| parsed > TASK_PAGE_LIMIT_MAX` | 红 2(边界格 + 不静默夹取格),还原后 19/19 绿 |

八处全部按预期变红,还原后逐字节比对(`cmp`)与原文件相同,对应测试文件回到全绿。

## 4. 结论

- 全部 `tests/unit/task-*.test.ts`:643/643 通过。
- 门 20:5/5 通过,新模块被自动发现且零 I/O。
- `tsc --noEmit`:零输出。
- core-backend 全量单测:17957/17958 有意义地通过(唯一失败是与本次改动无关的既有瞬时网络问题,单独重跑 15/15 通过)。
- 8 处关键守卫 mutation 抽查全部按预期变红,还原后文件逐字节一致。

## 5. 未验证 / 留给后续

- 没有 DDL、路由、服务或前端代码;真实数据库、staging、生产环境:NOT RUN(本切片范围之外)。
- M4 裁决包 v2 尚未经 owner ratify——本文档只验证「纯函数按裁决包推荐值实现且自洽」,不代表任何 R 编号已经裁定;设计文档 §5 的 ASSUMPTION 表是改动裁决后要回来重新核对的清单。
