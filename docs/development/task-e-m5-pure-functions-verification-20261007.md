# 任务功能线 — 任务 E(M5 P2 纯函数)验证记录(DRAFT, 2026-10-07;2026-10-08 闸方复审修复;2026-10-09 owner 裁决后更新标签)

- **状态:DRAFT(指 Draft PR:只开 Draft,不合并)。** owner 于 2026-10-07 同意开启任务 E。owner 2026-10-09 裁定 S01–S37 各取推荐值:取值没有变,源码与测试里对应的标签由 `ASSUMPTION(task-e): [Sxx]` 改为 `RULED(2026-10-09): [Sxx]`;门 20 变严同日获同意,设计 §7 问题 4 关闭。这次裁定没有点名任何 D 编号,所以 `[Dxx]` 仍标 `ASSUMPTION(task-e)`,S 与 D 并存的拆成两段;自有选择不变。**设计 §7 问题 1–3(锚点、导出时区、`count` 越界码)仍待 owner 裁**,缺省不变。§2–§7 记下的单测与变异结果是 `82eea91fc3` 及其之前跑出的,原样保留;这几节的其他文字(含 §5、§6 里裁决之后的现状)在 2026-10-09 有过修订。标记计数(RULED / ASSUMPTION / 自有选择)与 2026-10-09 之后跑的检查见 §8。
- 分支:`claude/tasks-e-pure`,基于 `origin/main` `7137688372`,以 Draft PR #6249 推送(不合并)。分支的提交历史按 head 的树重建为单个提交,下文提到的本分支提交号都是重建之前的,只作溯源:`82eea91fc3` 与 `d6c84264ff` 推送到过 #6249,其余是第一次推送之前本地历史里的。2026-10-07 的最后一个提交是 `9b9ee2b6b7`;2026-10-08 按闸方复审修了一轮(§7),源码的最后一个提交是 `956c0c0c63`(只改一条注释),测试的最后一个提交是 `85fd2554fd`(复审之后自查补的 import 检查,§7.6),其后只有文档提交。下面每一项都注明是在哪个提交上跑的。
- 设计:`docs/development/task-e-m5-pure-functions-design-20261007.md`(偏离的完整清单在其 §3,编号与本记录 §5 一致)。
- 环境:Node 20.20.2,命令都在 `packages/core-backend/` 下用 `./node_modules/.bin/…` 运行,未跑 `pnpm install`。

## 1. 范围

相对 `7137688372`:

- 源码 8 个,全部新增:`src/tasks/task-civil-date.ts`、`task-dependencies.ts`、`task-milestone.ts`、`task-recurrence.ts`、`task-fields.ts`、`task-attachments.ts`、`task-projection.ts`、`task-export.ts`(共 3078 行)。
- 单测 11 个:10 个新增(每个模块一个 `tests/unit/task-<模块>.test.ts`,加 `task-m5-probe.test.ts` 与 `task-m5-time-zone.test.ts`),1 个改动:门 20 的 harness `tests/unit/task-pure-no-io.test.ts`(main 上已有;只加单元格,见 §5 第 14 条)。11 个文件共 3353 行。
- 文档 2 个:设计与本记录。

除门 20 的 harness 外没有改动任何既有文件(`task-ids.ts`、`task-notifications.ts` 不动,理由见 §5 第 1 条)。

## 2. 命令与结果

以下都在 `85fd2554fd` 上跑(源码与 `956c0c0c63` 相同)。

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查(CI 第一条) | `tsc --noEmit -p .` | exit 0,零输出 |
| 类型检查(CI 第二条) | `tsc -p scripts/tsconfig.recovery-archive-acceptance.json` | exit 0,零输出 |
| 改动的测试文件的类型检查 | 临时 tsconfig(继承 `tsconfig.json`,只 include 上面 11 个测试文件,`typeRoots` 指向包内 `node_modules`;放在仓外,未提交) | exit 0 |
| Lint | 在 `packages/core-backend/` 下跑 `eslint`(`.eslintrc.json`),8 个源文件 | exit 0,零问题 |
| 任务单测 | `vitest run tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts` | 30 个文件、958 个用例全部通过,见 §2.1 |
| 同上,换进程时区 | 同上,分别加 `TZ=UTC`、`TZ=Asia/Taipei`、`TZ=America/New_York` | 三次都是 30 个文件、958 个用例全部通过 |
| 门 20 | `vitest run tests/unit/task-pure-no-io.test.ts` | 35/35(原有 5 格 + 静态部分 30 格);harness 自动发现 `src/tasks/` 下 18 个文件 |
| `'x'` 探针 + import 图 | `vitest run tests/unit/task-m5-probe.test.ts` | 44/44,见 §2.2 |
| `Intl.DateTimeFormat` 钉 | `vitest run tests/unit/source-files-hourcycle-parsing-guard.test.ts` | 16/16(本件没有新增调用点) |
| flag manifest | `node --test scripts/ops/global-history-flag-manifest.test.mjs`(仓根) | 35/35(本件没有新增 `TASKS_*` 源码读点) |
| 全量单测 | `vitest run`(core-backend 全部) | 见 §2.3 |
| 外部导入核对 | `task-m5-probe.test.ts` 的 import 图遍历(语法树),另加 `grep` | 无 `pg` / 连接池 / `db/pg` / `crypto` / `Intl.DateTimeFormat`,无任何包导入;外部导入只有 `utils/calendar-date`、`services/imageMagicBytes`、`services/csv-cell`、`multitable/display-name-hygiene`(以及 main 上 `task-dates.ts` 已有的 `multitable/automation-timezone`) |
| 门 20 静态规则在其他分支上 | 同一规则(语法树读取、沿相对 import 走、禁包导入、数据库层、非字面量与被当作值使用的 `require`)对 `origin/main`、任务 D、PR-3a、PR-3b、R01 锁、M3 后端各分支的 `src/tasks/` 逐一跑(经 `git show` 读取,仓外脚本) | 全部零违规 |
| 有无地方钉住或列举改动的测试文件 | `git grep` `origin/main` 的 `.github`、`scripts`、`docs` 与包内脚本,找 `task-pure-no-io`、`task-m5-probe`、`task-m5-time-zone` | 只有几份历史文档提到门 20 的 harness(时点记录,不改);没有 workflow 或脚本按文件名、哈希或行号钉住它们。任务线的枚举测试只列举 `tests/integration` 下的 `*.db.test.ts`,与这些文件无关 |
| 裁决包重叠扫描 | 三次字面扫描:分别比对 M4 裁决包与 M5 裁决包各一次,另有一次同时比对两份裁决包的更严扫描 | 本分支改动的全部 21 个文件,三次都 exit 0(§7.4;2026-10-09 的重跑见 §8.3) |
| 提交说明 | 每条提交说明写进文件后逐字符检查(只许可打印 ASCII、换行、汉字与中文标点;无 BOM、无 U+FFFD),以 `-F` 提交 | 2026-10-08 的全部提交通过 |

### 2.1 任务单测

`task-*` / `tasks-*` 共 30 个文件、958 个用例全部通过(改动之前,`9b9ee2b6b7` 上是 29 个文件、838 个)。本件的文件:

| 测试文件 | 用例 |
|---|---|
| `task-civil-date.test.ts` | 18 |
| `task-dependencies.test.ts` | 39 |
| `task-milestone.test.ts` | 7 |
| `task-recurrence.test.ts` | 93(修复前 92) |
| `task-fields.test.ts` | 67(修复前 65) |
| `task-attachments.test.ts` | 87(修复前 62) |
| `task-projection.test.ts` | 41(修复前 39) |
| `task-export.test.ts` | 25(修复前 21) |
| `task-m5-probe.test.ts` | 44(修复前 12) |
| `task-m5-time-zone.test.ts` | 24(新增) |
| `task-pure-no-io.test.ts`(门 20,main 上已有) | 35(修复前 5) |

main 上原有的任务测试(`task-access`、`task-dates`、`task-tree`、`task-ids` 等)原样通过。

### 2.2 门 20 与 `'x'` 探针

门 20 的 harness 原先只断言「没有调用到数据库桩」——任何非桩的抛错、任何返回值都算通过——所以它本身不能证明「`'x'` 调用会抛 `TypeError` 或返回否定结果」,也看不见一条从未被调用的导入。`task-m5-probe.test.ts` 用同样的占位规则把前一条做成断言:8 个模块共 65 个函数导出(另有 24 个常量导出;本轮没有增删导出),每一个都要么同步抛 `TypeError` / `RangeError`,要么返回 `false` / `null` / `undefined` / 空数组 / `{ok:false}`。实测分布:

- 抛 `TypeError`:54 个(含 `TaskRecurrenceSeriesCorruptError`——类不带 `new` 调用即抛 `TypeError`);抛 `RangeError`:3 个(`addCivilDays`、`civilDayDiff`、`civilWeekday`——`'x'` 是字符串但不是日期)。
- 返回否定结果:6 个(`parseMilestoneFlag`、`parseRecurrenceRule`、`parseAttachmentRefIds`、`parseTaskExportFormat` 返回 `{ok:false}`;`isTaskProjectionBaseIdCandidate`、`isTaskProjectionSheetIdCandidate` 返回 `false`)。
- `'x'` 本身就是合法输入、在探针里逐个钉住确切输出的 2 个:`normalizeAttachmentDisplayName('x')` ⇒ `{ok:true, name:'x'}`;`deriveTaskProjectionRecordId('x','x')` ⇒ `'rec_tsk_x__x'`。探针另有一格断言这张白名单里的每一项都对应真实导出。

