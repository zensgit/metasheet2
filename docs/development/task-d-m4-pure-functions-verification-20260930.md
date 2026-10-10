# 任务 D:M4 P1 纯函数验证记录(2026-09-30)

- 分支:`claude/tasks-d-pure`,基于 `origin/main`。只在本 worktree 写代码,不合并,不推送。
- 设计:`docs/development/task-d-m4-pure-functions-design-20260930.md`。
- Node:20.20.2。
- 2026-10-09 注:本分支已作为 Draft PR #6186 推送;2026-10-09 的提交只改两份文档的措辞(条目 id、现行规则),不改代码与测试。

## 1. 范围

七个新模块(`task-lists.ts`/`task-groups.ts`/`task-reminders.ts`/`task-notifications.ts`/`task-settings.ts`/`task-pagination.ts`/`task-realtime.ts`)+ 对 `task-ids.ts`(R23 两个新前缀)、`task-dates.ts`(一条注释修正,不改行为)的小改动。`task-access.ts` 未改(见设计文档 §6)。

独立复核共四轮,发现的问题均已修复(均为同分支的后续 commit,非 amend),详见 §6:
1. 多处 `ASSUMPTION(task-d)` 标记只在散文里提了裁决编号,没有用可 `grep` 的字面 token,以及 `task-settings.ts` 里把 R07(`time_zone` 列)错标成了 R02③/R02④。
2. `task-notifications.ts` 里两个标了 `ASSUMPTION(task-d)` 的常量其实是死代码:`RECIPIENT_ROLE_PRIORITY` 声明了但从未被读取(真正的优先级是硬编码在四次 `consider(...)` 调用的书写顺序里),`TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN` 这个"开关"改成 `true` 也不会让 `assignee_added` 真的进入通知闭集。两处都已改成常量真正驱动行为(§6)。
3. 第三轮独立复核(13 个编号项;5 处 P1/P2、5 处 P3/NIT)的修复在 `279c82002e`:角色与 scope 的运行时闭集校验、R06 第三条跳过判据、`isInDailyDigest` 的时区判别用例、每日汇总 SQL 的全文 pin、`isTaskReminderDue` 只由 floor 拒绝的用例,以及分页参数只接受安全整数、全天提醒严格校验日历日期等项,详见 §6 第三条 commit。
4. 第四轮独立复核(多视角,每条三票反驳)6 项、0 P1,修复在 `1193f0c0d7`,详见 §6 末条。

## 2. 命令与结果

全部命令在 `packages/core-backend/` 下用 `./node_modules/.bin/...` 运行(不用 pnpm)。

### 2.1 新增/改动模块的单测

```
./node_modules/.bin/vitest run tests/unit/task-*.test.ts --reporter=dot
```

结果(第三轮修复后重跑):**22 个文件、684 个用例,全部通过**(第三轮独立复核新增 41 个用例:643 → 684;含七个新模块各自的测试文件,以及因 `task-ids.ts` 加前缀而更新的 `task-ids.test.ts`;`task-access.test.ts`/`task-dates.test.ts`/`task-completion.test.ts`/`task-membership.test.ts`/`task-tree.test.ts`/`task-comments.test.ts`/`task-deletion.test.ts`/`task-lock-keys.test.ts` 等任务 B/C 遗留测试原样通过,未受影响)。

### 2.2 门 20(`task-pure-no-io.test.ts`)

上面的 `task-*.test.ts` glob 已包含它;单独复核:

```
./node_modules/.bin/vitest run tests/unit/task-pure-no-io.test.ts --reporter=dot
```

结果:**5/5 通过**。**订正(独立复核 item 13):下面这段此前的措辞过强,现按 harness 源码(`tests/unit/task-pure-no-io.test.ts`)的实际行为重写。**

