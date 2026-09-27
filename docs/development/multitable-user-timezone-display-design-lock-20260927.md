# 多维表按用户时区显示 — DESIGN-LOCK — 2026-09-27

> **Status: PROPOSED（草案，待 owner 复审后实施）。** 本文只锁设计，不含运行时代码。基线冻结在 `origin/main` @ `633421012`
> （含 PR #6083 = `4be9f697b` 业务时区、PR #6082 = `d5daa7acd` 自动化触发时区）。所有 `path:line` 在该 commit 上成立。
>
> **Owner 决定（2026-09-27，原话）：**「如果用户启用跨时区功能，我们能否自动出现时区标识，没有的话我们还是按业务时区」。
> 授权：2026-09-26 无人值守授权 + 2026-09-27「额度不用省」+ 本次决定。本文为 docs-only 任务；实现按 §8 分片，评审后启动。

## 0. 锁定的规则（owner 裁决，实施不得偏离）

1. **默认（用户未启用）**：一切按业务时区（`MULTITABLE_BUSINESS_TIMEZONE`，默认 Asia/Shanghai）显示，**不出现时区标识**。
   这就是今天 #6083 之后的行为，字节级不变。
2. **用户在个人设置里启用「跨时区显示」并选定一个 IANA 时区后**：dateTime 按该时区显示；只要个人时区 ≠ 业务时区，时间旁**自动**出现时区标识，
   如 `2026-09-24 09:00（东京时间）`；相等则无标识。
3. **存储不变**：dateTime / createdTime / modifiedTime 仍是 UTC 瞬时（ISO `Z`）。`date`（浮动日，#3417）不受影响。
4. **导出、自动化日期提醒、"今天"类筛选对该用户遵循同一规则**；服务端从**用户偏好**（请求作用域）得知时区，**永不从浏览器**得知。
5. 功能默认 OFF，按用户 opt-in；无需 env flag（§7）。

## 1. 现状（基线事实，负面结论附检索范围）

**时区解析与显示（web）**：`apps/web/src/multitable/utils/business-timezone.ts:89-93` `resolveDateTimeTimezone` = 字段显式非 `'UTC'` 时区 → 业务时区；
业务时区是一个响应式 holder（`:51-67`），由 `/api/multitable/context`、`/form-context` 响应写入（`apps/web/src/multitable/api/client.ts:2330, 2952`）。
现有"提示"（非本文的标识）：`:381-396` 按**浏览器**偏移与业务时区比较，浏览器不同才显示「北京时间」；挂在四处：
`components/cells/MetaDateTimeInput.vue:24,72`（title）、`components/MetaFieldHeader.vue:97`、`components/MetaFormView.vue:179-182`、
`components/MetaRecordFieldsPanel.vue:234-237`。显示消费点：`utils/field-display.ts:155-157`（格子、创建/修改时间）、`:62-75`（导出/分组头文本）、
`components/MetaGridTable.vue:928`（分组头）、`:1661`（粘贴解析）、`components/cells/MetaCellEditor.vue:679`、`components/cells/MetaDateTimePicker.vue:65`、
`components/MetaFilterConditionRow.vue:196-215`（筛选值按字段/业务时区解析后以**绝对瞬时**发给服务端）、`import/delimited.ts:204`（导入解析）、
`views/MultitableWorkbench.vue:5109, 5133`（CSV/XLSX 客户端导出经 `dateTimeExportText`）。

**服务端**：`packages/core-backend/src/multitable/business-timezone.ts:32-44`（env 解析）、`:63-70`（字段时区规则）；`date-time-wall-clock.ts:140-172`（格式化 /
分钟键）。`routes/univer-meta.ts:9056`、`:17301` 把 `businessTimezone` 回显给 web（匿名公共表单同样回显）。导出：`:16000-16026` 每列解析一次时区
（`exportDateTimeZoneById`），`:16142` 导出内视图筛选求值。筛选：`evaluateMetaFilterCondition` `:4244-4297` **在函数内部**取业务时区（`:4271`），
六个调用点——请求作用域三个：`export-xlsx :16142`、`view-aggregate :16353`、`/view :16859`；非请求作用域三个：`resolveRelationAggregation :1692`、
`applyLookupRollup :3854`、`loadDashboardSourceRows :5423`。相对日期算子 `evaluateRelativeDateOp :4219-4242` 仅 `date` 字段、按 **UTC 日**。

