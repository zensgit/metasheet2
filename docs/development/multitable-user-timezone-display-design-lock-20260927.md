# 多维表按用户时区显示 — DESIGN-LOCK — 2026-09-27

> **Status: PROPOSED（草案，评审第 3 轮修订后待 owner 复审）。** 本文只锁设计，不含运行时代码。基线冻结在 `origin/main` @ `c5dd857b2`
> （含 PR #6083 = `4be9f697b` 业务时区、PR #6082 = `d5daa7acd` 自动化触发时区）。所有 `path:line` 在该 commit 上成立
> （第 3 轮由 `6adc99fd0` 重定位：`univer-meta.ts`、`multitable-ai.ts`、`api/client.ts`、`MetaRecordFieldsPanel.vue`、`MultitableWorkbench.vue`、`meta-manager-labels.ts` 六个文件逐行重算，其余引用文件字节相同）。
>
> **Owner 决定（2026-09-27，原话）：**「如果用户启用跨时区功能，我们能否自动出现时区标识，没有的话我们还是按业务时区」。
> 授权：2026-09-26 无人值守授权 + 2026-09-27「额度不用省」+ 本次决定。owner 原话只覆盖**显示与标识**；其余取值均为 T 层默认，逐条列在 §10
> （`Ratified-by-default-2026-09-27`，24h 可否决）。修订记录：第 1 轮 2 blocker + 8 should-fix；第 2 轮 1 blocker + 4 should-fix + 9 nit（S2「默认模式也出标识」未采纳 → Q6）；
> 第 3 轮 2 should-fix（筛选行不提交无效值、自动化条件编辑器入延后表）+ 3 nit + 基线重定位，均已吸收。

## 0. 锁定的规则

1. **默认（用户未启用）**：按**解析时区**（字段显式非 `'UTC'` 时区 ＞ 业务时区 `MULTITABLE_BUSINESS_TIMEZONE`，默认 Asia/Shanghai）显示与编辑，**不出现时区标识**。
   这就是今天 #6083 之后的行为，字节级不变。字段显式时区今天只有集成方能设（无 UI 选择器，`business-timezone.ts:81`）；它在默认模式下显示非业务钟面且无标识是**既有**行为，本文不改（Q6）。
2. **启用「跨时区显示」并选定 IANA 时区后**：dateTime 按**显示时区**（字段显式 ＞ 用户 ＞ 业务）显示**并按同一钟面键入/选取**；只要显示时区与业务时区在所显示瞬时的 UTC 偏移不同，
   时间旁**自动**出现标识，如 `2026-09-24 09:00（东京时间）`；相同则无。
3. **存储不变**：dateTime / createdTime / modifiedTime 仍是 UTC 瞬时（ISO `Z`）。`date`（浮动日，#3417）不受影响。
4. **导出、筛选、自动化提醒**（T 层默认，owner 原话未涉及）：导出跟随显示时区、需要时带偏移后缀（D3）；筛选求值**不改**（业务时区，D4）；新建提醒默认业务时区（D8）。
   服务端从**用户偏好**（请求作用域）得知时区，**永不从浏览器**得知。
5. 默认 OFF，按用户 opt-in；不新增 env flag（D7；kill-switch 见 Q5）。

## 1. 现状（基线事实，负面结论附检索范围）

