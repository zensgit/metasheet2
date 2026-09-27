# 多维表按用户时区显示 — DESIGN-LOCK — 2026-09-27

> **Status: PROPOSED（草案，评审第 1 轮修订后待 owner 复审）。** 本文只锁设计，不含运行时代码。基线冻结在 `origin/main` @ `6adc99fd0`
> （含 PR #6083 = `4be9f697b` 业务时区、PR #6082 = `d5daa7acd` 自动化触发时区；与上一版基线 `633421012` 之间本文引用的文件无改动）。所有 `path:line` 在该 commit 上成立。
>
> **Owner 决定（2026-09-27，原话）：**「如果用户启用跨时区功能，我们能否自动出现时区标识，没有的话我们还是按业务时区」。
> 授权：2026-09-26 无人值守授权 + 2026-09-27「额度不用省」+ 本次决定。owner 原话只覆盖**显示**；本文其余取值均为 T 层默认，
> 逐条列在 §10 Decision Register，标 `Ratified-by-default-2026-09-27`，owner 24h 内可否决。修订记录：评审第 1 轮 2 blocker（B1 调用点计数、B2 解析作用域）+ 8 should-fix 已全部吸收。

## 0. 锁定的规则

1. **默认（用户未启用）**：一切按业务时区（`MULTITABLE_BUSINESS_TIMEZONE`，默认 Asia/Shanghai）显示，**不出现时区标识**——即使字段自带显式时区（§4）。这就是今天 #6083 之后的行为，字节级不变。
2. **用户在个人设置里启用「跨时区显示」并选定一个 IANA 时区后**：dateTime 按该时区显示；只要显示时区与业务时区在所显示瞬时的 UTC 偏移不同，时间旁**自动**出现时区标识，如 `2026-09-24 09:00（东京时间）`；相同则无标识。
3. **存储不变**：dateTime / createdTime / modifiedTime 仍是 UTC 瞬时（ISO `Z`）。`date`（浮动日，#3417）不受影响。
4. **导出、自动化日期提醒、筛选**：owner 原话未涉及；本文取值——导出跟随显示时区并带偏移后缀（D3）；**筛选求值与新建提醒默认仍按业务时区**（D4/D8，与上一版草案措辞相反，owner Q3/Q4）。服务端从**用户偏好**（请求作用域）得知时区，**永不从浏览器**得知。
5. 功能默认 OFF，按用户 opt-in；不新增 env flag（D7；实例级 kill-switch 见 Q5）。

## 1. 现状（基线事实，负面结论附检索范围）

**web 时区解析与显示**：`apps/web/src/multitable/utils/business-timezone.ts:89-93` `resolveDateTimeTimezone` = 字段显式非 `'UTC'` 时区 → 业务时区；业务时区是响应式 holder（`:51-67`），由 `/api/multitable/context`、`/form-context` 响应写入（`api/client.ts:2330, 2952`）。
`dateTimeValueToUtcMs` / `formatDateTimeInZone`（`:333-346`）**同一个 `timeZone` 参数既用于解析又用于显示**；`:338` 注释「zone-less stored string is a business wall clock」。
现有浏览器提示 `dateTimeZoneHint`（`:394-396`，按**浏览器**偏移与业务时区比较 `:381-384`）挂四处：`components/cells/MetaDateTimeInput.vue:24,72`、`components/MetaFieldHeader.vue:97`、`components/MetaFormView.vue:179-182`、`components/MetaRecordFieldsPanel.vue:234-237`。
`getBusinessTimezone()` 的直接调用点：`utils/field-display.ts:37, 46`（编辑器辅助函数默认参数，`src` 内无调用方）、`:63`（`dateTimeFieldTimezone`，导出/分组头文本）、`:157`（createdTime/modifiedTime 格子）、`utils/automation-trigger-timezone.ts:34`（提醒编辑器默认时区）、`business-timezone.ts:92`。
键入面：`components/cells/MetaCellEditor.vue:679`、`components/cells/MetaDateTimePicker.vue:65`、`components/MetaFilterConditionRow.vue:207-211`（筛选值解析为**绝对瞬时**后发服务端）。
外来文本面：`import/delimited.ts:204`（CSV/XLSX 导入）、`components/MetaGridTable.vue:1661`（粘贴；格子**复制**写出的是原始 ISO `:1641-1642`，故无时区的粘贴文本只可能来自外部）、`MetaFormView.vue:605-613`（`?prefill_x=` 预填）。
导出：`views/MultitableWorkbench.vue:5109, 5133` 经 `dateTimeExportText`。dateTime 筛选算子只有 is/isNot/after/before/isEmpty/isNotEmpty（`composables/useMultitableGrid.ts:290-297`），相对日期算子只给 `date`。

