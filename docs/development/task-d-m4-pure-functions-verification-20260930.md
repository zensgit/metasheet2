# 任务 D:M4 P1 纯函数验证记录(2026-09-30)

- 分支:`claude/tasks-d-pure`,基于 `origin/main`。只在本 worktree 写代码,不合并,不推送。
- 设计:`docs/development/task-d-m4-pure-functions-design-20260930.md`。
- Node:20.20.2。

## 1. 范围

七个新模块(`task-lists.ts`/`task-groups.ts`/`task-reminders.ts`/`task-notifications.ts`/`task-settings.ts`/`task-pagination.ts`/`task-realtime.ts`)+ 对 `task-ids.ts`(R23 两个新前缀)、`task-dates.ts`(一条注释修正,不改行为)的小改动。`task-access.ts` 未改(见设计文档 §6)。

独立复核发现两类问题并已修复(均为同分支的后续 commit,非 amend),详见 §6:
1. 多处 `ASSUMPTION(task-d)` 标记只在散文里提了裁决编号,没有用可 `grep` 的字面 token,以及 `task-settings.ts` 里把 R07(`time_zone` 列)错标成了 R02③/R02④。
2. `task-notifications.ts` 里两个标了 `ASSUMPTION(task-d)` 的常量其实是死代码:`RECIPIENT_ROLE_PRIORITY` 声明了但从未被读取(真正的优先级是硬编码在四次 `consider(...)` 调用的书写顺序里),`TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN` 这个"开关"改成 `true` 也不会让 `assignee_added` 真的进入通知闭集。两处都已改成常量真正驱动行为(§6)。

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

结果:**5/5 通过**。harness 用 `readdirSync` 自动发现 `src/tasks/*.ts`(现为 16 个文件 = 任务 B/C 遗留的 9 个 + 本次新增的 7 个),把每个文件的每个导出函数在 `pg`/连接池被替换成"调用即抛 `TASK_DB_STUB`"的桩之后逐一调用一遍——没有任何新模块的导出触达该桩,证明新代码在模块顶层和调用路径上都没有 I/O。

### 2.3 类型检查

CI 实际跑的类型检查链:根 `package.json` 的 `type-check` 脚本是 `pnpm -r type-check`,对 `core-backend` 落到它自己的 `type-check` 脚本 —— `tsc --noEmit && tsc -p scripts/tsconfig.recovery-archive-acceptance.json`(`.github/workflows/plugin-tests.yml` 的 "Run type checking" 步骤,只在 `matrix.node-version == '20.x'` 跑,即 `pnpm type-check`)。两条 tsc 命令用的 `include`/`exclude`(`packages/core-backend/tsconfig.json` 与 `scripts/tsconfig.recovery-archive-acceptance.json`,后者只是在前者基础上多 `include` 几个 `.mts` 脚本)**都排除 `**/*.test.ts`**——也就是说 CI 的这条链路本身从不对任意 `*.test.ts` 文件跑类型检查,不只是本次新增的这几个。

```
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc -p scripts/tsconfig.recovery-archive-acceptance.json
```

两条命令**都是零输出,exit 0**(与任务 B/C 验证记录用的第一条命令一致;第二条是本次额外核对的、CI 实际会跑的第二段)。

由于 CI 链路本身不覆盖测试文件,额外做了一次范围内的核对:用一个只 `include` 本次新增/改动的 8 个测试文件(`task-lists.test.ts`/`task-groups.test.ts`/`task-reminders.test.ts`/`task-notifications.test.ts`/`task-settings.test.ts`/`task-pagination.test.ts`/`task-realtime.test.ts`/`task-ids.test.ts`)、继承 `tsconfig.json` 其余选项的临时 `tsconfig`(未提交,核对完即删除)单独跑了一次 `tsc`(不出现在最终提交里,`git status` 复核过干净):

```
./node_modules/.bin/tsc -p <临时 tsconfig,仅 include 上述 8 个测试文件>
```

结果:**零输出,exit 0**。（未纳入范围:`src/__tests__/*.test.ts` 等 main 上早已存在、CI 本就不检查的测试文件——把它们一并纳入会带出与本次改动无关的既有类型错误,不是本次要核对的对象。）

### 2.4 core-backend 全量单测

```
./node_modules/.bin/vitest run --reporter=dot
```

结果:**1239 个文件,1065 通过 / 1 失败 / 173 跳过;19623 个用例,17957 通过 / 1 失败 / 1665 跳过**。耗时约 219 秒。