**web**：`apps/web/src/multitable/utils/business-timezone.ts:89-93` `resolveDateTimeTimezone` = 字段显式非 `'UTC'` ＞ 业务；业务时区是响应式 holder（`:51-67`），由 `/context`、`/form-context` 响应写入（`api/client.ts:2335, 2965`）。
读已存值的函数都是**单一 `timeZone` 参数**：`dateTimeValueToUtcMs` / `formatDateTimeInZone`（`:333-346`；`:338` 注释「zone-less stored string is a business wall clock」）、`pickerDateForValue` / `valueForPickerDate`（`:410-428`）；读键入文本：`parseDateTimeInput`（`:363-369`，`requireTime`）、`parseDateTimeTextToUtcMs`（`:261-294`；`:283` 裸日期仅在 `requireTime` 时拒绝）。
**键入面（每一处都经 `resolveDateTimeTimezone` 取单一时区）**：`components/cells/MetaCellEditor.vue:679`；`components/MetaRecordFieldsPanel.vue:223`（输入）`:231`（选择器）`:236/:239`（提示）；`components/MetaFormView.vue:166/:173/:179/:182`；`components/MetaFilterConditionRow.vue:196`（`:199` 显示、`:205` 有效性、`:208` 解析）。
筛选行的提交路径：`:205` 不带 `requireTime`（裸日期不被判无效）；`:209` `if (!parsed.ok) return text`、`:217-218` 仍把被拒文本 emit 进视图筛选；「无效」只有 `:90` 的 `aria-invalid`，`:222-228` scoped 样式里没有对应 CSS；`:195` 注释「backend treats it as matching nothing」对**裸日期不成立**——服务端 `univer-meta.ts:4272-4274` → `date-time-wall-clock.ts:112-125` 按业务时区零点求值（只对真正不可解析的文本 `dateTimeMinuteKey` 才为 null → 不匹配）。对照：编辑器从不提交无效草稿（`MetaDateTimeInput.vue:55-60`）。
共用组件 `components/cells/MetaDateTimeInput.vue:46`（单一 `timezone` prop）`:76`（显示已存值）`:80`（比较已存值）`:24/:72`（title 提示）；`components/cells/MetaDateTimePicker.vue:65-66, 82-86, 100`。
现有浏览器提示 `dateTimeZoneHint`（`:394-396`，浏览器偏移 vs 业务 `:381-384`）四处：两处可见 span（`MetaFormView.vue:179-182`、`MetaRecordFieldsPanel.vue:236-239`），两处仅 hover 的 title（`MetaDateTimeInput.vue:24`、`MetaFieldHeader.vue:16-17, 96-98`）。
显示：`utils/field-display.ts:155`（dateTime 格子，字段时区）、`:157`（createdTime/modifiedTime，业务）、`:63`（`dateTimeFieldTimezone`，导出/分组头）、`:37, 46`（默认参数，`src` 内无调用方）；`utils/automation-trigger-timezone.ts:34`（提醒编辑器默认）。
自动化**条件**编辑器：`components/MetaAutomationRuleEditor.vue:2941`（dateTime/createdTime/modifiedTime 条件 → `dateTime` 控件）`:2953`（原生 `datetime-local`：浏览器时区、原始 `YYYY-MM-DDTHH:mm`）`:344-346`；服务端 `multitable/automation-conditions.ts:461-468` 对字符串逐字比较（与已存 ISO `Z` 形状不同）。
外来文本：`import/delimited.ts:204`、粘贴 `components/MetaGridTable.vue:1661`（复制 `:1641` 是 `String(val)` 原样：正常值为绝对 ISO，遗留无时区字符串原样带出）、预填 `MetaFormView.vue:605-613`。导出 `views/MultitableWorkbench.vue:5121, 5145`。dateTime 筛选算子只有 is/isNot/after/before/isEmpty/isNotEmpty（`composables/useMultitableGrid.ts:290-297`）。时区列表 `apps/web/src/utils/timezones.ts:7-17`（回退列表）、`:101+`（`buildTimezoneOptions`）；北京别名集 `business-timezone.ts:30-36`。

