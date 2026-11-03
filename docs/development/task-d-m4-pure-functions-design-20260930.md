# 任务功能线 — 任务 D(M4 P1 纯函数 + 单测)设计(2026-09-30)

- 分支:`claude/tasks-d-pure`,基于 `origin/main`。只在本 worktree 写**无 I/O 纯函数与单测**;不含 DDL、路由、服务、前端;不合并;不启用任何 flag。
- 边界:任务 D 只写纯函数,先例为任务 B(`docs/development/task-b-pure-functions-design-20260926.md`)与任务 C(`docs/development/task-c-m3-pure-functions-design-20260928.md`),同样只做 `packages/core-backend/src/tasks/` 下的无 I/O 模块与单测。
- 设计来源:M4 条目 R01–R23、N1/N2 与 D1–D14 中归任务 D 的模块(本文只按条目 id 引用);任务功能线设计锁 `docs/development/task-feature-design-lock-20260917.md` §4、§4.4、§6、§13。
- **裁决状态**:owner 于 2026-10-07 裁定 R01–R23、N1、N2,取值与本设计实现的相同;R12 按收窄版裁定:把任务加入清单,除清单一端的 `edit`/`owner` 外,任务一端只认直接角色(创建人或负责人),任务创建人可以不经清单成员身份把自己的任务移出任一包含它的清单。本切片只实现清单一端的判定(`canListAction` 的取值不变),任务一端的直接角色判定与创建人移出由接线 PR 组合。D1–D14 是缺省实现约束。每一处依赖条目取值的地方,源码里都有一条 `// ASSUMPTION(task-d): R<nn> …` 或 `[D<nn>]` 注释,命名对应的条目 —— 改裁决时,`grep -rn 'ASSUMPTION(task-d)' src/tasks/` 就能找到全部要改的点。

## 1. 范围

七个新模块 + 两处对既有模块的小改动,全部无 I/O,由门 20 的 harness(`tests/unit/task-pure-no-io.test.ts`)自动发现并校验:

| 模块 | 状态 |
|---|---|
| `src/tasks/task-lists.ts` | 新增 |
| `src/tasks/task-groups.ts` | 新增 |
| `src/tasks/task-reminders.ts` | 新增 |
| `src/tasks/task-notifications.ts` | 新增 |
| `src/tasks/task-settings.ts` | 新增 |
| `src/tasks/task-pagination.ts` | 新增 |
| `src/tasks/task-realtime.ts` | 新增 |
| `src/tasks/task-ids.ts` | 改:`TASK_ID_PREFIXES` 加 `group: 'tgrp'`、`listEvent: 'tlev'`(R23) |
| `src/tasks/task-dates.ts` | 改:修正一条注释(见 §5「D11 注释修正」),不改行为 |
| `src/tasks/task-access.ts` | **未改**(见 §6「明确推迟」) |

不做:DDL、迁移、路由、服务、前端、flag、真实数据库/staging/生产验证 —— 与任务 B/C 同一条边界。

## 2. 各模块规则

### 2.1 `task-lists.ts`

清单角色闭集 `read | edit | owner`(`TASK_LIST_MEMBER_ROLES`)。`toTaskListMemberships` 把这套角色桥接到 `task-access.ts` 已经存在的 `TaskListMembership`(`read→'reader'`,`edit`/`owner`→`'editor'`)——这是清单侧角色表与任务级角色表之间**唯一**的桥接函数,不再另开第三套角色枚举。映射是显式三分支,没有默认分支:闭集之外的 `role` 一律 `throw TypeError`,不丢弃该行(同 `canListAction` 的 fail-closed-by-throwing 风格;独立复核 item 2)。

`applyAddMember`/`applyChangeMemberRole` 在入口对 `role` 做运行时闭集校验(两处共用 `parseTaskListMemberRole`,不是两套平行逻辑;独立复核 item 1):`'owner'`(闭集内但不可指派)和任何非法字符串/非字符串一律 422 `invalid_role`,且这个校验排在所有其它检查**之前**(结构性输入校验优先于业务状态判断)。`parseTaskListMemberRole(raw: unknown)` 另行导出,供路由边界使用。

