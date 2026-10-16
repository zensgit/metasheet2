# 考勤帮助中心补全：设计与核验

日期：2026-10-15，优化：2026-10-16。只改帮助内容。业务逻辑、迁移、工作流、vitest 配置、`src/index.ts`、`univer-meta.ts`、hash/pin 登记均未改。

## 2026-10-16 第五轮

三份排查按「现象 → 原因 → 怎么改」写进现有文章，并新增 `troubleshoot`（排查）。

- 排班保存被拦住：`SHIFT_COMPLIANCE_CAP_EXCEEDED`，强制方式为「保存时阻断」且显式排班分钟超上限。`enforceShiftComplianceCap`：`index.cjs:19667-19690`。
- 和另一组的人换班失败：没有单独的跨组错误码。列表和接口只接受已发布、生效、常规、单日、无生产者标记的排班。固定排班或轮班行带 `producer_type`，因此不出现。代码 `SHIFT_SWAP_SOURCE_UNSUPPORTED`、`SHIFT_SWAP_SOURCE_NOT_SINGLE_DAY`、`SHIFT_SWAP_SOURCE_TEMPORARY_COVERED`。`normalizeShiftSwapSourceSnapshot`：`index.cjs:33049-33072`；前端过滤 `AttendanceView.vue:24836-24841`。
- 预览正常、提交没写上：预览不写考勤行。令牌字面量 `1` 时提交要 10 分钟内的新令牌，过期或已用过为 `COMMIT_TOKEN_REQUIRED` / `COMMIT_TOKEN_INVALID`。`index.cjs:5947-5948`、`43513-43526`。
- `USER_NOT_IN_ORG`：考勤组加人（`index.cjs:47304-47310`）和导入提交写入成员（`index.cjs:30668-30674`）在目标不是本组织有效成员时返回 404。打卡写错组织仍是 `ATTENDANCE_PUNCH_ORG_NOT_PERMITTED`。
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
- 规则：09:12/17:40、宽限 10、取整 5 → 迟到 2、早退 10、工时 505。取整是向下。严重/旷工按宽限后的迟到分钟，内置 30/60。`computeMetrics`、`roundMinutes`：`index.cjs:11918-11922`、`12457-12473`。
- 班次：22:00–06:00 的下班落在次日。`resolveOvernightFlag`：`index.cjs:7106-7108`。
- 补卡：起始日 1 时 2026-03 整月共用 3 次；起始日 26 的周期跨月。窗口按规则时区的工作日。`computeMakeupCycleWindow`：`index.cjs:14854-14873`。同时提交不同日期可能比上限多 1，已写进注意事项。
- 请假：09:00–18:00、480 分钟，中点 13:30，上下午各 240。同一工作日第二条请假即重复，不论上午下午。`halfDayLeaveHelper.ts:105-107`；重复查询 `index.cjs:10543-10556`。
- 加班规则：20→30，40→45，610→600。向上取整后再截每日上限。`applyOvertimeRule`：`index.cjs:11931-11944`。
- 节假日工时：首日默认 8 小时写成 480。加班来源只产生警告，不加进这 480。`applyHolidayPolicy`：`index.cjs:12848-12878`。
- 计薪：26 日至次月 25 日，锚点 2026-03-10 与 2026-03-26 两个窗口。`resolvePayrollWindow`：`index.cjs:8503-8524`。
- 导入：默认表头与跳过原因（日期、工号映射、邮箱/用户名/手机号、两人匹配）。`index.cjs:799-813`；`attendance-import-user-identity.cjs:75-98`。
- 年假：满 8 年发 2400 分钟；累计工龄满年、2026-05-27 入职折成 3 天 1440 分钟；本单位工龄同年入职不满 12 个月跳过。`computeAnnualLeaveAccrualForUser`：`index.cjs:19995-20038`。
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

行号对应当前 `main` 上的源码（帮助改动之前的行为）。