**服务端**：`packages/core-backend/src/multitable/business-timezone.ts:32-44`（env，只 trim `:34-36`）、`:63-70`（`resolveDateTimeFieldTimeZone`；`:69` 回退与 `:4272` 同一函数）；`date-time-wall-clock.ts:55`（`ABSOLUTE_RE` 接受 `±hh:mm`）、`:112-125`（无时区文本 → 给定时区钟面，裸日期 = 零点）、`:149-161`（单一 `timeZone`）、`:169-171`（`dateTimeMinuteKey`）。
`routes/univer-meta.ts:9088`、`:17335` 回显 `businessTimezone`。导出 `:16034-16060`：`:16042` 字段时区、`:16043` 业务时区、`:16056` 裸钟面；`:16037-16039` 不变量「an export re-imports to the same instant」。
写入解析：`field-codecs.ts:1012` ← `:1163` ← `record-write-service.ts:994`（`:829` 事务内）/ `record-service.ts:715`（`:566` 事务内）；导入 `:15788` 同一 codec。
筛选：`evaluateMetaFilterCondition(type, cellValue, condition, nowMs)`（`:4245-4250`）内部取业务时区 `:4272`，用于分钟键、`between`（`:4284`）、`contains` 文本（`:4293`）；`:4265-4268` 注释承诺「API 无时区文本 = 业务时间」；相对日期算子仅 `date`（`:4269-4270`；`:4220-4243` 按 UTC 日）。**七个调用点**（全部在有 `req` 的路径上）：`export-xlsx :16176`（路由 `:15911`）、`view-aggregate :16387`（`:16253`）、`/view :16893`（`:16629`）、`routes/multitable-ai.ts:807`（bulk-preview，路由 `:669`，`:754/:804` 要求 parity with /view）；派生值 / 共享结果三处——`resolveRelationAggregation :1693`（`:1629 req: Request | undefined`）、`applyLookupRollup :3855`（`:3682`）、`loadDashboardSourceRows :5424`（`:5325 req: Request`）。
条件格式日规则 `conditional-formatting-service.ts:162-163`（`startOfDay` 按**进程本地**时区）、`:171`（`Date.parse`）：既有问题，与本文无关，入延后表。

**认证与身份**：`src/index.ts:1745-1757`——`publicToken` 走 `optionalJwtAuthMiddleware`（`:1747`；`auth/jwt-middleware.ts:41-50`），有效 bearer 时仍写 `req.user`（`:111`）；`mst_` token 仅 `multitable/oapi-read-allowlist.ts:29-47, 79-91` 放行（`:1752`），其它 → `jwtAuthMiddleware` 401（`:1756`）。`multitable/access.ts:62-66` `userId` 可为 `''`，`:79-81` 原样返回（反先例 `routes/views.ts:273,298` 的 `|| 0`）。API token 形状 `middleware/api-token-auth.ts:80-83`。

**自动化提醒**：`multitable/automation-date-reminder.ts:19-24, 36-42`；编辑器默认业务（`automation-trigger-timezone.ts:87-98`）；调度器无用户上下文（`automation-scheduler.ts` 检索 `actorId|userId|created_by` 为空）。

**用户偏好存储（负面结论）**：无通用偏好表（检索 `src/db/migrations/*`、`migrations/*.sql`、`src/**/*.ts` 的 `user_preferences|userPreferences|user_settings|preferences`，只命中 `_template.ts:15`、插件 `preferences` jsonb、`NotificationPreferences`）。`users`（`zzzz20260119100000_create_users_table.ts`）无 timezone 列；web 语言只在 localStorage（`composables/useLocale.ts:5,19-29`）。正先例 `meta_view_personal_configs`（`zzzz20260705150000_create_meta_view_personal_configs.ts`；同前缀另有钉钉动作迁移，勿混）。`/settings` = `SessionCenterView`（`router/appRoutes.ts:255-259`）；语言 `<select>` `App.vue:94-100`（`onLocaleChange :311-315`）。`db/migration-provider.ts:32-34`：provider 缺迁移名 = 历史损坏。

## 2. 锁定 1 — 数据模型

- 新表 **`user_display_preferences`**：`user_id text PRIMARY KEY`、`timezone_enabled boolean NOT NULL DEFAULT false`、`timezone text NULL`、`updated_at timestamptz NOT NULL DEFAULT now()`；
  `CHECK ((timezone_enabled = false OR timezone IS NOT NULL) AND (timezone IS NULL OR char_length(timezone) <= 64))`。无行 = 未启用。不改 `users`，不扩 `view_states`。
- 迁移 `src/db/migrations/zzzz20260927120000_create_user_display_preferences.ts`（幂等）；`down` = `DROP TABLE IF EXISTS`。**回滚顺序**：先 `down` 再退代码，或只 forward-fix（`migration-provider.ts:32-34`）。
- 写入校验（D11）：trim → `isValidIanaTimeZone`（`automation-timezone.ts:54-63`）→ **按用户输入原样落库**（与业务时区 `:34-36` 同一规则）。**不**用 `Intl.DateTimeFormat(...).resolvedOptions().timeZone` 规范化：
  它随 ICU 变——本机 Node 20.20.2 / ICU 78 实测 Asia/Kolkata→Asia/Calcutta、Europe/Kyiv→Europe/Kiev、Etc/UTC→UTC、EST5EDT→America/New_York，会让 GET ≠ PUT。
  `{ enabled: true, timezone: null }`、非法、超 64 字符 → 路由层 400 `VALIDATION_ERROR`（values-free）；CHECK 是最后防线。不采用「`'UTC'` = 未设」语义。

