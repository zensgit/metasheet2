# 考勤帮助中心补全：设计与核验

日期：2026-10-15，优化：2026-10-16，更正：2026-11-10。#6426 合入后补记：2026-11-10。只改帮助内容、规格测试和本核验文档。业务逻辑、授权逻辑、迁移、工作流、vitest 配置、`src/index.ts`、`univer-meta.ts`、hash/pin 登记均未改。

## 2026-11-10 三处业务指引更正

Harold 审阅 Draft #6426（当时 head `2ab1b998b`）后暂不合并，指出三处帮助与代码不符。本轮只改帮助内容和规格测试，未改业务逻辑。

### 1. 「导出范围」不是查看他人报表的权限

查看和导出是两条授权，不能写成同一件事。

- 查看他人为真的条件只有 `canAccessOtherUsers`：`hasAttendanceAdminAccess` 或 `attendance:approve`。`hasAttendanceAdminAccess` 在 `RBAC_BYPASS === 'true'`、`user_roles.role_id = 'admin'`，或 `attendance:admin` 时为真（`plugins/plugin-attendance/index.cjs:24153-24158`、`24264-24268`、`24280-24283`）。
- 下列读取在目标用户不是本人时只调用 `canAccessOtherUsers`，不调用 `assertAttendanceRecordExportAllowed`：`GET /api/attendance/records` 与 `GET /api/attendance/calendar`（同一处理函数，`index.cjs:31493-31523`、`31624-31634`）、`GET /api/attendance/summary`（`index.cjs:32634-32669`）、`GET /api/attendance/reports/requests`（`index.cjs:32702-32736`）。没有 `attendance:approve` / `attendance:admin`（以及上面的管理员绕过）时返回 403 `No access to other users`。
- 普通记录导出是另一条路。`GET /api/attendance/export`（`index.cjs:52779-52828`）在目标不是本人时先查 `canAccessOtherUsers`。已有这项权限就直接导出，不再按排班「导出」范围过滤。没有这项权限时才回退到 `assertAttendanceRecordExportAllowed`（`index.cjs:26960-26975`，调用点 `52822`）：排班范围的动作必须包含 `export`，并且覆盖该人与日期，否则 `SCHEDULER_SCOPE_FORBIDDEN`。全文件只有这一处调用 `assertAttendanceRecordExportAllowed`。
- 工资周期导出不走这个后备。`GET /api/attendance/payroll-cycles/:id/summary/export` 与 `GET /api/attendance/payroll-cycles/:id/export` 共用 `handlePayrollCycleSummaryExport`（`index.cjs:46747-46776`、路由 `46824-46834`）。目标不是本人时只调用 `canAccessOtherUsers`，不允许就 403 `No access to other users`，不调用 `assertAttendanceRecordExportAllowed`。

已改正：`reports`（含 FAQ）、`records`、`scopes`、`permissions`。中文统一为：排班“导出范围”不授予页面查看他人报表的权限。普通记录导出在缺少查看他人权限时，按该范围校验；已有查看他人权限者不受该范围限制。工资周期导出不采用这个后备检查。

### 2. 旧工作日的补卡额度不因提交到下个月而恢复

- `computeMakeupCycleWindow` 按工作日期（规则时区下的 `workDate`）计算周期，注释写明 NOT submit time。`index.cjs:14848-14872`。
- `enforceMakeupPunchPolicy` 用这份 `workDate` 取周期，再统计同一主体、`work_date` 落在该周期内、状态属于 `countStatuses` 的补卡申请。`index.cjs:14943-14966`。强约束默认关：`DEFAULT_SETTINGS.makeupPunchPolicy.enabled` 为 `false`（`index.cjs:542-543`）。前端表单初值同样是 `enabled: false`（`AttendanceView.vue:16980-16981`）。
- 前端提示句「本周期的补卡次数已用完。」：`apps/web/src/views/attendance/makeupPunchRequestStatus.ts:35-39`。

已改正：`makeup` 步骤、示例、失败处理、FAQ，以及 `errors` 中 `MAKEUP_PUNCH_QUOTA_EXCEEDED` 行。删除了「等到下个周期 / 等到下个自然月」这类会让人以为提交月份变化即可恢复旧工作日额度的指引。

### 3. 已有下班卡时不要再点「上班打卡」