**服务端**：`packages/core-backend/src/multitable/business-timezone.ts:32-44`（env）、`:63-70`（`resolveDateTimeFieldTimeZone`）；`date-time-wall-clock.ts:55`（`ABSOLUTE_RE`，接受 `±hh:mm` 后缀）、`:112-125`（无时区文本 → 给定时区钟面；**裸日期 = 该时区零点**）、`:149-161`（`dateTimeValueToUtcMs` / `formatDateTimeValue`，同样单一 `timeZone` 参数）。
`routes/univer-meta.ts:9056`、`:17301` 回显 `businessTimezone`。导出 `:16000-16026`：每列解析一次时区，`:16003-16005` 写明不变量「an export re-imports to the same instant」。
写入解析：`field-codecs.ts:1012` `validateDateTimeValue` ← `:1163` `coerceBatch1Value` ← `record-write-service.ts:994`（在 `:829` `pool.transaction` **之内**；`:9` 步骤注释）与 `record-service.ts:715`（在 `:566` 事务之内）；导入 `import-xlsx :15754` 同一 codec。
筛选：`evaluateMetaFilterCondition(type, cellValue, condition, nowMs)`（`:4244-4249`，**第 4 位是 `nowMs`**）在函数内部取业务时区（`:4271`）；`:4268-4269` 相对日期算子仅 `date`（`evaluateRelativeDateOp :4219-4242`，按 UTC 日）。
**七个调用点**：请求作用域四个——`export-xlsx :16142`（路由 `:15877`）、`view-aggregate :16353`（`:16219`）、`/view :16859`（`:16595`）、`routes/multitable-ai.ts:782`（`POST /sheets/:sheetId/ai/shortcut/bulk-preview`，路由 `:644`，`:729` / `:779` 注释要求 parity with /view）；非请求作用域三个——`resolveRelationAggregation :1692`（函数 `:1627`）、`applyLookupRollup :3854`（`:3680`）、`loadDashboardSourceRows :5423`（`:5323`）。

**认证门**：`src/index.ts:1745-1757` 全局 JWT 门——带 `publicToken` 的请求走 `optionalJwtAuthMiddleware`（`:1747`；`auth/jwt-middleware.ts:41-50` `isPublicFormAuthBypass`），若同时带有效 bearer 则 `req.user` 仍被写入（`:111`）；`mst_` API token 仅在 `multitable/oapi-read-allowlist.ts:29-47, 79-91` 的锚定路径上放行（`:1752`），其它路径落 `jwtAuthMiddleware` → **401**（`:1756`）。API token 用户形状 `middleware/api-token-auth.ts:80-83`。

**自动化日期提醒**：规则自带 `triggerConfig.timezone`（`multitable/automation-date-reminder.ts:19-24, 36-42`），编辑器新建默认业务时区（`automation-trigger-timezone.ts:87-98`）；调度器无用户上下文（`automation-scheduler.ts` 检索 `actorId|userId|created_by` 为空）。