## 3. 锁定 2 — API、身份、加载

- `GET/PUT /api/multitable/me/display-timezone`，body 仅 `{ enabled, timezone }`，挂 `univerMetaRouter`（`index.ts:1913-1918`）。**actor 只取 `resolveRequestAccess(req).userId`**，body/query/header 中 userId 无影响。
  **`userId === ''` 必须拒绝（D13）**：`PUT` → 401、`GET` → `{ enabled: false, timezone: null }`、任何路径的 viewer 解析 → 业务时区且**不查库**——否则所有无 id 请求共享同一行（`access.ts:62-66, 79-81`；`views.ts:273` 的 `|| 0` 反先例）。切片 1 无管理员代设。
- **`mst_` API token**：新路由不入 allowlist → GET/PUT 网关 401（`index.ts:1752 → :1756`）；路由内 `apiToken === true → 业务时区` 分支保留为纵深防御。
- **`publicToken`（D5）**：带 `publicToken` 即业务时区、`viewerTimezone = null`，即使 `req.user` 已被写入（`index.ts:1747`，`jwt-middleware.ts:41-50, 111`）。
- web 一次加载：`/context` 与已认证 `/form-context` 新增 `viewerTimezone: { enabled, timezone } | null`，与 `businessTimezone` 同落点（`client.ts:2335, 2965` → `setViewerTimezone`）；`PUT` 成功后用响应写 holder。
- **读取时机（D10）**：切片 1 触及偏好表的服务端路径只有 `/context`、`/form-context`、`export-xlsx`（GET，池上读）与本路由（GET 读；PUT 是对偏好表自身的单条 upsert，不含其它事务）——**没有记录写路径读它**（D1/D2 使写路径与查看者无关）。每请求最多一次主键查询，不做跨请求缓存。
  约束保留：将来若任何写路径需要它，必须在事务开始前于 `pool` 读、作为值传入，不得在事务句柄上查（`record-write-service.ts:829`、`record-service.ts:566`）。

## 4. 锁定 3 — 解析时区 / 显示时区拆分与标识

- **两个时区（D9）**：**解析时区** = 字段显式非 `'UTC'` ＞ 业务，即今天的 `resolveDateTimeTimezone`（web `:89-93`）/ `resolveDateTimeFieldTimeZone`（服务端 `:63-70`），**不改**，只用于读**已存**无时区字符串与外来文本。
  **显示时区** = 字段显式 ＞ 用户（enabled 且合法）＞ 业务，新函数 web `resolveDateTimeDisplayTimezone(property)` / 服务端 `resolveDateTimeDisplayTimeZone(property, viewer)`，用于显示**与用户键入/选取**。未启用时两者恒等 → 字节不变。
- **共用函数形状**：读已存值的 `dateTimeValueToUtcMs`、`formatDateTimeInZone`（`:333-346`）、`pickerDateForValue`（`:410-415`）拆成 `(value, parseZone, displayZone)`（无时区已存字符串按 `parseZone` 读——`:338` 现注释；改字段类型不迁移值 `field-retype-whitelist.ts:4-5`，遗留值长期存在）；
  读键入/选取结果的 `parseDateTimeInput`（`:363`）、`valueForPickerDate`（`:418`）保持单参数 = **显示时区**。服务端 `dateTimeValueToUtcMs` / `formatDateTimeValue`（`:149-161`）同样拆分。