`canListAction(ctx, action)` 是一张 `角色 × 动作` 真相表(闭集 9 个动作:`view/rename/archive/unarchive/manage_members/transfer_owner/add_item/remove_item/manage_groups`),`archive`/`unarchive` 额外接受 `ctx.isCreator` 覆盖(锁 §13-14,已定:归档权 = `created_by ∪ edit/owner`)。

成员/所有权转换函数:`applyAddMember`(R17 在职校验以调用方已算好的布尔量 `isActiveInOrg` 传入;越界 D14 软上限)、`applyRemoveMember`(R12(b):`created_by` 永不可移除;R12(c):当前 `owner` 不可直接移除,须先转让)、`applyChangeMemberRole`(同样挡住 `owner`)、`applyTransferOwner`(R12(d):目标必须已是成员,原 owner 降为 `edit`)。`applyArchive`/`applyUnarchive` 只算状态转换,不复核权限(权限已由 `canListAction` 单独判定,同 `task-tree.ts` 的 `canReparent` 与 `validateSetParent` 分离先例)。

`validateTaskListName` 复用 `task-ids.ts` 的 `normalizeUserText`,按 Unicode 码点(不是 UTF-16 单元)判 100 上限(D14)。

`planAddTaskToList`/`planRemoveTaskFromList` 实现 D2 的两事件规则:同一次加入/移出清单在同一事务里写 `task_events.list_added/list_removed` **与** `task_list_events.item_added/item_removed`——本函数只规划这两个事件对象,写入由调用方在同一事务内完成。无变化(已在清单里 / 不在清单里)不产生任何事件。

### 2.2 `task-groups.ts`

`scope` 闭集 `list | user`(R11)。`applyCreateGroup`/`applyRenameGroup`/`applyDeleteGroup`(被删分组里的项归入默认组;默认组不能删)/`applyMoveItem`(整数重排,同一事务内全量重算目标组的 position)。四个 `apply*` 函数入口都先跑 `assertValidTaskGroupScope`:闭集外 `throw TypeError`,不按任一 scope 兜底(独立复核 item 9);`applyDeleteGroup` 另要求组行的 `scope` 与参数 `scope` 一致,否则同样 `throw TypeError`。

`arraysEqual`(`applyMoveItem` 的同组同序判定)先比长度、再逐项比较;`previous` 是 `next` 严格前缀(`next` 更长)的情形有单测(独立复核 item 12)。

D2 规定个人 scope 里换组不产生事件，本模块把这一点推广到**全部** `task_list_events`(`group_created`/`group_renamed`/`group_deleted`):这三个事件都需要 `listId`,而 `user` scope 的个人分组没有所属清单,所以这个推广是形状上唯一说得通的读法,已在源码注释里标出。

### 2.3 `task-reminders.ts`

`parseRemindPolicy` 实现 R02③ 的闭集 `{"mode":"default"}` / `{"mode":"none"}`,缺行/缺值按 default 处理,其余一律 422。

`computeDefaultRemindAt` 是锁 §4.4(**已定**算法)的实现:定时分支纯瞬时算术 `due_at − 30min`;全天分支**先**用 `assertValidCalendarDateString` 校验 `dueDate` 是规范拼写的 `YYYY-MM-DD` 且是真实存在的日历日期(独立复核 item 10)、**再** `isValidIanaTimeZone` 校验、**再**调用 `computeDateReminderOccurrence(dueDate, {timeOfDay:'18:00', offsetDays:0, timezone}, {floating:true})`(`automation-date-reminder.ts:241`,锁 `:140`/`:253` 指名复用);任一校验失败都直接抛错,不存在的日期(如 `2026-02-30`)与非规范拼写(如 `2026-3-8`)都在这一步被拒绝。`assertValidCalendarDateString` 与 `task-dates.ts` 私有的 `parseIsoDate` 逻辑一致,但没有跨模块导入它(沿用本模块树"小共享 helper 就地保留"的既有写法,同 `task-lists.ts`/`task-groups.ts` 的名称校验函数)。