- 写入后若 `last_out_at < first_in_at`，抛出 `HttpError(409, 'ATTENDANCE_PUNCH_ORDER_CONFLICT', 'Check-out cannot precede check-in; review the work date and existing punches')`。`hasReversedLivePunchOrder`：`plugins/plugin-attendance/lib/attendance-live-punch-order.cjs:5-8`；抛出点在同一事务内，拒绝会回滚：`index.cjs:23617-23621`。实时打卡拒绝客户端时间（`index.cjs:30920-30922`），发生时间是 `getOnlinePunchServerInstant()`（`index.cjs:30974-30975`）。已有下班、还没有更早的上班时，再点「上班打卡」会把 `first_in_at` 写成现在，现在晚于已有下班，于是再次 409。
- 补卡审批通过后按申请里的 `requested_in_at` / `requested_out_at` 回写（`index.cjs:39879-39882`，写入 `index.cjs:39924-39931`），不使用这次点击的服务器现在时间。三种类型是 `missed_check_in`、`missed_check_out`、`time_correction`（`index.cjs:14592`、`24322-24324`）。帮助改为引导「补卡」（漏打上班卡）或「时间更正」，明确不要再点「上班打卡」。

已改正：`punch` 简介、失败步骤、新 FAQ，以及 `errors` 中 `ATTENDANCE_PUNCH_ORDER_CONFLICT` 行。

规格 `apps/web/tests/attendanceAdminGuide.spec.ts` 新增 3 个业务指引断言，原有结构/导航/搜索 5 项和锁定短语保持不变。

## 2026-11-10 #6426 合入后的指引补记

#6426 已以 squash `4b2cc28f3271076bf3fb147d650cdd8308787908` 合入 `main`。本轮从该 `origin/main` 切分支，只改帮助措辞、规格测试和本核验文档，不改授权逻辑或其他业务代码。行号对这份 `main` 树重新核对。

### 1. 导出前重载：筛选比较、按钮禁用、函数拦截

帮助不再写「改了日期要先重载再导出；筛选过期时导出会被拦住。」。`records` 写：「日期、组织或人员筛选变化后，请重新加载数据再导出。」`reports`（做完后怎么确认）在同一句之后补上操作：「重新加载时点「重载报表」，再点「导出 CSV」或「导出 Excel」。」按钮文案与报表工具条一致：`AttendanceView.vue:97-98` 为 `tr('Reload report', '重载报表')`（申请报表卡片另有同文案按钮 `1547`）。这覆盖日期、组织和人员三项筛选，而不是只提日期。

代码依据（`apps/web/src/views/AttendanceView.vue`，`4b2cc28f`）：

- 筛选比较：`currentReportsQueryKey`（`12923-12929`）由 `from`、`to`、`orgId`、`userId` 组成。`reportsDataStale`（`12931-12933`）为 `reportsPartialDataStale`，或 `loadedReportsQueryKey` 与 `currentReportsQueryKey` 不一致。`reportsExportBlocked`（`12934-12935`）在报表不可用、尚未加载（`loadedReportsQueryKey` 为空），或筛选已过期时为真。
- 按钮禁用：导出 CSV（`124`）为 `:disabled="exporting || loading || reportsExportBlocked"`；导出 Excel（`127`）为 `:disabled="exportingXlsx || loading || reportsExportBlocked"`。
- 导出函数拦截：`exportCsv`（`24313-24326`）和 `exportXlsx`（`24399-24412`）在 `reportsExportBlocked` 时直接返回。不可用时提示「请先重载报表再导出。」；筛选已变时提示「筛选条件已变化，请先重载报表再导出。」。

### 2. 服务端 `importer` 模板与界面差异（不写入操作帮助）

服务端 `ATTENDANCE_ROLE_TEMPLATES` 另有 `importer` 模板：`attendance:read` + `attendance:import`（`packages/core-backend/src/routes/attendance-admin.ts:234-239`）。用户权限页的角色模板下拉只有员工、审批人、管理员：单人 `AttendanceView.vue:3834-3836`，批量 `3916-3918`。操作帮助故意不介绍 `importer`，因为界面没有入口，写进去会让用户找不到操作位置。

### 3. 旧版管理员直接授权回退缺少导入权限（独立兼容性问题）