- **键入面逐处（B1）**——启用时「显示 / 键入」= 显示时区、已存无时区字符串 = 解析时区；未启用时全部 = 解析时区（即今天）：

  | 位置 | 今天 | 改为 |
  |---|---|---|
  | `MetaDateTimeInput.vue:46` prop `timezone`；`:76` 显示已存值；`:80` 比较已存值 | 单一 zone | 新增 prop `parseTimezone`（默认业务）；`:76/:80` 用 `(parseZone, displayZone)`；键入解析用 `timezone`（显示） |
  | `MetaDateTimePicker.vue:66 / 82-86 / 100` | 单一 zone | 同上：`pickerDateForValue(value, parseZone, displayZone)`、`valueForPickerDate(picked, displayZone)` |
  | `MetaCellEditor.vue:679` | `resolveDateTimeTimezone` | `timezone = resolveDateTimeDisplayTimezone`，`parseTimezone = resolveDateTimeTimezone` |
  | `MetaRecordFieldsPanel.vue:223 / :231` | 同上 | 同上；`:236/:239` 提示 → 标识（本节末） |
  | `MetaFormView.vue:166 / :173`（已认证） | 同上 | 同上；`:179/:182` 提示 → 标识；公共表单路径 holder 禁用 → 恒为解析时区 |
  | `MetaFilterConditionRow.vue:196` | 同上 | `:199` 显示、`:208` 键入解析 → 显示时区；**已存无时区筛选文本的解析时区 = 业务时区**（镜像服务端 `:4272`，不经 `resolveDateTimeTimezone`；仅显式时区字段有差 → Q7）；`:205` 有效性改 `requireTime: true`；**`:209 / :217-218` 解析失败不再 emit**——保留上次已提交值，输入框加可见错误样式 + 中/英文 values-free 提示（D12）；值框旁新增标识 span |
  | `field-display.ts:155 / :157 / :63` | 字段 / 业务 | 显示时区（已存值仍按解析时区读）；`:37/:46` 默认参数对齐（无调用方） |

  反例（实现必须让它为红）：业务 Shanghai、用户 Tokyo，格子 `10:00（东京时间）`，编辑器打开显示 `10:00`、键入 `10:00` → 存 `01:00Z` → 格子仍 `10:00（东京时间）`；若编辑器显示 `09:00` 或存成 `02:00Z` 即违反规则 2。
- **禁改**：`getBusinessTimezone()`（`:54-56`）、`resolveDateTimeTimezone`（`:89-93`）本体；`automation-trigger-timezone.ts:34`（D8）。
- **标识（D6）**：以 `enabled` 为门（未启用字节不变，含 Q6 的集成方字段时区例外）。启用后，仅当显示时区与业务时区**在所显示瞬时**的 UTC 偏移不同才显示（同 `browserTimezoneDiffers :381-384` 比较法；空值以 `now`）。
  DST 业务时区可能逐格有/无标识，建议固定偏移业务时区。标签：中文 `<城市>时间`（东京 / 伦敦 / 纽约 / 新加坡 / 洛杉矶 / 悉尼 / 柏林；北京别名集 `:30-36`），英文 `Tokyo time`；不在表内 → `<IANA id> (UTC±hh:mm)`（`:386-391`）。
  形态 `YYYY-MM-DD HH:mm（东京时间）`，只读装饰：不进编辑框文本、不进导出单元格、不参与 `contains`。
- **可见载体（N2）**：标识必须是**可见文本**——格子渲染文本、抽屉 / 表单 / 筛选行的 span、字段头名称旁；`MetaDateTimeInput.vue:24` 与 `MetaFieldHeader.vue:16-17` 的 title 只是辅助，不算「自动出现」。
  **接受的限制**：格子编辑器打开期间，格子文本被输入框替换，此刻标识由**字段头名称旁的可见文本**（同列常驻）与输入框 title 承载；提交后格子标识恢复。抽屉 / 表单 / 筛选行的 span 在编辑期间持续可见。
  启用时四处 `dateTimeZoneHint`（浏览器 vs 业务）**被替换**为标识文本（显示 vs 业务），不叠加；未启用保持今天。

## 5. 锁定 4 — 解析作用域、导出、筛选