`shouldEnqueueReminder`(写入时门槛,R06)与 `isTaskReminderDue`(扫描期门槛,R06:直接调用 `isDateReminderDue`,窗口常量 `TASK_REMINDER_SCAN_WINDOW_MS = 2` 小时,已在单测里字面量钉死)是两个独立的时间门槛,分别对应写入时刻与 tick 扫描时刻。`isReminderSkippedByTaskState(task, deliveryRemindAt)` 是到点时的任务状态短路,有三条跳过判据(R06;第三条见独立复核 item 3):①已完成;②已软删;③**这条投递排队时锁定的 `remind_at` 值,与任务当前的 `remind_at` 不一致(含任务当前 `remind_at` 为 `null` 的情况)**。

四族 `source_key` 构造器(`buildTaskReminderSourceKey`/`buildTaskDailyDigestSourceKey`/`buildTaskEventSourceKey`/`buildTaskListEventSourceKey`)沿用仓库里唯一的现成先例(`UnscheduledReminderService.ts` 的 `<prefix>:<id>:recipient:<uid>:channel:<ch>` 形)。

`isInDailyDigest`(TS)与 `buildTaskDailyDigestCondition`(SQL,由 `buildTaskScopeCondition({view:'assigned'})` 派生,不自建角色臂)实现 R07 的每日汇总内容:本人已逾期的任务，加上今天与明天到期、尚未完成的任务;今天、明天按查看者(收件人)时区 `viewerTz` 计算,不读 `task.timeZone`。`buildTaskDailyDigestCondition` 的 SQL 有一条全文字面量 pin 测试(同 `task-access.test.ts` 给 `buildTaskPendingCondition` 做的那种),把全天分支的 `+1` 与定时分支的 `+2` 日期偏移、以及完整的 `NOT EXISTS (... completed_at IS NOT NULL)` 子句钉成一个精确字符串(独立复核 item 5)。`isInDailyDigest` 有三个时区判别用例:全天分支在 UTC 与上海结果相反的同一实例、定时分支 `dueAt` 落在 UTC 与上海两地后天零点之间的用例、`task.timeZone` 与 `viewerTz` 不一致时只有 `viewerTz` 决定结果的用例;把 `viewerToday(now, viewerTz)`/`viewerNextMidnight(now, viewerTz)` 改成读 `task.timeZone` 的源码级 mutation,都有其中至少一个用例变红(独立复核 item 4)。

### 2.4 `task-notifications.ts`

D13 的触发闭集(`completed`/`completed_by_any`/`reopened`/`deleted`/`commented`;`attachment_added` 留 P2)与 `recipient_role` 闭集(`creator`/`assignee`/`follower`/`list_member`)。`resolveNotificationRecipients` 按 `RECIPIENT_ROLE_PRIORITY` **驱动**(不是与该常量并行的一段硬编码调用顺序——改这个常量就会改变行为)去重并排除 actor。`resolveReminderRecipients`/`reminderRecipientRole` 实现 R06 的提醒收件人规则。`resolveListArchiveNotificationRecipients` 实现 R05(e) 的清单归档通知(通知清单创建人,`recipientRole` 仍记 `'list_member'`)。R05-opt(`assignee_added` 默认不在通知闭集里)直接标在 `TASK_NOTIFIABLE_EVENTS` 这个字面量数组上——没有另设一个「开关」常量:闭合的 TS 联合类型没有干净的「布尔位拓宽」写法,数组字面量本身就是唯一真相。

### 2.5 `task-settings.ts`