import 图(D16):探针从八个新模块出发沿相对 import 走下去,到达的文件只能在 `src/tasks/` 或一张短名单上(`utils/calendar-date`、`services/imageMagicBytes`、`services/csv-cell`、`multitable/display-name-hygiene`、经 `task-dates.ts` 到达的 `multitable/automation-timezone`),整张图出现任何包导入、非字面量说明符、被当作值使用的 `require` 或解析不到 `.ts` 的导入即失败。模块说明符从 TypeScript 语法树读取:`import … from`、副作用 `import '…'`、仅类型导入、`export … from`、`import x = require(…)`、`import()` 类型、动态 `import()` 与 `require()` 调用,以及经名为 `require` 的成员调用(`module.require(…)`、`globalThis['require'](…)`),单引号、双引号、模板字面量都算;注释和字符串内容不算。读不到的:运行时拼出来的模块名(`eval`、`new Function`、用字符串拼成的属性名)。对照格:每种写法各一格(包导入 16 种写法、经成员调用的 `require` 2 种、`src/tasks` 外的相对导入 5 种),两种非字面量写法,`require` 被当作值使用的 5 种(别名、参数、逗号表达式的被调方、`{ require }`、成员的别名),一格解析不到的导入,一格反向对照(注释、JSDoc、字符串与模板字符串里的导入字样,以及只是名叫 `require` 的属性、类型成员与接口方法,都不报);两个正控(遍历是传递的;`multitable/field-codecs.ts` 的包导入会被报出)。

门 20 的 harness 本轮加了静态部分(§5 第 14 条):同样从语法树读说明符,从 `src/tasks/` 的每个文件出发沿相对 import 走(可以走出 `src/tasks/`,但不进入数据库层),禁止包导入、进入 `db/` / `integration/db/` / `data-adapters/` 的相对导入、非字面量说明符、被当作值使用的 `require` 和解析不到的导入;它不要求到达的文件在短名单上(那是任务 E 自己的 D16 约束)。对照格:真实人口一格、传递性一格、经导入的 helper 带进来的包一格、包导入 12 种写法、经成员调用的 `require` 2 种、数据库层 6 种写法、非字面量 2 种、`require` 被当作值使用 4 种、反向对照 1 格(含名叫 `require` 的属性与类型成员)。门 20 的真正依据仍是行为部分:`vi.mock('pg')` 与连接池 mock 在任何 `src/tasks/*.ts` 被 import 之前生效。

### 2.3 全量单测

本轮在 `85fd2554fd` 上跑一次全量:1256 个文件,1251 通过 / 5 失败;20243 个用例,20199 通过 / 44 失败。5 个失败文件正好是已知的本地失败:`multitable-recovery-archive-file-store`(22)、`multitable-recovery-archive-reader`(1)、`multitable-recovery-local-custody-store`(4)、`multitable-recovery-local-startup`(16),以及 `attendance-admin-plugin-lib-dist-layout-boot` 的 `ELOOP`(1;worktree 里 `plugins/plugin-attendance/node_modules` 是指回主 checkout 的符号链接),没有别的。

此前各次(2026-10-07):`cbd1ead845` 上 6 个失败文件(5 个已知本地失败 + `multitable-raw-record-data-projection.guard.test.ts` 命中,§5 第 8 条);`cd8f50b1f8`、`44c2117e75`、`0f2d9d7dcd` 上都只剩那 5 个已知本地失败文件。

## 3. 按模块

「变异」列:`B` 开头是 §4 表的行(先前那 76 处在最终代码上重跑),`G` / `N` 开头是 §7.3 表的行(闸方用的变异、本轮新守卫的变异)。

| 模块 | 函数导出 | 常量导出 | 用例 | 变异 | 标签(2026-10-09 之后) |
|---|---|---|---|---|---|
| `task-civil-date.ts` | `addCivilDays`、`civilDayDiff`、`civilWeekday`、`daysInCivilMonth` | — | 18(另有 `task-m5-time-zone.test.ts` 的格) | B01–B05;G-Z1、G-Z2、G-Z4 | RULED:S32 |
| `task-dependencies.ts` | `wouldCreateDependencyCycle`、`validateAddDependency`、`applyAddDependency`、`applyRemoveDependency`、`canManageDependency`、`dependencyCandidates` | `TASK_DEPENDENCY_MAX_EDGES_PER_TASK` | 39 | B06–B15 | RULED:S11、S12、S28;ASSUMPTION:D4、D17、D18;自有选择 1 处 |
| `task-milestone.ts` | `parseMilestoneFlag`、`applySetMilestone` | — | 7 | B16–B17 | RULED:S13 |
| `task-recurrence.ts` | `parseRecurrenceRule`、`nextOccurrenceDueDate`、`isWithinRecurrenceEnd`、`shouldSpawnOnFlip`、`planSpawn`、`applySetRecurrence`、`applyClearRecurrence`、`planSeriesDelete`、`TaskRecurrenceSeriesCorruptError` | `TASK_RECURRENCE_FREQS`、`TASK_RECURRENCE_INTERVAL_MAX`、`TASK_RECURRENCE_COUNT_MAX` | 93 | B18–B31;G-A、G-R15 | RULED:S14、S15、S16、S17;ASSUMPTION:D3、D18、S14〔与 D18 同条,挂问题 3〕;自有选择 4 处 |
| `task-fields.ts` | `parseFieldDefinition`、`validateFieldValue`、`applySetFieldValue`、`canManageFieldDefinition`、`planDeleteFieldDefinition`、`canBindField`、`canWriteFieldValue`、`checkFieldDefinitionQuota`、`applyBindField`、`applyUnbindField`、`resolveVisibleTaskFieldValues`、`listReusableTaskFieldIds` | `TASK_FIELD_TYPES`、`TASK_FIELD_LIMITS` | 67 | B32–B41、B68–B76;G-B、G-F2、G-F20;N1-a…e | RULED:S24、S25、S26、S27、S28;ASSUMPTION:D10、D18;自有选择 7 处 |
| `task-attachments.ts` | `validateAttachmentCandidate`、`normalizeAttachmentDisplayName`、`deriveTaskAttachmentStorageKey`、`authorizeTaskAttachmentDownload`、`canAddAttachment`、`canRemoveAttachment`、`planRemoveAttachment`、`planAttachmentAddedEvents`、`planCommentAttachmentBind`、`checkCommentAttachmentTotals`、`checkTaskAttachmentQuota`、`parseAttachmentRefIds`、`buildTaskAttachmentDownloadHeaders`、`isUnboundAttachmentExpired` | `TASK_ATTACHMENT_MIME_EXTENSIONS`、`…_ALLOWED_MIME_TYPES`、`…_SIGNATURE_MIME_TYPES`、`…_LIMITS`、`…_UNBOUND_TTL_MS`、`…_STORAGE_PREFIX`、`…_STATUSES`、`…_BIND_KINDS`、`…_SCAN_STATES`、`…_INITIAL_SCAN_STATE` | 87 | B42–B53;G-A3、G-A22、G-Z3;N2-a…c、N3-a…h、N-DN-a…d、N-BS-a…c、N-REF-a…b | RULED:S18、S19、S20、S21、S22;ASSUMPTION:D5、D6、D18;自有选择 5 处 |
| `task-projection.ts` | `deriveTaskProjectionBaseId`、`deriveTaskProjectionSheetId`、`deriveTaskProjectionRecordId`、`deriveTaskProjectionFieldId`、`isTaskProjectionBaseIdCandidate`、`isTaskProjectionSheetIdCandidate`、`resolveTaskProjectionDateColumnType`、`taskProjectionColumns`、`buildTaskProjectionViewSpecs`、`projectTaskRow`、`taskProjectionNoopDigest`、`restrictTaskProjectionCapabilities`、`taskProjectionInteractionCanEdit`、`isTaskProjectionRowReadable` | `TASK_PROJECTION_SYSTEM_KIND`、`…_SYSTEM_OWNER`、`…_BUILTIN_KEYS`、`…_VIEW_MARKER`、`…_VIEW_KINDS`、`…_DENIED_CAPABILITY_KEYS` | 41 | B54–B64;G-P6;N-P-a…c | RULED:S01、S02、S03、S05、S06、S08、S25、S30、S36;ASSUMPTION:D7、D9、D13;自有选择 4 处(percent 格式不投影由 S25 那条括注单列) |
| `task-export.ts` | `parseTaskExportFormat`、`taskExportFileName`、`formatTaskExportCell`、`buildTaskExportCsv` | `TASK_EXPORT_FORMATS`、`TASK_EXPORT_CSV_BOM` | 25 | B65–B67;N-E-a…f | RULED:S10;ASSUMPTION:D11;自有选择 4 处 |

标记数(字面 token 的出现次数):`82eea91fc3` 上是源码 89(civil-date 1、dependencies 7、milestone 1、recurrence 11、fields 20、attachments 22、projection 21、export 6)加测试 37,共 126,其中带逗号形 `ASSUMPTION(task-e, own choice` 的 28 个是自有选择;2026-10-09 之后是源码 99、测试 45,共 144,分布见 §8.2。自有选择不是裁决包的推荐值,也不因这次落槌而变。

## 4. 变异抽查:先前的 76 处,在最终代码上重跑(76/76 变红)

> 2026-10-09 注:下表和 §7.3 表里「第一个失败用例」栏引用的是 `82eea91fc3` 上的原标题;之后个别用例标题里的标签文字改成了 `RULED(2026-10-09)` 或拆段写法(§8),变异没有重跑。

脚本化驱动(本地,未提交):对每一处——备份 → 用唯一匹配的字符串替换做定点修改 → 只跑相应的测试文件(JSON reporter 取失败用例标题)→ 用备份覆盖还原 → 逐字节核对(`filecmp.cmp(shallow=False)` 加原始字节比较)。整轮前后各取一次 `sha256(git diff + '\0' + git status --porcelain)`,两次都是 `6e340b9c…afa01d`(单个 NUL 字节的哈希,即两次都是干净工作树)。本轮最后一次整表在 `85fd2554fd` 上跑,与 §7.3 的 77 处同一轮,共 153 处:153/153 变红,153/153 还原后逐字节一致。

