# 考勤帮助中心补全：设计与核验

日期：2026-10-15。只改帮助内容。业务逻辑、迁移、工作流、vitest 配置、`src/index.ts`、`univer-meta.ts`、hash/pin 登记均未改。

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

相关检查：`apps/web/tests/attendanceAdminGuide.spec.ts`。它挂载帮助组件，断言上述短语、团队可用性打开、搜索「口径说明」只命中报表、以及简介/场景/步骤/常见问题四段。

结果见 PR 说明中的命令输出。

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