**5.1 谁键入的文本按谁的钟读（D1 / D2）**
- (a) **web UI 键入 / 选取**（§4 表内各处）→ 显示时区：用户正看着那个钟面。web 解析后仍以绝对 ISO 发服务端。
- (b) **别处产生的文本**——XLSX/CSV 导入（`:15788` → `field-codecs.ts:1163/:1012`；web `delimited.ts:204`）、粘贴（`MetaGridTable.vue:1661`；复制 `:1641` 原样带出的遗留无时区字符串本就是业务钟面，按解析时区读才保义）、预填（`MetaFormView.vue:605-613`）、JWT REST 无时区写入（`record-write-service.ts:994`、`record-service.ts:715`）、插件 / 内部调用 → **解析时区**，永不查看者。
  否则：① PLM/K3 导出的 `09:00` 被东京用户导入存 00:00Z 而非 01:00Z；② A 导出 B 导入偏 1h；③ 预填链接逐人不同；④ REST 语义随 JWT 持有人偏好变。`:16037-16039` 不变量对任何导入者成立。
- 时光机校验 `exact-anchor-restore-validate.ts:97` 保持业务时区。

**5.2 导出（D3）**：单元格带 `+09:00` 后缀**当且仅当显示时区 ≠ 解析时区**（按该瞬时 UTC 偏移）——只在启用且用户时区偏移 ≠ 该列解析时区时发生；未启用用户（含集成方字段时区列）保持今天 `:16042-16043 / :16056` 的裸钟面**字节不变**。
后缀服务端 `ABSOLUTE_RE :55`、web `:232` 已接受，任何导入者精确往返。表头不变。覆盖 `export-xlsx :16034-16060` 与 web `MultitableWorkbench.vue:5121, 5145`；分组头（`MetaGridTable.vue:928`）是显示面：显示时区、无后缀、按 §4 标识。

**5.3 筛选（D4）**：**本文不改 `evaluateMetaFilterCondition`**（`:4245-4299` 字节不变，仍按 `:4272` 业务时区，不加参数）。理由：按查看者求值会让共享视图逐人不同；改按字段时区虽对无显式时区字段等价（`:69` 与 `:4272` 同一回退），
但对显式时区字段会改变无时区筛选值（#6083 前保存的视图、JWT / 插件写的配置，`:4265-4268` 承诺）、遗留无时区单元格（`:169-171`）、`contains` 文本（`:4293`）、`between` 端点（`:4284`）的含义——超出 owner 所问，延后为 Q7。
**七个调用点的不变量**：没有一处传查看者时区；将来若加时区参数，四个请求作用域调用点（含 `multitable-ai.ts:807` bulk-preview 与 `/view :16893`）必须同一请求同一时区、一起改。
web 侧（D12）：筛选行键入按显示时区解析、以绝对瞬时保存（`:207-211`）；**解析失败（含裸日期）一律不提交**——`:209 / :217-218` 改为不 emit，视图筛选保留上次已提交值，输入框显示可见错误样式与中/英文提示（同编辑器 `MetaDateTimeInput.vue:55-60` 的「不提交无效草稿」契约）；`:195` 注释改为如实描述（裸日期在服务端按业务零点求值，只有不可解析文本才不匹配）。
既有已保存的裸日期：行内显示原文 + 错误样式；服务端求值不变（`:4272-4274` → `:112-125`）。

## 6. 覆盖面与公共表单

| 切片 1 覆盖 | 延后 |
|---|---|
| 格子显示与编辑器、抽屉、已认证表单、createdTime/modifiedTime、分组头、字段头、筛选行（显示文本 + 标识 + 键入）、CSV/XLSX 导出（web + 服务端）、记录页 | 日历 / 时间线分桶、history / provenance / comment / notification 时间戳（13 组件）、dateTime lookup 值、仪表盘、Yjs 桥、通知正文、**条件格式日规则**（`conditional-formatting-service.ts:162-163` 进程本地时区，既有问题）、字段时区筛选求值（Q7）、**自动化条件编辑器的 dateTime 条件**（见下） |

**自动化条件编辑器**（`MetaAutomationRuleEditor.vue:2941 / :2953 / :344-346` 原生 `datetime-local` + `automation-conditions.ts:461-468` 字符串比较）：在飞的配套改动——PR #6107（后端，draft，分支 `fix/automation-condition-typing-backend`）与其前端配套分支（写作时尚未推送到 origin）——先把该输入换成 #6083 的业务时区钟面输入、并让求值器识别时区；本文的解析 / 显示拆分在它们落地后叠加到该面，切片 1 不碰这两个文件。
其余延后项先由 wave-4 收敛到业务时区，再叠加显示时区。**公共表单（匿名或带 `publicToken`）**只按业务时区；web 公共表单路径 holder 置禁用。