这与上一款不是同一件事。当前部署优先把 `{ template: role }` 交给 `/api/attendance-admin/users/.../roles/assign`，走服务端管理员模板（含 `attendance:import`，`attendance-admin.ts:240-244`）。仅当该接口被当作旧部署回退时，才使用前端 `provisionRolePermissions`。其中 `admin` 为 `attendance:read`、`attendance:write`、`attendance:approve`、`attendance:admin`，不含 `attendance:import`（`AttendanceView.vue:12828-12832`）。调用点在 `22515`、`22569`、`22705`、`22798`。这是旧版兼容路径上的缺口，本补丁只在维护文档记录，不修改任何授权逻辑。

## 2026-10-16 第五轮

三份排查按「现象 → 原因 → 怎么改」写进现有文章，并新增 `troubleshoot`（排查）。

- 排班保存被拦住：`SHIFT_COMPLIANCE_CAP_EXCEEDED`，强制方式为「保存时阻断」且显式排班分钟超上限。`enforceShiftComplianceCap`：`index.cjs:19665-19672`。默认 `shiftCompliance.enforcement` 已是 `'block'`，但三个上限默认 `null`，上限都空时函数直接返回（`index.cjs:435-439`）。
- 和另一组的人换班失败：没有单独的跨组错误码。列表和接口只接受已发布、生效、常规、单日、无生产者标记的排班。固定排班或轮班行带 `producer_type`，因此不出现。代码 `SHIFT_SWAP_SOURCE_UNSUPPORTED`、`SHIFT_SWAP_SOURCE_NOT_SINGLE_DAY`、`SHIFT_SWAP_SOURCE_TEMPORARY_COVERED`。`normalizeShiftSwapSourceSnapshot`：`index.cjs:32992-33016`；前端过滤 `isShiftSwapSourceCandidate`：`AttendanceView.vue:24941-24947`。
- 预览正常、提交没写上：预览不写考勤行。令牌开关是字面量比较 `process.env.ATTENDANCE_IMPORT_REQUIRE_TOKEN === '1'`（不是 `parseBoolean`，`'true'` 不开）。`index.cjs:5967-5968`，有效期 `IMPORT_COMMIT_TOKEN_TTL_MS = 10 * 60 * 1000` 在 `5967`。打开时缺少或失效的提交返回 `COMMIT_TOKEN_REQUIRED` / `COMMIT_TOKEN_INVALID`，例如 `index.cjs:43459-43483`。
- `USER_NOT_IN_ORG`：考勤组加人在写入前调用 `assertActiveOrgMemberUserIds`（`index.cjs:47328-47330`），导入提交写入成员时同样调用（`index.cjs:30611-30617`）。抛出点是 404（`index.cjs:20399`）。打卡写错组织仍是 `ATTENDANCE_PUNCH_ORG_NOT_PERMITTED`。
- 排查文章顺序：规则/班次 → 考勤组成员 → 审批/导入批次。搜索词：异常人员、缺勤未生成、报表数字对不上。
- 搜索别名只落到已有能力：外勤（打卡/设置）、补卡额度（补卡）、排班管理员（排班管理范围，不是单独角色模板）、年假额度（年假）。

本轮没有新的未实现功能要写入缺口清单。跨考勤组换班不是一条禁止码，所以不把「禁止跨组换班」写进帮助。

## 2026-10-16 第四轮

按钉钉帮助的栏目组织补深度，不抄原文。新增文章 id `glossary`（名词解释）。打卡、补卡、请假、加班、换班各加「失败时怎么办」，代码与「错误码与提示」一致。快速入门开头增加「管理员一天配置完」和「员工一天怎么用」。主要管理文章补齐前提/权限、示例、做完后怎么确认、注意事项里缺的短步骤，并用中文文章名互指。

### 栏目对照

| 钉钉帮助常见栏目 | 本手册文章 |
| --- | --- |
| 管理员快速配置 | 快速入门、设置、名词解释 |
| 考勤组与班次 | 考勤组、班次、排班、规则、排班管理范围 |
| 打卡方式与规则 | 打卡、设置（IP 白名单、地理围栏、外勤）、补卡 |
| 假勤申请 | 请假、加班、换班、请假类型、加班规则、出差写在请假文内 |
| 审批与统计 | 审批流、报表、统计字段、计薪、年假、团队可用性 |
| 常见问题 | 常见问题、错误码与提示 |
| 名词解释 | 名词解释 |

钉钉有而本产品不能按步骤操作的能力仍只在下方缺口清单，不单开文章。本轮没有新的产品缺口。节假日加班来源不加分钟已在第 21 条。

