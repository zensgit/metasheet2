# 任务功能线 — 任务 E(M5 P2 纯函数 + 单测)设计(DRAFT, 2026-10-07;2026-10-08 按闸方复审修订;2026-10-09 按 owner 裁决更新标签)

- **状态:DRAFT(指 Draft PR:不合并、不推送到 main)。** owner 于 2026-10-07 同意开启任务 E。owner 2026-10-09 裁定 S01–S37 各取推荐值:取值没有变,源码里对应的标签由 `// ASSUMPTION(task-e): [Sxx]` 改为 `// RULED(2026-10-09): [Sxx]`。这次裁定没有点名任何 D 编号,所以 D 编号仍是闸方给的默认约束,继续标 `ASSUMPTION(task-e): [Dxx]`;同一条注释里 S 与 D 并存的拆成两段,各带各的标记(只有重复规则 `count` 的那一条整条不动,因为它挂着问题 3)。门 20 变严(§3 偏离 14)同日获 owner 同意,§7 问题 4 关闭。**仍待 owner 裁的是 §7 问题 1–3**,以及所有标 `ASSUMPTION(task-e, own choice)` 的自有选择,其中偏离 7、17、18、20 与每任务附件上限的计数口径,现在是在已裁文字之上的偏离或读法(§9)。`grep -rn 'ASSUMPTION(task-e' packages/core-backend/src/tasks/` 仍是尚未被 owner 点名的全部清单,`grep -rn 'RULED(2026-10-09)'` 是已裁清单;计数见 §5。
- 分支:`claude/tasks-e-pure`,基于 `origin/main` `7137688372`。与任务 D(#6186)、PR-3a、PR-3b 无依赖,不 import 它们的任何文件。
- 先例:任务 B / C(已在 main)、任务 D(#6186 Draft)。同样只做 `packages/core-backend/src/tasks/` 下的无 I/O 模块与 `tests/unit/` 下的单测。
- 引用口径:裁决包条目只写编号(`S14`、`E11`、`D18` 等),不转述其句子。锁 = `docs/development/task-feature-design-lock-20260917.md`(main 版)。
- 与安全有关的部分(附件允许哪些类型、多大,下载授权的判定、投影 id 的推导、导出格的中和、不设会让服务端访问外部地址的字段类型)在本文和源码里只描述规则本身。
- 2026-10-08:闸方复审(10 条 P2 与若干 P3/NIT)之后改过一轮,改了什么见 §8;逐条的修复、单测与变异记录在验证记录的「闸方复审修复」一节。

## 1. 范围

源码全部是**新文件**(S32 已裁:任务 E 只新建文件;main 与其他在飞分支上已存在的文件一律不碰,门 20 harness 一处除外,见下)。全部无 I/O,由门 20 harness(`tests/unit/task-pure-no-io.test.ts`,非递归 `readdirSync`)自动发现,所以都放在 `src/tasks/` 顶层。

**唯一一处改动既有文件**:门 20 的 harness 本身。闸方复审要求把门 20 的静态导入检查做全(单引号以外的写法此前一律漏检),这只能改 main 上那个测试文件;改动只加单元格、只让检测更严,原有五格一字未动(§4,§3 偏离 14)。这一改动已获 owner 2026-10-09 同意。

| 模块 | 内容 | 主要编号 |
|---|---|---|
| `task-civil-date.ts` | 民用日期加减、星期、月长、两日差 | S32(子项) |
| `task-dependencies.ts` | 依赖边的加/删判定、无环检查(允许菱形)、双端授权、候选 | S11、S12、E14、D4、D17、D18 |
| `task-milestone.ts` | 里程碑开关的请求体校验与状态转换 | S13、E14 |
| `task-recurrence.ts` | 规则闭集与解析、下一期截止日、派生判定与派生计划、设/清规则、系列删除计划 | S14–S17、E05、E11、D2、D3、D15 |
| `task-fields.ts` | 字段类型闭集、定义解析、值校验、三层权限、绑定事件、值可见性 | S24–S28、E13、D10、D18 |
| `task-attachments.ts` | 白名单与上限、候选文件校验、存储键、显示名、下载判定、移除/添加/评论绑定、响应头 | S18–S23、E12、D5、D6、D18 |
| `task-projection.ts` | base/sheet/记录/字段 id 推导与候选判定、列目录、视图规格、行投影与 no-op 摘要、能力夹钳、交互 canEdit、行可读判定 | S01–S08、S36、E08、E09、D7、D9 |
| `task-export.ts` | 清单 CSV 导出:格式参数、文件名、单元格格式化、整表构造 | S10、D11 |

单测:每个模块一个 `tests/unit/task-<模块>.test.ts`,另加 `tests/unit/task-m5-probe.test.ts`(见 §4)与 `tests/unit/task-m5-time-zone.test.ts`(见 §2.1)。

**不做**:DDL、迁移、路由、服务、前端、flag、manifest;`task-ids.ts` 与 `task-notifications.ts` 不动(见 §3 偏离 1);不 import 任务 D 的模块(`task-reminders.ts` 等只在 #6186 上)。

两条沿用任务 B/C/D 的规则:
- 时间一律由调用方显式传入(`now` 等),不隐式读时钟;
- **没有变化就没有事件**:输入与输出等价时返回空事件数组(`noop: true`)。

事件名只用锁 §4.2 的两个闭集(`task_events` / `task_list_events`),不新增词(E03)。

## 2. 各模块

下面每张表的「调用方须先加载」列,是纯函数拿不到、必须由服务层在调用前查好的输入。

### 2.1 `task-civil-date.ts`(S32 子项)

| 导出 | 说明 |
|---|---|
| `addCivilDays(date, days)` | `YYYY-MM-DD` 加整数天,返回 `YYYY-MM-DD` |
| `civilDayDiff(from, to)` | `to − from` 的天数(整数,可负) |
| `civilWeekday(date)` | 0 = 星期日 … 6 = 星期六(`getUTCDay` 口径,D15) |
| `daysInCivilMonth(year, month)` | 公历月长(闰年规则同 `utils/calendar-date.ts`) |

规则:输入日期必须过 `isValidIsoCalendarDate`(否则 `RangeError`;非字符串 `TypeError`);`days` 必须是安全整数。算法用 `Date.UTC` 毫秒,但年份经 `setUTCFullYear` 设置,避免 `Date.UTC` 把 0–99 年映射成 19xx 年;结果再过一次 `isValidIsoCalendarDate`,落到 0001-01-01 至 9999-12-31 之外即 `RangeError`。不新增 `Intl.DateTimeFormat` 调用点(D15)。

与进程时区无关(D15):CI 的跑测进程在 UTC,此时把 UTC 取值器换成本地取值器得到的结果完全相同,普通单测看不出来。`task-m5-time-zone.test.ts` 因此在进程内把 `process.env.TZ` 依次切到 UTC 以东与以西的四个时区(Asia/Taipei、Pacific/Kiritimati、America/Chicago、Pacific/Pago_Pago),跑完即还原;每个时区先用一格对照确认本地时钟确实偏离了 UTC,再核对 2026 年每一天的星期、前后 1 天与 40 天的步进和天数差、100 年以内与日历两端、按周与按月的下一期,以及附件存储键的月份(月界两侧各一个时刻)。

任务 D 的 `task-reminders.ts` 自带一份未导出的 `addCivilDays`。按已裁的 S32 子项,导出放在本模块;#6186 再次 rebase 时,任务 D 那份改为从这里 import,main 上只会有这一份。

### 2.2 `task-dependencies.ts`(S11、S12、E14、D4、D17、D18)

| 导出 | 调用方须先加载 | 结果 |
|---|---|---|
| `TASK_DEPENDENCY_MAX_EDGES_PER_TASK = 50` | — | 每个任务的前置与后置合计条数上限(D18) |
| `wouldCreateDependencyCycle(edges, predecessorId, successorId)` | 本 org 全部在册边 | 布尔:加 `P→S` 是否成环 |
| `validateAddDependency(input)` | 两端 id 与 org;本 org 全部在册边 | `{ok:true}` 或 `{ok:false, reason}` |
| `applyAddDependency(input & {actorId, now})` | 同上 | 失败同上;成功 `{edge, events}` |
| `applyRemoveDependency({predecessorId, successorId, edges, actorId, now})` | 本 org 全部在册边 | `{noop, events}` |
| `canManageDependency({predecessorRoles, successorRoles, sameOrg})` | 调用者对两端的角色 | 布尔 |
| `dependencyCandidates({taskId, direction, candidateIds, edges})` | 调用者**可编辑**且同 org、未软删、匹配搜索词的任务 id | 排序后的 id 列表 |

- 只有一种关系:前置 → 后置,不带类型、不带 lag(S12)。不阻断完成:本模块不导出任何读写完成状态的函数(S12,UNVERIFIED)。
- 判定顺序(固定,单测用同时违反多条的输入钉住):`cross_org`(任一端 org 为空或两端不同)→ `self` → `duplicate`(同向边已存在)→ `limit`(**插入后**任一端的前置与后置合计超过 50)→ `cycle`。`cross_org` 排第一:路由把它与「无权」一起映射为同一个 404(S11)。
- 无环判定:加 `P→S` 成环 ⇔ 从 `S` 沿现有边能到达 `P`。用带 visited 集合的 BFS,**重访直接跳过、不抛错**——菱形(A→B、A→C、B→D、C→D)是合法图。不复用 `task-tree.ts` 的 `descendantsOf`(它在重访时抛 `TaskTreeCorruptError`,E14)。
- 输入合同:`edges` 只含两端都未软删的边(D4 / D17:任务被软删后它的边仍留在表里,由读取方过滤;软删本身不写 `dependency_removed`)。
- 事件:加边产生两条 `dependency_added`,各写在一端任务上,payload 带对端 id(后置端 `{predecessorId}`、前置端 `{successorId}`,S11);删边同形 `dependency_removed`;删一条不存在的边 = noop、无事件。
- 授权:两端都 `can(roles,'edit')` 且同 org(S11,与设父同形;失败由路由统一 404)。
- 候选(**自有扩展**,§3 偏离 7):排除自身、两端之间任一方向已存在的边、以及加上后会成环的任务(同 `parentCandidates` 排除全部子孙的做法);父子关系不排除;不按 `limit` 过滤(达到上限的候选在加边时得到 422 `limit`)。

### 2.3 `task-milestone.ts`(S13)

| 导出 | 结果 |
|---|---|
| `parseMilestoneFlag(raw)` | 只接受真正的布尔值:`{ok:true, value}`;其余 `{ok:false, reason:'invalid_milestone'}` |
| `applySetMilestone({current, next, actorId, now})` | 同值 ⇒ `noop`、无事件;否则 `milestone_set` / `milestone_cleared` |

- 不要求任务有截止日(S13,UNVERIFIED)。设/取消里程碑的权限 = `can(roles,'edit')`,由路由直接调用 `task-access.ts` 的 `can`,本模块不再包一层。
- 不追加到 PR-3a 的 `task-edit.ts`(避免与在飞分支碰同一文件)。

### 2.4 `task-recurrence.ts`(S14–S17、E05、E11、D2、D3、D15)

**规则闭集**(S14):

```
{ freq: 'daily' | 'weekly' | 'monthly' | 'yearly',
  interval: 1..365,                       // 必填整数
  byWeekday?: (0..6)[],                    // 仅 weekly,且 weekly 必填;0 = 星期日;去重并升序规范化
  byMonthDay?: 1..31 | 'last',             // 仅 monthly;缺省取锚点日
  end?: { until: 'YYYY-MM-DD' } | { count: 1..365 } }   // 恰一个键
```

未知键、越界、类型不符、字段出现在不属于它的 `freq` 上 ⇒ `{ok:false, reason:'invalid_recurrence', field}`(`field` 是闭集键名,不回显输入)。不含工作日频率,不接受自由表达式。`count` 超过 365 也答 `invalid_recurrence`(取 S14 而不取 D18 的 `LIMIT`,理由见 §3 偏离 15)。

| 导出 | 调用方须先加载 | 结果 |
|---|---|---|
| `parseRecurrenceRule(raw)` | — | 规范化后的规则或 `invalid_recurrence` |
| `nextOccurrenceDueDate(rule, current, anchor)` | 当前实例 `due_date`;系列锚点日期 | 下一期 `due_date` |
| `isWithinRecurrenceEnd(rule, dueDate, occurrenceNumber)` | — | 布尔 |
| `shouldSpawnOnFlip({wasDone, done, recurrence, alreadySpawned})` | 翻转前后状态;本任务是否已有 `recurrence_spawned` 事件 | 布尔 |
| `planSpawn(input)` | 当前实例的携带集(见下);系列锚点日期;当前实例在系列中的序号;新任务 id | 新行字段,连同要复制的指派、关注、所属清单与字段值,外加提醒指示和两条事件;或 `no_due_date` / `series_ended` |
| `applySetRecurrence({taskId, current, next, dueDate, actorId, now})` | 当前规则与截止日 | `due_required` / `invalid_recurrence` / 成功(同规则 ⇒ noop) |
| `applyClearRecurrence({taskId, current, isLatestOpenOccurrence, actorId, now})` | 本任务是否为系列最新且未完成的实例 | `not_current_occurrence` / 成功(已无规则 ⇒ noop) |
| `planSeriesDelete(input)` | 系列全部成员(含已软删)、本 org 在册节点表、调用者对每个成员的角色 | 待软删 id、待清规则 id、事件;或 `not_found` / `forbidden` / `has_children` |
| `TaskRecurrenceSeriesCorruptError` | — | 系列链损坏(分叉、环、断链)时抛出 |

下一期截止日(`nextOccurrenceDueDate`):
- daily:`current + interval` 天。
- weekly:周一为一周之始(**自有选择**,`interval > 1` 时才有区别)。先找**当前这一周**内晚于 `current` 的命中星期;没有就取 `interval` 周之后那一周里的第一个命中星期。`interval = 1` 时等价于「严格晚于 `current` 的下一个命中星期」。
- monthly:目标月 = `current` 所在月 + `interval`;日 = `byMonthDay`(`'last'` 取月末)或锚点日,超过目标月长则钳到月末。**日取自规则日/锚点日,从不取自上一期被钳过的日子**,所以 01-31 → 02-28 → 03-31 不漂移。
- yearly:目标年 = `current` 年 + `interval`;月/日取锚点;2 月 29 日的锚点在平年落 2 月 28 日、闰年回到 29 日。
- 锚点 = 系列第一期的 `due_date`(还没有系列的任务就是它自己的 `due_date`),由调用方加载。步进的「起点」始终是当前实例(S14、S17(c)),所以改动当前实例的截止日,作用到的是以后派生的各期。
- **锚点与 S17(c) 的关系未裁**,列为 §7 问题 1(含备选与默认值,以及几种会跳过一整期的情形);当前代码按默认值实现,标为自有选择,不是已定。

结束条件(`isWithinRecurrenceEnd`):`until` 含当日(下一期 `due_date <= until` 才派生);`count` = 系列总期数(含第一期),调用方给出当前实例的 1 起序号,下一期序号 `> count` 即不派生。

派生(S15、S16、D3、E05):
- 派生在「把任务从未完成写成完成」的那次写入里触发,与事件类型无关;`shouldSpawnOnFlip` = 翻转前未完成 ∧ 翻转后完成 ∧ 有规则 ∧ 本任务还没有 `recurrence_spawned` 事件。reopen 后再完成不会第二次派生(D3)。存储的规则解析失败视为数据损坏,抛 `TypeError`(同 `TaskTreeCorruptError` 的处理方式)。
- 携带(S16):标题、描述、完成模式、时区、`due_time` / `start_time`、负责人(`completedAt: null`,`assignedBy` = 系列创建人)、关注人、清单归属、字段值、里程碑、`parent_id` 与 `depth`、规则本身、`recurrence_series_id`(= 系列第一期 id)、`previous_occurrence_id`。留在原实例、不复制的有:依赖、附件、评论和子任务。新实例的 `created_by` 沿用原值。
- 日期(E05):`due_date` 按上面的规则步进;`start_date` 平移同样的民用天数;`due_at` 用 `task-dates.ts` 的 `computeDueAt` 重算(保留 `due_time` 与 `time_zone`)。
- 提醒(S16):原实例有 `remind_at` ⇒ 新实例的提醒与新 `due_at` 保持同样的提前量;没有 ⇒ 返回 `{kind:'default_policy', policyUserId: created_by}`,由服务层用任务 D 的 `computeDefaultRemindAt` 计算(本模块不 import 任务 D)。
- 事件:旧任务 `recurrence_spawned`(payload `{spawnedTaskId}`);新任务 `created`(actor = 触发完成的人,S16)。新任务的 `created` 事件也是它的提醒 floor。
- 截止日被清空的有规则任务完成时返回 `no_due_date`(不派生)。

设/清规则(E11、S17(a)、S35):
- 设规则前置:任务有截止日,否则 `due_required`(422)。同一规范化规则 ⇒ noop。事件 `recurrence_set`。换成另一条规则时整体替换,锚点与 `count` 的起算点仍沿用系列原有的(§7 问题 1 (iii))。
- 清规则:已无规则 ⇒ noop;只允许系列最新且未完成的实例,否则 `not_current_occurrence`(422)。事件 `recurrence_cleared`。
- 调用者集合(S35)= 持 `edit` 者,由路由用 `can(roles,'edit')` 判定;本模块不含角色判定。

系列删除(E11、S17(b)(d)):
- 顺序按 `previous_occurrence_id` 链,不按 `due_date`(后者可编辑)。
- 待删 = 目标实例本身 ∪ 链上晚于它、未软删且未完成的实例。每一条都过任务 C 的 `planDeleteTask`(A4:仍有未删子任务 ⇒ 拒绝;删除权仍只有创建人)。任何一条不过,整体拒绝并返回那一条的 id。链上晚于目标、但已经软删的实例跳过(它已不在节点表里,不再删一次)。
- 删除后链上最晚的未删实例若仍带规则,清掉它的规则并记 `recurrence_cleared`。已完成的实例(目标除外)不删。

### 2.5 `task-fields.ts`(S24–S28、E13、D10、D18)

类型闭集(S25):`text | number | select | multiSelect | member | date`。不含 url / checkbox / dateTime。

config 闭合 schema(D10、S25;未知键一律 `invalid_config`):

| 类型 | config(规范化后) | 值形 |
|---|---|---|
| `text` | `{maxLength?: 1..2000}` | 字符串,`normalizeUserText` 后按码点计长 |
| `number` | `{decimals: 0..6, format: 'plain' \| 'percent'}`(缺省 `0` / `'plain'`) | 有限数且 `\|x\| < 1e15` |
| `select` / `multiSelect` | `{options: [{id, label, color?}]}`(≤ 100 项) | 选项 **id**(多选为去重数组) |
| `member` | `{single: boolean}`(缺省 `false`) | 用户 id 数组(≤ 50;`single` 时 ≤ 1) |
| `date` | `{}` | floating `YYYY-MM-DD`(`isValidIsoCalendarDate`) |

- 选项 id 由服务端生成 `opt_<随机>`,随机源由调用方注入(同 `task-ids.ts` 的做法);label 走 `normalizeUserText`、≤ 100 码点,在同一字段内忽略大小写后不能重名;color 只接受 `#rrggbb` / `#rgb`,规范化为小写 6 位。更新定义时,带 `id` 的项必须是原有选项;不带 `id` 的是新项。
- 字段名走 `normalizeUserText` + `display-name-hygiene.ts` 的 `checkDisplayNameHygiene`,≤ 100 码点(**自有选择**:与清单名上限同值)。定义的类型不可改。
- 所有类型:`null` 与 `''` 都表示清空。
- 文本值:超过 2000 码点一律答 `limit`(D18 的码;存储的 `maxLength` 再大也不放宽);在 2000 以内、但超过本字段 `maxLength` 的,答 `too_long`(D10 的配置规则)。
- 值校验全部在本模块内实现,不 import `multitable/field-codecs.ts`(D16;第一版对那几个 codec 的复用已在 2026-10-07 撤回,见 §3 偏离 3)。单选:字符串,且是本字段某个选项的 id。多选:非空字符串组成的数组,按首次出现去重,每一项都必须是本字段的选项 id;空数组表示清空。成员:非空字符串组成的数组,按首次出现去重,每个 id 不超过 50 个字符且在调用方给的候选集里(本 org 在职用户,R17 helper 或 `user_orgs`),去重后至多 50 人,`single` 时至多 1 人;空数组表示清空;候选集检查先于人数上限。id 一律按原样比较:不 trim、不跳过空白项,带首尾空白或全是空白的 id 被拒(第一版经 codec 会先 trim 再比较、并跳过空白项——这是唯一一处收紧,新单测钉住;其余已钉住的取值行为不变)。50 个字符的 id 上限沿用第一版的行为(自有选择)。数值:只收有限的 JSON 数且 |x| < 1e15,不收数字字符串;日期:`isValidIsoCalendarDate`。

| 导出 | 调用方须先加载 | 结果 |
|---|---|---|
| `parseFieldDefinition({type, name, config, previous?, random})` | 更新时:原定义的类型与 config | 规范化定义;或 `invalid_type` / `invalid_name` / `invalid_config` / `limit` |
| `validateFieldValue(def, value, ctx)` | `ctx.memberCandidates`(成员型) | `{ok:true, value}`(清空为 `null`);或 `invalid_value` / `not_in_options` / `not_a_candidate` / `too_long` / `out_of_range` / `limit` |
| `applySetFieldValue({def, current, next, ctx, actorId, now})` | 当前值 | 同上;成功时同值 ⇒ noop,否则 `field_value_changed`(payload `{fieldId}`) |
| `canManageFieldDefinition({actorId, createdBy, actorEditsBindingList})` | 调用者是否在某个绑了该字段的清单里有编辑权(edit/owner) | 布尔(改名/改选项) |
| `planDeleteFieldDefinition({actorId, createdBy, bindingCount})` | 绑定数 | `forbidden`(非创建者;空的 actor 永远不等于空的创建者)/ `field_in_use`(仍有绑定)/ 成功 |
| `canBindField(viewerListRole)` | 调用者在该清单的角色 | 布尔(给清单挂字段、摘字段、调顺序、设显隐,都要清单 edit/owner) |
| `canWriteFieldValue({taskRoles, fieldBoundToTaskList})` | 该字段有没有绑在包含此任务的清单上 | 布尔 |
| `applyBindField` / `applyUnbindField` | 该清单现有绑定 | `field_bound` / `field_unbound`(`task_list_events`);已绑/未绑 ⇒ noop;绑定数上限 50 ⇒ `limit` |
| `checkFieldDefinitionQuota(existingCount)` | 本 org 现有定义数 | 上限 200 ⇒ `limit` |
| `resolveVisibleTaskFieldValues(input)` | 调用者能否 `view`;调用者所在清单;任务所在清单;绑定;值 | 按清单分组的可见字段值(S27) |
| `listReusableTaskFieldIds(input)` | 本 org 字段定义、绑定、调用者可编辑的清单 | 可复用字段 id(S24) |

- 三层权限(S26):建定义只看路由上的 `rbacGuard('tasks','write')`;改名或改选项,允许字段的创建者,以及在任一绑了该字段的清单上有 edit/owner 的人;删定义只允许创建者,而且要一个绑定都不剩,删掉定义时它的值一并删除;绑定、解绑、排序、显隐,看调用者在那张清单上是不是 edit/owner;写值要求调用者对任务有 `edit`,而且字段绑在包含这个任务的清单上;解绑时值留着。各谓词都不接受 admin 参数,`tasks:admin` 依然没有使用方。
- 值可见性(S27):调用者能读到任务 T 的字段 F 的取值,当且仅当 `can('view')`,且存在清单 L:F 绑定于 L、T 属于 L、调用者是 L 的成员。只因直接角色(创建、负责或关注)能看任务、却不在任何相关清单里的人,读不到这些自定义字段的取值(UNVERIFIED)。
- 清单角色沿用 main 上 `task-access.ts` 的 `TaskListMembership['role']`(`'editor' | 'reader'`;清单 owner 归入 `'editor'`,同任务 D 的桥接),不新增第三套清单角色枚举。

### 2.6 `task-attachments.ts`(S18–S23、E12、D5、D6、D18)

- 白名单(S18)由**一张** MIME → 扩展名表驱动:`application/pdf`(pdf)、`image/png`(png)、`image/jpeg`(jpg、jpeg)、`image/gif`(gif)、`image/webp`(webp)、`text/plain`(txt)、`text/csv`(csv)。同一张表决定允许的类型、扩展名一致性检查与存储键的扩展名。查表用 `Object.hasOwn`。
- 上限(S18、D18):单文件 `1..10485760` 字节(`Number.isSafeInteger`);每任务 ≤ 20 个(**自有读法**:计入该任务全部未删、已绑定的附件,含评论附件,因为两者都显示在附件栏);每条评论 ≤ 5 个且合计 ≤ 25MB;`refs` 批量解析 ≤ 200 个 id,按**原始数组**的长度算,在去重和逐个校验之前(S21 引的审批先例就是这样);未绑定行 168 小时过期(S19)。
- MIME 参数:声明类型先小写、去首尾空白;带参数(如 `text/plain; charset=utf-8`)视为不在白名单(与审批先例一致,单测钉住)。

| 导出 | 调用方须先加载 | 结果 |
|---|---|---|
| `validateAttachmentCandidate({mimeType, fileName, sizeBytes, head})` | 上传的字节(`head`,至少前 16 字节,必填) | `{ok:true, mimeType, storageExtension}` 或 `invalid_size` / `file_too_large` / `mime_not_allowed` / `extension_not_allowed` / `extension_mime_mismatch` / `content_mime_mismatch` |
| `normalizeAttachmentDisplayName(raw)` | — | 规范化显示名或 `invalid_name` |
| `deriveTaskAttachmentStorageKey(mimeType, now, suffix)` | 调用方生成的随机后缀 | `task-attachments/<yyyy-mm>/<suffix>.<ext>`(UTC 月份) |
| `authorizeTaskAttachmentDownload({row, viewerId, viewerOrgId, roles})` | 附件行;调用者对所属任务的角色 | `allow` / `not_found` / `gone` |
| `canAddAttachment(roles, bindKind)` | 调用者角色 | 布尔 |
| `canRemoveAttachment({roles, isUploader, bindKind})` | 同上 | 布尔(没有 `view` 一律假) |
| `planRemoveAttachment({row, actorId, roles, now})` | 附件行;调用者角色 | `not_found` / `forbidden` / 成功(已绑定 ⇒ `attachment_removed`) |
| `planAttachmentAddedEvents({taskId, attachmentIds, bindKind, actorId, now})` | — | 每个附件一条 `attachment_added` |
| `planCommentAttachmentBind({attachmentIds})` | — | 去重后的 id;或 `invalid_ids` / `limit` |
| `checkCommentAttachmentTotals(sizes)` | 待绑定行的字节数 | `limit`(> 5 个或 > 25MB) |
| `checkTaskAttachmentQuota({existingCount, adding})` | 该任务已绑定附件数 | `limit`(> 20) |
| `parseAttachmentRefIds(raw)` | — | 去重后的 id;或 `invalid_ids` / `limit`(原始数组 > 200) |
| `buildTaskAttachmentDownloadHeaders({mimeType, fileName})` | — | 四个响应头 |
| `isUnboundAttachmentExpired({createdAt, now})` | — | 布尔 |

规则:
- 候选校验顺序:大小 → MIME 在白名单 → 扩展名在白名单 → 扩展名与 MIME 一致 → 内容。签名判定用 `services/imageMagicBytes.ts` 的 `sniffImageContentType` 加 `%PDF` 头。pdf/png/jpeg/gif/webp **必须**有一致的签名(`head` 缺签名、或识别出别的类型,都拒绝;识别为 BMP 而声明为 png 的同样拒绝)。
- txt/csv 的内容判定(**自有规则**,S18 只要求图片与 PDF 带签名):问的是「这些字节是不是图片或 PDF」,不是「开头几个字节像不像某个签名」。拒绝的只有两种:开头是 PDF 的 `%PDF`(PDF 头本身就是文本,能凭的只有它);或者共享嗅探器认出某种图片签名,**并且**前 16 个字节里有文本不会出现的字节(NUL,或 TAB、LF、FF、CR 以外的 C0 控制符)——真正的图片文件头在这个范围里都有这样的字节(PNG 签名自带的 0x1A、JPEG 的段长、GIF 的画布尺寸、10 MiB 以内 WEBP 的 RIFF 长度、BMP 的保留零)。所以以 `BM`、`GIF8` 开头的普通文字(如 `BMI,Height`、`BMW sales`、`GIF89a is a format`)照收;没有任何可识别签名的字节,即使含 NUL(例如 UTF-16 文本)也不因内容被拒。
- 显示名:超过 255 时按**码点**截断(D5 写的是 `slice(0,255)`,按 UTF-16 单元算;这里的差别见 §3 偏离 16),再走 `normalizeUserText` 与显示名卫生;截断时如果名字以白名单里的扩展名结尾,只缩短主干、保留 `.扩展名`(原样大小写),这样保存下来的名字仍带着上传时与类型核对过的那个扩展名。不合格 ⇒ `invalid_name`。
- 存储键:前缀 `task-attachments/`(S22);后缀名由校验通过的 MIME 类型决定,与上传时的文件名无关;随机部分由调用方注入;月份按 UTC 取。
- 行状态与 `boundAt` 必须一致:`unbound` 没有 `boundAt`,`bound` 必有;`deleted` 两者皆可(绑定前或绑定后被删)。不一致的行视为数据损坏,下载判定与移除计划都抛 `TypeError`。
- 下载判定顺序(S21):① 调用者或行的 org 为空、或两者不同 ⇒ `not_found`;② 从未绑定过的行只有上传者可下,其余 ⇒ `not_found`(空的 viewer 永远不等于空的上传者);③ 已绑定的行要求 `can(roles,'view')`,否则 `not_found`;④ 只有过了 ①–③,`deleted` / `infected` 才返回 `gone`(410)。所属任务已不存在或已软删时,调用方传 `['none']`。资源面(`authenticate` + `rbacGuard('tasks','read')`,403)与存储不可用(503,在 ①–③ 之后)由路由负责。
- 响应头(S21、D6):`Content-Type` = 存储的 MIME(必须在白名单内,否则 `TypeError`);`Content-Disposition: attachment; filename="<ASCII 回退名>"; filename*=UTF-8''<RFC 5987 编码>`(回退名不含 `"`、`\`、控制字符和非 ASCII;`filename*` 对 attr-char 之外的字节一律百分号编码,含 `'` `(` `)` `*`);`X-Content-Type-Options: nosniff`;`Content-Security-Policy: default-src 'none'`。从不 `inline`、从不签名 URL。
- 角色(S20):往任务上直接加附件要 `can('attach')`;在评论里加要 `can('comment')`;查看与下载要 `can('view')`。移除的前提是对所属任务有 `view`:没有就答 `not_found`,和附件不存在时一模一样,上传者也不例外(锁 §5.1;所属任务已删时调用方传 `['none']`,所以谁也删不掉,S23 要求这些附件留着)。有 `view` 之后:上传者能移除自己传的(哪种绑定都行);持 `attach` 的人还能移除直接挂在任务上的那一类;评论里的附件,除了上传它的人,别人都不能移除(有 `view` 但不许移除 ⇒ `forbidden`)。从未绑定的行没有所属任务,与角色无关:只有上传者能移除,别人得到同样的 `not_found`。
- 移除计划不接收 org:路由必须只在会话 org 内加载附件行(审批先例的移除路由同样如此),别的 org 的行到这里就是 `null`。
- 评论绑定(S19):`attachmentIds` 去重后 ≤ 5;每个 id 过 `isValidTaskDomainId`(本件不生成 `tatt_` id,见 §3 偏离 1);真正的绑定 UPDATE 与 rowCount 比对在 PR-4b 的路由事务里。
- 任务软删不动附件(S23):本模块没有「随任务删除附件」的函数。
- M5 没有扫描引擎:`scan_state` 只写 `unscanned`(S22);`infected` 只在下载判定里按 410 处理。

### 2.7 `task-projection.ts`(S01–S08、S36、E08、E09、D7、D9)

id(S03、E08):

| 导出 | 规则 |
|---|---|
| `deriveTaskProjectionBaseId(orgId, sha256Hex)` | `base_tsk_proj_<sha256(orgId) 前 32 位十六进制>`;`orgId` 过 `isValidPrintableAsciiId`,不 trim;`sha256Hex` 由调用方注入,输出必须匹配 `^[a-f0-9]{64}$` |
| `deriveTaskProjectionSheetId(listId)` | `sht_tsk_proj_<listId>`;`listId` 必须匹配 `^tlst_[A-Za-z0-9]+$`(保证推导结果一定过 sheet 候选正则) |
| `deriveTaskProjectionRecordId(listId, taskId)` | `rec_tsk_<listId>__<taskId>`;拒绝 `parseTaskProjectionRecordId` 会拒绝的一切,双向往返单测 |
| `deriveTaskProjectionFieldId(sheetId, key)` | `<sheetId>__<key>`;key 为内置列键或 `tfld_` 形字段 id(两处都带标记:字段 id 形 RULED [S03];`tfld_` 前缀 RULED [S30],前缀暂时写死在此处的安排标 ASSUMPTION [D13]) |
| `isTaskProjectionBaseIdCandidate(id)` | `^base_tsk_proj_[a-f0-9]{32}$` |
| `isTaskProjectionSheetIdCandidate(id)` | `^sht_tsk_proj_tlst_[A-Za-z0-9]+$` |

这两条正则只在这里写一次,PR-4c 的两条 create 路由用它们做拒绝(S03)。投影记录 id 本身不带任何权限:从中拆出的 `(listId, taskId)`,任务 API 仍要照常鉴权(D21,属路由规则)。

列目录与视图(D7、S05):

| 键 | 类型 | 说明 |
|---|---|---|
| `title` | string | |
| `status` | select(`open`、`done`) | |
| `assignees` | person | 升序 |
| `creator` | person | |
| `startDate` / `dueDate` | date 或 dateTime | 清单内全是全天任务 ⇒ `date`;有任一定时任务 ⇒ `dateTime`。dateTime 列里:带时刻的取任务时区下该时刻;不带时刻的截止取当天 23:59:59.999(经 `computeDueAt`,与 `due_at` 一致);不带时刻的开始取当天 0 点(同一换算,见下) |
| `completedAt` | dateTime | |
| `isMilestone` | boolean | |
| `taskVersion` | number,只读 | = 投影时的 `tasks.version`(S06 / S08) |
| `dependencies` | 自表 link | 只投同清单内的前置;另输出要写进 `meta_links` 的行 |
| `listGroup` | select | 清单内分组名 |
| 自定义字段 | 按 S25 映射 | select/multiSelect 投 label(id → label);member → person;date → date;number → number;text → string |

- 不带时刻的开始(**自有选择**,§3 偏离 17):dateTime 列里取任务时区当天的第一个时刻(00:00:00.000,与 `due_at` 同一套墙钟换算)。这样全天任务覆盖它的整天,不带时刻的开始也不会落在同一天带时刻的截止之后(甘特条不会倒置或长度为零)。
- `resolveTaskProjectionDateColumnType(tasks)` 按上表规则选 `date` / `dateTime`;`taskProjectionColumns({listId, dateColumnType, groupNames, boundFields})` 给出整张表的列(内置键见 `TASK_PROJECTION_BUILTIN_KEYS`,显示名为自有选择)。
- 绑定字段的类型必须在 S25 的六型闭集里:`taskProjectionColumns` 与 `projectTaskRow` 用同一个检查,闭集之外一律 `TypeError`,列与行不会各执一词。
- `TASK_PROJECTION_VIEW_MARKER = 'taskProjectionView'`;`buildTaskProjectionViewSpecs(listId)` 给出 grid / kanban(按 `status` 分组)/ gantt(`startDate` → `dueDate`,依赖列 `dependencies`)三个视图规格,config 里都带标记键(D7)。
- `projectTaskRow(input)` ⇒ `{recordId, data, links, digest}`;`taskProjectionNoopDigest(projected, sha256Hex)` = 对 `projectTaskRow` 产出的 `{data, links}` 做规范化序列化(对象键排序)后的 sha256。集合语义的数组(负责人、依赖、links)在行里就已排好序;自定义多值字段保持存储顺序(它的顺序本身是可见内容)。摘要相同 ⇒ 服务层跳过 `meta_records` / `meta_links` 写入,但仍要把映射行的 `projected_version` 更新到当前 `tasks.version`(D9,服务层规则)。

能力与可见性(S01、S02、S06、S36):

| 导出 | 规则 |
|---|---|
| `TASK_PROJECTION_DENIED_CAPABILITY_KEYS` | 九个写键(与 e-learning 投影同一组) |
| `restrictTaskProjectionCapabilities(capabilities, isProjectionSheet, viewerListRole, listArchived)` | 非投影 sheet 原样返回;投影 sheet:九个写键全假(**没有 admin 参数**,对所有人一样),`canRead` = 调用者是清单成员,`canExport` 恒假,`canManageViews` = 清单 edit/owner 且清单未归档;原对象里没有的键不新增 |
| `taskProjectionInteractionCanEdit(viewerListRole, listArchived)` | 清单 edit/owner 且未归档(S06、S36(c)) |
| `isTaskProjectionRowReadable({viewerListRole, taskDeleted, taskListed})` | 成员 ∧ 任务未软删 ∧ 任务仍在该清单(S02 两臂;撤权与软删即刻生效,不等 reconcile) |

`viewerListRole` 是调用方算好的「会话租户下的清单角色」:清单 org ≠ `req.authenticatedTenantId`、或调用方没有租户上下文时,一律传 `null`(S01、S02 的租户合取在调用方发射)。

### 2.8 `task-export.ts`(S10、D11)

| 导出 | 规则 |
|---|---|
| `TASK_EXPORT_FORMATS = ['csv']`、`parseTaskExportFormat(raw)` | 只认 `csv`(缺省即 csv);其余 `unsupported_format`(不做 xlsx) |
| `taskExportFileName(listId)` | `task-list-<listId>.csv`;`listId` 不合格 ⇒ `TypeError` |
| `formatTaskExportCell(value, column, ctx?)` | `null` ⇒ 空;数组 ⇒ `, ` 连接;person 列按 `ctx.userLabels` 映射显示名、依赖列按 `ctx.recordTitles` 映射任务标题(缺省都用原 id);其余按 `stringifyCsvValue` |
| `buildTaskExportCsv({listId, dateColumnType, groupNames, boundFields, rows, userLabels?})` | 列 = `task-projection.ts` 的 `taskProjectionColumns`(单一来源),行 = `projectTaskRow` 的输出;CRLF;正文前加 UTF-8 BOM(与审批导出先例一致) |

规则:
- 单元格里只要有任务作者写的文字(表头也算),前导 `=` `+` `-` `@`、TAB、CR、LF 一律交给共享 helper `services/csv-cell.ts` 的 `sanitizeCsvCell` 中和;本模块不另写中和或引号逻辑。投影 sheet 的多维表导出由 `canExport` 恒假关闭(S10)。
- 数值列(**自有选择**,§3 偏离 18):值是字段编解码能产出的数(有限、|x| < 1e15)时,原样写成数,只经共享的 `quoteRfc4180` 加引号、不做前导中和,所以 -5 在表格软件里仍是数而不是文本 `'-5`。这样的值的文字只有数字、正负号、小数点与指数,不可能是作者写的文字。数值列里的其他值(数字字符串、越界的数)以及其他列里的数,照常经 `sanitizeCsvCell`。
- dateTime 列(**自有选择**,§3 偏离 19,§7 问题 2):单元格保持投影值,即 UTC 的 ISO 时刻;表头在列名后加 ` (UTC)` 注明。裁决包没有规定导出用哪个时区。`date` 列(全天的开始/截止、日期型字段)是不带时区的民用日期,表头不加注。

### 2.9 上限与超限的答复

D18 列出的每一项都在单点定义,超限答 `limit`(路由映射为 422 `LIMIT`);唯一例外是重复规则的 `count`(见 §3 偏离 15)。S28 另有几项不在 D18 的清单里,答复码按各自的规则:

| 上限 | 出处 | 函数 | 超限答复 |
|---|---|---|---|
| 每任务前置 + 后置 ≤ 50 | D18 | `validateAddDependency` | `limit` |
| 重复 `count` 1..365 | S14 / D18(两处冲突) | `parseRecurrenceRule` | `invalid_recurrence`(`field: 'count'`),取 S14 |
| 重复 `interval` 1..365 | S14 | `parseRecurrenceRule` | `invalid_recurrence`(`field: 'interval'`) |
| 每 org 字段定义 ≤ 200 | D18 | `checkFieldDefinitionQuota` | `limit` |
| 每清单绑定 ≤ 50 | D18 | `applyBindField` | `limit` |
| 每字段选项 ≤ 100 | D18 | `parseFieldDefinition` | `limit` |
| 选项 label ≤ 100 码点 | S28 | `parseFieldDefinition` | `invalid_config` |
| 字段名 ≤ 100 码点 | 自有选择 | `parseFieldDefinition` | `invalid_name` |
| 文本值 ≤ 2000 码点 | D18 | `validateFieldValue` | `limit` |
| 文本值 ≤ 本字段 `maxLength` | D10 | `validateFieldValue` | `too_long` |
| `text` 的 `maxLength` 配置 1..2000 | D10 | `parseFieldDefinition` | `invalid_config` |
| 成员值 ≤ 50 人 | S28 | `validateFieldValue` | `limit` |
| 数值 \|x\| < 1e15 | S28 | `validateFieldValue` | `out_of_range` |
| 单文件 ≤ 10 MiB | S18 | `validateAttachmentCandidate` | `file_too_large` |
| 每任务附件 ≤ 20 | D18 | `checkTaskAttachmentQuota` | `limit` |
| 每条评论附件 ≤ 5 个 | D18 | `planCommentAttachmentBind`、`checkCommentAttachmentTotals` | `limit` |
| 每条评论附件合计 ≤ 25 MiB | S18 | `checkCommentAttachmentTotals` | `limit` |
| `refs` ≤ 200 个(原始数组) | S21 | `parseAttachmentRefIds` | `limit` |
| 显示名 255 | D5 | `normalizeAttachmentDisplayName` | 截断,不拒绝 |

## 3. 偏离与说明

这是完整清单:验证记录 §5 记下的每一条都在这里,编号一致。

1. **调用方要求与裁决包冲突之一:`task-ids.ts` 与 `task-notifications.ts` 没有改(未完成调用方列出的最后一步)。** 调用方的任务说明把两处字面量改动(`TASK_NOTIFIABLE_EVENTS` 里添上 `attachment_added`,`TASK_ID_PREFIXES` 里添上 `tfld` 与 `tatt`)列为任务 E 的最后一步;裁决包把这两处放在任务 E 之外(分别归 PR-4b S5 与 PR-4a S0),理由是:`task-notifications.ts` 不在 main 上(只在 #6186 与 PR-3a 分支),在本分支新建它会与 #6186 冲突并让通知闭集有两个出处;#6186 正在改 `task-ids.ts` 里同一处字面量对象(加 `tgrp` / `tlev`)。S32 的推荐值(任务 E 只建新文件)也指向不改。后果:本件不生成 `tfld_` / `tatt_` id,入站 id 一律只过 `isValidTaskDomainId`;以后补上只需在 `TASK_ID_PREFIXES` 加两个键并补 `task-ids` 单测。**状态**:协调方 2026-10-07 接受按裁决包处理——两处都留在任务 E 之外(协调方的处理意见,当时不是 owner 裁决);2026-10-09 S32 获 owner 取推荐值(任务 E 只建新文件),这一处理与之一致。
2. **新增 `task-civil-date.ts`。** 调用方列出的模块里没有它;S32 子项有它。按天、按周推算下一期要用到它。
3. **已撤回:`task-fields.ts` 不再用 `multitable/field-codecs.ts`。** 第一版按调用方提示复用了 `classifySelectCellValue`、`normalizeMultiSelectValue`、`validatePersonValue`,这与裁决包的复用说明和 D16 的导入范围冲突;协调方 2026-10-07 改为以裁决包与 D16 为准(协调方的改判,不是 owner 裁决)。现在三个分支在模块内实现(§2.5),加载 `src/tasks/` 不再连带加载 `sanitize-html` 或构造 logger。本模块树的外部导入只剩 D16 的 `utils/calendar-date`、`services/imageMagicBytes`、`services/csv-cell`,以及没有 import、加载时不做任何事的 `multitable/display-name-hygiene`(D5 点名的显示名卫生,字段名也用它)。`task-m5-probe.test.ts` 的静态 import 图遍历把这一条钉住(§4)。
4. **不引入 `crypto`。** base id 与 no-op 摘要都需要 sha256;两处都由调用方注入 `sha256Hex`(同 `task-ids.ts` 注入随机源的做法),模块校验其输出形状。
5. **签名调整**(相对裁决包列出的签名):`canRemoveAttachment` 用 `{roles, isUploader, bindKind}`(S20 的评论级规则需要绑定类型;`isCreator` 已被 `roles` 覆盖);`restrictTaskProjectionCapabilities` 用 `(capabilities, isProjectionSheet, viewerListRole, listArchived)`(S36(c) 需要归档输入;`isMember` 与 `listRole` 合并为一个可空角色);`applySetRecurrence` / `applyClearRecurrence` 多一个 `taskId`(事件要落在哪个任务上)。
6. **`task-dates.ts` 里一条注释会变旧。** main 上 `validateViewerTimeZoneHeader` 的注释说,本模块树对外只准导入 `isValidIanaTimeZone`;任务 D 已在 #6186 把它改成逐文件表述。本件不改那条注释;本件新增的外部导入逐个写在各模块抬头(D16)。
7. **`dependencyCandidates`** 是自有扩展(见 §2.2;另外排除会成环的候选)。S11 现已裁,已裁文字对候选只列了两类排除(自身,以及已经存在的边),所以这一扩展是在已裁文字之上收窄候选集;源码标 `ASSUMPTION(task-e, own choice)`,待 owner 表态。
8. **仓库级守卫的一次命中**:第一版 `taskProjectionNoopDigest` 里的 `data: row.data` 被 raw record-data projection 守卫匹配;参数改名为 `projected` 并解构后通过,行为不变。PR-4c 真正把 `data` 写进 `meta_records` 的那一处若被该守卫匹配,应在它的白名单里按 WRITE-PATH 登记。
9. **清单角色**沿用 `task-access.ts` 的 `TaskListMembership['role']`(`'editor' | 'reader'`),没有引入任务 D 的 `read/edit/owner` 枚举(任务 D 不在 main);清单 owner 由调用方桥接为 `'editor'`。
10. **`'x'` 探针**是在门 20 之上新增的更严断言(§4),不是对门 20 的修改。(门 20 harness 本身在本轮另有改动,见第 14 条。)
11. **锚点 × S17(c) 是待 owner 裁的问题**(§7 问题 1)。当前代码按默认值 (a) 实现并标为自有选择,不是已定。
12. **给后续 PR 用、本模块内没有读者的常量**:`TASK_ATTACHMENT_LIMITS.maxRefBodyBytes`、`TASK_ATTACHMENT_INITIAL_SCAN_STATE`、`TASK_PROJECTION_SYSTEM_KIND`、`TASK_PROJECTION_SYSTEM_OWNER`、`TASK_PROJECTION_VIEW_KINDS`。它们由单测钉值,但要到 PR-4b / 4c 才有生产读者。
13. **`tfld_` 前缀暂时写死**在 `task-projection.ts` 的字段 id 校验里(带 `[S30][D13]` 标记);PR-4a S0 往 `TASK_ID_PREFIXES` 加 `field: 'tfld'` 后,应改为从那里派生(后续项)。
14. **本件改了一个 main 上已有的文件:门 20 的 harness**(`tests/unit/task-pure-no-io.test.ts`),与 S32(任务 E 不改已有文件)不符;这是唯一一处例外,已获 owner 同意(下文)。原因:闸方复审发现门 20 只在调用撞上数据库桩时才红,任何引号写法的 `pg` 或 `db/` 导入都过得去,而锁里的静态规则只是 harness 之外的一条 grep;调用方要求在本分支一并补全。改动只加单元格:从 `src/tasks/` 的每个文件出发、沿相对 import 一路读下去,模块说明符从 TypeScript 语法树取(import / export 声明含仅类型与再导出、`import x = require()`、`import()` 类型、动态 `import()` 与 `require()` 调用、经名为 `require` 的成员调用,引号不限,模板字面量也算),遇到包导入、进入 `db/` / `integration/db/` / `data-adapters/` 的相对导入、非字面量说明符、`require` 被当作值使用(别名、参数、`{ require }`)、解析不到 `.ts` 文件的导入即红;每种写法各有一格对照,另有一格反向对照(注释、字符串,以及只是名叫 `require` 的属性或类型成员都不算)。读不到的:运行时拼出来的模块名(`eval`、`new Function`、用字符串拼成的属性名)。原有五格一字未动,检测只会更严。同一规则在 main 与在飞的任务分支(任务 D、PR-3a、PR-3b、R01 锁、M3 后端)上逐一跑过,全部为零违规。**这一改动让一个已 ratify 的门的判据变严**(锁 §12 门 20):按新规则,`src/tasks/` 里的仅类型包导入、Node 内置模块、非字面量说明符都会让门 20 变红,而锁里的静态规则 (A) 只管 `db/` 相对导入。owner 2026-10-09 同意这一加严,§7 问题 4 关闭。
15. **重复规则 `count` 超过 365 答 `invalid_recurrence`(取 S14),不答 D18 的 `LIMIT`。** 裁决包里这两处冲突:S14 把 `count: 1..365` 写进规则闭集并规定越界答 `INVALID_RECURRENCE`,D18 又把重复次数的 365 上限放进超限答 `LIMIT` 的那份清单。取 S14 的理由:S14 是专门定义规则闭集和它的错误码的那一条,而且同一个范围的下界(`count: 0`)只能是 `invalid_recurrence`,若取 D18,同一个键会因为越界方向不同而答两种码;`invalid_recurrence` 还带 `field: 'count'`,`limit` 没有。D18 那一行只是汇总 S28 的数值。owner 若取 D18,只需改 `parseRecurrenceRule` 的一行与一格单测(§7 问题 3)。2026-10-09 之后:S14 已裁,其文字规定越界答 `INVALID_RECURRENCE`;D18 没有被 2026-10-09 的裁定点名,仍是默认约束,把同一个上限放进答 `LIMIT` 的清单。两者对 `count` 仍不一致,owner 没有就这一点表态,缺省不变(当前代码与已裁的 S14 文字一致)。
16. **附件显示名按码点截到 255**,D5 写的是 `originalname.slice(0,255)`(UTF-16 单元)。按码点截不会切开代理对;代价是全为 astral 字符的名字最多保留 255 个,即 510 个 UTF-16 单元。截断时保留白名单扩展名(§2.6)是在 D5 之上的自有补充,目的是让保存的名字仍与上传时核对过的类型一致。
17. **dateTime 列里,不带时刻的开始取当天 0 点**(§2.7)。S05 与 D7 让混合清单里不带时刻的值一律取任务时区当天最后一毫秒,开始与截止两列都这样写,依据是与 `due_at` 保持一致;`due_at` 只有截止才有,所以截止照旧,开始改取当天第一个时刻。owner 若要字面读法,改 `projectDate` 的一行与对应单测即可。S05 现已裁,它对混合清单的文字就是开始与截止都取任务时区当天最后一毫秒,所以这一处现在是对已裁文字的偏离(源码标 `ASSUMPTION(task-e, own choice)`),待 owner 表态。
18. **导出时数值列的编解码数值不做前导中和**(§2.8)。D11 写的是每格都经 `sanitizeCsvCell`;S10 的规则对象是含作者文字的格,编解码产出的有限数不含作者文字。其余各格(含数值列里的非数值)仍经 `sanitizeCsvCell`。S10 现已裁,其文字引用了 D11 的逐格中和(含表头);数值列的这一例外因此也是对已裁文字的偏离,待 owner 表态。
19. **导出的 dateTime 格按 UTC 输出,并在表头注明 `(UTC)`。** 裁决包对导出时区没有规定;这是暂定做法,备选列在 §7 问题 2。
20. **txt/csv 的内容判定是自有规则**(§2.6):S18 只要求图片与 PDF 带一致的签名。第一版对文本类型「识别出任何签名就拒绝」,会把以 `BM`、`GIF8` 开头的正常文本误拒;现在只拒绝确实是图片或 PDF 的字节。

## 4. 门 20 与 `'x'` 探针

门 20 的 harness 原先只断言「没有调用到数据库桩」:任何非桩错误或任何返回值都算通过,所以它不能证明「用 `'x'` 调用时抛 `TypeError` 或返回否定结果」,也看不见一条从未被调用的导入。本件另加 `tests/unit/task-m5-probe.test.ts`:按门 20 同样的占位规则(参数名含 query/executor/client/db 的位置给异步抛出器,其余给 `'x'`)调用八个新模块的每一个函数导出,断言它抛 `TypeError` / `RangeError`,或返回否定结果(`false`、`null`、空数组、`{ok:false}`);`'x'` 本身就是合法输入的少数导出列在一张显式表里,逐个钉住它们的确切输出。

为此所有导出在入口处做类型检查。所有注入的可调用参数都不以 query/executor/client/db 命名。

同一个测试文件还做一次静态 import 图遍历(D16):从八个新模块出发,沿相对 import 一路走下去,到达的文件只能在 `src/tasks/` 里,或在一张短名单上(`utils/calendar-date`、`services/imageMagicBytes`、`services/csv-cell`、`multitable/display-name-hygiene`,以及经 `task-dates.ts` 到达的 `multitable/automation-timezone`);整张图里出现任何包导入、非字面量说明符、被当作值使用的 `require` 或解析不到的导入即失败。说明符从 TypeScript 语法树读取(第一版用的正则只认单引号,双引号写法会漏,闸方复审指出):import / export 声明、`import x = require()`、`import()` 类型、动态 `import()` 与 `require()` 调用、经名为 `require` 的成员调用(`module.require(...)` 之类),引号不限,模板字面量也算;注释和字符串内容不算。读不到的是运行时拼出来的模块名(`eval`、`new Function`、用字符串拼成的属性名)。每种写法各有一格对照,另有一格反向对照。两个正控:遍历是传递的(从 `task-recurrence.ts` 能走到 `automation-timezone`);对 `multitable/field-codecs.ts` 遍历会报出它的包导入。

门 20 的 harness 本轮加了一个静态部分(§3 偏离 14),规则与上面同源,但只禁不列:不要求到达的文件在短名单上(那是任务 E 自己的 D16 约束),只禁止包导入、进入数据库层的相对导入、非字面量说明符和被当作值使用的 `require`,因此对 main 与在飞分支上的其他任务模块同样适用。它让门 20 的判据比锁里写的更严,见 §7 问题 4(owner 已于 2026-10-09 同意,问题关闭)。

## 5. 标签计划与计数(2026-10-09 之后)

标签规则(owner 2026-10-09 裁定之后):

- 取值由 S 编号决定的 ⇒ `RULED(2026-10-09): [Sxx]`。测试用例标题里写成 `(RULED(2026-10-09): [Sxx]; ASSUMPTION(task-e): [Dyy])` 的形式。
- D 编号(闸方给的默认约束)在 2026-10-09 的裁定里没有点名 ⇒ 保持 `ASSUMPTION(task-e): [Dxx]`;一条注释里 S 与 D 并存时拆成两段,各带各的标记。
- 自有选择(逗号形 `ASSUMPTION(task-e, own choice)`)与 §7 的三个待裁问题 ⇒ 保持 `ASSUMPTION`。重复规则 `count` 的 `[S14][D18]` 因挂着问题 3 整条不动(S14 本身已裁),注释里补了一句说明。
- 本次没有改任何取值或代码:源码与测试去掉注释与用例标题之后的编译产物,与 `82eea91fc3` 逐字相同(验证记录 §8)。

计数(按字面 token 的出现次数;源码 8 个文件加测试 11 个文件):

| | RULED | ASSUMPTION(D 编号,另加 `count` 那一条的 S14) | 自有选择 | 合计 |
|---|---|---|---|---|
| 源码 | 54 | 20 | 25 | 99 |
| 测试 | 31 | 10 | 4 | 45 |
| 合计 | 85 | 30 | 29 | 144 |

落槌之前是 126 个(98 个 `ASSUMPTION(task-e): [..]` 加 28 个自有选择)。变化:68 个纯 S 的标记改标,17 条 S 与 D 并存的拆成两段(各多出 1 个标记),源码里 number 字段 percent 格式不投影的括注原本藏在 S25 那一条里、现在单列为自有选择(多出 1 个):126 + 17 + 1 = 144。

按模块(源码;括号里是出现次数):

| 模块 | RULED | ASSUMPTION 剩余 | 自有选择 |
|---|---|---|---|
| `task-civil-date.ts` | S32 | — | — |
| `task-dependencies.ts` | S11(3)、S12、S28 | D4、D17、D18 | 1:候选排除成环项 |
| `task-milestone.ts` | S13 | — | — |
| `task-recurrence.ts` | S14(2)、S15、S16、S17(2) | D3、D18;S14〔与 D18 同条,挂问题 3〕 | 4:周一为一周之始与锚点定义〔待 owner 裁,§7 问题 1〕、`count` 含第一期与 `until` 含当日、`end: null` 不算「无结束」、先校验规则再查截止日 |
| `task-fields.ts` | S24、S25(2)、S26(5)、S27、S28 | D10(2)、D18(2) | 7:字段名上限、成员 id 长度上限、color 形状、类型不可改、`''` 清空、id 按原样比较、可见分组的排序 |
| `task-attachments.ts` | S18(3)、S19(4)、S20(2)、S21(4)、S22(2) | D5(2)、D6、D18 | 5:txt/csv 的内容判定、MIME 参数、显示名按码点计数、截断时保留扩展名与为空时拒绝、每任务上限的计数口径 |
| `task-projection.ts` | S01(2)、S02、S03(5)、S05(2)、S06(2)、S08、S25、S30、S36(2) | D7(4)、D9、D13 | 4:列显示名、视图显示名、percent 格式不投影、不带时刻的开始取当天 0 点 |
| `task-export.ts` | S10 | D11(2) | 4:BOM、数组连接符与显示名映射、dateTime 列按 UTC 并在表头注明、数值列的编解码数值不中和 |

已裁的 S 编号里,源码没有任何标记的有 S04、S07、S09、S23、S29、S31、S33、S34、S35、S37:它们属于后续 PR(路由、服务、迁移、门表、调度)或本件明确不做的部分(§6)。

## 6. 不在本件

- 一切 I/O:DDL、迁移、路由、服务、前端、开关与 manifest、调度作业、真库与 staging 验证。
- 锁序包装器(S09)、deny sibling 的 SQL 生成器(S02 的 SQL 臂改 `task-access.ts`,属 PR-4c 且需 owner 确认)、TS/SQL 对拍。
- 门表行(S31)、DML 普查闸(S37)、富文本(S29,推荐不做)、cursor 分页(S34)。
- 依赖对完成的阻断(S12 推荐不阻断)。

## 7. 待 owner 裁的问题

2026-10-09 的落槌不覆盖问题 1–3,三者仍待裁,缺省不变;问题 4 已关闭。

### 问题 1:改了当前实例的截止日或规则,后续各期怎么算?(S14 × S17(c))

S14 的推荐值要求按月 / 按年步进不漂移(01-31 → 02-28 → 03-31,而不是 → 03-28);S17(c) 的推荐值:编辑当前这一期(规则或截止日)只作用于以后派生的各期,步进起点是当前这一期。两条放在一起,对「按月(未写 `byMonthDay`)」和「按年」的规则有不同读法:

| 选项 | 做法 | 按天 / 按周 | 按月(未写 `byMonthDay`)/ 按年 | 代价 |
|---|---|---|---|---|
| **(a) 默认,当前代码** | 锚点 = 系列第一期的 `due_date`;步数从当前实例算,日(按年还有月)取自锚点 | 跟着改过的日期走 | 不跟:当前实例从 31 日改到 15 日,下一期仍是 31 日(或月末);按年从 2 月 10 日改到 3 月 1 日,下一期仍是 2 月 10 日 | 用户改了日期,后续却不变;按月只能靠写 `byMonthDay` 换日子,按年没有办法换月日 |
| (b) | 锚点 = 当前实例 | 跟着走 | 跟着走 | 月末漂移回来:01-31 → 02-28 → 03-28 → … |
| (c) | 保留 (a) 的步进方式,但在设规则或改截止日时重写锚点:按月把新的日写进 `byMonthDay`,按年记下新的月日 | 跟着走 | 跟着走,且不漂移 | 按年需要一个存月日的地方:规则闭集加键(S14 改动)或加列(DDL);服务层每个改截止日的写入点都要同步改规则 |

默认值:**(a)**,单测按 (a) 钉住(`task-recurrence.test.ts` 的按年用例)。owner 裁定之前,(a) 只是默认值,不是已定;源码在锚点处标 `ASSUMPTION(task-e, own choice)` 并指向本问题。若取 (b),只改 `nextOccurrenceDueDate` 的锚点来源与相应单测;若取 (c),另需 S14 闭集或 DDL 的改动,归 PR-4a。

同一算法下还有三类情形,裁决包没有给值,一并请 owner 看(示例都按当前代码算出,可复现):

(i) **当前实例不在规则日上时,按月 / 按年会跳过本期,按周不会。** 按月、按年的目标月(年)= 当前月(年)+ `interval`,不检查本月(本年)里是否还有晚于当前日的命中日;按周则先找本周里更晚的命中星期。
- 按月、`byMonthDay: 15`,当前实例 2026-01-05 ⇒ 下一期 2026-02-15(01-15 被跳过)。
- 按月、`byMonthDay: 'last'`,当前实例 2026-01-15 ⇒ 2026-02-28(01-31 被跳过)。
- 对照:按周、只在周五,当前实例是周一 2026-10-05 ⇒ 同一周的 2026-10-09。
- 备选:按月 / 按年改为「严格晚于当前日的第一个命中日(钳到月末)」,与按周一致,也不漂移;代价是改动 S14 的步进定义。

(ii) **把当前实例改到下一个周期里时,会跳过一整期。**
- 按月、锚点 2026-01-31,当前实例改到 2026-02-01 ⇒ 下一期 2026-03-31(2 月没有了)。
- 按年、锚点 2026-12-31,当前实例改到 2027-01-05 ⇒ 下一期 2028-12-31(2027 年没有了)。
- (i) 的备选同样能消除这一类。

(iii) **中途换规则时,锚点和 `count` 的起算点沿用系列原有的。** `applySetRecurrence` 允许在任何一期替换规则;`planSpawn` 始终从系列第一期的截止日取锚点,`count` 也从系列第一期数起。
- 每周一次、第一期截止 2026-01-05 的系列,在截止 2026-03-20 的那一期改成每月一次 ⇒ 下一期 2026-04-05(日取自第一期的 5 日,不是 20 日)。
- 在第 5 期设 `{freq: 'daily', interval: 1, end: {count: 3}}` ⇒ `planSpawn` 答 `series_ended`,新规则一期也不派生。
- 备选:`applySetRecurrence` 返回 `noop: false` 时,服务层把替换发生的那一期记为新的锚点与计数起点(要存它的截止日与序号;放在规则里还是加列归 PR-4a)。

### 问题 2:导出 CSV 的 dateTime 格用哪个时区?

裁决包没有规定。当前做法:保持投影值(UTC 的 ISO 时刻),表头写 `<列名> (UTC)`(§2.8,§3 偏离 19)。备选:(甲)按任务自己的时区写成 `YYYY-MM-DD HH:mm`,全天的只写日期——每行可能不同时区,需要另加一列时区;(乙)按导出者的时区写(路由读查看者时区头);(丙)维持现状。混合清单里全天任务的截止在 UTC 下常落到次日,当前做法靠表头提示,读者仍需自己换算。

### 问题 3:重复规则 `count` 越界答哪个码?

S14 与 D18 冲突(§3 偏离 15)。当前取 S14:`invalid_recurrence`,`field: 'count'`。若取 D18:超过 365 答 `limit`(0 仍是 `invalid_recurrence`)。S14 已裁、D18 未被 2026-10-09 的裁定点名,所以「已裁文字与默认约束不一致」这件事仍在;当前缺省与已裁的 S14 文字一致,owner 没有就 `count` 表态。

### 问题 4(已关闭,2026-10-09):门 20 的判据变严了

锁 §12 的门 20 已 ratify,它的过门判据是 harness 的行为部分,静态规则 (A) 只禁 `db/` 相对导入。本件按调用方指示给 harness 加了静态部分(§3 偏离 14):`src/tasks/` 的导入图里出现任何包导入(含仅类型导入与 Node 内置模块)、数据库层导入、非字面量说明符、被当作值使用的 `require`,门 20 都会红。main 与五个在飞任务分支目前都零违规。owner 已于 2026-10-09 同意这一加严,不再需要确认,也不退回只禁 `db/` 的旧口径。

## 8. 2026-10-08 修订(闸方复审)

- 文本值超过 2000 码点改答 `limit`(§2.5、§2.9)。
- 附件移除:对所属任务没有 `view` 的人一律 `not_found`,上传者也一样;`canRemoveAttachment` 没有 `view` 一律假(§2.6)。
- txt/csv 内容判定改为只拒绝确实是图片或 PDF 的字节(§2.6,偏离 20)。
- 显示名截断保留扩展名;行状态与 `boundAt` 必须一致;`refs` 上限按原始数组(§2.6)。
- 投影:不带时刻的开始取当天 0 点(偏离 17);绑定字段类型闭集在行投影里同样检查;两处补 ASSUMPTION 标记(§2.7)。
- 导出:数值列的编解码数值不中和(偏离 18);dateTime 表头注明 UTC(偏离 19,问题 2)。
- 进程时区:新增 `task-m5-time-zone.test.ts`(§2.1)。
- import 图:探针改读语法树,并能认出经成员调用与当作值使用的 `require`;门 20 harness 加静态部分(§4,偏离 14,问题 4)。
- 重复规则 `count` 的码按 S14(偏离 15,问题 3);问题 1 补三类情形。
- 本文里与裁决包重合的文字(含引号里的片段)全部改写,只留条目编号。

## 9. 2026-10-09 修订(owner 裁决之后)

- owner 2026-10-09 裁定:S01–S37 取推荐值;S32 第二句(PR-4a / 4b / 4c 在 M4 合并授权后起 Draft)同时获准,与本件无关。门 20 变严获同意(§7 问题 4 关闭)。§7 问题 1–3 不在这次裁定之内,仍待裁,缺省不变。
- 标签:68 个纯 S 的标记改为 `RULED(2026-10-09)`;17 条 S 与 D 并存的拆成两段(S 段 RULED,D 段仍 ASSUMPTION);重复规则 `count` 那一条整条不动并补了一句说明;percent 格式不投影单列为自有选择。计数见 §5。
- 取值与行为:没有改。源码与测试去掉注释与用例标题之后的编译产物,与 `82eea91fc3` 逐字相同;任务单测仍是 30 个文件、958 个用例(验证记录 §8)。
- 已裁文字与自有选择的交界,都仍标 `ASSUMPTION(task-e, own choice)`,待 owner 逐条表态:
  1. 偏离 17:不带时刻的开始取当天 0 点;已裁的 S05 写的是开始与截止都取 23:59:59.999。
  2. 偏离 7:候选集另外排除会成环的任务;已裁的 S11 只排除自身和已经存在的边。
  3. 偏离 18:数值列的编解码数值不经 `sanitizeCsvCell`;已裁的 S10 引用的 D11 写的是逐格中和。
  4. 偏离 20 的 txt/csv 内容判定,以及每任务 20 个附件的计数口径(含评论附件):都是在已裁的 S18 之上的读法或加严。
- S20 的 RULED 标签下有一句来自锁 §5.1 的限定(对所属任务没有 `view` 的人谁也不能移除,上传者也一样)。它比 S20 的字面(上传者本人在任何绑定下都可移除)更窄,注释里标明了出处。
- D3、D4、D5、D6、D7、D9、D10、D11、D13、D17、D18 在 2026-10-09 的裁定里没有点名,保持默认约束的身份。多数条目的 S 文字里已含同样的数值与规则;若 owner 认为它们随 S 编号一并获准,需要点名,之后改标只是机械替换。