**用户偏好存储（负面结论）**：无通用用户偏好表——检索 `src/db/migrations/*`、`migrations/*.sql`、`src/**/*.ts` 的 `user_preferences|userPreferences|user_settings|preferences`，只命中 `_template.ts:15`、插件表 `preferences` jsonb、`NotificationPreferences` 类型。`users` 表（`zzzz20260119100000_create_users_table.ts`）无 timezone 列。web 语言只存 localStorage（`composables/useLocale.ts:5,19-29`）。反先例 `view_states`（`routes/views.ts:273,298` 以 `|| 0` 取用户）；正先例 `meta_view_personal_configs`（`zzzz20260705150000_create_meta_view_personal_configs.ts`；同前缀另有 `_add_send_dingtalk_approval_card_automation_action.ts`，勿混）。`/settings` 是 `SessionCenterView`（`router/appRoutes.ts:255-259`）；语言切换 `<select>` 在 `App.vue:94-100` 导航栏（处理函数 `onLocaleChange :311-315`）。时区列表 `utils/timezones.ts:83-99`，北京别名集 `business-timezone.ts:30-36`。迁移缺失的后果：`db/migration-provider.ts:32-34`（Kysely 把 provider 里缺名视为历史损坏）。

## 2. 锁定 1 — 数据模型

- 新表 **`user_display_preferences`**：`user_id text PRIMARY KEY`、`timezone_enabled boolean NOT NULL DEFAULT false`、`timezone text NULL`、`updated_at timestamptz NOT NULL DEFAULT now()`；
  `CHECK ((timezone_enabled = false OR timezone IS NOT NULL) AND (timezone IS NULL OR char_length(timezone) <= 64))`。无行 = 未启用。不改 `users`（认证/目录同步敏感），不扩 `view_states`（反先例）。
- 迁移 `src/db/migrations/zzzz20260927120000_create_user_display_preferences.ts`（幂等 `IF NOT EXISTS`）；`down` = `DROP TABLE IF EXISTS`。
  **回滚顺序（D10）**：先跑 `down` 再回退代码，或只 forward-fix；**不得先回退代码**——旧代码的 provider 缺这条迁移名即被判历史损坏（`migration-provider.ts:32-34`）。
- 写入校验（服务端，D11）：trim → `isValidIanaTimeZone`（`multitable/automation-timezone.ts:54-63`）→ **规范化** `new Intl.DateTimeFormat('en-US', { timeZone }).resolvedOptions().timeZone` 后落库（大小写/别名统一）；`{ enabled: true, timezone: null }`、非法、超 64 字符在路由层 400 `VALIDATION_ERROR`（values-free），**不靠 CHECK 报错**（CHECK 是最后防线）。
  不采用字段属性里「`'UTC'` = 未设」语义：`enabled` 已显式表达设/未设。

## 3. 锁定 2 — API、加载、读取时机

- `GET /api/multitable/me/display-timezone` → `{ enabled, timezone }`；`PUT` 同路径，body 仅 `{ enabled, timezone }`。挂在 `univerMetaRouter`（`src/index.ts:1913-1918`）。**actor 只取 `resolveRequestAccess(req).userId`**（`multitable/access.ts:59-97`）；body/query/header 里任何 userId 无影响（与 personal-view-config 同构）。切片 1 无管理员代设。
- **`mst_` API token（N1）**：新路由**不加入** `oapi-read-allowlist.ts` 任一列表，故 GET / PUT 都在网关 **401**（`index.ts:1752 → :1756`），到不了路由；路由内 `req.user.apiToken === true → 业务时区` 分支保留为纵深防御。
- **`publicToken`（D5）**：请求带 `publicToken`（`isPublicFormAuthBypass`）即按业务时区、`viewerTimezone = null`，**即使 `req.user` 已被 `optionalJwtAuthMiddleware` 写入**（`index.ts:1747`，`jwt-middleware.ts:41-50, 111`）。
- web 一次加载：`/context` 与已认证 `/form-context` 响应新增 `viewerTimezone: { enabled, timezone } | null`，与 `businessTimezone` 同落点（`client.ts:2330, 2952` → 新 holder `setViewerTimezone`）；`PUT` 成功后用响应写 holder，不重拉。
- **读取时机（D10）**：偏好在每个请求**只读一次**、在 **`pool` 上**、在**任何写事务开始之前**，作为值向下传；**禁止**在事务句柄上查询（`record-write-service.ts:829` 事务内的 `:992-994` 字段处理、`record-service.ts:566 / :715` 同理）。不做跨请求缓存，因此无失效问题。

