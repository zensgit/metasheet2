# 任务功能线 — 任务 D(M4 P1 纯函数 + 单测)设计(PROPOSED, 2026-09-30)

- 分支:`claude/tasks-d-pure`,基于 `origin/main`。只在本 worktree 写**无 I/O 纯函数与单测**;不含 DDL、路由、服务、前端;不合并;不启用任何 flag。
- 授权:调用方指示「起任务 D(只做纯函数)」,先例为任务 B(`docs/development/task-b-pure-functions-design-20260926.md`)与任务 C(`docs/development/task-c-m3-pure-functions-design-20260928.md`),同样只做 `packages/core-backend/src/tasks/` 下的无 I/O 模块与单测。
- 设计来源:M4 裁决包 v2(闸方 PROPOSED 建议,未入库、未经 owner ratify)§3.1 的任务 D 模块表,以及它所引用的 R01–R23 裁决行、N1/N2 窄问、§3.4 D1–D14 闸方默认值;任务功能线设计锁 `docs/development/task-feature-design-lock-20260917.md` §4、§4.4、§6、§13。
- **裁决状态**:M4 裁决包 v2 是闸方 PROPOSED 建议,**owner 尚未 ratify**。本设计按裁决包的「推荐值」实现,每一处依赖未裁决值的地方,源码里都有一条 `// ASSUMPTION(task-d): R<nn> …` 或 `[D<nn>]` 注释,命名对应的裁决编号 —— owner 改裁决时,`grep -rn 'ASSUMPTION(task-d)' src/tasks/` 就能找到全部要改的点。

## 1. 范围

八个新模块 + 两处对既有模块的小改动,全部无 I/O,由门 20 的 harness(`tests/unit/task-pure-no-io.test.ts`)自动发现并校验:

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

清单角色闭集 `read | edit | owner`(`TASK_LIST_MEMBER_ROLES`)。`toTaskListMemberships` 把这套角色桥接到 `task-access.ts` 已经存在的 `TaskListMembership`(`read→'reader'`,`edit`/`owner`→`'editor'`)——这是清单侧角色表与任务级角色表之间**唯一**的桥接函数,不再另开第三套角色枚举。**独立复核 item 2 修复**:遇到闭集之外的 `role`(DB CHECK 本该挡住、但万一没挡住的脏数据)不再落入 `edit`/`owner` 分支之外的隐式 `'editor'` 默认值——显式三分支判断,闭集外一律 `throw TypeError`(同 `canListAction` 的 fail-closed-by-throwing 风格;不是丢弃该行)。

**独立复核 item 1 修复**:`applyAddMember`/`applyChangeMemberRole` 的 `role` 参数只有编译期类型保证(`TaskListMemberAssignableRole`),没有运行时保证——一个绕过 TS 的调用方(典型地是未做校验就透传的 HTTP `req.body.role`)可以把任何值传进来。两个函数入口新增运行时闭集校验(复用同一个 `parseTaskListMemberRole`,不是两套平行逻辑),`'owner'`(闭集内但不可指派)和任何非法字符串/非字符串一律 422 `invalid_role`,且这个校验排在所有其它检查**之前**(结构性输入校验优先于业务状态判断)。新导出 `parseTaskListMemberRole(raw: unknown)` 给路由边界单独用。

`canListAction(ctx, action)` 是一张 `角色 × 动作` 真相表(闭集 9 个动作:`view/rename/archive/unarchive/manage_members/transfer_owner/add_item/remove_item/manage_groups`),`archive`/`unarchive` 额外接受 `ctx.isCreator` 覆盖(锁 §13-14,已定:归档权 = `created_by ∪ edit/owner`)。

成员/所有权转换函数:`applyAddMember`(R17 在职校验以调用方已算好的布尔量 `isActiveInOrg` 传入;越界 D14 软上限)、`applyRemoveMember`(R12(b):`created_by` 永不可移除;R12(c):当前 `owner` 不可直接移除,须先转让)、`applyChangeMemberRole`(同样挡住 `owner`)、`applyTransferOwner`(R12(d):目标必须已是成员,原 owner 降为 `edit`)。`applyArchive`/`applyUnarchive` 只算状态转换,不复核权限(权限已由 `canListAction` 单独判定,同 `task-tree.ts` 的 `canReparent` 与 `validateSetParent` 分离先例)。