## 2026-10-16 第三轮

按当前计算代码补了可核对的例子，并给偏短的文章补了前提和示例。

- 快速入门改成 8 步，文章 id 写在步骤标题里：settings、rules、shifts、groups、assignments、leave-types、approvals、import、reports。
- 规则：09:12/17:40、宽限 10、取整 5 → 迟到 2、早退 10、工时 505。取整是向下。严重/旷工按宽限后的迟到分钟，内置 30/60。`roundMinutes`：`index.cjs:11950-11954`；`computeMetrics`：`index.cjs:12463`。
- 班次：22:00–06:00 的下班落在次日。`resolveOvernightFlag`：`index.cjs:7128-7131`。
- 补卡：起始日 1 时 2026-03 整月共用 3 次；起始日 26 的周期跨月。窗口按规则时区的工作日。`computeMakeupCycleWindow`：`index.cjs:14848-14872`。同时提交不同日期可能比上限多 1，已写进注意事项。额度按工作日期所在周期，不按提交月份。
- 请假：09:00–18:00、480 分钟，中点 13:30，上下午各 240。同一工作日第二条请假即重复，不论上午下午。`halfDayLeaveHelper.ts:105-107`；重复查询 `findDuplicateAttendanceRequest`：`index.cjs:10575-10588`。
- 加班规则：20→30，40→45，610→600。向上取整后再截每日上限。`applyOvertimeRule`：`index.cjs:11963-11977`。
- 节假日工时：首日默认 8 小时写成 480。加班来源只产生警告，不加进这 480。`applyHolidayPolicy` 把 `workMinutes` 设成基准分钟：`index.cjs:12859-12888`；加班来源只 `warnings.push`：`index.cjs:12906-12909`。
- 计薪：26 日至次月 25 日，锚点 2026-03-10 与 2026-03-26 两个窗口。`resolvePayrollWindow`：`index.cjs:8517-8528`。
- 导入：默认表头与跳过原因（日期、工号映射、邮箱/用户名/手机号、两人匹配）。字段映射含工号：`index.cjs:813`；身份解析 `attendance-import-user-identity.cjs:75-98`。
- 年假：满 8 年发 2400 分钟；累计工龄满年、2026-05-27 入职折成 3 天 1440 分钟；本单位工龄同年入职不满 12 个月跳过。`computeAnnualLeaveAccrualForUser`：`index.cjs:19993`。
- 团队可用性、统计字段、排班范围、审批流补了权限和一条例子。
- 常见问题增加员工情景：忘打卡、围栏外、班次不对、驳回后再交、换班、结果在哪看。

## 2026-10-16 优化

- 「设置」把打卡间隔、IP 白名单、地理围栏、员工常用图标、节假日工时、外勤打卡审批拆成各自步骤。文案使用页面上的字段名和按钮名。
- 「设置」「节假日」「导入」「报表」各加一步「做完后怎么确认」：保存设置不扫当天缺勤；节假日同步不改打卡钟点；导入要等「提交」；报表藏列仍在导出文件里。
- 「错误码与提示」改成一行一个代码：出现时机，然后处理。含 `USER_NOT_IN_ORG`（404，名单/年假）与 `ATTENDANCE_PUNCH_ORG_NOT_PERMITTED`（403，打卡组织）。未新造代码。
- 总览和员工篇写明手册只从管理端「考勤帮助」打开，总览没有第二本帮助。
- 「常见问题」改为指向已有文章，去掉与设置、节假日、计薪、报表重复的问答。既有测试短语仍留在原文章；`口径说明` 仍只在报表。

## 设计

产品内帮助中心是管理端「考勤帮助」：`apps/web/src/views/attendance/AttendanceAdminGuide.vue` 读取 `attendanceAdminGuideContent.ts`。文章结构固定为功能简介、适用场景、操作流程、常见问题。本次只扩充这篇内容，并让当前管理区块打开对应文章。

帮助挂在管理端顶栏（`AttendanceView.vue` 的 `showAdmin`）。员工总览不另挂入口。员工打卡、补卡、请假、加班、换班、查看记录写在同一本手册里，供管理员对照真实页面说明，也供打开管理端帮助的人检索。

中英文成对。界面为中文时显示中文。公共钉钉/飞书帮助只用来核对目录是否覆盖快速入门、管理员配置、员工使用、报表、常见问题、错误码和权限。正文按本仓库页面和接口编写。