## 4. 锁定 3 — 解析时区 / 显示时区拆分与标识

- **两个时区，不是一个（D9）**：
  - **解析时区** = 字段显式非 `'UTC'` `property.timezone` ＞ 业务时区。就是今天的 `resolveDateTimeTimezone`（web `:89-93`）/ `resolveDateTimeFieldTimeZone`（服务端 `:63-70`），**不改**。
  - **显示时区** = 字段显式时区 ＞ 用户时区（enabled 且合法）＞ 业务时区。新函数 web `resolveDateTimeDisplayTimezone(property)`（读 viewer holder）/ 服务端 `resolveDateTimeDisplayTimeZone(property, viewer)`。
  - `dateTimeValueToUtcMs` + `formatDateTimeInZone`（web `:333-346`）、`dateTimeValueToUtcMs` + `formatDateTimeValue`（服务端 `:149-161`）的单一 `timeZone` 参数拆成 `(parseZone, displayZone)`；**无时区的已存字符串永远按业务钟面读**（web `:338` 现注释；改字段类型不迁移单元格值——`field-retype-whitelist.ts:4-5`、`meta-manager-labels.ts:571-574`——这类遗留值会长期存在，含义不得随查看者变）。
  - **禁改**：`getBusinessTimezone()`（`:54-56`）与 `resolveDateTimeTimezone`（`:89-93`）本体。要改的 web 调用点只有：`field-display.ts:155`（dateTime 格子 → 显示时区）、`:157`（createdTime/modifiedTime → 显示时区）、`:63`（`dateTimeFieldTimezone` → 显示时区，供导出/分组头）；`:37, 46` 默认参数对齐显示时区（无调用方）；`automation-trigger-timezone.ts:34` **不动**（D8）。
- **标识（D6）**：**以 `enabled` 为门**——未启用时无论字段是否自带显式时区都不出标识（§0 规则 1）。启用后，仅当显示时区与业务时区**在所显示瞬时**的 UTC 偏移不同才显示（比较法同 `browserTimezoneDiffers :381-384`；空格子 / 空编辑框以 `now` 比较）。
  须披露的推论：业务时区若是 DST 时区，同一列可能逐格有/无标识；建议实例把业务时区设为固定偏移时区（Asia/Shanghai 即是）。
  标签：中文 `<城市>时间`（东京 / 伦敦 / 纽约 / 新加坡 / 洛杉矶 / 悉尼 / 柏林；北京别名集沿用 `:30-36`），英文 `Tokyo time`；不在表内 → `<IANA id> (UTC±hh:mm)`（`businessTimezoneLabel :386-391` 规则）。形态 `YYYY-MM-DD HH:mm（东京时间）`，标识是**只读装饰**：不进编辑框文本、不进导出单元格、不参与 `contains`。
- **与现有浏览器提示的关系**：启用时四处 `dateTimeZoneHint`（§1）**被新标识替换**，不叠加；未启用时四处保持今天的行为。

## 5. 锁定 4 — 解析作用域（B2）、导出、筛选