本轮代码改动使其中 5 行的原定点不复存在,按同一条判定在新代码上重写了定点(其余 71 行原样):B43「图片/PDF 缺签名」与 B44「签名与声明类型的比对」改到新的签名分支上;B46「显示名按 UTF-16 单元截断」改到新的截断式上;B65、B66「行 / 表头不经共享 helper」改到新的 `exportCell` / `headerLabel` 上。「变异」列只写被改的是哪一条判定、改成了什么。

| # | 文件 | 变异 | 结果 | 第一个失败用例 |
|---|---|---|---|---|
| B01 | `task-civil-date.ts` | year set via Date.UTC (0-99 remapped to 19xx) | RED (3 failed) | task-civil-date addCivilDays keeps a year below 100 as written (no 19xx remapping) |
| B02 | `task-civil-date.ts` | result range guards removed | RED (1 failed) | task-civil-date addCivilDays a result before 0001-01-01 or after 9999-12-31 is a RangeError |
| B03 | `task-civil-date.ts` | day count: safe-integer check weakened to finite | RED (2 failed) | task-civil-date addCivilDays rejects non-integer day counts |
| B04 | `task-civil-date.ts` | input date validation removed (Feb 30 rolls over) | RED (3 failed) | task-civil-date addCivilDays rejects an unreal or non-canonical date with RangeError (never rolls over) |
| B05 | `task-civil-date.ts` | leap rule: century exception removed | RED (1 failed) | task-civil-date daysInCivilMonth applies the Gregorian leap rule |
| B06 | `task-dependencies.ts` | reachability treats a revisit as corruption (descendantsOf style) | RED (3 failed) | task-dependencies wouldCreateDependencyCycle walks a diamond without throwing: revisiting D is fine |
| B07 | `task-dependencies.ts` | limit: degree counted before insert | RED (3 failed) | task-dependencies validateAddDependency limit (degree after insert, both ends) 50 existing edges on the predecessor: refused |
| B08 | `task-dependencies.ts` | limit: successor end not checked | RED (1 failed) | task-dependencies validateAddDependency limit (degree after insert, both ends) 50 existing edges on the SUCCESSOR only: refused |
| B09 | `task-dependencies.ts` | cross_org comparison removed | RED (3 failed) | task-dependencies validateAddDependency cross_org: the two ends live in different orgs |
| B10 | `task-dependencies.ts` | self check removed | RED (2 failed) | task-dependencies validateAddDependency self: a task cannot depend on itself |
| B11 | `task-dependencies.ts` | cycle check removed from validateAddDependency | RED (4 failed) | task-dependencies validateAddDependency the reverse edge is a cycle, not a duplicate |
| B12 | `task-dependencies.ts` | event payload names the wrong end | RED (2 failed) | task-dependencies applyAddDependency emits dependency_added on both ends, each naming the other end (successor first) |
| B13 | `task-dependencies.ts` | absent-edge no-op branch removed from remove | RED (2 failed) | task-dependencies applyRemoveDependency removing an absent edge is a no-op with no events |
| B14 | `task-dependencies.ts` | two-end edit check reduced to the successor | RED (1 failed) | task-dependencies canManageDependency (ASSUMPTION(task-e): [S11] edit on both ends, same org) needs edit on both ends |
| B15 | `task-dependencies.ts` | candidates: cycle direction swapped | RED (2 failed) | task-dependencies dependencyCandidates new predecessors: excludes itself, linked tasks, and everything downstream |
| B16 | `task-milestone.ts` | same value no longer a no-op | RED (1 failed) | task-milestone applySetMilestone same value is a no-op with no event (both directions) |
| B17 | `task-milestone.ts` | strict boolean check in the flag parser replaced by coercion | RED (1 failed) | task-milestone parseMilestoneFlag refuses everything else as invalid_milestone |
| B18 | `task-recurrence.ts` | month-end clamp replaced by overflow | RED (3 failed) | task-recurrence nextOccurrenceDueDate monthly the anchor day is clamped to short months and comes back afterwards (01-31 → 02-28 → 03-31) |
| B19 | `task-recurrence.ts` | monthly day taken from the previous (clamped) occurrence | RED (1 failed) | task-recurrence nextOccurrenceDueDate monthly the anchor day is clamped to short months and comes back afterwards (01-31 → 02-28 → 03-31) |
| B20 | `task-recurrence.ts` | yearly month/day taken from the current occurrence | RED (2 failed) | task-recurrence nextOccurrenceDueDate yearly a Feb 29 anchor lands on Feb 28 in common years and on Feb 29 again in the next leap year |
| B21 | `task-recurrence.ts` | weeks start on Sunday instead of Monday | RED (1 failed) | task-recurrence nextOccurrenceDueDate weekly interval 2 with Sunday in the set: Sunday closes the Monday-start week |
| B22 | `task-recurrence.ts` | until made exclusive | RED (2 failed) | task-recurrence isWithinRecurrenceEnd (ASSUMPTION(task-e, own choice): until inclusive, count includes the first) until is inclusive |
| B23 | `task-recurrence.ts` | count off by one | RED (2 failed) | task-recurrence isWithinRecurrenceEnd (ASSUMPTION(task-e, own choice): until inclusive, count includes the first) count is the total number of occurrences |
| B24 | `task-recurrence.ts` | one-time spawn guard removed (D3) | RED (1 failed) | task-recurrence shouldSpawnOnFlip (ASSUMPTION(task-e): [S15][D3]) no flip, a reopen, no rule, or an earlier spawn ⇒ no spawn |
| B25 | `task-recurrence.ts` | start date shifted by a fixed day instead of the due-date delta | RED (1 failed) | task-recurrence planSpawn (ASSUMPTION(task-e): [S16]) the start date moves by the same number of civil days as the due date (monthly clamp) |
| B26 | `task-recurrence.ts` | reminder shifted by 24h instead of the due_at offset | RED (1 failed) | task-recurrence planSpawn (ASSUMPTION(task-e): [S16]) keeps the local time of day across a daylight-saving change (due_at recomputed in the task zone) |
| B27 | `task-recurrence.ts` | series id restarts at every occurrence | RED (1 failed) | task-recurrence planSpawn (ASSUMPTION(task-e): [S16]) a later occurrence keeps the series id of the first one |
| B28 | `task-recurrence.ts` | latest-open-occurrence check removed from clear | RED (1 failed) | task-recurrence applyClearRecurrence (ASSUMPTION(task-e): [S17]) an earlier occurrence answers not_current_occurrence |
| B29 | `task-recurrence.ts` | open-status condition removed from the later-occurrence filter | RED (1 failed) | task-recurrence planSeriesDelete (ASSUMPTION(task-e): [S17]) a later COMPLETED occurrence is not deleted and becomes the one whose rule is cleared |
| B30 | `task-recurrence.ts` | series order taken from input order, not the chain | RED (5 failed) | task-recurrence planSeriesDelete (ASSUMPTION(task-e): [S17]) "later" follows the chain, not the order of the input array |
| B31 | `task-recurrence.ts` | due-date precondition removed | RED (1 failed) | task-recurrence applySetRecurrence due_required without a due date |
| B32 | `task-fields.ts` | select validated by label instead of id | RED (4 failed) | task-fields validateFieldValue select stores the option id |
| B33 | `task-fields.ts` | number type check replaced by Number() coercion | RED (1 failed) | task-fields validateFieldValue number a numeric STRING is refused (not coerced) |
| B34 | `task-fields.ts` | magnitude bound made inclusive | RED (1 failed) | task-fields validateFieldValue number finite JSON numbers with \|x\| < 1e15 |
| B35 | `task-fields.ts` | single-member rule removed | RED (1 failed) | task-fields validateFieldValue member single: at most one user |
| B36 | `task-fields.ts` | member limit off by one | RED (1 failed) | task-fields validateFieldValue member at most 50 users |
| B37 | `task-fields.ts` | option labels compared case-sensitively | RED (1 failed) | task-fields parseFieldDefinition select / multiSelect options labels are unique case-insensitively |
| B38 | `task-fields.ts` | zero-binding condition removed from definition delete | RED (1 failed) | task-fields permissions (ASSUMPTION(task-e): [S26]) planDeleteFieldDefinition: creator only, and only with zero bindings |
| B39 | `task-fields.ts` | list-membership condition removed from the value-visibility filter (S27) | RED (2 failed) | task-fields resolveVisibleTaskFieldValues (ASSUMPTION(task-e): [S27]) only lists that hold the task AND have the viewer as a member |
| B40 | `task-fields.ts` | bound-to-list condition removed from the value-write predicate | RED (1 failed) | task-fields permissions (ASSUMPTION(task-e): [S26]) canWriteFieldValue: edit on the task and the field bound to one of its lists |
| B41 | `task-fields.ts` | same value no longer a no-op | RED (1 failed) | task-fields applySetFieldValue the same value (after normalization) is a no-op |
| B42 | `task-attachments.ts` | own-key lookup on the MIME table replaced by a plain property read | RED (2 failed) | task-attachments validateAttachmentCandidate object-prototype names are just unknown types (own-key lookup) |
| B43 | `task-attachments.ts` | required-signature branch for images/PDF removed | RED (2 failed) | task-attachments validateAttachmentCandidate content signature a signature-bearing type needs a matching signature |
| B44 | `task-attachments.ts` | comparison of the detected signature with the declared type removed | RED (2 failed) | task-attachments validateAttachmentCandidate content signature a signature-bearing type needs a matching signature |
| B45 | `task-attachments.ts` | file size ceiling off by one | RED (2 failed) | task-attachments validateAttachmentCandidate size 10 MiB is the ceiling |
| B46 | `task-attachments.ts` | display name cut by UTF-16 units | RED (4 failed) | task-attachments normalizeAttachmentDisplayName (ASSUMPTION(task-e): [D5]) never splits a surrogate pair when cutting |
| B47 | `task-attachments.ts` | org-equality check removed from the download decision | RED (2 failed) | task-attachments authorizeTaskAttachmentDownload (ASSUMPTION(task-e): [S21]) org first: another org, a blank viewer org, or a blank row org are not_found — even for the uploader |
| B48 | `task-attachments.ts` | uploader-only check on never-bound rows removed | RED (3 failed) | task-attachments authorizeTaskAttachmentDownload (ASSUMPTION(task-e): [S21]) a never-bound row: the uploader only |
| B49 | `task-attachments.ts` | lifecycle (410) check moved ahead of the authorization checks | RED (2 failed) | task-attachments authorizeTaskAttachmentDownload (ASSUMPTION(task-e): [S21]) deleted or infected answers gone, but only after authorization |
| B50 | `task-attachments.ts` | bind-kind condition removed from the removal predicate | RED (2 failed) | task-attachments add / remove permissions (ASSUMPTION(task-e): [S20]) remove: the uploader (any binding); attach holders only for task-level attachments |
| B51 | `task-attachments.ts` | filename* leaves ' ( ) unencoded | RED (2 failed) | task-attachments buildTaskAttachmentDownloadHeaders (ASSUMPTION(task-e): [S21][D6]) non-ASCII names: an ASCII fallback plus the UTF-8 filename* |
| B52 | `task-attachments.ts` | quoted fallback keeps " and \ | RED (1 failed) | task-attachments buildTaskAttachmentDownloadHeaders (ASSUMPTION(task-e): [S21][D6]) the quoted fallback never contains a quote, a backslash, CR or LF |
| B53 | `task-attachments.ts` | per-comment id limit off by one | RED (1 failed) | task-attachments event and binding plans planCommentAttachmentBind: absent ⇒ none; at most 5 distinct ids |
| B54 | `task-projection.ts` | early return for full-capability input added ahead of the clamp | RED (2 failed) | task-projection restrictTaskProjectionCapabilities (ASSUMPTION(task-e): [S01][S36]) every deny key is false on a projection sheet, for every role — full (admin-shaped) input included |
| B55 | `task-projection.ts` | write-key loop in the clamp disabled | RED (1 failed) | task-projection restrictTaskProjectionCapabilities (ASSUMPTION(task-e): [S01][S36]) every deny key is false on a projection sheet, for every role — full (admin-shaped) input included |
| B56 | `task-projection.ts` | export capability derived from membership instead of fixed false | RED (2 failed) | task-projection restrictTaskProjectionCapabilities (ASSUMPTION(task-e): [S01][S36]) every deny key is false on a projection sheet, for every role — full (admin-shaped) input included |
| B57 | `task-projection.ts` | archived condition removed from the view-arrangement capability (S36) | RED (1 failed) | task-projection restrictTaskProjectionCapabilities (ASSUMPTION(task-e): [S01][S36]) read = member, views = editor of a list that is not archived |
| B58 | `task-projection.ts` | deleted/listed conditions removed from the row-readability predicate (S02) | RED (1 failed) | task-projection interaction canEdit and row readability isTaskProjectionRowReadable: member, task not deleted, task still in the list (ASSUMPTION(task-e): [S02]) |
| B59 | `task-projection.ts` | list-id format check in sheet-id derivation weakened to non-empty | RED (1 failed) | task-projection deriveTaskProjectionSheetId (ASSUMPTION(task-e): [S03]) only a generated list id is accepted |
| B60 | `task-projection.ts` | base id digest cut to 31 characters | RED (1 failed) | task-projection deriveTaskProjectionBaseId (ASSUMPTION(task-e): [S03]) base_tsk_proj_ + the first 32 hex of sha256(orgId), a valid candidate |
| B61 | `task-projection.ts` | list-id check removed from record-id derivation | RED (2 failed) | task-projection deriveTaskProjectionRecordId pairs with parseTaskProjectionRecordId derive(parse(r)) = r for every id the parser accepts, and derive refuses the halves of every id it rejects |
| B62 | `task-projection.ts` | digest keys not sorted | RED (2 failed) | task-projection no-op digest (ASSUMPTION(task-e): [S08][D9]) is sha256 over canonical JSON: keys sorted, arrays as given |
| B63 | `task-projection.ts` | assignees not sorted in the row | RED (2 failed) | task-projection projectTaskRow projects one task into one row (date columns) |
| B64 | `task-projection.ts` | base candidate pattern not end-anchored | RED (1 failed) | task-projection candidate patterns (ASSUMPTION(task-e): [S03]) base: exactly 32 lower-case hex characters |
| B65 | `task-export.ts` | row cells joined without the shared helper | RED (13 failed) | task-export buildTaskExportCsv BOM, header of column labels, one CRLF line per task, trailing CRLF |
| B66 | `task-export.ts` | header joined without the shared helper | RED (1 failed) | task-export buildTaskExportCsv every other cell, the header included, goes through the shared CSV cell helper header cells: a custom field name with a lead character |
| B67 | `task-export.ts` | BOM dropped | RED (16 failed) | task-export buildTaskExportCsv BOM, header of column labels, one CRLF line per task, trailing CRLF |
| B68 | `task-fields.ts` | multi-select option-membership check removed | RED (3 failed) | task-fields validateFieldValue multiSelect an unknown id (or a label) is not_in_options |
| B69 | `task-fields.ts` | member candidate-set check removed | RED (3 failed) | task-fields validateFieldValue member someone outside the candidate set is not_a_candidate |
| B70 | `task-fields.ts` | member user-id length ceiling removed | RED (1 failed) | task-fields validateFieldValue member a user id longer than 50 characters is refused even when it is a candidate (ASSUMPTION(task-e, own choice)) |
| B71 | `task-fields.ts` | multi-select de-duplication removed | RED (2 failed) | task-fields validateFieldValue multiSelect deduplicates in first-seen order; an empty array clears |
| B72 | `task-fields.ts` | member de-duplication removed | RED (2 failed) | task-fields validateFieldValue member user ids from the candidate set, deduplicated |
| B73 | `task-fields.ts` | multi-select ids trimmed and blank entries skipped (exact comparison removed) | RED (1 failed) | task-fields validateFieldValue multiSelect ids are compared exactly: padded or blank entries are refused, not trimmed or skipped |
| B74 | `task-fields.ts` | member ids trimmed and blank entries skipped (exact comparison removed) | RED (1 failed) | task-fields validateFieldValue member ids are compared exactly: padded or blank entries are refused, not trimmed or skipped |
| B75 | `task-fields.ts` | member count limit checked before candidate membership | RED (1 failed) | task-fields validateFieldValue member candidate membership is checked before the 50-user limit |
| B76 | `task-fields.ts` | a package-loading module import added to task-fields (import-graph rule) | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |

## 5. 偏离与说明

与设计 §3 同一份清单、同一编号;这里只补核对依据。

1. **调用方要求与裁决包冲突之一 —— 调用方列出的最后一步(`task-notifications.ts` 加 `attachment_added`、`task-ids.ts` 加 `tfld_` / `tatt_`)没有做。** 实测核对:`task-notifications.ts` 不在 `origin/main` 上(只在 #6186 与 PR-3a 分支),在这里新建会让通知闭集有两个出处;#6186 正在改 `task-ids.ts` 里同一处字面量对象。后果:本件不生成 `tfld_` / `tatt_` id;入站的附件 id、字段 id 只过 `isValidTaskDomainId`(投影的字段 id 推导要求 `tfld_` 形)。**状态**:协调方 2026-10-07 接受按裁决包处理,两处都留在任务 E 之外(协调方的处理意见,不是 owner 裁决)。
2. **新增 `task-civil-date.ts`**(调用方列表里没有,S32 子项有)。#6186 再次 rebase 时把 `task-reminders.ts` 里未导出的 `addCivilDays` 换成从本模块 import。
3. **已撤回:`task-fields.ts` 不再用 `multitable/field-codecs.ts`(`0f2d9d7dcd`)。** 协调方 2026-10-07 改为以裁决包与 D16 为准(协调方的改判,不是 owner 裁决)。把那一轮的新测试文件放到第一版实现上跑,65 格里只有 3 格不同(`TASK_FIELD_LIMITS` 的钉值与两格「id 按原样比较」),后两格是唯一的收紧。
4. **不引入 `crypto`。** sha256 由调用方注入,模块校验输出是 64 位小写十六进制;单测用 `node:crypto` 注入。
5. **签名调整**:`canRemoveAttachment({roles, isUploader, bindKind})`;`restrictTaskProjectionCapabilities(capabilities, isProjectionSheet, viewerListRole, listArchived)`;`applySetRecurrence` / `applyClearRecurrence` 多一个 `taskId`。
6. **`task-dates.ts` 的一条旧注释**:本件不改既有源文件,那条注释由 #6186 改为逐文件表述。
7. **自有扩展**:`dependencyCandidates`(另外排除会成环的候选)。S11 现已裁(已裁文字只排除自身和已经存在的边),所以这是在已裁文字之上的自有选择,待 owner 表态(设计 §3 第 7 条)。
8. **仓库级守卫的一次命中**(§2.3):原写法 `data: row.data` 被 raw record-data projection 守卫匹配;改名后通过,行为不变。
9. **清单角色**沿用 `task-access.ts` 的 `TaskListMembership['role']`;清单 owner 由调用方桥接为 `'editor'`。
10. **`'x'` 探针**是在门 20 之上新增的更严断言(§2.2);门 20 本身的改动见第 14 条。
11. **锚点 × S17(c) 是待 owner 裁的问题**(设计 §7 问题 1,本轮补了三类情形与算例,算例都用代码复算过)。当前代码按默认值 (a) 实现并标为自有选择,不是已定。
12. **给后续 PR 用、本模块内没有读者的常量**:`TASK_ATTACHMENT_LIMITS.maxRefBodyBytes`、`TASK_ATTACHMENT_INITIAL_SCAN_STATE`、`TASK_PROJECTION_SYSTEM_KIND`、`TASK_PROJECTION_SYSTEM_OWNER`、`TASK_PROJECTION_VIEW_KINDS`。
13. **`tfld_` 前缀暂时写死**在 `task-projection.ts` 里,本轮加了 `[S30][D13]` 标记,现为 RULED `[S30]` 与 ASSUMPTION `[D13]` 两段;PR-4a S0 之后应改为从 `TASK_ID_PREFIXES` 派生。
14. **改了 main 上的门 20 harness**(与 S32 不符:任务 E 原本不改已有文件;调用方要求,owner 已同意这一例外)。这让一个已 ratify 的门的判据变严(锁 §12 门 20 的静态规则只禁 `db/` 相对导入,现在仅类型包导入、Node 内置模块、非字面量说明符、被当作值使用的 `require` 也会让门 20 变红);2026-10-09 owner 已同意这一加严,设计 §7 问题 4 关闭。只加单元格:`git diff 7137688372 -- tests/unit/task-pure-no-io.test.ts` 删去的唯一一行是 `import { readdirSync } from 'fs'`(换成同时导入 `existsSync` / `readFileSync` 的一行),原有五格未动;同一规则在 main 与五个在飞任务分支上零违规(§2)。
15. **重复规则 `count` 越界答 `invalid_recurrence`(S14),不答 D18 的 `LIMIT`。** 两处冲突,取 S14 的理由见设计 §3 第 15 条;单测 `count 366 ⇒ field count` 钉住;owner 可改(设计 §7 问题 3)。S14 已裁而 D18 未被点名,两者对 `count` 仍不一致,owner 没有表态,缺省不变。
16. **显示名按码点截到 255**(D5 写的是 UTF-16 单元的 `slice(0,255)`),截断时保留白名单扩展名。单测钉住两点:255 个 astral 字符整串保留;`'A'×250 + '.html.png'` 截成以 `.png` 结尾,并且下载头的两个文件名都以 `.png` 结尾。
17. **dateTime 列里,不带时刻的开始取当天 0 点**(S05 / D7 的字面读法是 23:59:59.999)。单测:上海时区 `2026-10-06` 开始 ⇒ `2026-10-05T16:00:00.000Z`;同日 09:00 截止时开始不在截止之后;纽约时区单日全天任务从 `04:00Z` 到次日 `03:59:59.999Z`。S05 现已裁,所以这是对已裁文字的偏离,待 owner 表态。
18. **导出时数值列的编解码数值不做前导中和**(D11 写的是每格)。单测:`-5`、`-0.25`、`-1e-7` 原样;数值列里的 `'-5'` 字符串、`-1e15`、`'=1+1'`,以及文本列里的数,都照常中和。S10 现已裁,其文字引用 D11 的逐格中和,所以这也是对已裁文字的偏离,待 owner 表态。
19. **导出的 dateTime 格按 UTC 输出,表头注明 `(UTC)`**(裁决包没有规定;设计 §7 问题 2)。
20. **txt/csv 的内容判定是自有规则**(S18 只要求图片与 PDF 带签名)。单测见 §7.1 第 3 条。

## 6. NOT RUN

- 一切 I/O 层:DDL / 迁移、路由、服务、调度作业、前端、开关与 manifest 条目——都不在本件范围。
- 真库、staging、生产:未连任何数据库(门 20 的桩之外没有数据库)。
- 门 7(锁序控件)、门 9(投影撤权)、门 10 的 P2 子集、门 19 的投影端、候选 M5-a…g 的 HTTP / 真库格:要等 PR-4a / 4b / 4c。
- TS 判定与 SQL 的对拍(投影可读判定 `isTaskProjectionRowReadable` 与将来 deny sibling 的 SQL 臂):需要真库与 PR-4c。
- 投影列/视图规格在真实多维表上的 provisioning、甘特 / 看板渲染、`meta_links` 写入后的依赖连线:需要 PR-4c 与前端。
- 下载响应头在真实 HTTP 响应上的表现、multer 对非 ASCII 文件名的解码:需要 PR-4b 的路由。
- 在 CI 的 Linux 跑测机上跑 `task-m5-time-zone.test.ts`:本机(macOS)上在 `TZ=UTC`、`Asia/Taipei`、`America/New_York` 三种进程时区下都过;CI 上依赖同一个 Node 行为(给 `process.env.TZ` 赋值即刻生效),对照格会在这一点不成立时变红而不是放过。
- 合并、DDL:未做;本分支已以 Draft PR #6249 推送(2026-10-09 注)。

## 7. 闸方复审修复(2026-10-08)

闸方在 `9b9ee2b6b7` 上提出 10 条 P2(三票均未被多数驳回)与 22 条 P3/NIT。10 条 P2 全修;P3/NIT 中由调用方点名的全部修或记录,其余 3 条属推送时的动作,本轮不做(§7.2 末)。本轮共 15 个提交,从 `5c1c078d65` 起;两份文档的这次更新是最后一个。

### 7.1 P2 逐条

| # | 发现 | 修复 | 新增/改动的单测 | 变异(§7.3) |
|---|---|---|---|---|
| 1 | 文本值超过 D18 的 2000 码点上限时答 `too_long`,与 D18 的 `LIMIT` 不符 | `validateFieldValue`:先查 2000 上限,超过答 `limit`(存储的 `maxLength` 再大也不放宽);只有在 2000 以内、超过本字段 `maxLength` 时答 `too_long`。其他超限路径逐一核对(设计 §2.9 的表):D18 列出的各项都已答 `limit`;唯一例外重复规则 `count` 取 S14 的 `invalid_recurrence`,原因记入设计 §3 第 15 条与 §7 问题 3,源码标记同步说明 | `task-fields`:无 `maxLength`、`maxLength 5` 配 6 与 2001 码点、`maxLength 5000` 配 2000 与 2001 码点、astral 字符在上限两侧(`5c1c078d65`) | G-F20、N1-a…e |
| 2 | 上传者对已绑定附件所属任务没有任何角色时,`planRemoveAttachment` 仍允许移除 | 已绑定的行:没有 `view` 一律 `not_found`(与附件不存在相同,上传者也一样,锁 §5.1);`canRemoveAttachment` 没有 `view` 一律假;文档注释写明所属任务缺失或软删时调用方传 `['none']`、org 范围由路由 SQL 负责(`eb49edcc23`) | 上传者无角色(`['none']` 与 `[]`)× 两种绑定 ⇒ 与 `plan(null)` 相同;从未绑定的行:上传者无论角色都能移除、他人得到同样的 `not_found`;谓词:无 `view` 时上传者也是假 | N2-a(旧形状)、N2-b、N2-c |
| 3 | `BM…`、`GIF8…` 开头的 txt/csv 被当成图片拒绝 | 规则写进设计 §2.6 与源码标记:txt/csv 只在字节确实是图片或 PDF 时拒绝——开头是 `%PDF`,或嗅探器认出图片签名且前 16 字节里有 NUL / TAB、LF、FF、CR 以外的 C0 控制符;声明为图片 / PDF 的仍要求一致签名(`c3f2ee0cbe`) | 接受:`BMI,Height…` CSV、`BMW sales…`、`GIF89a is a format`、`GIF8 frames…` CSV、`RIFF1234WEBP…`、`BM` 后紧跟 TAB/CR/LF;拒绝:真实的 PNG、JPEG、GIF(带画布描述)、WEBP、BMP、PDF 头分别声明为 txt 与 csv;16 字节窗口的边界两格;无签名的 NUL 字节(UTF-16 文本)不拒;`%PDF` 开头的文本拒绝;声明为 PDF 的近似头 `%PD\0` 等拒绝 | N3-a(旧规则)…N3-h、G-A22 |
| 4 | `applySetRecurrence` 换规则没有正控 | 断言完整结果(`ok`、新规则、`noop: false`、一条 `recurrence_set`),另加每周换每月一格(`24025fd1a6`) | `task-recurrence` 一格 | G-A |
| 5 | `applySetFieldValue` 清空已存值没有正控 | 断言完整结果;`null`、`''`、多选空数组三种清空(`24025fd1a6`) | `task-fields` 一格 | G-B |
| 6 | import 图守卫只认单引号;门 20 的 harness 完全不看导入 | 探针改为从语法树读说明符(各种写法与引号;非字面量、解析不到的都算违规)(`c291ad90d9`);门 20 harness 加静态部分(包、数据库层、非字面量、解析不到即红),原有五格不动(`cb6851a4b8`);复审之后自查,两边都补上经成员调用与被当作值使用的 `require`,并在文件抬头写明读不到的形式(`85fd2554fd`,§7.6) | 探针:每种写法一格、非字面量 2 格、解析不到 1 格、反向对照 1 格;门 20:真实人口、传递性、经 helper 带入的包、12 种包导入写法、6 种数据库层写法、非字面量 2 格、反向对照 1 格 | G-I1…I10-probe、G-I1…I10-gate20(每一处都确认红的是静态那一格,不是加载时崩溃);N-IR-a…e(两边各一组) |
| 7 | `planSeriesDelete` 里排除已软删实例的那半个条件没有单测 | 加一格:目标之后的那一期已软删(先删了最新的 open 期,再删前一期)⇒ 只删目标、不再删一次、无第二条 `deleted`(`24025fd1a6`) | `task-recurrence` 一格 | G-R15 |
| 8 | 民用日期只在 UTC 下验过,CI 在 UTC,改成本地取值器看不出 | 新文件 `task-m5-time-zone.test.ts`:进程内把 `process.env.TZ` 切到 UTC 以东两个、以西两个时区,跑完还原;每个时区一格对照(本地时钟确实偏离 UTC、且已还原),再核对 2026 年每一天的星期与步进、100 年以内与日历两端、按周与按月的下一期、存储键月份(`51f4276444`) | 24 格 | G-Z1、G-Z2、G-Z4(跑测进程固定在 `TZ=UTC`);N8-a(去掉切换,对照格变红) |
| 9 | `planDeleteFieldDefinition` 的空 actor 守卫没有反控 | 加 `{actorId:'', createdBy:''}` ⇒ `forbidden`(`24025fd1a6`) | `task-fields` 一行 | G-F2 |
| 10 | 下载判定里从未绑定行的空 viewer 守卫没有被走到 | 加上传者为空、viewer 为空的一格(另配一格非空 viewer)(`24025fd1a6`) | `task-attachments` 一格 | G-A3 |

### 7.2 P3 / NIT

| 发现 | 处理 |
|---|---|
| 设计文档有接近裁决包原文的段落 | 改写:与任一裁决包字面重合的片段全部改写(扫描见 §2 与 §7.4),设计 §1–§8 引用裁决包时只留条目编号 |
| 显示名按码点截断、D5 写 UTF-16 单元 | 保留码点口径,标为自有选择并进偏离清单(§5 第 16 条) |
| 显示名截断后扩展名可能与校验过的类型不符 | 已修:截断时保留白名单扩展名(`18180077bf`;N-DN-a…d) |
| 两处依赖未裁值却没有标记(`tfld_` 前缀、字段 id 形) | 已补 `[S30][D13]` 与 `[S03]`(`5d27ccdce5`) |
| 设计的偏离清单缺验证记录里的两条 | 设计 §3 与本记录 §5 现为同一份清单、同一编号(1–20) |
| `count` 超 365 的码在 S14 与 D18 之间悄悄选了一边 | 记录:设计 §3 第 15 条、§7 问题 3;源码标记说明取 S14(`956c0c0c63`) |
| 下载与移除只看 `boundAt`、不核对状态 | 已修:状态与 `boundAt` 不一致的行在两处都抛 `TypeError`(`18180077bf`;N-BS-a…c) |
| `refs` 的 200 上限在去重之后才数 | 已修:按原始数组数,先于逐个校验,同审批先例(`18180077bf`;N-REF-a、N-REF-b) |
| `projectTaskRow` 不检查六型闭集 | 已修:行投影与列目录用同一个检查(`5d27ccdce5`;N-P-c) |
| 按月 / 按年在当前日不在规则日上、或改到下一周期时会跳过一期 | 记录:设计 §7 问题 1 (i)(ii),附算例(用代码复算) |
| 中途换规则沿用旧锚点与 `count` 起点 | 记录:设计 §7 问题 1 (iii),附算例 |
| 混合清单里不带时刻的开始投到 23:59:59.999 | 已修:取当天 0 点,与裁决包的截止规则并行;进偏离清单(§5 第 17 条;N-P-a、N-P-b) |
| 导出的 dateTime 是 UTC 的 ISO,读者会看错日子 | 裁决包没有规定:保持 UTC,表头注明 `(UTC)`,列为 owner 问题(设计 §7 问题 2;N-E-e、N-E-f) |
| 负数导出成文本 `'-5` | 已修:数值列里编解码能产出的数照原样写,只经共享的引号处理;其余照常中和(§5 第 18 条;N-E-a…d) |
| 「UTC 月份」那一格在 UTC 与 UTC+8 下都不会失败 | 已修:并入 `task-m5-time-zone.test.ts`,月界两侧各一个时刻,东西两侧的时区都跑(G-Z3) |
| 文本 2000 上限在 `maxLength` 更大时没有单测 | 已修(#1 的单测;G-F20) |
| PDF 近似头没有单测 | 已修(#3 的单测;G-A22) |
| sheet 候选正则的开头锚没有单测 | 已修:`x_sht_tsk_proj_tlst_abc` 与前导空格两格(`24025fd1a6`;G-P6) |
| 未推送的分支历史里留有旧措辞 | 已处理:推送前用 head 的树重建为单个提交,旧历史没有推送 |
| `44c2117e75` 的提交说明里有字面 BOM 与 U+FFFD | 已处理:重建后的提交说明重写,过了逐字符检查 |
| 本记录的状态行在开 PR 后会过时 | 已改写为推送时的状态 |

### 7.3 变异:闸方用的变异与本轮新守卫(77 处,全部变红)

> 同 §4 开头的 2026-10-09 注:用例标题引用的是原标题。

与 §4 同一轮、同一个驱动。`G` 开头是闸方在复审里用过的变异(定点随代码移动的已按同一条判定重写;导入类的 I1–I6 是闸方的,I7–I10 是本轮补的(两种模板字面量写法、`require` 的别名、`module.require`),每一个都在探针与门 20 harness 上各跑一次);`N` 开头是本轮新守卫的变异。「期望红在」一栏有值的,驱动额外要求失败用例里包含该格,否则记为「红在别处」——77 处里没有这种情况。`G-Z*` 与 `N8-a` 的跑测进程固定在 `TZ=UTC`(与 CI 相同)。

| id | 文件 | 变异 | 期望红在 | TZ | 结果 | 第一个失败用例(有期望格时取该格) |
|---|---|---|---|---|---|---|
| G-A | `task-recurrence.ts` | finding 4: every replacement of an existing rule refused |  |  | RED (1 failed) | task-recurrence applySetRecurrence a changed rule replaces the old one |
| G-B | `task-fields.ts` | finding 5: every clear of a stored value refused |  |  | RED (1 failed) | task-fields applySetFieldValue clearing a stored value is a change |
| G-R15 | `task-recurrence.ts` | finding 7: later-occurrence filter keeps already-deleted members |  |  | RED (1 failed) | task-recurrence planSeriesDelete (ASSUMPTION(task-e): [S17]) an already-deleted occurrence AFTER the target is skipped, not deleted again |
| G-F2 | `task-fields.ts` | finding 9: definition delete lets a blank actor match a blank creator |  |  | RED (1 failed) | task-fields permissions (ASSUMPTION(task-e): [S26]) planDeleteFieldDefinition: creator only, and only with zero bindings |
| G-A3 | `task-attachments.ts` | finding 10: download lets a blank viewer match a blank uploader on a never-bound row |  |  | RED (1 failed) | task-attachments authorizeTaskAttachmentDownload (ASSUMPTION(task-e): [S21]) a never-bound row: a blank viewer never matches a blank uploader |
| G-F20 | `task-fields.ts` | P3 F20: the 2000 ceiling not applied when a maxLength is stored |  |  | RED (1 failed) | task-fields validateFieldValue text over 2000 code points is limit (D18), whatever maxLength says |
| G-A22 | `task-attachments.ts` | P3 A22: PDF magic fourth byte not checked |  |  | RED (1 failed) | task-attachments validateAttachmentCandidate content signature a declared PDF needs all four bytes of its magic (near-miss headers are refused) |
| G-P6 | `task-projection.ts` | P3 P6: sheet candidate pattern not start-anchored |  |  | RED (1 failed) | task-projection candidate patterns (ASSUMPTION(task-e): [S03]) sheet: sht_tsk_proj_tlst_ + alphanumerics |
| N1-a | `task-fields.ts` | finding 1: text ceiling check removed |  |  | RED (1 failed) | task-fields validateFieldValue text over 2000 code points is limit (D18), whatever maxLength says |
| N1-b | `task-fields.ts` | finding 1: text over the ceiling answers too_long (the old reason) |  |  | RED (1 failed) | task-fields validateFieldValue text over 2000 code points is limit (D18), whatever maxLength says |
| N1-c | `task-fields.ts` | finding 1: the field maxLength rule removed |  |  | RED (1 failed) | task-fields validateFieldValue text over the field maxLength (within 2000) is too_long |
| N1-d | `task-fields.ts` | finding 1: maxLength checked before the ceiling (order swapped) |  |  | RED (1 failed) | task-fields validateFieldValue text over 2000 code points is limit (D18), whatever maxLength says |
| N1-e | `task-fields.ts` | finding 1: text length counted in UTF-16 units |  |  | RED (1 failed) | task-fields validateFieldValue text normalizes and counts code points |
| N2-a | `task-attachments.ts` | finding 2: removal plan skips the view check for the uploader (the old shape) |  |  | RED (1 failed) | task-attachments planRemoveAttachment a bound row: the uploader without a role on the task gets the same not_found as a missing row (lock §5.1) |
| N2-b | `task-attachments.ts` | finding 2: removal predicate grants the uploader without view |  |  | RED (1 failed) | task-attachments add / remove permissions (ASSUMPTION(task-e): [S20]) remove: nobody without view on the task, the uploader included (lock §5.1) |
| N2-c | `task-attachments.ts` | finding 2: removal plan view check removed (no-role actor gets forbidden, not not_found) |  |  | RED (2 failed) | task-attachments planRemoveAttachment a viewer who may not remove it gets forbidden; a stranger gets not_found |
| N3-a | `task-attachments.ts` | finding 3: any recognised signature refuses text (the old rule) |  |  | RED (7 failed) | task-attachments validateAttachmentCandidate content signature txt/csv: refused only when the bytes are an image or a PDF a CSV that starts with BMI is accepted |
| N3-b | `task-attachments.ts` | finding 3: text never refused |  |  | RED (8 failed) | task-attachments validateAttachmentCandidate content signature txt/csv: refused only when the bytes are an image or a PDF a PNG header declared as text is refused |
| N3-c | `task-attachments.ts` | finding 3: the PDF magic no longer refuses text |  |  | RED (2 failed) | task-attachments validateAttachmentCandidate content signature txt/csv: refused only when the bytes are an image or a PDF a PDF header declared as text is refused |
| N3-d | `task-attachments.ts` | finding 3: non-text bytes searched in the whole head, not the first 16 |  |  | RED (1 failed) | task-attachments validateAttachmentCandidate content signature txt/csv: refused only when the bytes are an image or a PDF a non-text byte after the first 16 bytes does not count |
| N3-e | `task-attachments.ts` | finding 3: TAB, LF, FF and CR counted as non-text bytes |  |  | RED (1 failed) | task-attachments validateAttachmentCandidate content signature txt/csv: refused only when the bytes are an image or a PDF TAB, CR and LF right after BM is accepted |
| N3-f | `task-attachments.ts` | finding 3: non-text bytes refuse text even without a signature |  |  | RED (1 failed) | task-attachments validateAttachmentCandidate content signature txt/csv: refused only when the bytes are an image or a PDF bytes with no recognised signature are never refused as text (NULs alone do not count) |
| N3-g | `task-attachments.ts` | S18: a signature-bearing type without any signature accepted |  |  | RED (2 failed) | task-attachments validateAttachmentCandidate content signature a signature-bearing type needs a matching signature |
| N3-h | `task-attachments.ts` | S18: a signature-bearing type with another type's signature accepted |  |  | RED (2 failed) | task-attachments validateAttachmentCandidate content signature a signature-bearing type needs a matching signature |
| G-I1-probe | `task-milestone.ts` | finding 6: package import, single quotes (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I2-probe | `task-milestone.ts` | finding 6: package import, double quotes (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I3-probe | `task-milestone.ts` | finding 6: require("sanitize-html"), double quotes (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I4-probe | `task-milestone.ts` | finding 6: relative import outside src/tasks, double quotes (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I5-probe | `task-milestone.ts` | finding 6: re-export from a package, double quotes (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I6-probe | `task-milestone.ts` | finding 6: relative import outside src/tasks, single quotes (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I7-probe | `task-milestone.ts` | finding 6: dynamic import, template literal (M5 probe) | reaches only src/tasks files |  | RED (2 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I8-probe | `task-milestone.ts` | finding 6: require, template literal, into the DB layer (M5 probe) | reaches only src/tasks files |  | RED (2 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I9-probe | `task-milestone.ts` | finding 6: an alias of require (M5 probe) | reaches only src/tasks files |  | RED (2 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I10-probe | `task-milestone.ts` | finding 6: module.require of a package (M5 probe) | reaches only src/tasks files |  | RED (1 failed) | task E modules — import graph (D16) reaches only src/tasks files and the import-free helper list; no package imports |
| G-I1-gate20 | `task-milestone.ts` | finding 6: package import, single quotes (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I2-gate20 | `task-milestone.ts` | finding 6: package import, double quotes (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I3-gate20 | `task-milestone.ts` | finding 6: require("sanitize-html"), double quotes (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I4-gate20 | `task-milestone.ts` | finding 6: relative import outside src/tasks, double quotes (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I5-gate20 | `task-milestone.ts` | finding 6: re-export from a package, double quotes (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I6-gate20 | `task-milestone.ts` | finding 6: relative import outside src/tasks, single quotes (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I7-gate20 | `task-milestone.ts` | finding 6: dynamic import, template literal (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I8-gate20 | `task-milestone.ts` | finding 6: require, template literal, into the DB layer (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I9-gate20 | `task-milestone.ts` | finding 6: an alias of require (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-I10-gate20 | `task-milestone.ts` | finding 6: module.require of a package (gate 20 harness) | every file under src/tasks |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import every file under src/tasks, followed through its relative imports |
| G-Z1 | `task-civil-date.ts` | finding 8 Z1: civilToUtcMs uses local setters |  | UTC | RED (9 failed) | task E — results independent of the process time zone (D15) under 'Asia/Taipei' civilWeekday: every day of 2026 (2026-01-01 is a Thursday) |
| G-Z2 | `task-civil-date.ts` | finding 8 Z2: civilWeekday uses local getDay |  | UTC | RED (4 failed) | task E — results independent of the process time zone (D15) under 'America/Chicago' civilWeekday: every day of 2026 (2026-01-01 is a Thursday) |
| G-Z3 | `task-attachments.ts` | P3 Z3: storage-key month uses local getters |  | UTC | RED (4 failed) | task E — results independent of the process time zone (D15) under 'Asia/Taipei' deriveTaskAttachmentStorageKey: the UTC month on both sides of a month boundary |
| G-Z4 | `task-civil-date.ts` | finding 8 Z4: utcMsToCivil formats with local getters |  | UTC | RED (7 failed) | task E — results independent of the process time zone (D15) under 'Pacific/Kiritimati' addCivilDays: a year below 100 and the two calendar ends |
| N8-a | `task-m5-time-zone.test.ts` | finding 8: the zone switch in the helper removed (cells would run in the runner zone) |  | UTC | RED (4 failed) | task E — results independent of the process time zone (D15) under 'Asia/Taipei' control: the local clock really is offset from UTC while the zone is set, and is restored after |
| N-DN-a | `task-attachments.ts` | display name: the extension is not kept when cutting |  |  | RED (2 failed) | task-attachments normalizeAttachmentDisplayName (ASSUMPTION(task-e): [D5]) a cut keeps an allowlisted extension (own choice) the stem is shortened and the extension kept, in its own letter case |
| N-DN-b | `task-attachments.ts` | display name: an upper-case allowlisted extension not recognised |  |  | RED (1 failed) | task-attachments normalizeAttachmentDisplayName (ASSUMPTION(task-e): [D5]) a cut keeps an allowlisted extension (own choice) the stem is shortened and the extension kept, in its own letter case |
| N-DN-c | `task-attachments.ts` | display name: the stem not shortened for the kept extension (over 255) |  |  | RED (2 failed) | task-attachments normalizeAttachmentDisplayName (ASSUMPTION(task-e): [D5]) a cut keeps an allowlisted extension (own choice) the stem is shortened and the extension kept, in its own letter case |
| N-DN-d | `task-attachments.ts` | display name: cut by UTF-16 units (D5 literal), extension dropped |  |  | RED (4 failed) | task-attachments normalizeAttachmentDisplayName (ASSUMPTION(task-e): [D5]) never splits a surrogate pair when cutting |
| N-BS-a | `task-attachments.ts` | status/boundAt: an unbound row with boundAt accepted |  |  | RED (2 failed) | task-attachments authorizeTaskAttachmentDownload (ASSUMPTION(task-e): [S21]) a row whose status and boundAt contradict each other is corrupt data (TypeError) |
| N-BS-b | `task-attachments.ts` | status/boundAt: a bound row without boundAt accepted |  |  | RED (2 failed) | task-attachments authorizeTaskAttachmentDownload (ASSUMPTION(task-e): [S21]) a row whose status and boundAt contradict each other is corrupt data (TypeError) |
| N-BS-c | `task-attachments.ts` | status/boundAt: the removal plan skips the agreement check |  |  | RED (1 failed) | task-attachments planRemoveAttachment a row whose status and boundAt contradict each other is corrupt data (TypeError), as in the download decision |
| N-REF-a | `task-attachments.ts` | refs: the 200 limit counted after de-duplication (the old rule) |  |  | RED (1 failed) | task-attachments event and binding plans parseAttachmentRefIds: at most 200 entries in the raw array (before de-duplication), each well-formed |
| N-REF-b | `task-attachments.ts` | refs: raw limit off by one |  |  | RED (1 failed) | task-attachments event and binding plans parseAttachmentRefIds: at most 200 entries in the raw array (before de-duplication), each well-formed |
| N-P-a | `task-projection.ts` | untimed start projected at 23:59:59.999 like the due (the old rule) |  |  | RED (1 failed) | task-projection projectTaskRow dateTime columns: an untimed due is 23:59:59.999 (= due_at); an untimed start is 00:00 of its day (own choice) |
| N-P-b | `task-projection.ts` | untimed due projected at 00:00 instead of due_at |  |  | RED (1 failed) | task-projection projectTaskRow dateTime columns: an untimed due is 23:59:59.999 (= due_at); an untimed start is 00:00 of its day (own choice) |
| N-P-c | `task-projection.ts` | closed type set not enforced on bound fields (row data) |  |  | RED (1 failed) | task-projection projectTaskRow a bound field outside the six-type closed set is refused, as by the column catalog |
| N-E-a | `task-export.ts` | number columns: every value skips neutralization (not only codec numbers) |  |  | RED (1 failed) | task-export buildTaskExportCsv number columns: a codec number is written as a number (own choice) anything else in a number column is neutralized like any other cell |
| N-E-b | `task-export.ts` | number columns: the codec magnitude bound not checked |  |  | RED (1 failed) | task-export buildTaskExportCsv number columns: a codec number is written as a number (own choice) anything else in a number column is neutralized like any other cell |
| N-E-c | `task-export.ts` | a number in any column skips neutralization |  |  | RED (1 failed) | task-export buildTaskExportCsv number columns: a codec number is written as a number (own choice) a number in a column that is not a number column is neutralized |
| N-E-d | `task-export.ts` | number columns neutralized like text (negative numbers exported as text) |  |  | RED (1 failed) | task-export buildTaskExportCsv number columns: a codec number is written as a number (own choice) negative, fractional and small numbers keep their sign and are not prefixed |
| N-E-e | `task-export.ts` | dateTime header without the zone |  |  | RED (2 failed) | task-export buildTaskExportCsv BOM, header of column labels, one CRLF line per task, trailing CRLF |
| N-E-f | `task-export.ts` | every header labelled UTC |  |  | RED (4 failed) | task-export buildTaskExportCsv BOM, header of column labels, one CRLF line per task, trailing CRLF |
| N-IR-a-probe | `task-m5-probe.test.ts` | import reader: a call through X.require not read as a specifier |  |  | RED (2 failed) | task E modules — import graph (D16) controls: every specifier form is read, whatever the quotes require through a member call of a package is reported |
| N-IR-b-probe | `task-m5-probe.test.ts` | import reader: require used as a value not reported |  |  | RED (5 failed) | task E modules — import graph (D16) controls: every specifier form is read, whatever the quotes require used as an alias is reported |
| N-IR-c-probe | `task-m5-probe.test.ts` | import reader: a property or declaration named require reported as a value |  |  | RED (3 failed) | task E modules — import graph (D16) controls: every specifier form is read, whatever the quotes require through a member call of a package is reported |
| N-IR-d-probe | `task-m5-probe.test.ts` | import reader: a direct require call also reported as indirect |  |  | RED (8 failed) | task E modules — import graph (D16) controls: every specifier form is read, whatever the quotes require call, single quotes of a package is reported |
| N-IR-e-probe | `task-m5-probe.test.ts` | import reader: { require } shorthand taken for a name |  |  | RED (1 failed) | task E modules — import graph (D16) controls: every specifier form is read, whatever the quotes require used as a shorthand property is reported |
| N-IR-a-gate20 | `task-pure-no-io.test.ts` | import reader: a call through X.require not read as a specifier |  |  | RED (2 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import require through a member call of a package is reported |
| N-IR-b-gate20 | `task-pure-no-io.test.ts` | import reader: require used as a value not reported |  |  | RED (4 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import require used as an alias is reported |
| N-IR-c-gate20 | `task-pure-no-io.test.ts` | import reader: a property or declaration named require reported as a value |  |  | RED (3 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import require through a member call of a package is reported |
| N-IR-d-gate20 | `task-pure-no-io.test.ts` | import reader: a direct require call also reported as indirect |  |  | RED (6 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import a package import (require call, double quotes) is reported |
| N-IR-e-gate20 | `task-pure-no-io.test.ts` | import reader: { require } shorthand taken for a name |  |  | RED (1 failed) | gate 20 — static companion: the src/tasks import graph has no package or DB-layer import require used as a shorthand property is reported |

### 7.4 扫描

- 裁决包重叠:本分支改动的全部 21 个文件(8 个源文件、11 个测试文件、2 个文档),§2 所列的三次字面扫描都 exit 0。第一轮改写之前更严的那次扫描在两份文档里报出的片段,全部改写。2026-10-09 的重跑见 §8.3。
- 加入行扫描(`git diff 7137688372..HEAD` 的新增行):局域网 IP、主机名、本机路径、本机用户名,零命中。
- 威胁用词与本机路径、裁决包文件名:逐个文件检查,零命中。
- 源文件:无 `TASKS_*` 开关读点、无 `Intl.DateTimeFormat`、无 `crypto` / `pg` / 连接池字样;无字面 BOM、无 U+FFFD。

### 7.5 本轮 NOT RUN

- 闸方在 `9b9ee2b6b7` 上看到的「变异存活」本轮没有在旧提交上重跑(要先检出旧树);本轮只证明这些变异在新的单测下变红。
- 门 20 harness 的新静态部分只在本机跑过;在飞分支上是用仓外脚本(同一规则、经 `git show` 读取)核对的,没有在那些分支的工作树里跑 harness 本身。
- 其余同 §6。

### 7.6 复审之后的自查(2026-10-08)

修完闸方的发现后又自查了一轮,补了四处:

- **import 检查原先只认直接调用的 `require`**:别名(`const r = require`)、`(0, require)(…)`、`{ require }`、`module.require(…)` 都看不见,文档却写「各种写法都算」,与 P2 第 6 条当初的问题同类。两边(探针与门 20 harness)都补上:经名为 `require` 的成员调用按说明符检查,`require` 被当作值使用即违规;只是名叫 `require` 的属性或类型成员不算(反向对照)。读不到的形式(运行时拼出来的模块名)写进两个文件的抬头与两份文档。补完后的规则在 main 与五个在飞任务分支上仍零违规(`85fd2554fd`;变异 G-I9、G-I10、N-IR-a…e)。
- **有无地方钉住或列举改动的测试文件**:没有(§2 表)。
- **文档里引号中的裁决包片段**:字面扫描管不到的短片段,只要逐字出现在裁决包里也改写了。
- **门 20 判据变严是否已告知**:设计 §3 第 14 条之前只写了与 S32 不符;现在两份文档都写明这是对已 ratify 的门的加严、出自调用方指示而非 owner 裁决,并列为设计 §7 问题 4。

## 8. owner 裁决之后的标签更新(2026-10-09)

本节的命令都在 2026-10-09 改标之后的工作树上跑,对照的是 `82eea91fc3`;§8.3 末两行的扫描在 2026-10-09 文字修订之后的最终文本上又跑了一次。

### 8.1 范围

- owner 2026-10-09 裁定:S01–S37 取推荐值;门 20 变严同意;设计 §7 问题 1–3 不在这次裁定之内,仍待裁,缺省不变。
- 改动只有三类:源码与测试里的标签(含用例标题里的标签文字)、标签紧邻的注释、两份文档。取值、控制流、导出、签名、用例的断言都没有动。
- 规则:取值由 S 编号决定的改 `RULED(2026-10-09)`;D 编号在这次裁定里没有点名,保持 `ASSUMPTION(task-e): [Dxx]`;S 与 D 并存的拆成两段;自有选择与问题 3 的那一条(`[S14][D18]`)不动。完整规则与按模块的分布见设计 §5。
- 标签之外的注释改动共五处:`task-civil-date.ts` 的 S32 注释与 `task-dependencies.ts` 的候选自有选择注释里,「推荐值」改成「已裁」;`task-recurrence.ts` 里 `[S14][D18]` 那条补一句说明它为什么整条不动;`task-export.ts` 数值列那条自有选择补一句,说明已裁的 S10 引用的 D11 写的是逐格;`task-projection.ts` 不带时刻的开始那条补一句,说明它与已裁文字不同、等 owner。另有 number 字段 percent 格式不投影的括注,从 S25 那条里拆出来单列(§8.2)。

### 8.2 计数

标记总数 144(RULED 85 / ASSUMPTION 30 / 自有选择 29);源码 99(54 / 20 / 25),测试 45(31 / 10 / 4)。裁决前 126。按编号:

| RULED 编号 | 源码 | 测试 | 合计 |
|---|---|---|---|
| S01 | 2 | 1 | 3 |
| S02 | 1 | 1 | 2 |
| S03 | 5 | 4 | 9 |
| S05 | 2 | 2 | 4 |
| S06 | 2 | 2 | 4 |
| S08 | 1 | 1 | 2 |
| S10 | 1 | 1 | 2 |
| S11 | 3 | 1 | 4 |
| S12 | 1 | — | 1 |
| S13 | 1 | 1 | 2 |
| S14 | 2 | 1 | 3 |
| S15 | 1 | 1 | 2 |
| S16 | 1 | 1 | 2 |
| S17 | 2 | 2 | 4 |
| S18 | 3 | 1 | 4 |
| S19 | 4 | 1 | 5 |
| S20 | 2 | 1 | 3 |
| S21 | 4 | 2 | 6 |
| S22 | 2 | — | 2 |
| S24 | 1 | 1 | 2 |
| S25 | 3 | 2 | 5 |
| S26 | 5 | 1 | 6 |
| S27 | 1 | 1 | 2 |
| S28 | 2 | 2 | 4 |
| S30 | 1 | — | 1 |
| S32 | 1 | — | 1 |
| S36 | 2 | 2 | 4 |

| ASSUMPTION 编号 | 源码 | 测试 | 合计 |
|---|---|---|---|
| D3 | 1 | 1 | 2 |
| D4 | 1 | — | 1 |
| D5 | 2 | 1 | 3 |
| D6 | 1 | 1 | 2 |
| D7 | 4 | 1 | 5 |
| D9 | 1 | 1 | 2 |
| D10 | 2 | 1 | 3 |
| D11 | 2 | 1 | 3 |
| D13 | 1 | — | 1 |
| D17 | 1 | — | 1 |
| D18 | 5 | 4 | 9 |
| S14〔与 D18 同条,挂设计 §7 问题 3〕 | 1 | — | 1 |

### 8.3 检查

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查(CI 第一条) | `tsc --noEmit -p .`(`packages/core-backend/`) | exit 0 |
| 类型检查(CI 第二条) | `tsc -p scripts/tsconfig.recovery-archive-acceptance.json` | exit 0 |
| Lint | `eslint` 8 个源文件 | exit 0 |
| 任务单测 | `vitest run tests/unit/task-*.test.ts tests/unit/tasks-*.test.ts` | 30 个文件、958 个用例全过(与 `82eea91fc3` 相同);另加 `TZ=UTC`、`TZ=Asia/Taipei`、`TZ=America/New_York` 各一次,同样全过 |
| 门 20 | `vitest run tests/unit/task-pure-no-io.test.ts` | 35/35 |
| `'x'` 探针 + import 图 | `vitest run tests/unit/task-m5-probe.test.ts` | 44/44 |
| 行为未变 | 本地脚本(未提交):对任务 E 的 19 个 `.ts` 文件(8 个源文件、11 个测试文件;本次有 15 个文本发生变化,4 个没有),取 `82eea91fc3` 的内容与工作树的内容各自用 TypeScript `transpileModule`(`removeComments`)编译,测试文件另把 `describe` / `it` 的第一个字符串参数置空,比较输出 | 19/19 逐字相同。负控:改一个常量、改一个 `expect` 里的字面量会报差异;改注释、改用例标题不会 |
| 标记不变量 | 本地脚本(未提交) | 每个 `RULED(2026-10-09)` 只引用 S 编号,其注释正文不含 D 编号;剩下的 `ASSUMPTION(task-e): [..]` 只引用 D 编号,唯一例外是 `task-recurrence.ts` 里 `[S14][D18]` 那一条(问题 3);零违例 |
| 裁决包重叠扫描 | 字面扫描器 v1/v2 与引号扫描器 | 改标改动的 17 个文件,以及本分支相对 `7137688372` 改动的全部 21 个文件,三个扫描器都 exit 0;文字修订之后在这 21 个文件的最终文本上重跑,同样 exit 0 |
| 加入行扫描 | `git diff` 的新增行:局域网 IP、主机名、本机路径、本机用户名 | 零命中;文字修订之后对相对 `7137688372` 的全部新增行重跑,同样零命中 |

### 8.4 没有做

- 变异表(§4、§7.3 共 153 处)没有重跑:本次只动了注释和用例标题,上面的编译产物比对已经证明可执行代码逐字相同。
- 合并、DDL:没有做;改标先以 `d6c84264ff` 推送到 Draft PR #6249。
- §6、§7.5 记的 NOT RUN 项不变。