原有文章 id 保留：`overview`、`settings`、`holidays`、`payroll`、`rules`、`groups`、`availability`、`annual`、`fields`、`import`、`reports`。既有测试短语仍在这些文章里，包括「我的申请」「自动缺勤」「节假日同步」「summaryFieldCodes」「默认规则」「不计入考勤人员」「366」「6000」「2027-01-01」「同步字段目录」「10 分钟」「导入批次」「口径说明」。`口径说明` 仍只出现在报表文章，避免搜索测试命中多篇。

## 新增目录

| 分组 | 文章 |
| --- | --- |
| 考勤手册 | 总览、快速入门 |
| 员工使用 | 打卡、补卡、请假、加班、换班、查看记录 |
| 配置 | 设置、节假日、规则、考勤组（原有，并补了围栏、常用图标、类型） |
| 班次与排班 | 班次、排班、排班管理范围 |
| 申请与审批 | 请假类型、加班规则、审批流 |
| 计薪与年假 | 计薪、年假（原有） |
| 数据 | 团队可用性、统计字段、导入、报表（原有，导入补了 xlsx/CSV） |
| 说明 | 权限说明、错误码与提示、常见问题 |

打开管理区块时：启用准备 → 快速入门；补卡策略、班次、排班分配、排班管理范围、请假类型、加班规则、审批流、用户权限各打开同名文章。轮班规则、轮班分配、高级排班、综合工时打开排班。批量授权打开权限说明。原有回落保持不变（节假日同步 → 节假日，计薪周期 → 计薪，规则集/模板库 → 规则，年假余额/操作 → 年假，导入批次 → 导入）。

## 各节核验

行号对本次合并 `origin/main`（`a6fbdca73`，#6838）之后的当前树。#6838 只改管理员角色写入的锁内复核，没有改 `plugins/plugin-attendance/index.cjs` 和本注引用的前端文件，所以上表行号未移动。2026-10-16 写下来、后来已经挪位的行，以下表和缺口清单已改成现位置。