**5.1 谁键入的文本按谁的钟读（D1 / D2）**
- (a) **用户在 web UI 里键入**的文本——格子编辑器（`MetaCellEditor.vue:679`、`MetaDateTimeInput` / `MetaDateTimePicker.vue:65`）、抽屉字段面板、已认证表单字段、筛选行（`MetaFilterConditionRow.vue:207-211`）——按该用户的**显示时区**解析：他正看着那个钟面。web 解析后仍以绝对 ISO 发服务端，服务端无需知道是谁键入。
- (b) **在别处产生**的文本——XLSX/CSV 导入（服务端 `:15754` → `field-codecs.ts:1163 / :1012`；web `delimited.ts:204`）、粘贴（`MetaGridTable.vue:1661`）、预填链接（`MetaFormView.vue:605-613`）、JWT REST 的无时区写入（`record-write-service.ts:994`、`record-service.ts:715`）、插件 / 服务端内部调用——**永远按解析时区（字段显式 ＞ 业务）**，永不按查看者。
  否则四类漂移：① PLM/K3 导出的 `2026-09-24 09:00` 由东京用户导入存成 00:00Z 而非 01:00Z；② A 导出、B 导入偏移 +1h；③ 同一预填链接对不同用户是不同瞬时；④ 同一 REST 请求体的语义随 JWT 持有人的偏好静默改变。`univer-meta.ts:16003-16005` 的不变量「an export re-imports to the same instant」必须对**任何**导入者成立。
- 时光机恢复校验 `exact-anchor-restore-validate.ts:97` 非请求语义，保持业务时区。

**5.2 导出（D3）**：显示时区 ≠ 业务时区时，dateTime / createdTime / modifiedTime 单元格写 **`YYYY-MM-DD HH:mm+09:00`**（显式偏移后缀；服务端 `ABSOLUTE_RE :55`、web `:232` 今天就接受），任何导入者都精确往返；相等时保持今天的裸钟面**字节不变**。表头不变。覆盖服务端 `export-xlsx :16000-16026`（每列解析一次）与 web `MultitableWorkbench.vue:5109, 5133`（`dateTimeExportText`）。分组头（`MetaGridTable.vue:928`）是显示面：显示时区、无后缀、按 §4 标识规则。

**5.3 筛选（D4，取代上一版「三处请求作用域传 viewer 时区」）**
- **dateTime 筛选求值永远用解析时区（字段显式 ＞ 业务），永不用查看者**；只有筛选行**显示**的文本用显示时区。理由：web 对 dateTime 只提供 is/isNot/after/before/isEmpty/isNotEmpty 且值为绝对瞬时（`useMultitableGrid.ts:290-297`、`MetaFilterConditionRow.vue:207-211`），相对日期算子只给 `date`（`:4268-4269`），按查看者求值没有「今天」收益，却会让**共享视图对不同人返回不同行 / 聚合**。
- 唯一改变的边界：筛选值是裸日期 `2026-09-24`（web `requireTime` 拒绝后原文保存）时，服务端按求值时区取零点（`date-time-wall-clock.ts:112-125`）——现在**确定性**地是字段 / 业务时区的零点。
- `evaluateMetaFilterCondition` 增加**第 5 位**可选参数 `options?: { dateTimeZone?: string }`（第 4 位是 `nowMs`，`:4248`）；缺省 = 业务时区 → 未传参调用点字节不变。**七个调用点全部**传 `resolveDateTimeFieldTimeZone(field.property)`（都不传 viewer）；**`bulk-preview`（`multitable-ai.ts:782`）与 `/view`（`:16859`）在同一请求里必须拿到同一时区**——改其一必改其二，用一条 parity 用例钉住。

## 6. 锁定 5、6 — 覆盖面与公共表单

| 切片 1 覆盖 | 延后（与 #6083 "Deferred" 表及 wave-4「datetime deferred surfaces」对齐） |
|---|---|
| 格子显示与编辑器、抽屉字段面板、已认证表单视图、createdTime/modifiedTime、分组头、字段头、筛选行显示文本、CSV/XLSX 导出（web + 服务端）、记录页 | 日历 / 时间线按日分桶、history / provenance / comment / notification 时间戳（13 个组件）、dateTime 的 lookup 值、仪表盘、Yjs 桥、通知正文 |

延后项先由 wave-4 收敛到业务时区；本文的显示时区经同一函数在其后叠加（§8 S4），切片 1 不碰这些文件。**公共表单（匿名或带 `publicToken`）**只按业务时区（§3 D5）；web 在公共表单路径把 viewer holder 置为禁用——即使同一浏览器里有已登录会话也不带入。