**自动化日期提醒**：规则自带 `triggerConfig.timezone`（`multitable/automation-date-reminder.ts:19-24, 36-42`），编辑器新建默认业务时区
（`apps/web/src/multitable/utils/automation-trigger-timezone.ts:87-98`）；调度器无用户上下文（`automation-scheduler.ts` 中检索 `actorId|userId|created_by` 为空）。

**请求用户身份**：`multitable/access.ts:59-97` `resolveRequestAccess(req).userId` 来自 `req.user`（`auth/jwt-middleware.ts:111`）；
API token 请求 `req.user = { id: createdBy, apiToken: true }`（`middleware/api-token-auth.ts:80-83`）。

**用户偏好存储（负面结论）**：仓库无通用用户偏好表——检索 `packages/core-backend/src/db/migrations/*`、`migrations/*.sql`、`src/**/*.ts` 的
`user_preferences|userPreferences|user_settings|preferences`，只命中 `_template.ts:15` 的示例文件名、插件表 `preferences` jsonb、
`NotificationPreferences` 类型。`users` 表（`zzzz20260119100000_create_users_table.ts`）无 locale/timezone 列。web 语言只存 localStorage
（`composables/useLocale.ts:5,19-29`），无服务端。可复用的**反先例**：`view_states`（`routes/views.ts:273,298` 以 `|| 0` 取用户，个人视图 design-lock 明确禁止继承）；
**正先例**：`meta_view_personal_configs`（`zzzz20260705150000`，`(view_id,user_id)` 唯一、actor 只来自 `resolveRequestAccess`）。
个人设置页：`/settings` 是 `SessionCenterView`「我的会话」（`router/appRoutes.ts:255-259`），无偏好页；语言切换在 `App.vue:311-315` 导航栏。
时区列表与标签：`apps/web/src/utils/timezones.ts:83-99, 101+`（`UTC+09:00 · Asia/Tokyo`），北京别名集 `business-timezone.ts:30-36`。

## 2. 锁定 1 — 数据模型

- 新表 **`user_display_preferences`**（不改 `users`：认证/目录同步敏感；不扩 `view_states`：反先例）。列：`user_id text PRIMARY KEY`、
  `timezone_enabled boolean NOT NULL DEFAULT false`、`timezone text NULL`（≤64）、`updated_at timestamptz NOT NULL DEFAULT now()`；
  `CHECK (timezone_enabled = false OR timezone IS NOT NULL)`。无行 = 未启用。
- 迁移 `packages/core-backend/src/db/migrations/zzzz20260927120000_create_user_display_preferences.ts`（沿用 `zzzz` 前缀 + 幂等 `IF NOT EXISTS`）；
  `down` = `DROP TABLE IF EXISTS`。回滚后代码路径落回业务时区（§7）。
- 校验（服务端，写入时）：`isValidIanaTimeZone`（`multitable/automation-timezone.ts`）+ trim；不合法 → 400 `VALIDATION_ERROR`（values-free）。
  个人时区**不**采用字段属性里「`'UTC'` = 未设」的语义：`enabled` 已显式表达"设/未设"，存什么就按什么解析。

## 3. 锁定 2 — API 与加载

- `GET /api/multitable/me/display-timezone` → `{ enabled, timezone }`；`PUT` 同路径，body 仅 `{ enabled: boolean, timezone: string | null }`。
  挂在 `univerMetaRouter`（`src/index.ts:1914`）。**actor 只取 `resolveRequestAccess(req).userId`**；body/query/header 中任何 userId 被忽略（不是拒绝，是无影响，
  与 personal-view-config §1-B 同构）。切片 1 **无管理员代设**路由。`req.user.apiToken === true` 的请求：`PUT` 403，`GET` 返回禁用。
- web 一次加载：`/context` 与**已认证**的 `/form-context` 响应新增 `viewerTimezone: { enabled, timezone } | null`（匿名/API token 为 `null`），
  与 `businessTimezone` 同一落点（`client.ts:2330, 2952` → 新 holder `setViewerTimezone`），无额外往返；`PUT` 成功后直接用响应写 holder，不重拉。