| 帮助文章 | 核对到的行为 | 代码 |
| --- | --- | --- |
| 快速入门 | 管理区块顺序；模板只预填；打卡顺序为轮班班次、个人排班、默认规则 | `useAttendanceAdminRail.ts:203-236`；`attendanceContextHelp.ts:162-169`；组类型文案 `AttendanceView.vue:11594-11614` |
| 打卡 | `POST /api/attendance/punch` 需要 `attendance:write`；拒绝客户端时间；总览按钮为上班/下班打卡；不采集定位 | `index.cjs:30973-30979`；`AttendanceEmployeeWorkspace.vue:78-97`；`punchOutcome.ts:150-161` |
| 打卡约束 | 同类间隔、IP、围栏、未排班仅 `block` 才拒绝、外勤备注 | `index.cjs:31244-31254`；`punchOutcome.ts:114-136`；设置表单 `AttendanceView.vue:2995-3054`、`3305-3364` |
| 常用图标 | 管理员在设置保存四键；员工 `GET /api/attendance/employee-quick-action-icons` 只读；八个图标 id；默认 clock-plus / calendar / moon / swap | `index.cjs:13903-13926`、`52377-52385`；`attendanceEmployeeWorkspaceCommonIcons.ts:9-37`；`AttendanceEmployeeQuickActionIconsField.vue:1-6` |
| 补卡 | 强约束默认关；自然月、自助申请人、自然日固定；额度与窗口；七个 `MAKEUP_PUNCH_*` 人话 | `AttendanceView.vue:2636-2794`；`index.cjs:14909-14968`；`makeupPunchRequestStatus.ts:35-111` |
| 请假 | 全天/上午/下午按窗口中点；「需要审批」暂不生效；同日同类型重复；年假单日；调休编码 `comp_time` | `AttendanceEmployeeLeaveRequestCard.vue:9-11`；`attendanceApprovalOptionHint.ts:36-40`；`index.cjs:19911` |
| 出差 | 独立卡片：目的地时区与当地起止；`POST /api/attendance/business-trip-requests` | `index.cjs:37792` |
| 加班 | 最小/取整/每日上限；跨一个当地午夜可拆；多于一个午夜拒绝；加班银行不收法定节假日 | `index.cjs:12278`、`12345`；加班规则页 `AttendanceView.vue` 加班规则区块；银行说明见设置区加班银行文案 |
| 换班 | 已发布单日常规班；对方先同意；专用路由 | `AttendanceEmployeeShiftSwapRequestCard.vue:28-40`；同意/拒绝 `index.cjs:39173-39179` |
| 查看记录 | 「我的申请」是本人；报表三个数字是当前页；导出忽略本地列显隐，上限 5000 | 既有报表帮助与 `AttendanceView.vue:13722-13779` |
| 班次 | 单段可排班；多段在「仅供预览」时不能分配/轮班/换班/调度/发布 | `AttendanceShiftSegmentsEditor.vue:114-126`；`AttendanceView.vue:28327-28331` |
| 排班 | 草稿后发布；临时替班须再发布；高级排班与综合工时只读；合规阻断 `SHIFT_COMPLIANCE_CAP_EXCEEDED`；一天多班次默认关 | `index.cjs:19713-19724`、`427-431`；工作台 `readOnly` 见高级排班路由注释与页面「只读」文案 |
| 排班范围 | 动作：查看、编辑、导入、导出、清空、审批、调度、提醒；无匹配范围 `SCHEDULER_SCOPE_FORBIDDEN` | `AttendanceView.vue:1988-1991`、`30932-30940`；`index.cjs:26484` |
| 考勤组 | 类型创建后锁定 `ATTENDANCE_GROUP_TYPE_LOCKED`；负责人不计入考勤人员 | `index.cjs:47136`；既有考勤组帮助 |
| 请假类型 / 加班规则 | 「需要审批」只保存 | `attendanceApprovalOptionHint.ts:8-14` |
| 审批流 | 新申请状态 `pending`；空静态步骤进入管理员队列；动态步骤失败 `APPROVAL_DYNAMIC_ASSIGNEE_UNRESOLVED` 且不回退 | `index.cjs:34744`、`24668-24672`、`24747-24751`；页面警告 `AttendanceView.vue:8034` |
| 权限 | 五个键；三个模板不含单独的 import 键，导入路由接受 import 或 admin | `AttendanceView.vue:12797-12800` |
| 年假错误 | `USER_NOT_IN_ORG` 为 404，文案「该用户不是本组织的有效成员。」；与打卡组织错误不是同一个码 | `index.cjs:20401`；`AttendanceView.vue:26656`；打卡组织码见 `attendance-punch-org-resolution.cjs` |
| 时区提示 | 默认规则缺失、冻结上下文、非法时区等固定人话 | `attendanceTimezoneError.ts:3-22` |
| 导入 | 令牌字面量 `1`、10 分钟；`.xlsx` 浏览器转 CSV（10MB）；`.xls` 拒绝 | 既有导入帮助；`importXlsxConvert.ts:8-9`；`useAttendanceAdminImportWorkflow.ts:1368-1398` |
| 节假日 / 计薪 / 统计字段 / 团队可用性 | 沿用已核过的原文，未改其结论 | 原 `attendanceAdminGuideContent.ts` 对应文章 |