`validateTaskListName` 复用 `task-ids.ts` 的 `normalizeUserText`,按 Unicode 码点(不是 UTF-16 单元)判 100 上限(D14)。

`planAddTaskToList`/`planRemoveTaskFromList` 实现 D2 的两事件规则:同一次加入/移出清单在同一事务里写 `task_events.list_added/list_removed` **与** `task_list_events.item_added/item_removed`——本函数只规划这两个事件对象,写入由调用方在同一事务内完成。无变化(已在清单里 / 不在清单里)不产生任何事件。

### 2.2 `task-groups.ts`

`scope` 闭集 `list | user`(R11,已接受)。`applyCreateGroup`/`applyRenameGroup`/`applyDeleteGroup`(删组后项回默认组,不可删默认组)/`applyMoveItem`(整数重排,同一事务内全量重算目标组的 position)。**独立复核 item 9 修复**:`scope` 参数同样只有编译期保证;四个 `apply*` 函数入口现在都先跑 `assertValidTaskGroupScope`(闭集外 `throw TypeError`,不静默按 `'user'` 或 `'list'` 兜底——兜成任一边都会错误地決定要不要写 `task_list_events`)。

`arraysEqual`(`applyMoveItem` 的同组同序判定)的长度检查:`previous` 是 `next` 的严格前缀(`next` 更长)时,若删掉长度检查,`.every()` 只会遍历较短数组的下标、逐个比对都通过,从而误判"没变化"——这是长度检查唯一真正防住的方向(`previous` 更长的方向 `.every()` 自己就会因为多出的元素比对失败,长度检查在那个方向是多余的)。

D2 的「个人分组的移动不写事件」被本模块推广到**全部** `task_list_events`(`group_created`/`group_renamed`/`group_deleted`):这三个事件都需要 `listId`,而 `user` scope 的个人分组没有所属清单,所以这个推广是形状上唯一说得通的读法,已在源码注释里标出。

### 2.3 `task-reminders.ts`

`parseRemindPolicy` 实现 R02③ 的闭集 `{"mode":"default"}` / `{"mode":"none"}`,缺行/缺值按 default 处理,其余一律 422。

`computeDefaultRemindAt` 是锁 §4.4(**已定**算法)的实现:定时分支纯瞬时算术 `due_at − 30min`;全天分支**先**(独立复核 item 10 修复)`assertValidCalendarDateString` 严格校验 `dueDate` 是合法真实的 `YYYY-MM-DD`、**再** `isValidIanaTimeZone` 校验、**再**调用 `computeDateReminderOccurrence(dueDate, {timeOfDay:'18:00', offsetDays:0, timezone}, {floating:true})`(`automation-date-reminder.ts:241`,锁 `:140`/`:253` 指名复用)——任一校验失败都直接抛错,不像 `computeDateReminderOccurrence` 自身那样对两者都静默兜底(`new Date(String(dateValue))` 对 `'2026-02-30'` 不报错地滚成 3 月 2 日,对 `'2026-3-8'` 这种非规范拼写也直接放行——独立复核实测确认过这两个具体案例,而不是理论推测)。`assertValidCalendarDateString` 与 `task-dates.ts` 私有的 `parseIsoDate` 逻辑一致,但没有跨模块导入它(沿用本模块树"小共享 helper 就地保留"的既有写法,同 `task-lists.ts`/`task-groups.ts` 的名称校验函数)。

`shouldEnqueueReminder`(写入时门槛,R06)与 `isTaskReminderDue`(扫描期门槛,R06:直接调用 `isDateReminderDue`,窗口常量 `TASK_REMINDER_SCAN_WINDOW_MS = 2` 小时,已在单测里字面量钉死)是两个独立的时间门槛,分别对应写入时刻与 tick 扫描时刻。`isReminderSkippedByTaskState` 是到点时的任务状态短路,现在有三条跳过判据(**独立复核 item 3 新增第三条**,措辞由协调方转述、未回查原始裁决包文本):①已完成或②已软删(原有两条)③**这条投递排队时锁定的 `remind_at` 值,与任务当前的 `remind_at` 不一致(含任务当前 `remind_at` 已变 `null` 的情况)**——到点前任务的截止时间被改过、或提醒策略被关掉,旧的排队投递不能再按旧时间发。函数签名从 `(task)` 改为 `(task, deliveryRemindAt)`。