`parseBadgeScope`/`pendingScopeForBadge` 实现锁 §13-4(已定方向)+ D5(`'off'` 时调用方短路,不查库)。`parseSettingsPatch` 是整行 `task_user_settings` 的合并校验器。**`timeZone` 是独立于 `badgeScope`/`dailyReminderEnabled`/`defaultRemindPolicy` 的另一条裁决**:它属于 R07 而不是 R02(这一列是为每日汇总而设的)——对合并后的结果强制的是 **R07** 的 CHECK(`daily_reminder_enabled=false OR time_zone IS NOT NULL`),不是 R02 的。`timeZone` 的写入复用 `task-dates.ts` 的 `validateViewerTimeZoneHeader` 做规范化(D7:存进库的时区一律是规范名)。

`parseBadgeScope`/`parseRemindPolicy` 把 `null` 值按缺省处理(R02③ 的推广,见 §5),只用于**读一行既有记录**:列为 `NULL` 即从未设置,取默认值。PATCH 里不改某个字段只用**键缺失**(`undefined`)表达:`parseSettingsPatch` 在调用 `parseBadgeScope`/`parseRemindPolicy` **之前**把显式的 `badgeScope: null`/`defaultRemindPolicy: null` 判为 422(`invalid_badge_scope`/`invalid_policy`),不重置成默认值(独立复核 item 8)。`timeZone: null` 的 PATCH 语义是清空时区,不受这条约束。

### 2.6 `task-pagination.ts`

R15:默认 `limit` 是 100 而不是 50 —— 缺省 50 会让从不传 `limit` 的调用方少看到第 51–100 行。`limit` 1..100、`offset ≥ 0`,越界一律 422,不静默夹取。`TASK_PAGE_SORT_KEY`(D9)是 `tasks.updated_at DESC, tasks.id DESC` 稳定排序键常量(可直接拼进 `ORDER BY`;不加括号——行构造器里不允许 DESC——且带表名限定,避免连表时列名歧义)。

`limit`/`offset` 只接受安全整数:数字分支与字符串分支都用 `Number.isSafeInteger` 判定(数字 `1e300` 被拒绝),字符串分支另要求规范十进制拼写 `^(0|[1-9]\d*)$`:`"0"` 接受,`"007"`/`"00"` 这类带前导零的拼写被拒绝(独立复核 item 11)。

### 2.7 `task-realtime.ts`

`countsUpdateRecipients`(R16)= 写入前后负责人集合的并集(排序去重)。

## 3. 对既有模块的改动

- **`task-ids.ts`**:`TASK_ID_PREFIXES` 加 `group: 'tgrp'`、`listEvent: 'tlev'`(R23),连带更新了它们的格式文档注释与生成/校验单测(`tests/unit/task-ids.test.ts`)。
- **`task-dates.ts`**:仅改了 `validateViewerTimeZoneHeader` 上方一条注释——它原先说 `isValidIanaTimeZone` 是这整棵模块树里仅有的外部导入,而本次新增的 `task-reminders.ts`(同一棵 `src/tasks/` 树下)按锁 `:140` 额外导入了 `computeDateReminderOccurrence`。改成了逐文件表述(D11)。不改行为,不改测试断言。

## 4. 复用 main 上的既有函数(不重复实现)

- `task-access.ts`:`buildTaskScopeCondition`(`task-reminders.ts` 的每日汇总条件由它派生)、`TaskListMembership` 类型(`task-lists.ts` 的桥接目标)、`TaskPendingScope` 类型。
- `task-dates.ts`:`isOverdue`/`viewerToday`/`viewerNextMidnight`(`task-reminders.ts` 的每日汇总判定)、`validateViewerTimeZoneHeader`(`task-settings.ts` 的时区写入规范化)。
- `task-ids.ts`:`normalizeUserText`(清单名、分组名校验)。
- `../multitable/automation-date-reminder.ts`:`computeDateReminderOccurrence`、`isDateReminderDue`(锁 `:140` 指名复用,不重新实现)。
- `../multitable/automation-timezone.ts`:`isValidIanaTimeZone`(全天提醒分支调用前的强制校验)。

## 5. ASSUMPTION(task-d) 一览