## 7. 锁定 7 — 测试、开关、回滚

- **单元**：web 两函数拆分（解析时区不含 viewer；显示时区含）、标识以 `enabled` 为门（字段显式时区 + 未启用 → 无标识）、hint 与标识互斥、标签表；服务端 `viewer-timezone`（无行 / 禁用 / 非法 / API token / publicToken / 查询失败 → 业务时区）、`evaluateMetaFilterCondition` 缺省参数字节不变、`resolvedOptions` 规范化、`{ enabled: true, timezone: null }` → 400。
- **真库用例** `tests/integration/multitable-export-viewer-timezone-realdb.test.ts`（`describeIfDatabase` 形状同 `multitable-export-allrows-maskroute-realdb.test.ts:30`）：同一格 `2026-09-24T01:00:00.000Z`，A（Asia/Tokyo）导出 `2026-09-24 10:00+09:00`，B（未启用）`2026-09-24 09:00`；两份文件由 A、B 交叉导入都回到 `01:00Z`；A / B 对同一 dateTime 筛选视图得同一行集，`bulk-preview` 候选集 = `/view` 行集；伪造 `x-user-id` / `body.userId` 不改变结果。
- **web 规格带 TZ 探针**：沿用 `apps/web/tests/multitable-datetime-business-tz.spec.ts:11-13` 的子进程 `TZ` 方法（`tests/helpers/multitableBusinessTzProbe.ts`）：`TZ=America/New_York` 下用户时区 Asia/Tokyo，格子显示 `10:00（东京时间）`、键入 `10:00` 存 `01:00Z`、导入 `09:00` 存 `01:00Z`（不按东京读）；登记到 `apps/web/scripts/run-required-web-tests.sh` 一行一个 token。
- **变异证据**：每条守卫「去掉即红」（内存级）：去掉 `enabled` 门 → 标识单元红；去掉 actor 限定 → 伪造身份红；导入改按 viewer → 交叉导入红；bulk-preview 少传时区 → parity 红；去掉 publicToken 分支 → 表单用例红。
- **开关（D7）**：不新增 env flag，`global-history-flag-manifest` 不登记；实例级 kill-switch 待 Q5。**回滚**：§2 顺序；表缺失 / 查询错 → 业务时区，前端 `viewerTimezone` 缺失 → 禁用。

## 8. 交付切片与估算

| 切片 | 内容 | 估算 |
|---|---|---|
| S1 数据 + API | 迁移、`viewer-timezone.ts`（池上一次读）、GET/PUT + 规范化 / 400、`/context` / `/form-context` 回显、publicToken 分支、单元测试、伪造身份用例 | 1 人日 |
| S2 服务端对齐 | 导出偏移后缀、`evaluateMetaFilterCondition` 第 5 位参数 + 七调用点、bulk-preview parity 用例、真库用例 | 1 人日 |
| S3 Web 显示与设置 | 显示时区函数 + 三处 `field-display` 调用点、标识 / 标签 / hint 替换、键入面按显示时区、设置入口（导航栏语言切换旁 + 「我的会话」页新增区）、TZ 探针规格 | 1.5 人日 |
| S4 自动化与延后面 | 提醒编辑器「我的时区」**可选项**（默认不变）；wave-4 收敛后在日历 / 时间线 / 历史时间戳叠加显示时区 | 0.5 + 1 人日（后者待 wave-4） |

## 9. 非目标与 owner 待答

**非目标**：管理员 / 部门默认时区；团队级时区；改变存储；`date` 字段；浏览器时区自动生效（设置页可把浏览器时区**预选为建议**，未保存不落值，服务端永不读浏览器）；DST 规则改动（沿用 `business-timezone.ts:165-170` gap/overlap 规则）；把新路由加入 OAPI allowlist。