## 测试

相关检查是帮助组件规格 `apps/web/tests/attendanceAdminGuide.spec.ts`。它挂载帮助组件，断言既有短语、团队可用性打开对应文章、搜索「口径说明」只命中报表，以及简介、场景、步骤、常见问题四段。

2026-10-16 第五轮之后重跑，均通过：

- `pnpm --filter @metasheet/web exec vitest run --watch=false tests/attendanceAdminGuide.spec.ts`：1 个文件、5 个测试通过（88ms）。
- `pnpm --filter @metasheet/web exec eslint src/views/attendance/attendanceAdminGuideContent.ts --max-warnings=0`：退出码 0。

`apps/web` 的 `lint` 脚本文件清单不包含这篇帮助，所以上面的 eslint 是对改动文件的直接检查。未跑全量 `pnpm lint` / `pnpm type-check`。

## 缺口清单

下列能力在钉钉/飞书考勤帮助里常见。本仓库当前没有可按帮助步骤操作的同等行为，因此不写进用户帮助。

1. Wi-Fi 打卡、蓝牙、考勤机、设备绑定、人脸识别。考勤组里的打卡方式说明写明这些控件要等独立后端契约（`AttendanceView.vue:5879`、`14907`）。现有约束是设置页的 IP 白名单和地理围栏。
2. 网页总览采集 GPS 或在打卡按钮上上传照片。打卡请求不带定位和照片（`punchOutcome.ts:25-27`）。照片证据只对提交定位或外勤标记的客户端生效（`AttendanceView.vue:3337-3338`）。
3. 考勤组上自选「地点 / Wi-Fi / 考勤机」打卡方式。该抽屉不是可编辑的打卡方式配置。
4. 钉钉式自由工时：不排班、只按打卡时长算出勤。自由工时类型在界面上是人员和策略分组（`AttendanceView.vue:11609-11613`）。工作日解析要求非空 `shiftId`，`free_time` 无法提供已发布班次候选（`attendance-work-date-resolver.cjs:764-771`）。
5. 名为「外出申请」「外出打卡」「出差打卡」的独立流程。已有的是出差申请和外勤打卡审批。
6. 请假类型或加班规则取消「需要审批」后免审。界面标明暂不生效（`attendanceApprovalOptionHint.ts:36-40`）。
7. 管理端编辑假期「是否带薪」。字段在存储行上，请假类型表单没有这项。
8. 服务端强制请假附件。页面会拦，创建请求只把链接写入 metadata。
9. 按钟点检测请假时间段重叠。重复规则是同一人、同一工作日、同一申请类型已有待处理或已通过。
10. 年假一次申请跨多个标准日扣减。审批侧单日，超出为 `ANNUAL_LEAVE_MULTI_DAY_UNSUPPORTED`（`index.cjs:19911`）。
11. 加班规则页上的分段开关。三类加班时长来自分段快照；本页只编辑最小、取整和每日上限。
12. 未排班打卡「需审批」。设置归一化接受 `require_approval`（`index.cjs:15060`），打卡路径只在 `block` 时返回 `PUNCH_UNSCHEDULED_BLOCKED`（`index.cjs:31244-31254`）。
13. 排班合规的「预警」拦截。该选项文案为预留；只有「保存时阻断」且填写了上限才会回滚。
14. 自动对班的后台写入。默认关闭，且依赖额外运行开关。帮助不写开启步骤。
15. 多段班次在权威分段核算未启用时进入排班。编辑器已提示仅供预览（`AttendanceShiftSegmentsEditor.vue:122-124`）。`SEGMENT_CALCULATION_IMPLEMENTED` 仍为 `false`（`attendance-shift-service.cjs:70`）。
16. 员工在自助端改常用图标。设置页保存，总览只读四个键。
17. 报表页的人员选择器。筛选是组织 ID 和用户 ID 文本框。
18. 公式字段互相引用，以及 NOW、TODAY、查找函数、跨表单元格和脚本。统计字段帮助已写明禁用。
19. 补卡周期除自然月以外的周期、按部门共享额度、按工作日计提交窗口。这三项在补卡策略上是固定说明。
20. 哺乳假等特殊假种的单独时长规则。没有对应规则页，只是普通请假类型。
21. 节假日「计入加班」把加班分钟叠加进当日工时。`applyHolidayPolicy` 把首日工时设成基准分钟，加班来源只追加警告（「节假日首日加班单叠加工时」或「节假日首日存在加班单但未提供加班工时」），不把加班分钟加进 `workMinutes`（`index.cjs:12852-12878`）。
