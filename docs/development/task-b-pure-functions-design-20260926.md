# 任务功能线 — 任务 B(纯函数 + 单测)设计(PROPOSED,2026-09-26)

- 授权:owner 2026-09-26 原话「四题按建议值;同意拆分;起任务 B;用 B」(闸裁决书 §21;PR #5845 评论 5835498504)。本件只授权在独立分支 `claude/tasks-b-pure` 写**无 I/O 纯函数与单测**;不含 DDL、路由、服务、前端;不合并;不启用任何 flag。
- 设计来源:`docs/development/task-feature-design-lock-20260917.md` @ `grok/tasks-m0` head `ce180c8850`(正文 §0–§11、§13–§15 已按 owner 裁决为 ratified 输入;§12 门表仍 PROPOSED)。下面每条都标出锁/计划的出处;**标「假设」的条目锁未钉,实现按此假设,ratify/门审可改**。
- 基线:`origin/main` @ `f2d5331d60`。落点 `packages/core-backend/src/tasks/`(锁 §1 / 计划 :98:`src/tasks/` 只放无 I/O 纯函数),单测 `packages/core-backend/tests/unit/task-*.test.ts`(默认 vitest 收集,无 DB)。
- 允许的运行期依赖:`isValidIanaTimeZone`(`packages/core-backend/src/multitable/automation-timezone.ts:54`,纯函数;锁 §4.4 明文允许)。**禁止**:任何 `../db/` 相对导入、任何 `.query(` / 执行器形参、任何 `Date.now()` 以外的隐式时钟(所有时间函数显式接收 `now`)。

## 1. 模块清单

| 文件 | 导出 | 出处 |
|---|---|---|
| `src/tasks/task-lock-keys.ts` | `taskStructureLockKey(orgId)` → `task-structure:<orgId>`;`taskProjectionLockKey(listId, taskId)` → `task-projection:<listId>:<taskId>`;`tasksSchedulerLeaderLockKey()` → `tasks-scheduler:leader` | 锁 §6.4 `:436`(计划 v5 §5-5) |
| `src/tasks/task-ids.ts` | `TASK_ID_PREFIXES = {task:'tsk', list:'tlst', comment:'tcmt'}`;`generateTaskDomainId(kind, random)`(格式 `^(tsk\|tlst\|tcmt)_[A-Za-z0-9]+$`;`random` 由调用方注入,纯);`isValidTaskDomainId(s)`(= DDL CHECK 四合取 `^[!-~]+$ ∧ !~'__' ∧ !~'^_' ∧ !~'_$'`);`isValidPrintableAsciiId(s)`(`org_id`/`created_by` 只一合取);`parseTaskProjectionRecordId('rec_tsk_<listId>__<taskId>')`(先剥 `rec_tsk_` 前缀再取**首个** `__`;失败返回 `null`,不抛);`normalizeUserText(s)`(NFC、去 Unicode White_Space 与 U+200B/U+200C/U+200D/U+FEFF;返回归一串或 `null` 表示空) | 锁 §4.1/§4.2 `:92-93`、§7 `parseTaskProjectionRecordId`、门 10 |
| `src/tasks/task-dates.ts` | `computeDueAt({dueDate, dueTime, timeZone})`(定时 = `(dueDate, dueTime)` 在 `timeZone` 的瞬时;全天 = `dueDate` 当地 23:59:59.999 的瞬时;返回 `Date`);`viewerToday(now, viewerTz)`(`YYYY-MM-DD`);`viewerNextMidnight(now, viewerTz)`(`Date`);`isOverdue(task, now, viewerTz?)`(规则 1/3;`viewerTz` 缺省为任务时区);`isOverdueOrToday(task, now, viewerTz)`(规则 2/3);`validateViewerTimeZoneHeader(headerValue)`(只接受规范的命名时区,否则 `null`)与 `resolveViewerTimeZone(headerValue, taskTimeZone)`(非法或缺失回退任务 `time_zone`) | 锁 §4.4(计划 v5 §2.6);门 8 A 支数值 |
| `src/tasks/task-access.ts` | `TASK_ROLES`、`TASK_ABILITIES`(闭集);`TASK_ROLE_ABILITY`(布尔矩阵);`resolveTaskRoles(row, me)`(输入行级快照 `{createdBy, assigneeIds, followerIds}` + `me`;清单角色 P1,本期只从 `listMemberships` 可选参数读,默认空);`can(roles, ability)`(并集);`taskMatchesView(row, me, view)`(五视角表);`buildTaskScopeCondition({view, actorParam, orgParam})` → `{ sql, params[] }`(只产文本;org 子句**单点发射**;五臂 SQL 形照锁 §6.1);`buildTaskPendingCondition({actorParam, orgParam, scope, viewerTzParam?})` = `buildTaskScopeCondition({view:'assigned'})` 派生 + `status='open'` + 本人 assignee 行 `completed_at IS NULL` + scope 子句(`all_open` / `overdue` / `overdue_or_today`) | 锁 §6.1 `:241-253`、§13-4、§13-5(已裁 (a) 共用 WHERE 文本生成器) |
| `src/tasks/task-completion.ts` | `computeTaskDone({mode, assigneeRows})`(`all`:至少一行且全部 `completedAt` 非空;`any`:任一行非空;零行恒 false);`applyComplete({mode, rows, actorId, createdBy, now})` → 新行集 + `done` + `events[]`(any:其余人置**同一时刻**并记 `completed_by_any`;all:只置本人,`self_completed`;零负责人仅 creator 可 complete ⇒ `done` 且不经公式);`applyReopen({mode, rows, actorId, scope, createdBy})`(any 重启 = 全部;all 支持 `scope=self\|all`);`assertAnyModeInvariant(status, mode, rows)`(`open ∧ any ⇒ 无非空 completedAt`,违反返回 false) | 锁 §6.2、§13-9(已裁按建议)、§4.2 公式 |

## 2. 关键契约细节

### 2.1 真相表 `TASK_ROLE_ABILITY`(行 = 角色,列 = 能力;true = 允许)

| 角色 \ 能力 | view | edit | complete | reopen | comment | attach | delete | leave | 出处 |
|---|---|---|---|---|---|---|---|---|---|
| creator | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | 计划 :157「creator 全权」;**假设**:creator 不「退出」(退出是 follower 动作) |
| assignee | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 计划 :157 |
| follower | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✓ | 锁 §13-23 建议(未裁,取「只读+评论+退出」) |
| list-editor | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ | ✗ | 计划 :157「等同 assignee 但不可删」(P1,本期只建表值) |
| list-reader | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ | ✗ | ✗ | 计划 :157 |
| none | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | 计划 :157「none ⇒ 404」 |

叠加取并集(锁 §6.1)。`can(roles,'view')` 只回答单对象读;列表收行只由 `taskMatchesView` / SQL 臂决定(锁 `:243-244`)。

### 2.2 `taskMatchesView` 与 SQL 臂(逐行同构,锁 §6.1)

| view | TS 谓词 | SQL 臂(`:me` = actorParam) |
|---|---|---|
| assigned | `meInAssignees` | `EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id = :me)` |
| following | `meInFollowers` | `EXISTS (SELECT 1 FROM task_followers tf WHERE tf.task_id = tasks.id AND tf.user_id = :me)` |
| created | `createdByMe` | `tasks.created_by = :me` |
| delegated | `createdByMe ∧ othersAssigned` | `tasks.created_by = :me AND EXISTS (SELECT 1 FROM task_assignees ta WHERE ta.task_id = tasks.id AND ta.user_id <> :me)` |
| any_role | 上四者 OR | 四臂 OR |

`buildTaskScopeCondition` 输出形:`(tasks.org_id = :org) AND tasks.deleted_at IS NULL AND (<臂>)`;org 子句只在此处出现一次(锁 §4.3「单点发射」)。`buildTaskPendingCondition` 不自行写角色臂(锁 `:243`),只包裹 assigned 臂。**实现后修订(2026-09-26)**:`actorParam`/`orgParam` 是绑定**值**(`string`),固定占 `$1`/`$2`;pending 另占 `$3`(查看者时区,`COALESCE($3, tasks.time_zone)`)。嵌入更大查询的调用方把这三个值放在 params 最前,自己的参数从 `$4` 起编号。原文:参数占位用 `$n` 序号数组形(照 `ApprovalBridgeService.ts:215-229` 的 `{ sql, params }` 形状;计划 :113)。

### 2.3 日期(锁 §4.4)

- 三规则原文:定时 overdue = `due_at < now`;定时 overdue_or_today = `due_at < viewerNextMidnight`;全天 overdue = `due_date < viewerToday`,overdue_or_today = `due_date <= viewerToday`。
- 门 8 A 支数值必须在单测里逐字复现:`now=2026-09-15T12:30Z`、`time_zone='Asia/Shanghai'`、`due_at=2026-09-15T18:00:00Z`;`viewerNextMidnight(Asia/Shanghai)=2026-09-15T16:00Z`、`viewerNextMidnight(UTC)=2026-09-16T00:00Z`;六格边界(规则 1 `12:29:59Z` 真 / `12:30:00Z` 假;规则 2 `15:59:59Z` 真 / `16:00:00Z` 假;规则 3 `2026-09-14` 真、`2026-09-15` overdue 假但 overdue_or_today 真、`2026-09-16` 皆假);正控甲/乙(`Not/AZone` 与缺失 ⇒ 回退任务 tz)。
- 全天 `due_at` = 当地 23:59:59.999(锁 §4.4);跨时区格(门 5):同一全天任务,查看者 tz 为 `Pacific/Kiritimati`(+14)与 `Pacific/Pago_Pago`(−11)时 `computeDueAt` 输出逐字节相同(不随查看者换算)。
- 实现不得用 `moment`/`luxon`;用 `Intl.DateTimeFormat` 求当地偏移(与 `automation-timezone.ts` 同一手法),不引入新依赖。

### 2.4 完成判定(锁 §6.2、§13-9 已裁)

- `all`:`EXISTS(assignee) AND NOT EXISTS(uncompleted)`;零行 ⇒ false(锁 §4.2 公式)。
- `any`:任一 `completedAt` 非空 ⇒ done;`any×0` ⇒ 不判 done。
- 零负责人:仅 creator 可 complete/reopen;creator complete ⇒ `done`(handler 语义,不经公式;本模块用 `applyComplete` 返回 `{ done: true, via: 'creator-direct' }` 表达)。
- any 模式 complete:其余人 `completedAt` 置**同一时刻**(`now` 参数),事件 `completed_by_any`;all 模式:只置本人,任务仍 open 时事件 `self_completed`;全部完成 ⇒ `completed`。
- any 重启 = 全部清零(`reopened`);all 重启 `scope=self` 只清本人(`self_reopened`),`scope=all` 全清(`reopened`)。
- 不变量 `status='open' AND mode='any' ⇒ 无非空 completedAt`:`assertAnyModeInvariant` 供门 3 存活格每次 complete/reopen 后断言。
- 增删人/切模式(计划 §5-4):本期不实现,也不导出任何切模式函数(属 M2 路由面)。

## 3. 假设清单(实现按此,标注在代码注释 `// ASSUMPTION(task-b):`)

1. creator `leave=false`、assignee `leave=false`(退出只属 follower)。
2. `resolveTaskRoles` 的清单角色本期恒空(P1 表未建),签名保留 `listMemberships?: Array<{listId, role:'editor'|'reader'}>`。
3. `buildTaskPendingCondition` 的 `scope` 闭集 `all_open | overdue | overdue_or_today`(§13-4);`badge_scope='off'` 不进 SQL(由调用方短路)。
4. 参数占位形 `$n`;调用方负责把 `params` 接到 `pg.query`。
5. `generateTaskDomainId` 的随机源由调用方注入(`(bytes:number)=>string`),模块本身不依赖 `crypto`(保持纯、可测)。

## 4. 非目标

DDL、迁移、路由、服务、前端、`TASKS_*` flag、`remind_at` 缺省(P1)、树不变量(P0-B,§6.3)、任何真库测试、任何对 Grok 分支的改动。

## 5. 测试计划(全部无 DB;`pnpm --filter @metasheet/core-backend exec vitest run tests/unit/task-`)

| 文件 | 覆盖 | 必配的 mutation 探针(用 `vi.mock`/副本注入,不改源) |
|---|---|---|
| `tests/unit/task-lock-keys.test.ts` | 三键字面、参数拼接、空/非法输入抛 | 改前缀 ⇒ 红 |
| `tests/unit/task-ids.test.ts` | 生成格式、四合取 CHECK 正反例(前导 `_`、尾随 `_`、`__`、非 ASCII、空)、`rec_tsk_<list>__<task>` 解析(listId 含单 `_`、taskId 含 `__` 的边界)、`normalizeUserText`(「备料复核」过;`'\t'`、`'  \n '`、`'　'`、零宽 ⇒ null;NFC 合成) | 去掉一个合取 ⇒ 对应反例翻绿 ⇒ 红 |
| `tests/unit/task-dates.test.ts` | 门 8 A 支六格 + 正控甲/乙 + fallback 改 `'UTC'` 负控(用副本函数);门 5 跨时区字节不变;`computeDueAt` 全天/定时;DST 边界(`America/New_York` 2026-03-08、2026-11-01) | fallback 改 UTC ⇒ 两格红 |
| `tests/unit/task-access.test.ts` | 真相表 6×8 逐格 = §2.1;`can` 并集;`taskMatchesView` 8 子集 × 5 视角 + 覆盖格(`noa`/`oa`/`of` 共 9 格,与锁 i-m2 同名 `gate19\|<s>\|<v>[\|tag]`)= 锁 §6.1 钉死表;`buildTaskScopeCondition` 五臂 SQL 文本快照 + org 子句恰出现一次 + `buildTaskPendingCondition` 含 assigned 臂且不含其它角色臂 | 置反 `[assignee][complete]` ⇒ `can` 格红;删 SQL `created_by=:me` 合取 ⇒ 文本快照红 |
| `tests/unit/task-completion.test.ts` | 门 3 六格(`all×0/any×0/all×1/any×1/all×n/any×n`)、any 置同一时刻、all 部分完成 `self_completed` 且 open、重启 scope、不变量断言、零负责人非 creator 拒绝 | 删「零行 ⇒ false」⇒ `all×0` 红 |

验收:全部单测绿;`tsc --noEmit` 对 `packages/core-backend` 无新增错误;`grep -R -E "from[[:space:]]+['\"](\.\./)+db/|\.query\(" packages/core-backend/src/tasks` 零命中;每个探针在报告里贴「改前绿 / 改后红」的实跑输出。

## 6. 与门表的关系

本件对应锁 §12 门 8(日期六格)、门 10 标题子集(归一函数)、门 19 网格的 TS 侧(`taskMatchesView` 与钉死表)、门 20(无 I/O,静态两 ERE)、门 3 六格的纯函数部分。门 19 的 SQL 侧行集对拍、门 20 行为门、门 3 路由面都要等 M2 真库,本件不声称通过任何门。