## 7. 测试、开关、回滚

- **单元**：web 拆分函数（遗留无时区已存字符串在 Tokyo viewer 下仍按业务读）、`resolveDateTimeDisplayTimezone` 顺序、标识以 `enabled` 为门、hint 与标识互斥、标签表、筛选行裸日期 → 不 emit + 上次值保留 + 错误样式与提示可见；
  服务端 `viewer-timezone`（无行 / 禁用 / 非法 / `userId ''` / API token / publicToken / 查询失败 → 业务且不查库）、`{ enabled: true, timezone: null }` → 400、落库值 = 输入 trim。
- **编辑往返（B1 反例）**：web 规格，`TZ=America/New_York` 子进程（沿用 `apps/web/tests/multitable-datetime-business-tz.spec.ts:11-13` 方法，`tests/helpers/multitableBusinessTzProbe.ts`）：业务 Shanghai、用户 Tokyo，格子 `10:00（东京时间）`，编辑器打开 `10:00`，键入 `10:00` → `01:00Z`，选择器同；导入 `09:00` → `01:00Z`。登记 `run-required-web-tests.sh` 一行一个 token。
- **真库** `tests/integration/multitable-export-viewer-timezone-realdb.test.ts`（形状同 `multitable-export-allrows-maskroute-realdb.test.ts:30`）：同格 `01:00Z`，A（Tokyo）导出 `2026-09-24 10:00+09:00`，B（未启用）`2026-09-24 09:00`，C（Asia/Singapore 启用）`09:00` 无后缀；三份交叉导入回 `01:00Z`；伪造 `x-user-id` / `body.userId` 无效；无 `req.user` → 401。
- **变异证据**（内存级，去掉即红）：`enabled` 门 → 标识单元红；actor 限定 → 伪造身份红；`userId ''` 拒绝 → 共享行用例红；编辑器仍传解析时区 → 往返红；导入改 viewer → 交叉导入红；后缀条件改「≠ 业务」→ C 用例红；publicToken 分支 → 表单红；筛选行恢复 `:209` 的 `return text` → 裸日期用例红。
- **开关（D7）**：不新增 env flag；kill-switch 待 Q5。**回滚**：§2 顺序；表缺失 / 查询错 → 业务时区，前端 `viewerTimezone` 缺失 → 禁用。

## 8. 交付切片

| 切片 | 内容 | 估算 |
|---|---|---|
| S1 数据 + API | 迁移、`viewer-timezone.ts`、GET/PUT + 校验 + `userId ''` 拒绝、`/context` / `/form-context` 回显、publicToken 分支、单元与伪造身份用例 | 1 人日 |
| S2 服务端导出 | 服务端拆分函数、导出后缀（≠ 解析时区）、真库用例；**不碰筛选** | 0.5 人日 |
| S3 Web | 拆分函数与两个 prop、§4 表七处宿主、标识 / 标签 / hint 替换、筛选行标识 + 不提交无效值（错误样式 + 提示）、设置入口（导航栏语言切换旁 + 「我的会话」页新增区）、TZ 探针规格 | 2 人日 |
| S4 自动化与延后面 | 提醒编辑器「我的时区」可选项（默认不变）；#6107 与前端配套落地后叠加条件编辑器；wave-4 后叠加其余延后面 | 0.5 + 1 人日 |

## 9. 非目标与 owner 待答

**非目标**：管理员 / 部门默认时区；团队级时区；改变存储；`date` 字段；浏览器时区自动生效（设置页可预选为建议，未保存不落值）；DST 规则改动（`business-timezone.ts:165-170`）；新路由入 OAPI allowlist；改 `evaluateMetaFilterCondition`；改自动化条件编辑器（归 #6107 及其前端配套）。