四族 `source_key` 构造器(`buildTaskReminderSourceKey`/`buildTaskDailyDigestSourceKey`/`buildTaskEventSourceKey`/`buildTaskListEventSourceKey`)沿用仓库里唯一的现成先例(`UnscheduledReminderService.ts` 的 `<prefix>:<id>:recipient:<uid>:channel:<ch>` 形)。

`isInDailyDigest`(TS)与 `buildTaskDailyDigestCondition`(SQL,由 `buildTaskScopeCondition({view:'assigned'})` 派生,不自建角色臂)实现 R07 的每日汇总内容:「已逾期的任务与今明两天将截止的未完成任务」。**独立复核 item 5 修复**:`buildTaskDailyDigestCondition` 的 SQL 现在有一条全文字面量 pin 测试(同 `task-access.test.ts` 给 `buildTaskPendingCondition` 做的那种),把全天分支的 `+1` 与定时分支的 `+2` 日期偏移、以及完整的 `NOT EXISTS (... completed_at IS NOT NULL)` 子句都钉死成一个精确字符串,而不只是 `toContain` 式的子串断言。**独立复核 item 4 修复**:`isInDailyDigest` 新增三个能真正区分「用了 `viewerTz`」还是「用错成 `task.timeZone`」的判别用例(此前一版的"task.timeZone 无关"用例对两种实现给出同一结果,验证不出任何东西,已重做)——全天分支 UTC/Shanghai 结果相反的同一实例、定时分支 `dueAt` 恰好落在 UTC 与 Shanghai 两边"后天零点"边界之间的用例、以及 `task.timeZone` 与 `viewerTz` 显式不一致时只有 `viewerTz` 能决定结果的用例;三处都配了源码级 mutation 抽查(把 `viewerToday(now, viewerTz)`/`viewerNextMidnight(now, viewerTz)` 改成读 `task.timeZone`)确认会变红。

### 2.4 `task-notifications.ts`

D13 的触发闭集(`completed`/`completed_by_any`/`reopened`/`deleted`/`commented`;`attachment_added` 留 P2)与 `recipient_role` 闭集(`creator`/`assignee`/`follower`/`list_member`)。`resolveNotificationRecipients` 按 `RECIPIENT_ROLE_PRIORITY` **驱动**(不是与该常量并行的一段硬编码调用顺序——改这个常量就会改变行为)去重并排除 actor。`resolveReminderRecipients`/`reminderRecipientRole` 实现 R06 的提醒收件人规则。`resolveListArchiveNotificationRecipients` 实现 R05(e) 的清单归档通知(通知清单创建人,`recipientRole` 仍记 `'list_member'`)。R05-opt(`assignee_added` 默认不在通知闭集里)直接标在 `TASK_NOTIFIABLE_EVENTS` 这个字面量数组上——没有另设一个「开关」常量:闭合的 TS 联合类型没有干净的「布尔位拓宽」写法,数组字面量本身就是唯一真相。

### 2.5 `task-settings.ts`

`parseBadgeScope`/`pendingScopeForBadge` 实现锁 §13-4(已定方向)+ D5(`'off'` 时调用方短路,不查库)。`parseSettingsPatch` 是整行 `task_user_settings` 的合并校验器。**`timeZone` 是独立于 `badgeScope`/`dailyReminderEnabled`/`defaultRemindPolicy` 的另一条裁决**:M4 裁决包 v2 §0.1 把它从 R02④ 明确移到了 R07(「原④『加 time_zone 列』移到 R07,因为只有每日汇总用它」)——对合并后的结果强制的是 **R07** 的 CHECK(`daily_reminder_enabled=false OR time_zone IS NOT NULL`),不是 R02 的。`timeZone` 的写入复用 `task-dates.ts` 的 `validateViewerTimeZoneHeader` 做规范化(D7:写入时只落规范名)。