| 帮助文章 | 核对到的行为 | 代码 |
| --- | --- | --- |
| 快速入门 | 管理区块顺序；模板只预填；打卡顺序为轮班班次、个人排班、默认规则 | `useAttendanceAdminRail.ts:203-236`；`attendanceContextHelp.ts:162-169`；组类型 `AttendanceView.vue:11602`、自由工时文案 `11643-11647` |
| 打卡 | `POST /api/attendance/punch` 需要 `attendance:write`；拒绝客户端时间；总览按钮为上班/下班打卡；不采集定位 | `index.cjs:30916-30922`；`AttendanceEmployeeWorkspace.vue:78-97`；`punchOutcome.ts:150-161` |
| 打卡约束 | 同类间隔、IP、围栏在 `enforcePunchConstraints`；未排班仅 `mode === 'block'` 才拒绝；外勤备注 | `index.cjs:23208-23248`、`31186-31201`；`punchOutcome.ts:114-136`；设置表单 `AttendanceView.vue:3022-3056`，外勤照片勾选 `3341-3347` |
| 常用图标 | 管理员在设置保存四键；员工 `GET /api/attendance/employee-quick-action-icons` 只读；八个图标 id；默认 clock-plus / calendar / moon / swap | 默认 `index.cjs:620-625`；id `13902-13911`；路由 `52387-52389`；`attendanceEmployeeWorkspaceCommonIcons.ts:9-37`；`AttendanceEmployeeQuickActionIconsField.vue:1-6` |
| 补卡 | 强约束默认关；自然月、自助申请人、自然日固定；额度按工作日期周期；七个 `MAKEUP_PUNCH_*` 人话 | 默认 `index.cjs:542-563`；表单 `AttendanceView.vue:2642-2794` 与初值 `16980-16990`；强制 `index.cjs:14907-14966`；`makeupPunchRequestStatus.ts:35-111` |
| 请假 | 全天/上午/下午按窗口中点；「需要审批」暂不生效；同日同类型重复；年假单日；调休编码 `comp_time` | `AttendanceEmployeeLeaveRequestCard.vue:9-11`；`attendanceApprovalOptionHint.ts:36-40`；年假跨日 `index.cjs:19909` |
| 出差 | 独立卡片：目的地时区与当地起止；`POST /api/attendance/business-trip-requests` | `index.cjs:37735` |
| 加班 | 最小/取整/每日上限；跨一个当地午夜可拆；多于一个午夜拒绝；加班银行不收法定节假日 | `applyOvertimeRule` `index.cjs:11963-11977`；午夜拆分 `12284-12310`；加班规则页 `AttendanceView.vue` 加班规则区块；银行说明见设置区加班银行文案 |
| 换班 | 已发布单日常规班；对方先同意；专用路由 | `AttendanceEmployeeShiftSwapRequestCard.vue:28-40`；同意/拒绝 `index.cjs:39115-39122` |
| 查看记录 | 「我的申请」是本人；报表三个数字是当前页；导出忽略本地列显隐，上限 5000。查看他人不看导出范围。日期、组织或人员筛选变化后须重新加载再导出 | 导出上限 `index.cjs:52832-52833` 与 `AttendanceView.vue:22913`；查看他人见上文第 1 条；筛选比较/按钮禁用/导出拦截见「#6426 合入后的指引补记」第 1 条（`AttendanceView.vue:12923-12935`、`124`、`127`、`24313-24326`、`24399-24412`） |
| 班次 | 单段可排班；多段在「仅供预览」时不能分配/轮班/换班/调度/发布 | `AttendanceShiftSegmentsEditor.vue:114-126`；`AttendanceView.vue:28327-28331` |
| 排班 | 草稿后发布；临时替班须再发布；高级排班与综合工时只读；合规阻断 `SHIFT_COMPLIANCE_CAP_EXCEEDED`；一天多班次默认关 | 合规应答 `index.cjs:19713-19724`，强制函数 `19665-19672`；一天多班次默认 `multiShiftDay.enabled: false`、`maxSlots: 3`（`index.cjs:449-454`）。`427-431` 现在是最小打卡间隔和排班编辑窗口，不是一天多班次 |
| 排班范围 | 动作：查看、编辑、导入、导出、清空、审批、调度、提醒；无匹配范围 `SCHEDULER_SCOPE_FORBIDDEN`。导出动作不能查看他人报表 | 动作文案 `AttendanceView.vue:30891-30899`；拒绝 `index.cjs:26406-26413` |
| 考勤组 | 类型创建后锁定 `ATTENDANCE_GROUP_TYPE_LOCKED`；负责人不计入考勤人员 | `index.cjs:47152-47158`；既有考勤组帮助 |
| 请假类型 / 加班规则 | 「需要审批」只保存 | `attendanceApprovalOptionHint.ts:8-14` |
| 审批流 | 新申请状态 `pending`；空静态步骤进入管理员队列；动态步骤失败 `APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED` 且不回退 | 插入 `'pending'`：`index.cjs:34681-34694`；动态步骤抛出 `24412`；页面警告 `AttendanceView.vue:8065` |
| 权限 | 五个键。服务端管理员模板含 `attendance:read`、`attendance:write`、`attendance:approve`、`attendance:import`、`attendance:admin`。页面「角色模板」下拉仍是员工、审批人、管理员；分配走该服务端模板。服务端另有 `importer` 模板，操作帮助不介绍（界面无入口）。旧的直接授权回退清单不含 `attendance:import`，记为独立兼容性问题，本次不改授权逻辑 | 管理员模板 `packages/core-backend/src/routes/attendance-admin.ts:240-244`；`importer` 模板 `234-239`；下拉 `AttendanceView.vue:3834-3836`、批量 `3916-3918`；回退清单 `12828-12832`。详见「#6426 合入后的指引补记」第 2、3 条 |
| 年假错误 | `USER_NOT_IN_ORG` 为 404，文案「该用户不是本组织的有效成员。」；与打卡组织错误不是同一个码 | 抛出 `index.cjs:20399`；页面 `AttendanceView.vue:26773`；打卡组织码见 `attendance-punch-org-resolution.cjs` |
| 时区提示 | 默认规则缺失、冻结上下文、非法时区等固定人话 | `attendanceTimezoneError.ts:3-22` |
| 导入 | 令牌只在 `ATTENDANCE_IMPORT_REQUIRE_TOKEN === '1'` 时要求，10 分钟；`.xlsx` 浏览器转 CSV（10MB）；`.xls` 拒绝 | `index.cjs:5967-5968`；`importXlsxConvert.ts:8-9`；`useAttendanceAdminImportWorkflow.ts:1368-1398` |
| 节假日 / 计薪 / 统计字段 / 团队可用性 | 沿用已核过的原文，未改其结论 | 原 `attendanceAdminGuideContent.ts` 对应文章 |