本次全量跑是在 `bad1a95a7e`(实现 commit)上做的,晚两轮 fixup(`e0966600b0`/`25df44d066`)只改了 `src/tasks/task-notifications.ts`/`task-settings.ts` 内部的常量接线与注释、以及对应测试和文档,不改对外签名/行为。`grep -rlE "task-(notifications|settings|lists|groups|reminders|pagination|realtime)" packages/core-backend/src | grep -v '/src/tasks/'` 零命中——仓库里没有任何 `src/tasks/` 之外的文件导入这七个新模块,所以没有必要在 fixup 之后重新跑一遍全量单测;fixup 之后重新跑的是 §2.1(`task-*.test.ts` 643/643)、§2.3(两条 tsc 命令)与 §2.5(eslint),三者均在本文档定稿时的 head(`25df44d066`)上确认过绿。

唯一失败:`tests/integration/field-validation-flow.test.ts > Field validation — form submit > enum validation rejects unlisted value`,报 `ECONNRESET`/`socket hang up`。与本次改动无关(该测试文件不在 `src/tasks/` 依赖图内,任务 D 没有改过 `field-validation` 相关任何文件)——单独重跑该文件:

```
./node_modules/.bin/vitest run tests/integration/field-validation-flow.test.ts --reporter=dot
```

**15/15 全部通过**,坐实这是 `packages/core-backend/vitest.config.ts` 自己文档化的已知瞬时问题(supertest 每次请求起一个临时 `app.listen(0)`,高并发下偶发端口复用碰撞到另一个测试的 app 上;该文件的注释本身写明 CI 靠 `retry: 2` 吸收这类瞬时碰撞,本地默认不重试)。

### 2.5 Lint

CI 的 "Run type checking" 前一步是 "Run linting"(`.github/workflows/plugin-tests.yml`,同样只在 `matrix.node-version == '20.x'` 跑),命令是根 `pnpm lint` → `pnpm -r lint`。**`packages/core-backend/package.json` 没有 `"lint"` 脚本**——`pnpm -r` 对没有该脚本的包直接跳过,所以 CI 的这条链路本身**从不 lint `packages/core-backend/src` 下任何文件**(不只是本次新增的几个;这是既有状态,不是任务 D 造成的空档)。

即便如此,额外用仓库根的 eslint 二进制 + `packages/core-backend/.eslintrc.json` 直接核对了一遍本次新增/改动的源文件(测试文件被 `.eslintignore` 规则跳过,与"CI 不 lint 测试文件"这一发现一致):

```
../../node_modules/.bin/eslint src/tasks/task-lists.ts src/tasks/task-groups.ts src/tasks/task-reminders.ts \
  src/tasks/task-notifications.ts src/tasks/task-settings.ts src/tasks/task-pagination.ts \
  src/tasks/task-realtime.ts src/tasks/task-ids.ts src/tasks/task-dates.ts
```

结果:1 条 `no-misleading-character-class` 错误,位置在 `task-ids.ts` 的 `ZERO_WIDTH_CHARS`/`EDGE_TRIM_RE`(任务 B 的既有代码,`git diff origin/main -- .../task-ids.ts` 证实本次 diff 完全没有碰到那几行)——**与本次改动无关的既有问题**,不是任务 D 引入的。本次新增的七个模块本身零 lint 问题。

**核对时序说明**(避免与 §1/§6 的叙述冲突):本节这次 eslint 核对是在 §6 的死代码修复(commit `25df44d066`)**之后**跑的,不是发现问题的手段。修复**之前**,`RECIPIENT_ROLE_PRIORITY` 在模块内从未被任何代码引用过——`core-backend/.eslintrc.json` 里确实配了 `@typescript-eslint/no-unused-vars`(warn 级),按理说能抓到这种未引用的模块级常量,但 CI 从不对 `packages/core-backend` 跑 eslint(§2.5 上文已确认该包没有 `"lint"` 脚本),所以没有任何自动检查真正抓到它,是靠独立复核逐行读代码发现的。

## 3. Mutation 抽查(9 处关键守卫;备份 → 改 → 跑 → 还原 → 比对,不用 `git checkout --`)

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
| 9 | `task-notifications.ts` `RECIPIENT_ROLE_PRIORITY`(§6 修复之后的版本 —— 证明常量现在真正驱动行为) | `['creator','assignee','follower','list_member']` 改成 `['creator','follower','assignee','list_member']`(交换 assignee/follower 顺序) | 红 2(`assignee>follower` 优先级断言 + 「assignee+follower 同一人应记 assignee」的 mutation-sensitive 断言),还原后 24/24 绿 |