每条对应源码里一处或多处 `// ASSUMPTION(task-d): [R<nn>/D<nn>] …` 注释。下表的「值」与 owner 2026-10-07 裁定的取值相同(R12 的收窄版见文首;本表的 R12 各行是清单一端的判定);D 条目是缺省实现约束。

下表「裁决」列写 `— (own choice, …)` 的行是**本模块自己的实现选择,不是裁决条目的取值**,共 7 行。第三轮独立复核加的 6 行(`独立复核 item 1/2/8/9/10/11`)对应的源码注释用 `ASSUMPTION(task-d, own choice …` 这个逗号形前缀(`grep -n 'ASSUMPTION(task-d, own' packages/core-backend/src/tasks/*.ts` 能找到全部 7 处这种注释——`item 1` 那一行覆盖 `applyAddMember`/`applyChangeMemberRole` 两处站点,所以 7 处注释对应这 6 行表格,不是 1:1)。**第一轮**那一行(`canListAction` 的 `rename`/`manage_members`/`manage_groups`)不属于这 7 处——它当初标的是 `ASSUMPTION(task-d): [R12(a)]`(冒号形,跟着 R12(a) 一起写),own-choice 的说明是紧接着那条注释之后、以大写 `OWN CHOICE` 出现在散文里的(`task-lists.ts:111`),用 `grep -n 'OWN CHOICE' packages/core-backend/src/tasks/task-lists.ts` 能单独找到它。