**独立复核 item 8 修复**:`parseBadgeScope`/`parseRemindPolicy` 把 `null` 值当"缺省用默认"处理(R02③,见下)——这对**读一行既有记录**是对的(列真是 `NULL` 就是从没设置过,该退默认值),但对**PATCH 里的显式 `null`** 是错的:一个 PATCH 唯一的"别碰这个字段"写法是**键缺失**(`undefined`),显式传 `badgeScope: null`/`defaultRemindPolicy: null` 没有定义过"清空重置成默认"的语义,`parseSettingsPatch` 现在会在调用 `parseBadgeScope`/`parseRemindPolicy` **之前**先挡下显式 `null`,422 掉(`invalid_badge_scope`/`invalid_policy`)而不是悄悄把字段重置成默认值。这条规则刻意不套用到 `timeZone` 身上——`timeZone: null` 早就有明确定义的 PATCH 语义(清空时区),两者不是同一回事。

### 2.6 `task-pagination.ts`

R15(**v2 修订**:默认 `limit` 改为 100,不是 v1 的 50 —— v1 的默认值会让第 51–100 行对「从不传 `limit`」的调用方静默消失)。`limit` 1..100、`offset ≥ 0`,越界一律 422,不静默夹取。`TASK_PAGE_SORT_KEY`(D9)是 `tasks.updated_at DESC, tasks.id DESC` 稳定排序键常量(可直接拼进 `ORDER BY`;不加括号——行构造器里不允许 DESC——且带表名限定,避免连表时列名歧义)。

**独立复核 item 11 修复(实测确认的真 bug)**:数字分支原先用 `Number.isInteger`,对 `1e300` 返回 `true`(没有小数部分,但远超 `Number.MAX_SAFE_INTEGER`,是任何真实行数/偏移量场景下都不可能出现的值)——修复前 `parsePageParams({ offset: 1e300 })` 实测返回 `{ ok: true, params: { offset: 1e+300 } }`,`offset` 又没有上界检查(不像 `limit` 有),这个值会原样传给下游 SQL 的 `OFFSET` 绑定。字符串分支已经在用 `Number.isSafeInteger`,数字分支现在改用同一个函数,两分支从此一致。同时把字符串分支的正则从 `^\d+$` 收紧为 `^(0|[1-9]\d*)$`——原正则会接受 `"007"`/`"00"` 这类带前导零的拼写并悄悄解析成 `7`/`0`,与文档字面用的"canonical"一词矛盾;收紧后 `"0"` 本身仍被接受,只拒绝非规范拼写。

### 2.7 `task-realtime.ts`

`countsUpdateRecipients`(R16)= 写入前后负责人集合的并集(排序去重)。

## 3. 对既有模块的改动

- **`task-ids.ts`**:`TASK_ID_PREFIXES` 加 `group: 'tgrp'`、`listEvent: 'tlev'`(R23),连带更新了它们的格式文档注释与生成/校验单测(`tests/unit/task-ids.test.ts`)。
- **`task-dates.ts`**:仅改了 `validateViewerTimeZoneHeader` 上方一条注释——它曾写「`isValidIanaTimeZone` 是这整棵模块树唯一允许的外部导入」,而本次新增的 `task-reminders.ts`(同一棵 `src/tasks/` 树下)按锁 `:140` 额外导入了 `computeDateReminderOccurrence`。改成了逐文件表述(D11)。不改行为,不改测试断言。

## 4. 复用 main 上的既有函数(不重复实现)

- `task-access.ts`:`buildTaskScopeCondition`(`task-reminders.ts` 的每日汇总条件由它派生)、`TaskListMembership` 类型(`task-lists.ts` 的桥接目标)、`TaskPendingScope` 类型。
- `task-dates.ts`:`isOverdue`/`viewerToday`/`viewerNextMidnight`(`task-reminders.ts` 的每日汇总判定)、`validateViewerTimeZoneHeader`(`task-settings.ts` 的时区写入规范化)。
- `task-ids.ts`:`normalizeUserText`(清单名、分组名校验)。
- `../multitable/automation-date-reminder.ts`:`computeDateReminderOccurrence`、`isDateReminderDue`(锁 `:140` 指名复用,不重新实现)。
- `../multitable/automation-timezone.ts`:`isValidIanaTimeZone`(全天提醒分支调用前的强制校验)。