九处全部按预期变红,还原后逐字节比对(`cmp`)与原文件相同,对应测试文件回到全绿。

## 4. 结论

- 全部 `tests/unit/task-*.test.ts`:643/643 通过。
- 门 20:5/5 通过,新模块被自动发现且零 I/O。
- CI 实际跑的两条 `tsc` 命令(`tsc --noEmit` + `tsc -p scripts/tsconfig.recovery-archive-acceptance.json`):均零输出。额外核对的 8 个测试文件(CI 本身不覆盖测试文件的类型检查):也零输出。
- Lint:CI 的 `pnpm lint` 本就不覆盖 `packages/core-backend`(该包没有 `"lint"` 脚本,§2.5);额外用 eslint 直接核对本次新增/改动的源文件,零新增问题(1 条既有、与本次改动无关的错误,§2.5)。
- core-backend 全量单测:17957/17958 有意义地通过(唯一失败是与本次改动无关的既有瞬时网络问题,单独重跑 15/15 通过)。
- 9 处关键守卫 mutation 抽查全部按预期变红,还原后文件逐字节一致。

## 5. 未验证 / 留给后续

- 没有 DDL、路由、服务或前端代码;真实数据库、staging、生产环境:NOT RUN(本切片范围之外)。
- M4 裁决包 v2 尚未经 owner ratify——本文档只验证「纯函数按裁决包推荐值实现且自洽」,不代表任何 R 编号已经裁定;设计文档 §5 的 ASSUMPTION 表是改动裁决后要回来重新核对的清单。
- `isInDailyDigest`(TS)与 `buildTaskDailyDigestCondition`(SQL)的双形对拍(裁决包候选门 M4-c 要求):需要真实 Postgres,留给 PR-3a(见设计文档 §6)。

## 6. 独立复核 fixup(同分支后续 commit,非 amend)

第一轮提交(`bad1a95a7e`)之后的两轮独立复核分别发现并修复了以下问题,均已在后续 commit 里改正,改正后重新跑过 §2/§3 的全部命令:

- **commit `e0966600b0`**:多处 `ASSUMPTION(task-d)` 只在散文里点了裁决编号、没有用字面可 `grep` 的 `ASSUMPTION(task-d)` token(`task-groups.ts` 的 R11、`task-lists.ts` 的 R12(b)/(c)、`task-notifications.ts` 的 D13 若干处、`task-settings.ts` 的 D5/D7、`task-pagination.ts` 的 D9);`task-reminders.ts` 里一条 D6 标记因为括号内多了个逗号,写成了 `ASSUMPTION(task-d, gate default D6…` 而不是标准形状 `ASSUMPTION(task-d): [D6]`,同样不可 grep。全部改正为统一的 `ASSUMPTION(task-d): [R<nn>/D<nn>]` 形状。
- **commit `25df44d066`**:
  - `task-notifications.ts` 的 `RECIPIENT_ROLE_PRIORITY` 声明了但从未被 `resolveNotificationRecipients` 读取——真正的优先级是硬编码在四次 `consider(...)` 调用的书写顺序里;改后 owner 就算裁定不同优先级、把这个常量改一下,行为也不会跟着变。已改成显式 `for (const role of RECIPIENT_ROLE_PRIORITY)` 驱动,常量现在是唯一真相(mutation #9 证实)。
  - `TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN` 这个"开关"常量改成 `true` 不会让 `assignee_added` 真的进入 `TASK_NOTIFIABLE_EVENTS`(该数组是独立的字面量,不读这个布尔值)——是纯装饰性的死代码。已删除该常量与对应测试断言,`[R05-opt]` 标记直接移到 `TASK_NOTIFIABLE_EVENTS` 数组本身上,数组字面量就是唯一真相。
  - `task-settings.ts` 里 `timeZone` 字段与 `daily_reminder_requires_time_zone` 校验被错标成 R02③/R02④——M4 裁决包 v2 §0.1 已把这一列明确从 R02 移到 R07("原④『加 time_zone 列』移到 R07")。改标为 `[R07]`,`[R02]` 只留给 `badgeScope`/`dailyReminderEnabled`/`defaultRemindPolicy` 三个字段。设计文档 §2.5/§5 与对应测试标题同步改正。