- 服务端缓存：**仅请求内 memo**（首次解析后挂 `req`），不做跨请求缓存；每个需要的请求最多一次主键查询（导出/筛选/导入按请求一次，不按格子）。因此无失效问题。

## 4. 锁定 3 — 显示解析顺序与标识

- 有效时区 = **字段显式非 `'UTC'` `property.timezone`** ＞ **用户时区（enabled 且合法）** ＞ **业务时区**。web 与服务端同一函数形状
  （web：`resolveDateTimeTimezone(property)` 内部读 viewer holder；服务端：`resolveDateTimeFieldTimeZone(property, viewer)`）。
- 标识规则：**仅当有效时区与业务时区在所显示瞬时的 UTC 偏移不同**才显示（与 web `business-timezone.ts:381-384` 现有比较法一致：Asia/Singapore 与 Asia/Shanghai 同钟面不标）。
  标签：中文 `<城市>时间`（东京时间 / 伦敦时间 / 纽约时间 / 新加坡时间 / 洛杉矶时间 / 悉尼时间 / 柏林时间，北京别名集沿用 `:30-36`），英文 `Tokyo time`；
  不在表内 → `<IANA id> (UTC±hh:mm)`（即 `businessTimezoneLabel :386-391` 现规则）。渲染形态 `YYYY-MM-DD HH:mm（东京时间）`，标识是**只读装饰**：
  不进入编辑框文本、不进入导出单元格、不参与 `contains` 匹配。
- 默认模式下现有"浏览器不同则提示北京时间"的四处提示**保持不变**（今天的行为）；它不是本文的标识，且是用户发现本功能的入口（见 Q3）。

## 5. 锁定 4 — 服务端对齐（请求作用域，永不来自浏览器）

- 新模块 `multitable/viewer-timezone.ts`：`resolveViewerDisplayTimeZone(req)`；API token / 匿名 / 查询失败 → 业务时区（fail-to-default，values-free 单次 warn，**不**让请求失败）。
- **导出**（`:16000-16026`）：dateTime 列 = 字段显式时区 else viewer 时区；createdTime/modifiedTime = viewer 时区。单元格文本形状不变，表头不变（Q4）。
- **导入/写入解析**必须对称，否则用户导出再导入会漂移一个偏移量：服务端 `multitable/field-codecs.ts:1012` `validateDateTimeValue`（经 `:1163` 进入记录写入与
  `import-xlsx :15754`）与 web `delimited.ts:204`、粘贴 `MetaGridTable.vue:1661` 对**无时区文本**按 viewer 时区读；API token 请求按业务时区读（集成方行为确定）；
  时光机恢复校验 `exact-anchor-restore-validate.ts:97` 是非请求语义，保持业务时区。
- **筛选**：`evaluateMetaFilterCondition` 增加可选 `options.dateTimeZone`（缺省 = 业务时区 → 未传参调用点字节不变）；三处请求作用域调用点传 viewer 时区；
  三处非请求作用域（lookup/rollup 派生值、仪表盘）保持业务时区（结果被所有用户共享）。web 侧 `MetaFilterConditionRow` 解析筛选值时用同一有效时区。
  相对日期算子今天只作用于 `date` 字段（浮动日，与用户时区无关）：切片 1 不改；未来若给 dateTime 加 istoday 等算子，必须取 viewer 时区（记入 §6 延后）。
- **自动化日期提醒**：规则继续自存时区；编辑器**新建默认仍是业务时区**（`triggerTimezoneForSave` 不变）；当编辑者启用了个人时区，时区选项里**额外列出**
  「我的时区（东京时间）」供显式选择。提醒发出的通知正文仍按规则时区/业务时区（收件人偏好属通知面，延后）。

## 6. 锁定 5、6 — 覆盖面与公共表单

| 切片 1 覆盖 | 延后（与 #6083 "Deferred" 表及 wave-4「datetime deferred surfaces」对齐） |
|---|---|
| 格子显示与编辑器、抽屉字段面板、已认证表单视图、createdTime/modifiedTime、分组头、字段头提示、筛选行、粘贴/导入、CSV/XLSX（web + 服务端）、记录页 | 日历/时间线按日分桶、history/provenance/comment/notification 时间戳（13 个组件）、dateTime 的 lookup 值、仪表盘、Yjs 桥、通知正文 |