## 测试

相关检查是帮助组件规格 `apps/web/tests/attendanceAdminGuide.spec.ts`。它挂载帮助组件，断言既有短语、团队可用性打开对应文章、搜索「口径说明」只命中报表，以及简介、场景、步骤、常见问题四段。2026-11-10 起另有业务指引测试：查看他人报表权限与导出范围、补卡额度按工作日周期、打卡顺序冲突引导补卡/更正，以及日期/组织/人员筛选变化后须重新加载再导出（锁定新句，禁止旧句「筛选过期时导出会被拦住」）。既有锁定短语保持不变。

2026-10-16 第五轮之后重跑，均通过：

- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendanceAdminGuide.spec.ts`：1 个文件、5 个测试通过（88ms）。
- `pnpm --filter @metasheet/web exec eslint src/views/attendance/attendanceAdminGuideContent.ts --max-warnings=0`：退出码 0。

2026-11-10 按合并 `078b0ed68` 后的树重跑，均通过：

- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendanceAdminGuide.spec.ts`：1 个文件、8 个测试通过（221ms）。
- `pnpm --filter @metasheet/web exec eslint src/views/attendance/attendanceAdminGuideContent.ts tests/attendanceAdminGuide.spec.ts --max-warnings=0`：退出码 0。`apps/web` 的 `lint` 脚本文件清单不包含这篇帮助，所以这是对改动文件的直接检查；`pnpm --filter @metasheet/web lint` 同样退出码 0。
- `pnpm --filter @metasheet/web type-check`（`vue-tsc -b`，以及 approval / stock-prep 两份 verification tsconfig）：退出码 0。

合并 `a6fbdca73`（#6838）之后又跑了同一组命令。行号没有变化。规格 8 个测试通过（153ms）；对改动文件的 eslint、`pnpm --filter @metasheet/web lint`、`pnpm --filter @metasheet/web type-check` 退出码都是 0。

拉取 GitHub update-branch 后的 `5ebac5e64` 之后，只改了导出范围说明和管理员模板清单。规格 8 个测试通过（163ms）；对改动文件的 eslint、`pnpm --filter @metasheet/web lint`、`pnpm --filter @metasheet/web type-check` 退出码都是 0。

#6426 合入 `4b2cc28f` 之后的本轮补记，在该 `main` 树上重跑：

- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendanceAdminGuide.spec.ts`：1 个文件、9 个测试通过（171ms）。
- `pnpm --filter @metasheet/web exec eslint src/views/attendance/attendanceAdminGuideContent.ts tests/attendanceAdminGuide.spec.ts --max-warnings=0`：退出码 0。


## 缺口清单

下列能力在钉钉/飞书考勤帮助里常见。本仓库当前没有可按帮助步骤操作的同等行为，因此不写进用户帮助。

1. Wi-Fi 打卡、蓝牙、考勤机、设备绑定、人脸识别。考勤组里的打卡方式说明写明这些控件要等独立后端契约（`AttendanceView.vue:5883-5887`、`14916-14919`）。现有约束是设置页的 IP 白名单和地理围栏（`AttendanceView.vue:3022-3056`）。
2. 网页总览采集 GPS 或在打卡按钮上上传照片。打卡请求不带定位和照片（`punchOutcome.ts:25-27`）。外勤照片勾选在设置页（`AttendanceView.vue:3341-3347`），不是总览打卡按钮。
3. 考勤组上自选「地点 / Wi-Fi / 考勤机」打卡方式。该抽屉不是可编辑的打卡方式配置。
4. 钉钉式自由工时：不排班、只按打卡时长算出勤。自由工时类型在界面上是人员和策略分组（`AttendanceView.vue:11643-11647`）。工作日解析要求非空 `shiftId`，`free_time` 无法提供已发布班次候选（`attendance-work-date-resolver.cjs:764-771`）。
5. 名为「外出申请」「外出打卡」「出差打卡」的独立流程。已有的是出差申请和外勤打卡审批。
6. 请假类型或加班规则取消「需要审批」后免审。界面标明暂不生效（`attendanceApprovalOptionHint.ts:36-40`）。
7. 管理端编辑假期「是否带薪」。字段在存储行上，请假类型表单没有这项。
8. 服务端强制请假附件。页面会拦，创建请求只把链接写入 metadata。
9. 按钟点检测请假时间段重叠。重复规则是同一人、同一工作日、同一申请类型已有待处理或已通过。
10. 年假一次申请跨多个标准日扣减。审批侧单日，超出为 `ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED`（`index.cjs:19909`）。
11. 加班规则页上的分段开关。三类加班时长来自分段快照；本页只编辑最小、取整和每日上限。
12. 未排班打卡「需审批」。设置归一化接受 `allow` / `block` / `require_approval`（`index.cjs:15057-15060`），缺省是 `DEFAULT_SETTINGS.punchPolicy.unscheduled.mode`，值为 `'allow'`（`index.cjs:445`）。打卡路径只在 `mode === 'block'` 时返回 `PUNCH_UNSCHEDULED_BLOCKED`（`index.cjs:31186-31201`）。`require_approval` 不会在这条路径上改成审批。
13. 排班合规的「预警」拦截。`enforceShiftComplianceCap` 只在 `enforcement === 'block'` 且至少一个上限非空时继续（`index.cjs:19665-19672`）。默认 `enforcement` 已是 `'block'`，三个上限默认 `null`（`index.cjs:435-439`），所以未填上限时不回滚。`warn` 不进入这段强制。
14. 自动对班的后台写入。帮助不写开启步骤。要真正写入，下面五处必须同时成立，缺一则 `runAttendanceAutoShiftAutoWriteOnce` 返回 `{ ran: false, reason: 'disabled' }`（`index.cjs:17461-17472`）：
    - 组织设置 `autoShiftMatching.enabled` 默认 `false`，`mode` 默认 `'preview'`，`autoWrite.enabled` 默认 `false`（`index.cjs:581-594`）。写入还要求 `enabled === true`、`mode === 'auto'`、`autoWrite.enabled === true`。
    - 运行开关 `ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED`：`isAutoShiftMatchingRuntimeEnabled` 用 `parseBoolean(process.env.ATTENDANCE_AUTO_SHIFT_MATCHING_ENABLED, false)`（`index.cjs:16844-16846`）。`parseBoolean` 对字符串先 `trim().toLowerCase()`，`'true'`、`'1'`、`'yes'` 为真，缺省 `false`（`index.cjs:6526-6532`）。
    - 运行开关 `ATTENDANCE_AUTO_SHIFT_AUTO_WRITE_ENABLED`：同样的 `parseBoolean(..., false)`（`index.cjs:16848-16850`）。
    - 设置注释写明后台写入还要这两个环境开关（`index.cjs:27479-27480`）。这不是字面量 `=== 'true'`。
15. 多段班次在权威分段核算未启用时进入排班。编辑器已提示仅供预览（`AttendanceShiftSegmentsEditor.vue:122-124`）。`SEGMENT_CALCULATION_IMPLEMENTED` 仍为 `false`（`plugins/plugin-attendance/lib/attendance-shift-service.cjs:56-70`）。同文件注释写明：插件里按环境变量决定参考写入的判断已经退役；这个常量只表示权威计算器尚未交付。`ATTENDANCE_SHIFT_SEGMENT_CALCULATION_ENABLED` 仍被实时打卡的外层指纹路径读取（`index.cjs:31163-31164`），它不是把 `SEGMENT_CALCULATION_IMPLEMENTED` 设为真的开关。
16. 员工在自助端改常用图标。设置页保存，总览只读四个键。
17. 报表页的人员选择器。筛选是组织 ID 和用户 ID 文本框。
18. 公式字段互相引用，以及 NOW、TODAY、查找函数、跨表单元格和脚本。统计字段帮助已写明禁用。
19. 补卡周期除自然月以外的周期、按部门共享额度、按工作日计提交窗口。这三项在补卡策略上是固定说明。
20. 哺乳假等特殊假种的单独时长规则。没有对应规则页，只是普通请假类型。
21. 节假日「计入加班」把加班分钟叠加进当日工时。`applyHolidayPolicy` 把 `workMinutes` 设成基准分钟（`index.cjs:12884-12888`），加班来源只追加警告（「节假日首日加班单叠加工时」或「节假日首日存在加班单但未提供加班工时」，`index.cjs:12906-12909`），不把加班分钟加进 `workMinutes`。