**owner 待答（保持开放，本文不替 owner 决定；括号内为 T 层建议值，已按 §10 默认前进）**
- **Q1** 导入 / 预填链接 / REST 无时区文本按哪个钟读？（建议：字段显式 ＞ 业务，永不查看者——D2）
- **Q2** 显示时区 ≠ 业务时区时导出是否带 `+09:00` 偏移后缀？（建议：是——D3；表头不加后缀）
- **Q3** 共享视图的 dateTime 筛选按业务时区还是查看者？（建议：业务——D4，偏离上一版规则 4「筛选」措辞）
- **Q4** 新建日期提醒的默认时区？（建议：业务——D8，偏离上一版规则 4「提醒」措辞；编辑者可显式选「我的时区」）
- **Q5** 是否需要实例级 kill-switch（一键让所有人回到业务时区）？（切片 1 不做；若要，登记 env flag）
- 次级：DST 时区标识措辞固定城市名还是随季节（建议固定）；既有 `date` 相对日期算子按 UTC 日（`:4222-4225`）建议另开修复。

## 10. Decision Register（T 层默认值，均标 `Ratified-by-default-2026-09-27`，owner 24h 内可否决）

| # | 默认值 | 是否偏离 owner 原话 | 否决落地代价 | 标记 |
|---|---|---|---|---|
| D1 | web UI 键入的文本按查看者显示时区解析（§5.1a） | 否（原话未涉及） | 键入面改回解析时区；标识与钟面不一致需另解 | `Ratified-by-default-2026-09-27` |
| D2 | 导入 / 预填 / REST / 粘贴 / 插件按字段显式 ＞ 业务解析，永不查看者（§5.1b；Q1） | 否 | 服务端解析点加 viewer 参数，并放弃 `:16003-16005` 不变量 | `Ratified-by-default-2026-09-27` |
| D3 | 显示时区 ≠ 业务时区的导出单元格带 `±hh:mm` 后缀；相等字节不变；表头不变（§5.2；Q2） | 否 | 去后缀，接受跨人导入漂移 | `Ratified-by-default-2026-09-27` |
| D4 | dateTime 筛选求值按字段 ＞ 业务，永不查看者（§5.3；Q3） | **是**（上一版规则 4「筛选」） | 四处请求作用域调用点改传 viewer；共享视图逐人不同 | `Ratified-by-default-2026-09-27` |
| D5 | `mst_` API token 与带 `publicToken` 的请求一律业务时区，即使 `req.user` 已设（§3） | 否 | 无（收紧项） | `Ratified-by-default-2026-09-27` |
| D6 | 标识以 `enabled` 为门；按所显示瞬时的 UTC 偏移比较，空值用 `now`；启用时替换 `dateTimeZoneHint` 不叠加（§4） | 否（原话的具体化） | 改比较法或改叠加，一处函数 | `Ratified-by-default-2026-09-27` |
| D7 | 不新增 env flag；实例 kill-switch 待 Q5（§7） | 否 | 加一个 exact-literal `'true'` flag 并登记 manifest | `Ratified-by-default-2026-09-27` |
| D8 | 新建日期提醒默认业务时区；「我的时区」只是可选项（§5 / §8 S4；Q4） | **是**（上一版规则 4「提醒」） | `triggerTimezoneForSave` 默认改读 viewer | `Ratified-by-default-2026-09-27` |
| D9 | 解析时区 / 显示时区两参数拆分；无时区已存字符串 = 业务钟面；禁改 `getBusinessTimezone()`（§4） | 否 | 合回单参数，即上一版方案 | `Ratified-by-default-2026-09-27` |
| D10 | 偏好每请求一次、`pool` 上、写事务前读取；回滚先 `down` 再退代码或只 forward-fix（§2 / §3） | 否 | 无 | `Ratified-by-default-2026-09-27` |
| D11 | IANA id 经 `resolvedOptions().timeZone` 规范化；`{ enabled: true, timezone: null }` / 超长 → 路由 400；CHECK 加 ≤64（§2） | 否 | 放宽校验 | `Ratified-by-default-2026-09-27` |