harness 用 `readdirSync` 自动发现 `src/tasks/*.ts`(现为 16 个文件 = 任务 B/C 遗留的 9 个 + 本次新增的 7 个),对每个导出的函数只调用**一次**,用一个由参数名正则猜出来的占位参数列表(参数名匹配 `/query|executor|client|db/i` 的位置传入桩查询函数,其余一律传入字符串 `'x'`)——它**不**按函数自身的分支/reason 逐一构造输入去覆盖每条路径。实测这类占位调用对本模块树里的函数,要么在函数体第一行解构/属性访问处就直接抛出 `TypeError`(例如 `applyRemoveMember`:`'x'` 解构出的 `members` 是 `undefined`,`undefined.find(...)` 直接抛;实测确认,`packages/core-backend` 下用 `tsx` 跑过)、要么落进第一条守卫就直接返回一个拒绝结果而不抛错(例如 `applyAddMember`:`'x'` 解构出的 `role` 是 `undefined`,`parseTaskListMemberRole(undefined)` 返回 `{ok:false, reason:'invalid_role'}`,函数据此直接 `return`,同样不抛)——两种情形都被 harness 自己的 try/catch 归类为"ok-or-other"。无论哪种,这次调用都没有跑到函数除了最前面这一两行之外的任何有意义分支,更谈不上"逐一调用一遍"覆盖了调用路径。

harness 真正给出的、站得住的保证只有两层:①`vi.mock('pg', …)`/`vi.mock('.../connection-pool', …)` 在任何 `src/tasks/*.ts` 文件被 import **之前**就已生效——只要这些文件(或它们传递 import 的任何东西)真的 `import` 了 `pg`/连接池,模块图本身就会先命中被 mock 的桩,不需要等到"调用某个分支"才发现;②对 `src/tasks/` 全体源文件跑 `grep -rn "from 'pg'|connection-pool|poolManager|pg\.query|db/pg"`,结果只有 `task-access.ts` 文档注释里的一句纯文字提及,零个真实 import。这两点合起来——本模块树没有任何文件导入过 db 访问入口,而 mock 又抢在 import 之前生效——才是"`src/tasks` 无 I/O"这个结论真正的依据;harness 的"逐个导出调用一次"只是这之上一层很弱的附加信号(证明**这一次**用占位输入调用,没有立刻命中桩),不是"证明新代码在调用路径上都没有 I/O"的充分条件。本文档不再复述后者这个过强表述。

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

**第一次**(`bad1a95a7e`,实现 commit,第一轮独立复核之前):**1239 个文件,1065 通过 / 1 失败 / 173 跳过;19623 个用例,17957 通过 / 1 失败 / 1665 跳过**。耗时约 219 秒。唯一失败:`tests/integration/field-validation-flow.test.ts > Field validation — form submit > enum validation rejects unlisted value`,报 `ECONNRESET`/`socket hang up`。与本次改动无关(该测试文件不在 `src/tasks/` 依赖图内)——单独重跑该文件 **15/15 全部通过**,坐实这是 `packages/core-backend/vitest.config.ts` 自己文档化的已知瞬时问题(supertest 每次请求起一个临时 `app.listen(0)`,高并发下偶发端口复用碰撞到另一个测试的 app 上;该文件的注释本身写明 CI 靠 `retry: 2` 吸收这类瞬时碰撞,本地默认不重试)。

第一/二轮 fixup(`e0966600b0`/`25df44d066`)只改了 `src/tasks/task-notifications.ts`/`task-settings.ts` 内部的常量接线与注释,不改对外签名/行为,且 `grep -rlE "task-(notifications|settings|lists|groups|reminders|pagination|realtime)" packages/core-backend/src | grep -v '/src/tasks/'` 零命中(没有任何 `src/tasks/` 之外的文件导入这七个新模块),所以当时判断没必要在这两轮 fixup 之后重新跑全量单测。

**第二次**(`279c82002e`,第三轮独立复核修复之后的干净提交树,改动确实触及导出函数的签名/行为,不再是纯内部改动,因此这次**必须**重新跑全量):

结果:**1239 个文件,1066 通过 / 0 失败 / 173 跳过;19664 个用例,17999 通过 / 0 失败 / 1665 跳过**。耗时约 289 秒。这次跑**零失败**——连第一次那条 `field-validation-flow.test.ts` 瞬时碰撞都没有复现,进一步印证那是环境性瞬时问题,不是确定性 bug(用例总数 19623→19664,`+41` 与 §2.1 的 643→684 一致,全部来自任务 D 本轮新增测试;文件数 1239 不变)。

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

**第三轮修复后(`279c82002e`)重跑同一条 eslint 命令**:结果同上,仍然只有那一条既有的 `task-ids.ts` `no-misleading-character-class`,零新增问题——本轮新增/改动的五个源文件(`task-lists.ts`/`task-groups.ts`/`task-reminders.ts`/`task-settings.ts`/`task-pagination.ts`)干净。