延后项的排序：wave-4 项先把这些面收敛到**业务时区**；本文的 viewer 时区通过同一解析函数在其后叠加（§8 S4），切片 1 不碰这些文件。

**公共表单（匿名）**：只按业务时区，`form-context` 带 `publicToken` 时 `viewerTimezone = null`，web 在公共表单路径把 viewer holder 置为禁用——即使同一浏览器里有已登录会话也不带入。

## 7. 锁定 7 — 测试、开关、回滚

- **单元**：web `business-timezone` 解析顺序（字段＞用户＞业务）、标识规则（同偏移不标、装饰不进编辑文本）、标签表；服务端 `viewer-timezone`（无行/禁用/非法/API token/查询失败均 → 业务时区）、
  `evaluateMetaFilterCondition` 缺省参数字节不变。
- **一条真库用例** `tests/integration/multitable-export-viewer-timezone-realdb.test.ts`（`describeIfDatabase` 形状同 `multitable-export-allrows-maskroute-realdb.test.ts:30`）：
  同一张表、同一格 `2026-09-24T01:00:00.000Z`，用户 A（Asia/Tokyo）导出得 `2026-09-24 10:00`，用户 B（未启用）得 `09:00`；伪造 `x-user-id`/`body.userId` 不改变结果。
- **web 规格带 TZ 探针**：沿用 `apps/web/tests/multitable-datetime-business-tz.spec.ts:11-13` 的**子进程 `TZ`** 方法（`tests/helpers/multitableBusinessTzProbe.ts`）：
  `TZ=America/New_York` 下用户时区 Asia/Tokyo，格子显示 `10:00（东京时间）`、输入 `10:00` 存 `01:00Z`；登记到 `apps/web/scripts/run-required-web-tests.sh` 一行一个 token。
- **变异证据**：每条守卫须有"去掉即红"（内存级：去掉 `enabled` 判断 → 单元红；去掉 actor 限定 → 伪造身份用例红；导入不对称 → 往返用例红）。
- **开关**：**不新增 env flag**——按用户 opt-in 本身就是门，`global-history-flag-manifest` 不需登记。**回滚**：迁移 `down` 删表；表缺失/查询错 → 业务时区（§5），前端 `viewerTimezone` 缺失 → 禁用。

## 8. 交付切片与估算

| 切片 | 内容 | 估算 |
|---|---|---|
| S1 数据 + API | 迁移、`viewer-timezone.ts`、GET/PUT、`/context`/`/form-context` 回显、单元测试、伪造身份用例 | 1 人日 |
| S2 服务端对齐 | 导出/筛选/导入/写入解析接 viewer 时区、API token 分支、真库导出用例 | 1 人日 |
| S3 Web 显示与设置 | holder + 解析顺序、标识与标签表、§6 左列各面、设置入口（导航栏语言切换旁 +「我的会话」页新增「个人显示设置」区）、TZ 探针规格 | 1.5 人日 |
| S4 自动化与延后面 | 提醒编辑器「我的时区」选项；wave-4 收敛后在日历/时间线/历史时间戳叠加 viewer 时区 | 0.5 + 1 人日（后者待 wave-4） |

## 9. 非目标与 owner 待答

**非目标**：管理员/部门默认时区；团队级时区；改变存储；`date` 字段；浏览器时区自动生效（设置页可把浏览器时区**预选为建议**，但未点保存不落任何值，服务端永不读浏览器）；
DST 规则改动（沿用 `business-timezone.ts:165-170` 的 gap/overlap 规则）。

- **Q1** DST 时区的标识措辞：`纽约时间` 固定，还是随季节 `美东夏令时间`？建议固定城市名（偏移已隐含在解析中）。
- **Q2** 是否允许管理员按部门设置默认个人时区？建议切片 1 不做，等真实需求。
- **Q3** 有了 opt-in 后，现有"浏览器不同即提示北京时间"是否保留、还是改成指向设置的入口？建议保留并追加链接。
- **Q4** 用户时区导出的 XLSX/CSV 表头是否加 `（东京时间）` 后缀？建议不加（保持再导入对称），在导出对话框提示。
- **Q5** 既有问题：`date` 字段的 istoday/isoverdue 按 **UTC 日**（`:4222-4225`），北京 00:00–08:00 之间"今天"仍是昨天；与用户时区无关，建议另开修复改按业务日。