## 5. ASSUMPTION(task-d) 一览

每条对应源码里一处或多处 `// ASSUMPTION(task-d): [R<nn>/D<nn>] …` 注释。owner 尚未 ratify M4 裁决包 v2;下表的「值」就是裁决包的推荐值,**不是** owner 裁决。

下表「裁决」列写 `— (own choice, …)` 的行是**本模块自己的实现选择,不是裁决包推荐值**,共 7 行。第三轮独立复核加的 6 行(`独立复核 item 1/2/8/9/10/11`)对应的源码注释用 `ASSUMPTION(task-d, own choice …` 这个逗号形前缀(`grep -n 'ASSUMPTION(task-d, own' packages/core-backend/src/tasks/*.ts` 能找到全部 7 处这种注释——`item 1` 那一行覆盖 `applyAddMember`/`applyChangeMemberRole` 两处站点,所以 7 处注释对应这 6 行表格,不是 1:1)。**第一轮**那一行(`canListAction` 的 `rename`/`manage_members`/`manage_groups`)不属于这 7 处——它当初标的是 `ASSUMPTION(task-d): [R12(a)]`(冒号形,跟着 R12(a) 一起写),own-choice 的说明是紧接着那条注释之后、以大写 `OWN CHOICE` 出现在散文里的(`task-lists.ts:111`),用 `grep -n 'OWN CHOICE' packages/core-backend/src/tasks/task-lists.ts` 能单独找到它。