## 3. Mutation 抽查(28 处关键守卫;备份 → 改 → 跑 → 还原 → 比对,不用 `git checkout --`)

前 9 处(第一/二轮独立复核期间做的):每一条都用 `cp` 先备份到临时目录,`python3` 做定点字符串替换,跑对应测试文件确认变红,再用原文件 `cp` 覆盖回来并用 `cmp` 逐字节核对还原。

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

后 19 处(第三轮独立复核 13 项,`279c82002e` 引入的新守卫):不再逐条手跑,用一个脚本化驱动(未提交)——对每一条:`git diff | sha256` 记基线 → 备份 → 用 Python 字符串替换做定点 mutate → 用 `--reporter=verbose` 跑对应测试文件、既按退出码判红/绿、也把实际失败的用例标题抓下来当证据 → 用备份覆盖还原 → `filecmp.cmp` 逐字节核对还原 → 全部跑完后再取一次 `git diff | sha256` 跟基线比对。下面表格「结果」列里带引号的用例标题就是脚本抓到的真实失败标题,不是转述;19 处全部 PASS。最后一次重跑是在只有这两份 doc 文件有未提交改动的工作区上做的(`packages/` 当时与 `279c82002e` 逐字节一致——`git diff 279c82002e HEAD -- packages/` 零输出,`git diff` 命令本身也证实了这一点),两次哈希相同,都是 `2061953acb44e2c3201b2527efdbcba184b65ecd63fe44234fb0f5c63313ea59`(这是**那份 docs diff 的哈希,不是空 diff 的哈希**——空 diff 的哈希是 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`,`printf '' | shasum -a 256` 算出来的,跟上面那个不是一回事)。两次相同证明脚本自己跑完之后 `packages/` 目录(唯一会被脚本 mutate 的地方)和跑之前逐字节一致,不依赖人工记忆去核对 19 次还原。

| # | 模块 / 被改的守卫 | 改法 | 结果 |
|---|---|---|---|
| 10 | `task-lists.ts` `applyAddMember` 的 `role` 闭集守卫(item 1) | 删掉 `if (!parseTaskListMemberRole(role).ok) {…}` 整段 | 红,还原后逐字节一致 |
| 11 | `task-lists.ts` `applyChangeMemberRole` 的 `role` 闭集守卫(item 1) | 同上,删对应位置的守卫 | 红,还原后逐字节一致 |
| 12 | `task-lists.ts` `toTaskListMemberships` 的闭集外 throw(item 2) | 三分支判断退回成"非 read 一律 editor" | 红,还原后逐字节一致 |
| 13 | `task-groups.ts` `applyCreateGroup` 的 scope 断言(item 9) | 删掉 `assertValidTaskGroupScope(scope, 'applyCreateGroup')` | 红,还原后逐字节一致 |
| 14 | `task-groups.ts` `applyRenameGroup` 的 scope 断言(item 9) | 同上 | 红,还原后逐字节一致 |
| 15 | `task-groups.ts` `applyDeleteGroup` 的 scope 断言(item 9) | 同上 | 红,还原后逐字节一致 |
| 16 | `task-groups.ts` `applyMoveItem` 的 scope 断言(item 9) | 同上 | 红,还原后逐字节一致 |
| 17 | `task-groups.ts` `arraysEqual` 的长度检查(item 12) | 删掉 `if (a.length !== b.length) return false` | 红——`applyMoveItem > "same group, SAME-LENGTH-PREFIX but different length (next is previous + one more item) -> changed: true"`,还原后逐字节一致 |
| 18 | `task-reminders.ts` `isReminderSkippedByTaskState` 第三条判据(item 3) | 只留 status/deletedAt 判据,砍掉 remind_at 比对整段 | 红,还原后逐字节一致 |
| 19 | `task-reminders.ts` `isInDailyDigest` 全天分支(item 4) | `viewerToday(now, viewerTz)` 改成 `viewerToday(now, task.timeZone)` | 红,还原后逐字节一致 |
| 20 | `task-reminders.ts` `isInDailyDigest` 定时分支(item 4) | 两处 `viewerNextMidnight(…, viewerTz)` 改成 `task.timeZone` | 红——只有用例 (b)(`"scheduled: a dueAt that falls between UTC's and the recipient's day-after-tomorrow start"`)命中,还原后逐字节一致 |
| 21 | `task-reminders.ts` `buildTaskDailyDigestCondition` 的 `+2`/`+1` 偏移(item 5) | 改成 `+3`/`+2` | 红——`buildTaskDailyDigestCondition > "full-text SQL pin: the exact NOT EXISTS clause and the all-day (+1) / scheduled (+2) date offsets"`,还原后逐字节一致 |
| 22 | `task-reminders.ts` `isTaskReminderDue` 的 floor 接线(item 6) | `floor.getTime()` 改成字面量 `0` | 红,还原后逐字节一致 |
| 23 | `task-reminders.ts` `TASK_REMINDER_SCAN_WINDOW_MS`(item 7) | `2 * 60 * 60 * 1000` 改成 `3 * 60 * 60 * 1000` | 红——`"R06: TASK_REMINDER_SCAN_WINDOW_MS is pinned to 2 hours (ASSUMPTION(task-d): [R06])"` + `"absolute-time case: remindAt exactly 2h30m before now -> false"`,还原后逐字节一致 |
| 24 | `task-reminders.ts` `computeDefaultRemindAt` 的严格日期校验(item 10) | 删掉 `assertValidCalendarDateString(dueDate)` 这一行调用 | 红——`"...\"2026-3-8\", not zero-padded) THROWS RangeError"` + `"...\"2026-02-30\") THROWS RangeError, never silently rolls over"`,还原后逐字节一致 |
| 25 | `task-settings.ts` `parseSettingsPatch` 的 `badgeScope` 显式 null 守卫(item 8) | 删掉 `if (patch.badgeScope === null) return {…}` | 红,还原后逐字节一致 |
| 26 | `task-settings.ts` `parseSettingsPatch` 的 `defaultRemindPolicy` 显式 null 守卫(item 8) | 同上 | 红,还原后逐字节一致 |
| 27 | `task-pagination.ts` `toStrictNonNegativeInteger` 数字分支(item 11) | `Number.isSafeInteger` 退回 `Number.isInteger` | 红——`"offset as the NUMBER 1e300 is rejected -> invalid_offset (not silently accepted as an unsafe \"integer\")"`(`limit` 同款用例本来就会被上界单独挡住,不具判别力),还原后逐字节一致 |
| 28 | `task-pagination.ts` `toStrictNonNegativeInteger` 字符串分支正则(item 11) | `^(0\|[1-9]\d*)$` 退回 `^\d+$` | 红——`"a leading-zero digit string (\"007\") is rejected, not silently parsed as 7"` + `"\"00\" is rejected (not a canonical spelling of 0)"`,还原后逐字节一致 |

全部 28 处按预期变红,还原后逐字节比对(`cmp`/`filecmp.cmp`)与原文件相同,对应测试文件回到全绿;第 10–28 处的脚本运行还额外核对了"整个循环跑完,工作区 diff 跟循环开始前逐字节一致"这一条,不只是逐条各自还原。

## 4. 结论

- 全部 `tests/unit/task-*.test.ts`:684/684 通过(第三轮独立复核后)。
- 门 20:5/5 通过;新模块被自动发现,且 `src/tasks/` 全体源文件里没有任何一处真实 import `pg`/连接池(§2.2 已订正 harness 本身"逐个导出调用一次"这一步能证明什么、不能证明什么)。
- CI 实际跑的两条 `tsc` 命令(`tsc --noEmit` + `tsc -p scripts/tsconfig.recovery-archive-acceptance.json`):均零输出。额外核对的 8 个测试文件(CI 本身不覆盖测试文件的类型检查):也零输出。
- Lint:CI 的 `pnpm lint` 本就不覆盖 `packages/core-backend`(该包没有 `"lint"` 脚本,§2.5);额外用 eslint 直接核对本次新增/改动的源文件,零新增问题(1 条既有、与本次改动无关的错误,§2.5)。
- core-backend 全量单测:第一次(`bad1a95a7e`)17957/17958 有意义地通过(唯一失败是与本次改动无关的既有瞬时网络问题,单独重跑 15/15 通过);第三轮修复后在干净提交树 `279c82002e` 上重跑,**17999/17999 全部通过,零失败**。
- 28 处关键守卫 mutation 抽查(9 处第一/二轮 + 19 处第三轮脚本化)全部按预期变红,还原后文件逐字节一致;第三轮额外核对了整个脚本跑完后工作区 `git diff` 与跑之前逐字节一致。

## 5. 未验证 / 留给后续

- 没有 DDL、路由、服务或前端代码;真实数据库、staging、生产环境:NOT RUN(本切片范围之外)。
- owner 于 2026-10-07 裁定了 R、N 条目,取值与本切片实现的相同(R12 的收窄版见设计文档文首);本文档验证的是纯函数按这些取值实现且自洽;设计文档 §5 的 ASSUMPTION 表是改动裁决后要回来重新核对的清单。
- `isInDailyDigest`(TS)与 `buildTaskDailyDigestCondition`(SQL)的双形对拍(R01 要求):需要真实 Postgres,留给 PR-3a(见设计文档 §6)。

## 6. 独立复核 fixup(同分支后续 commit,非 amend)

第一轮提交(`bad1a95a7e`)之后的三轮独立复核分别发现并修复了以下问题,均已在后续 commit 里改正,改正后重新跑过 §2/§3 的全部命令:

- **commit `e0966600b0`**:多处 `ASSUMPTION(task-d)` 只在散文里点了裁决编号、没有用字面可 `grep` 的 `ASSUMPTION(task-d)` token(`task-groups.ts` 的 R11、`task-lists.ts` 的 R12(b)/(c)、`task-notifications.ts` 的 D13 若干处、`task-settings.ts` 的 D5/D7、`task-pagination.ts` 的 D9);`task-reminders.ts` 里一条 D6 标记因为括号内多了个逗号,写成了 `ASSUMPTION(task-d, gate default D6…` 而不是标准形状 `ASSUMPTION(task-d): [D6]`,同样不可 grep。全部改正为统一的 `ASSUMPTION(task-d): [R<nn>/D<nn>]` 形状。
- **commit `25df44d066`**:
  - `task-notifications.ts` 的 `RECIPIENT_ROLE_PRIORITY` 声明了但从未被 `resolveNotificationRecipients` 读取——真正的优先级是硬编码在四次 `consider(...)` 调用的书写顺序里;改后 owner 就算裁定不同优先级、把这个常量改一下,行为也不会跟着变。已改成显式 `for (const role of RECIPIENT_ROLE_PRIORITY)` 驱动,常量现在是唯一真相(mutation #9 证实)。
  - `TASK_NOTIFICATION_ASSIGNEE_ADDED_OPT_IN` 这个"开关"常量改成 `true` 不会让 `assignee_added` 真的进入 `TASK_NOTIFIABLE_EVENTS`(该数组是独立的字面量,不读这个布尔值)——是纯装饰性的死代码。已删除该常量与对应测试断言,`[R05-opt]` 标记直接移到 `TASK_NOTIFIABLE_EVENTS` 数组本身上,数组字面量就是唯一真相。
  - `task-settings.ts` 里 `timeZone` 字段与 `daily_reminder_requires_time_zone` 校验被错标成 R02③/R02④——这一列属于 R07,不属于 R02。改标为 `[R07]`,`[R02]` 只留给 `badgeScope`/`dailyReminderEnabled`/`defaultRemindPolicy` 三个字段。设计文档 §2.5/§5 与对应测试标题同步改正。
- **commit `279c82002e`**(第三轮独立复核,13 个编号项;下列编号即 item 编号):
  1. `task-lists.ts` `applyAddMember`/`applyChangeMemberRole`:`role` 参数只有编译期类型,没有运行时闭集校验——两处入口现在都先调用新导出的 `parseTaskListMemberRole(raw: unknown)`(同一函数,不是两套平行逻辑),`'owner'`/未知字符串/非字符串一律 422 `invalid_role`,且排在其它检查之前。
  2. `task-lists.ts` `toTaskListMemberships`:显式三分支映射,闭集外的 `role` 一律 `throw TypeError`(同 `canListAction` 的 fail-closed-by-throwing 风格)。
  3. `task-reminders.ts` `isReminderSkippedByTaskState`:R06 第三条跳过判据(与 R06 一致)——排队投递锁定的 `remind_at` 与任务当前 `remind_at` 不一致(含当前为 `null`)⇒ skipped。签名为 `(task, deliveryRemindAt)`。
  4. `isInDailyDigest`:新增三个真正能区分"用对 `viewerTz`"和"用错成 `task.timeZone`"的判别用例——第一版的 `task.timeZone` 用例对两种实现给出同一结果,不具判别力,已发现并重做。
  5. `buildTaskDailyDigestCondition`:新增全文 SQL pin(同 `task-access.test.ts` 的风格),取代此前只有 `toContain` 子串断言的覆盖。
  6. `isTaskReminderDue`:原"remindAt 在 floor 之前"用例其实是被 2 小时扫描窗口挡住的(相差约 12 小时,远超窗口),floor 守卫本身从未被单独触发过——已替换成真正只有 floor 守卫会拒绝的用例。
  7. `TASK_REMINDER_SCAN_WINDOW_MS` 新增字面量 pin 测试(`=== 2 * 60 * 60 * 1000`),外加一个 2 小时 30 分钟的绝对时间用例。
  8. `task-settings.ts` `parseSettingsPatch`:PATCH 体里显式 `badgeScope: null`/`defaultRemindPolicy: null` 现在 422,不再静默重置成默认值(`parseBadgeScope`/`parseRemindPolicy` 的"null 视为缺省"读法只对"读一行既有记录"成立,PATCH 语境的"别碰"写法只有键缺失)。
  9. `task-groups.ts`:四个 `apply*` 函数入口新增 `scope` 运行时闭集校验,闭集外 `throw TypeError`。
  10. `computeDefaultRemindAt`(全天分支):调用 `computeDateReminderOccurrence` 之前严格校验 `dueDate` 是规范的 `YYYY-MM-DD` 且是真实存在的日历日期;不存在的日期(如 `2026-02-30`)与非规范拼写(如 `2026-3-8`)都 `throw RangeError`。
  11. `task-pagination.ts`:数字分支与字符串分支都只接受安全整数(`Number.isSafeInteger`),`offset: 1e300` ⇒ `invalid_offset`;字符串分支只接受规范拼写 `^(0|[1-9]\d*)$`,`"007"`/`"00"` 这类带前导零的拼写被拒绝。
  12. `task-groups.ts` `arraysEqual`:新增能区分"删掉长度检查"这个 mutation 的用例(`previous` 是 `next` 的严格前缀、`next` 更长的方向)。
  13. 本文档 §2.2:订正了对门 20 harness 实际行为的过强描述(见上方 §2.2 的订正段落)。

以上 13 项之外:19 处新守卫(表格第 10–28 行)全部脚本化 mutation 抽查确认;`tests/unit/task-*.test.ts` 从 643 增至 684;两条 `tsc` 命令、eslint 复核均重新跑过并确认干净(§2.3/§2.5)。

- **第 4 轮独立复核(多视角,每条三票反驳)**:共 6 条,0 P1。处理如下:
  - `TASK_PAGE_SORT_KEY` 原值 `(updated_at DESC, id DESC)` 拼进 `ORDER BY` 会在 PostgreSQL 报语法错误(行构造器里不允许 DESC),列名也未限定表名。改为 `tasks.updated_at DESC, tasks.id DESC`,新增拼接测试;本地 PostgreSQL 15 实测可执行。
  - `isInDailyDigest` 的全天用例此前都把 `dueAt` 设为 `null`,测不出「按 `dueTime` 还是按 `dueAt` 分支」。新增用 `computeDueAt` 生成真实 `dueAt` 的全天用例(任务时区洛杉矶、查看者上海)。
  - `validateTaskGroupName` 新增星芒平面(emoji)边界用例,码点计数有测试守住。
  - `applyDeleteGroup`:组行的 `scope` 与参数 `scope` 不一致时抛 `TypeError`,新增测试。
  - R06 第三条跳过判据:与 R06 一致,删去原先的限定语。
  - 变异抽查 5 处(码点计数、scope 不一致、全天分支、排序键加括号、排序键去表名)全部变红,还原后工作区只剩本轮改动。
  - `tests/unit/task-*.test.ts`:689/689;`tsc --noEmit` 0 错误。