| 裁决 | 模块 / 函数 | 选的值 | 备注 |
|---|---|---|---|
| R23 | `task-ids.ts` `TASK_ID_PREFIXES` | `group:'tgrp'`, `listEvent:'tlev'` | 沿用 `tev` 先例的加词手法 |
| R12(a) | `task-lists.ts` `canListAction` | `add_item`/`remove_item` 需要清单 `edit`/`owner` | R12(a) 直接规定 |
| — (own choice, 非 R 编号) | `task-lists.ts` `canListAction` | `rename`/`manage_members`/`manage_groups` 与 `add_item` 同档(edit 即可) | R12 没有点名这三个动作;沿用 `list-editor` 在 `task-access.ts` 里「edit ⇒ 广泛可写」的同形状,可逆 |
| R17 | `task-lists.ts` `applyAddMember` | `isActiveInOrg` 为调用方已算好的布尔量 | 真正的 `user_orgs` 查询是 I/O,留给调用方 |
| R12(b) | `task-lists.ts` `applyRemoveMember` | `created_by` 永不可移除 | 422 `created_by_immutable` |
| R12(c) | `task-lists.ts` `applyRemoveMember`/`applyChangeMemberRole` | 当前 `owner` 不可直接移除/改角色 | 422 `owner_must_transfer` |
| R12(d) | `task-lists.ts` `applyTransferOwner` | 目标必须已是成员;原 owner 降为 `edit`(不是 `read`) | 「目标必须已是成员」是本模块对 R12(d) 的保守读法 |
| D14 | `task-lists.ts` | 清单成员 ≤100,单任务所属清单 ≤10,清单名 ≤100 码点 | 软限额,可逆常量 |
| — (own choice, 独立复核 item 1) | `task-lists.ts` `applyAddMember`/`applyChangeMemberRole`/新导出 `parseTaskListMemberRole` | `role` 参数运行时闭集校验(`'owner'`/未知字符串/非字符串 ⇒ 422 `invalid_role`),排在所有其它检查之前 | `role` 的编译期类型不是运行时保证;三处共用同一 `parseTaskListMemberRole`,不是三套平行逻辑 |
| — (own choice, 独立复核 item 2) | `task-lists.ts` `toTaskListMemberships` | 闭集外的 `role` 值 `throw TypeError`,不丢弃该行、也不默认成 `'editor'` | 同 `canListAction` 的 fail-closed-by-throwing 风格;可逆为丢弃该行 |
| R11 | `task-groups.ts` | `scope='list'\|'user'`,被删分组里的项归入默认组,默认组不能删 | |
| D14 | `task-groups.ts` | 每 scope 分组 ≤50,分组名 ≤100 码点 | |
| D2(推广) | `task-groups.ts` | `group_created`/`group_renamed`/`group_deleted` 只在 `scope==='list'` 时产生 | D2 只说分组之间的移动;本模块把同一条理由(个人分组没有 `listId`)推广到创建/改名/删除 |
| — (own choice, 独立复核 item 9) | `task-groups.ts` 四个 `apply*` 函数 | `scope` 运行时闭集校验,闭集外 `throw TypeError` | 同上,`scope` 的编译期类型不是运行时保证 |
| R02③(推广) | `task-reminders.ts` `parseRemindPolicy` | `null`/`undefined` **值**(不只是缺行)按 default 处理 —— **仅限"读一行既有记录"语境**;`task-settings.ts` `parseSettingsPatch` 的 PATCH 语境里显式 `null` 不会到达这个函数,而是在更上层直接 422(见下一条) | R02③ 只说缺行;本模块推广到缺值,只在读语境下 |
| — (own choice, 独立复核 item 8) | `task-settings.ts` `parseSettingsPatch` | PATCH 体里显式 `badgeScope: null`/`defaultRemindPolicy: null` ⇒ 422(不是"重置成默认") | PATCH 唯一的"别碰"写法是键缺失(`undefined`);不影响 `timeZone: null`(那个有独立定义的"清空"语义) |
| — (own choice, 独立复核 item 10) | `task-reminders.ts` `computeDefaultRemindAt`(全天分支) | 调用 `computeDateReminderOccurrence` **之前**先严格校验 `dueDate` 是真实存在的 `YYYY-MM-DD` 日期,失败 `throw RangeError` | 不存在的日期(如 `2026-02-30`)与非规范拼写(如 `2026-3-8`)都抛错;镜像 `task-dates.ts` 私有 `parseIsoDate` 的逻辑,不跨模块导入 |
| R06 | `task-reminders.ts` | 扫描窗口 `W=2` 小时(`TASK_REMINDER_SCAN_WINDOW_MS`),单测已字面量钉死 | 单点常量,要求 ≥ 调度间隔(由 PR-3b 保证) |
| R06 | `task-reminders.ts` `isReminderSkippedByTaskState` | 已完成、已软删,或排队时的 `remind_at` 与任务当前 `remind_at` 不一致(含当前为 `null`)⇒ skipped | 三条都按 R06;签名为 `(task, deliveryRemindAt)` |
| R05/R06/R07(推广) | `task-reminders.ts` 四个 `source_key` 构造器 | `<prefix>:<id>:recipient:<uid>:channel:<ch>` | 裁决条目只定了每族的前缀;内部形状取自仓库里唯一的现成先例(`UnscheduledReminderService.ts`) |
| R07 | `task-reminders.ts` `isInDailyDigest`/`buildTaskDailyDigestCondition` | 逾期 ∪ (今天或明天截止);今天/明天用查看者(收件人)时区 | 源码注释记录了"逾期"这一支在逻辑上被第二支吸收的事实 |
| D13 | `task-notifications.ts` | 触发闭集 5 值,`recipient_role` 优先级 creator>assignee>follower>list_member | `attachment_added` 留 P2 |
| R05-opt | `task-notifications.ts` `TASK_NOTIFIABLE_EVENTS` | `assignee_added` 不在数组里(默认不含) | 默认关闭;没有单独的开关常量,数组字面量本身是唯一真相 |
| R06 | `task-notifications.ts` `resolveReminderRecipients` | 零行 ⇒ `[creatorId]`;非零行但全部已完成 ⇒ 空数组(不回退到 creator) | 对"零负责人"的字面读法 |
| R05(e) | `task-notifications.ts` `resolveListArchiveNotificationRecipients` | 通知清单创建人,`recipientRole:'list_member'` | |
| D5 | `task-settings.ts` `pendingScopeForBadge` | `'off'` → `null`,调用方短路 | |
| R07(**不是** R02③) | `task-settings.ts` `parseSettingsPatch` | 对**合并后**结果强制 daily-reminder-需要-time_zone | `time_zone` 列本身也属 R07;不是只查 patch 里出现的字段 |
| D7 | `task-settings.ts` `parseSettingsPatch` | 写入 `timeZone` 复用 `validateViewerTimeZoneHeader` 规范化 | |
| R15 | `task-pagination.ts` | `limit` 默认 **100** | 缺省 50 会让不传 `limit` 的调用方少看到第 51–100 行 |
| D9 | `task-pagination.ts` `TASK_PAGE_SORT_KEY` | `tasks.updated_at DESC, tasks.id DESC` | 取值形式为可直接使用的 `ORDER BY` 列表 |
| — (own choice, 独立复核 item 11) | `task-pagination.ts` `toStrictNonNegativeInteger` | 两个分支都只接受安全整数(`Number.isSafeInteger`);字符串分支只接受 `^(0\|[1-9]\d*)$` | 数字 `1e300`、带前导零的 `"007"`/`"00"` 都被拒绝 |
| R16 | `task-realtime.ts` `countsUpdateRecipients` | 写入前后负责人集合的并集 | 关注人不在收件人内 |