| 裁决 | 模块 / 函数 | 选的值 | 备注 |
|---|---|---|---|
| R23 | `task-ids.ts` `TASK_ID_PREFIXES` | `group:'tgrp'`, `listEvent:'tlev'` | 沿用 `tev` 先例的加词手法 |
| R12(a) | `task-lists.ts` `canListAction` | `add_item`/`remove_item` 需要清单 `edit`/`owner` | 裁决包原文明确 |
| — (own choice, 非 R 编号) | `task-lists.ts` `canListAction` | `rename`/`manage_members`/`manage_groups` 与 `add_item` 同档(edit 即可) | 裁决包未点名这三个动作;沿用 `list-editor` 在 `task-access.ts` 里「edit ⇒ 广泛可写」的同形状,可逆 |
| R17 | `task-lists.ts` `applyAddMember` | `isActiveInOrg` 为调用方已算好的布尔量 | 真正的 `user_orgs` 查询是 I/O,留给调用方 |
| R12(b) | `task-lists.ts` `applyRemoveMember` | `created_by` 永不可移除 | 422 `created_by_immutable` |
| R12(c) | `task-lists.ts` `applyRemoveMember`/`applyChangeMemberRole` | 当前 `owner` 不可直接移除/改角色 | 422 `owner_must_transfer` |
| R12(d) | `task-lists.ts` `applyTransferOwner` | 目标必须已是成员;原 owner 降为 `edit`(不是 `read`) | 「目标必须已是成员」是本模块在 R12(d) 原文之上的保守读法 |
| D14 | `task-lists.ts` | 清单成员 ≤100,单任务所属清单 ≤10,清单名 ≤100 码点 | 软限额,可逆常量 |
| — (own choice, 独立复核 item 1) | `task-lists.ts` `applyAddMember`/`applyChangeMemberRole`/新导出 `parseTaskListMemberRole` | `role` 参数运行时闭集校验(`'owner'`/未知字符串/非字符串 ⇒ 422 `invalid_role`),排在所有其它检查之前 | `role` 的编译期类型不是运行时保证;三处共用同一 `parseTaskListMemberRole`,不是三套平行逻辑 |
| — (own choice, 独立复核 item 2) | `task-lists.ts` `toTaskListMemberships` | 闭集外的 `role` 值 `throw TypeError`,不丢弃该行、也不默认成 `'editor'` | 同 `canListAction` 的 fail-closed-by-throwing 风格;可逆为丢弃该行 |
| R11 | `task-groups.ts` | `scope='list'\|'user'`,删组后项回默认组,不可删默认组 | |
| D14 | `task-groups.ts` | 每 scope 分组 ≤50,分组名 ≤100 码点 | |
| D2(推广) | `task-groups.ts` | `group_created`/`group_renamed`/`group_deleted` 只在 `scope==='list'` 时产生 | D2 原文只点名了「分组移动」;本模块把同一条理由(个人分组没有 `listId`)推广到创建/改名/删除 |
| — (own choice, 独立复核 item 9) | `task-groups.ts` 四个 `apply*` 函数 | `scope` 运行时闭集校验,闭集外 `throw TypeError` | 同上,`scope` 的编译期类型不是运行时保证 |
| R02③(推广) | `task-reminders.ts` `parseRemindPolicy` | `null`/`undefined` **值**(不只是缺行)按 default 处理 —— **仅限"读一行既有记录"语境**;`task-settings.ts` `parseSettingsPatch` 的 PATCH 语境里显式 `null` 不会到达这个函数,而是在更上层直接 422(见下一条) | 原文只写「缺行」;推广到「缺值」,但只在读语境下 |
| — (own choice, 独立复核 item 8) | `task-settings.ts` `parseSettingsPatch` | PATCH 体里显式 `badgeScope: null`/`defaultRemindPolicy: null` ⇒ 422(不是"重置成默认") | PATCH 唯一的"别碰"写法是键缺失(`undefined`);不影响 `timeZone: null`(那个有独立定义的"清空"语义) |
| — (own choice, 独立复核 item 10, 修复实测确认的真 bug) | `task-reminders.ts` `computeDefaultRemindAt`(全天分支) | 调用 `computeDateReminderOccurrence` **之前**先严格校验 `dueDate` 是真实存在的 `YYYY-MM-DD` 日期,失败 `throw RangeError` | 实测 `new Date('2026-02-30')` 静默滚成 3-02,`new Date('2026-3-8')` 静默接受非规范拼写——`computeDateReminderOccurrence` 自身两者都不挡;镜像 `task-dates.ts` 私有 `parseIsoDate` 的逻辑,不跨模块导入 |
| R06 | `task-reminders.ts` | 扫描窗口 `W=2` 小时(`TASK_REMINDER_SCAN_WINDOW_MS`),单测已字面量钉死 | 单点常量,要求 ≥ 调度间隔(由 PR-3b 保证) |
| R06 | `task-reminders.ts` `isReminderSkippedByTaskState` | 已完成或已软删 ⇒ skipped;**独立复核新增第三条**:排队时的 `remind_at` 与任务当前 `remind_at` 不一致(含当前为 `null`)⇒ skipped | 第三条已对照裁决包 v2 的 R06 建议值核对一致;签名从 `(task)` 改为 `(task, deliveryRemindAt)` |
| R05/R06/R07(推广) | `task-reminders.ts` 四个 `source_key` 构造器 | `<prefix>:<id>:recipient:<uid>:channel:<ch>` | 裁决包只给了每族的前缀;内部形状取自仓库里唯一的现成先例(`UnscheduledReminderService.ts`) |
| R07 | `task-reminders.ts` `isInDailyDigest`/`buildTaskDailyDigestCondition` | 逾期 ∪ (今天或明天截止);今天/明天用查看者(收件人)时区 | 源码注释记录了"逾期"这一支在逻辑上被第二支吸收的事实 |
| D13 | `task-notifications.ts` | 触发闭集 5 值,`recipient_role` 优先级 creator>assignee>follower>list_member | `attachment_added` 留 P2 |
| R05-opt | `task-notifications.ts` `TASK_NOTIFIABLE_EVENTS` | `assignee_added` 不在数组里(默认不含) | 裁决包自称"语料无原页的自有设计";没有单独的开关常量,数组字面量本身是唯一真相 |
| R06 | `task-notifications.ts` `resolveReminderRecipients` | 零行 ⇒ `[creatorId]`;非零行但全部已完成 ⇒ 空数组(不回退到 creator) | 对"零负责人"的字面读法 |
| R05(e) | `task-notifications.ts` `resolveListArchiveNotificationRecipients` | 通知清单创建人,`recipientRole:'list_member'` | |
| D5 | `task-settings.ts` `pendingScopeForBadge` | `'off'` → `null`,调用方短路 | |
| R07(**不是** R02③) | `task-settings.ts` `parseSettingsPatch` | 对**合并后**结果强制 daily-reminder-需要-time_zone | `time_zone` 列本身也是 R07(v2 §0.1 把它从 R02④ 移出);不是只查 patch 里出现的字段 |
| D7 | `task-settings.ts` `parseSettingsPatch` | 写入 `timeZone` 复用 `validateViewerTimeZoneHeader` 规范化 | |
| R15(v2) | `task-pagination.ts` | `limit` 默认 **100**(v2 把 v1 的 50 改正) | v1 的 50 会让第 51–100 行静默消失 |
| D9 | `task-pagination.ts` `TASK_PAGE_SORT_KEY` | `tasks.updated_at DESC, tasks.id DESC` | 取值形式为可直接使用的 `ORDER BY` 列表 |
| — (own choice, 独立复核 item 11, 修复实测确认的真 bug) | `task-pagination.ts` `toStrictNonNegativeInteger` | 数字分支改用 `Number.isSafeInteger`(原为 `Number.isInteger`);字符串分支正则收紧为 `^(0\|[1-9]\d*)$`(原为 `^\d+$`,接受前导零) | 实测 `parsePageParams({offset:1e300})` 修复前返回 `ok:true`;`offset` 无上界检查,是唯一能证伪这条修复的用例(`limit:1e300` 本来就会被上界挡住) |
| R16 | `task-realtime.ts` `countsUpdateRecipients` | 写入前后负责人集合的并集 | 关注人不在收件人内 |