**owner 待答（保持开放；括号内为 T 层建议值，已按 §10 默认前进）**
- **Q1** 导入 / 预填 / REST 无时区文本按哪个钟读？（建议：解析时区——D2）
- **Q2** 显示时区 ≠ 解析时区时导出是否带偏移后缀？（建议：是——D3）
- **Q3** 共享视图的 dateTime 筛选按业务还是查看者？（建议：业务，且本文不改求值——D4）
- **Q4** 新建日期提醒默认时区？（建议：业务——D8）
- **Q5** 是否要实例级 kill-switch？（切片 1 不做）
- **Q6** 集成方设了字段显式时区、用户未启用时，是否也出标识？（建议：不出，保持字节不变；这是 #6083 既有行为）
- **Q7** 显式时区字段的筛选求值是否改按字段时区？（建议：另开，不在本文）
- 次级：DST 标识措辞（建议固定城市名）；`date` 相对日期算子按 UTC 日（`:4223-4226`）另开修复。

## 10. Decision Register（T 层默认值，均标 `Ratified-by-default-2026-09-27`，owner 24h 内可否决）

| # | 默认值 | 相对什么的偏离 | 否决落地代价 | 标记 |
|---|---|---|---|---|
| D1 | web UI 键入 / 选取按显示时区解析（§4 表、§5.1a） | owner 未涉及 | 键入面改回解析时区；违反规则 2 反例 | `Ratified-by-default-2026-09-27` |
| D2 | 导入 / 预填 / REST / 粘贴 / 插件按解析时区，永不查看者（§5.1b；Q1） | owner 未涉及 | 服务端加 viewer 参数，放弃 `:16037-16039` 不变量 | `Ratified-by-default-2026-09-27` |
| D3 | 导出后缀当且仅当显示时区 ≠ 解析时区；其余字节不变；表头不变（§5.2；Q2） | owner 未涉及 | 去后缀，接受跨人导入漂移 | `Ratified-by-default-2026-09-27` |
| D4 | 筛选求值不改，仍业务时区；七调用点无一传查看者（§5.3；Q3 / Q7） | 第 1 轮草案（曾写传 viewer） | 改按 viewer：共享视图逐人不同，/view 内 rollup 条件与仪表盘和格子筛选不一致 | `Ratified-by-default-2026-09-27` |
| D5 | `mst_` 与 `publicToken` 请求一律业务时区（§3） | owner 未涉及 | 无 | `Ratified-by-default-2026-09-27` |
| D6 | 标识以 `enabled` 为门；按所显示瞬时偏移比较，空值 `now`；启用时替换 hint 不叠加；可见文本为载体，编辑中由字段头承载（§4） | owner 原话的具体化 | 改门或叠加，一处函数 | `Ratified-by-default-2026-09-27` |
| D7 | 不新增 env flag（§7；Q5） | owner 未涉及 | 加 flag 并登记 manifest | `Ratified-by-default-2026-09-27` |
| D8 | 新建提醒默认业务时区，「我的时区」可选（§8 S4；Q4） | 第 1 轮草案 | `triggerTimezoneForSave` 默认读 viewer | `Ratified-by-default-2026-09-27` |
| D9 | 解析 / 显示两时区拆分；无时区已存字符串 = 业务钟面；禁改 `getBusinessTimezone()` / `resolveDateTimeTimezone`（§4） | owner 未涉及 | 合回单参数 | `Ratified-by-default-2026-09-27` |
| D10 | 切片 1 无写路径读偏好（PUT 只 upsert 偏好表自身）；将来若有，事务前池上读；回滚先 `down`（§2 / §3） | owner 未涉及 | 无 | `Ratified-by-default-2026-09-27` |
| D11 | 时区按输入 trim 原样落库，不做 ICU 规范化；非法 / 空 / 超长 → 路由 400；CHECK ≤64（§2） | owner 未涉及 | 加规范化，接受 GET ≠ PUT | `Ratified-by-default-2026-09-27` |
| D12 | 筛选行不提交解析失败的值（含裸日期）：保留上次已提交值 + 可见错误样式 + 中/英文提示；`:195` 注释订正；已存无时区筛选文本按业务时区读（§4 表、§5.3） | owner 未涉及 | 恢复 `:209` 原样提交，接受服务端按业务零点求值 | `Ratified-by-default-2026-09-27` |
| D13 | `userId === ''` 拒绝：PUT 401、GET 禁用、viewer 解析不查库（§3） | owner 未涉及 | 无（收紧项） | `Ratified-by-default-2026-09-27` |