## 6. 明确推迟(不在本切片)

- **`task-access.ts` 的 `buildTaskByIdCondition`**(R04,2026-10-07 已裁):它改变任务 B 已落 main 模块的行为面,只服务 `GET /api/tasks/:id` 详情路由。本切片没有任何纯函数调用它,`task-access.ts` 本次**未改**,由 PR-3a 随详情路由实现。
- **N1**(2026-10-07 已裁:`all` 模式下,因负责人增减导致任务状态改变时,在同一事务里补写 `completed`/`reopened` 事件):这是在同一数据库事务里追加 `task_events` 行的 I/O 职责,由接线 PR(PR-3a/3b)实现,不是纯函数职责;`task-membership.ts`(任务 C)本次未改。
- **N2**(2026-10-07 已裁:在职校验回填 M2 的 `POST /api/tasks`):同样是路由 + 真库夹具的工作,由 PR-3a 实现。
- **R01**(M4 退出门集合)、**R03**(日期写入 API/PATCH 路由 + `remind_at` 列)、**R04**(详情路由角色解析)、**R09/R10/R13/R18/R19/R20/R21/R22**:全部是路由、DDL、前端或纯流程性裁决,不产生任何任务 D 纯函数,留给对应的后端/前端 PR。
- **R08**(follower 能力冲突 `{follower, list-reader}`):已在 main 上 ——`task-access.ts` 的 `TASK_ROLE_ABILITY` 早已按该取值实现(任务 B),本次不需要任何改动。
- **staging 真投递**(post-merge owner 步骤):不适用于本切片。
- **`isInDailyDigest`(TS)与 `buildTaskDailyDigestCondition`(SQL)的双形对拍**:R01 要求每日汇总的今天/明天边界由这两份文本在真库上对拍(与门 19 的 `taskMatchesView`/SQL 臂对拍同一手法)。本切片只保证两者各自的单测覆盖(见验证记录),**没有**、也不可能在无 I/O 的纯函数切片里做双形对拍——这需要真实 Postgres 连接跑 `buildTaskDailyDigestCondition` 产出的 SQL 并与 `isInDailyDigest` 的 TS 判定逐行比对,留给 PR-3a 的真库测试。

## 7. 与门表的关系

本件是 R01(M4 退出门集合,2026-10-07 已裁)中以下三项的纯函数层实现:通知收件人集合的纯函数格(部分)、提醒与每日汇总的纯函数格、门 20(新模块无 I/O)。HTTP/真库层(outbox 幂等与表形、调度器与投递 worker 单实例、清单可见性/隔离/写授权、红点 socket 扇出、新接口面在既有门上的格)全部要等 PR-3a/3b/3c 落地才能计分——本件不声称通过任何门。