## 6. 明确推迟(不在本切片)

- **`task-access.ts` 的 `buildTaskByIdCondition`**(裁决包 §3.1 原本把它列进任务 D):这是对任务 B 已落 main 模块的行为面改动,裁决包自己也写明「改任务 B 模块,需 owner 确认」。本次没有任何任务 D 纯函数需要调用它——它只服务未来 `GET /api/tasks/:id` 详情路由(PR-3a,R04)。按调用方指示的「不确定就不改」原则,`task-access.ts` 本次**未改**,留给 PR-3a 并同时经 owner 对 R04 的确认。
- **N1**(all 模式下增删负责人使任务状态翻转时是否补发 `completed`/`reopened` 事件):这需要在同一数据库事务里追加 `task_events` 行,是 PR-3a/3b 的 I/O 职责,不是纯函数职责;`task-membership.ts`(任务 C)已经在 NOTE 里记录了这个空白,本次未改该文件。
- **N2**(在职校验回填 M2 的 `POST /api/tasks`):同样是路由 + 真库夹具的工作,留给 PR-3a。
- **R01**(M4 退出门集合)、**R03**(日期写入 API/PATCH 路由 + `remind_at` 列)、**R04**(详情路由角色解析)、**R09/R10/R13/R18/R19/R20/R21/R22**:全部是路由、DDL、前端或纯流程性裁决,不产生任何任务 D 纯函数,留给对应的后端/前端 PR。
- **R08**(follower 能力冲突 `{follower, list-reader}`):裁决包标注为「事实已落 main」——`task-access.ts` 的 `TASK_ROLE_ABILITY` 早已按建议值实现(任务 B),本次不需要任何改动。
- **staging 真投递**(post-merge owner 步骤):不适用于本切片。
- **`isInDailyDigest`(TS)与 `buildTaskDailyDigestCondition`(SQL)的双形对拍**:裁决包候选门 M4-c 明确要求这两份文本在真库上对拍(与门 19 的 `taskMatchesView`/SQL 臂对拍同一手法)。本切片只保证两者各自的单测覆盖(见验证记录),**没有**、也不可能在无 I/O 的纯函数切片里做双形对拍——这需要真实 Postgres 连接跑 `buildTaskDailyDigestCondition` 产出的 SQL 并与 `isInDailyDigest` 的 TS 判定逐行比对,留给 PR-3a 的真库测试。

## 7. 与门表的关系

本件是候选门 M4-b(收件人纯函数网格,部分)、M4-c(提醒与每日汇总纯函数部分)、门 20(新模块无 I/O)的纯函数层实现。HTTP/真库层(M4-a outbox、M4-d 调度单实例、M4-e 清单可见性隔离写授权、M4-f socket、M4-g 新表面复用已武装的门)全部要等 PR-3a/3b/3c 落地才能计分——本件不声称通过任何门。
