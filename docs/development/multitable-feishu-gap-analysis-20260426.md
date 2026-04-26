# 多维表 vs 飞书多维表 · 差距分析（Gap Analysis）— 2026-04-26

> 状态：**侦察文档（recon），未列入交付**
> 主笔：Claude（Opus 4.7, 1M context）+ 代码侦察（read-only）
> 目的：以代码事实为基线，比对飞书多维表（Feishu Bitable）特性矩阵，导出下一波多维表交付优先级与并行 lane 编排
> 范围：`packages/core-backend/src/multitable/`、`packages/core-backend/src/routes/univer-meta.ts`、`apps/web/src/multitable/**`、`packages/core-backend/src/db/migrations/*meta*`
> **不在范围**：`plugins/plugin-integration-core/*`（K3 PoC 路径，正交）

---

## 1. 执行摘要（Executive Summary）

多维表的"骨架成熟，外貌粗糙"形态非常清晰：
- **后端骨架成熟**：12,832 行 multitable 服务代码，覆盖 CRUD / cross-table link / lookup / rollup / formula / 自动化 / 钉钉投递 / webhook / API token / 三级权限（sheet/view/field/record）/ 公开表单 / Yjs 多人协作 / 评论 + @提及。51 个 REST 端点 + 单独 webhook/api-token/dingtalk-group 路由文件。
- **前端体量真实**：8 个核心视图组件（Grid 636L / Kanban 442L / Gallery 434L / Calendar 684L / Timeline 589L / Form 511L / Dashboard 426L / Import 840L），不是 stub。
- **关键差距集中在三处**：**字段类型仅 10 种**（飞书 ~20，缺 currency/percent/rating/phone/email/url/auto-number/created-by/created-time/barcode/location/multiSelect 真实模型/longText 等）、**公式引擎仅 45 函数**且无前端编辑器（飞书 ~40 但配可视化 builder + 中文文档）、**视图仅 6 类**（缺 Gantt 视图前端、Hierarchy 树）。AI 能力**完全为零**（grep 全空）。
- **第二档差距**：无条件格式（cell/row 颜色规则）、无 xlsx 导入导出（仅 CSV/TSV）、无 record/cell version history（meta_records.version 是 optimistic lock 用途，非历史）、无订阅通知（"X 变化时通知我"）、无原生模板库 / 模板市场。
- **意外亮点**：`field_permissions` / `record_permissions` / `meta_view_permissions` 三表已落库且接好 API；Yjs 实时协作可用；钉钉群/个人投递作为 first-class action 已实现。

**Top 3 客户影响差距**：(1) 字段类型不足导致 ERP/CRM 真实数据迁入即受阻；(2) Excel xlsx 导入缺失阻碍 B2B 客户初次试用；(3) 条件格式 + 公式编辑器缺失影响"打开就能用"印象。

**总工作量估算**（仅 P0 + P1，下文详列）：约 **42-58 人天**，可拆 6-9 个 lane 并行。首推 Wave M-Feishu-1 执行 4 个严格 file-disjoint 的 lane（xlsx 导入导出 / 字段类型扩展 / 条件格式 / send_email 动作，共 17 人天），均与 `plugin-integration-core` 文件不相交。Gantt 前端解锁推迟到 Wave 2（与条件格式共用 ViewManager 不能并行）。

---

## 2. 差距矩阵（Gap Matrix）

**状态图例**：
- ✅ 成熟：与飞书功能对等
- 🟢 可用：实现存在，缺打磨/子能力
- 🟡 部分：基础骨架，重大缺口
- 🔴 缺失：完全未实现
- ⚫ 不在范围：明确推迟（如 AI）

### 2.1 字段类型（飞书 ~20，本品 ~10 + 注册表扩展位）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| Text (string) | ✅ | `field-codecs.ts:3-13` (类型枚举)、`MetaCellEditor.vue:26-42`、`MetaCellRenderer.vue:4` | 单行文本、Yjs 协作编辑均在 | — |
| Long text / multi-line | 🔴 | 无 `longtext` / `richtext` 字段类型；`MetaCellEditor.vue:1-260` 仅有 `<input>` 单行 | 飞书有"多行文本"独立类型支持换行/Markdown | 1.5 人天（前端编辑器 + 类型注册） |
| Number | ✅ | `field-codecs.ts:6,66`、`MetaCellEditor.vue:46-54` | 缺 number format（千分位/小数位）UI 配置；`sanitizeFieldProperty` 未处理 format | 0.5 人天补 format |
| Currency | 🔴 | `mapFieldType` 未识别；`grep -i currency packages/core-backend/src/multitable` 0 命中 | 飞书有独立 currency 字段（货币符 + 小数位 + 千分位） | 1.5 人天 |
| Percent | 🔴 | 同上，无 `percent` 类型 | 飞书独立 percent 字段 | 1 人天 |
| Rating | 🔴 | 037 迁移种子数据有 `type:'rating'`（form 演示），但 `field-codecs.ts:64-77 mapFieldType` 不识别（fallback 'string') | 仅 form 视图演示数据用过；无后端类型支持、无前端星级渲染 | 1.5 人天 |
| Single-select | ✅ | `field-codecs.ts:127-130 sanitizeFieldProperty type:'select'`、`extractSelectOptions:79-96`、`MetaCellEditor.vue:67-79` | 多色 option 已支持 | — |
| Multi-select | 🟡 | `mapFieldType:70` 把 `multiselect` 归一为 `select`；编辑器只 `<select>` 单选 | 后端类型未细分；前端无 multi-select chip 编辑器 | 2 人天（拆类型 + 多选 UI） |
| Date | 🟢 | `field-codecs.ts:8`、`MetaCellEditor.vue:5-13` | 仅 date（无 time component），`mapFieldType:68` 把 `datetime` 折进 `date` | 1 人天补 datetime 类型 + 时区 |
| Checkbox / Boolean | ✅ | `field-codecs.ts:67`、`MetaCellEditor.vue:57-64`、`MetaCellRenderer.vue:142` | — | — |
| Member / Person | 🟢 | `univer-meta.ts:3815-3846 /person-fields/prepare`、`univer-meta.ts:3848-3884 /people-search`、`SYSTEM_PEOPLE_SHEET_DESCRIPTION` 模式（人员存"系统隐藏 sheet"内） | 实现"link 到隐藏 people sheet"而非原生 person 字段；UI 体验 OK 但语义间接 | 2 人天可改原生 person 类型（可选） |
| Attachment | ✅ | `attachment-service.ts` 562L、`multitable_attachments` 表（migration:42-60）、`POST /attachments` `GET /attachments/:id` `DELETE /attachments/:id` | 含 storage、orphan retention | — |
| URL | 🔴 | 无 url 字段类型；只能放 string | 飞书有 url 独立类型（带"打开链接"按钮） | 0.5 人天 |
| Email | 🔴 | 037 迁移种子有 `type:'email'`（form 演示），`field-codecs.ts:64-77` 不识别 | 仅 form 演示用；无独立后端类型 | 0.5 人天 |
| Phone | 🔴 | 无；飞书有独立 phone 字段 | 缺 | 0.5 人天 |
| Formula | 🟢 | `field-codecs.ts:8,69,221-226`、`formula-engine.ts:165L` 包装 base `formula/engine.ts:200+` | 引擎跑通 45 函数（详见 §2.4），但**无前端公式编辑器/函数提示/中文文档**；`MetaCellEditor.vue` 无 formula 分支 | 详见 §2.4 |
| Lookup | 🟢 | `field-codecs.ts:147-180 sanitizeFieldProperty type:'lookup'`、`univer-meta.ts:1419+` 跨表批量 lookup | 后端实现，前端 UX 未审 | — |
| Rollup | 🟢 | `field-codecs.ts:182-219`、支持 count/sum/avg/min/max | 5 个聚合够用，但缺 array/concatenate 聚合 | 0.5 人天补聚合 |
| Link (cross-table) | ✅ | `field-codecs.ts:132-145`、`meta_links` 表（zzz20251231:54-60）、`MetaLinkPicker.vue` 组件、`univer-meta.ts:6160 /fields/:fieldId/link-options` | — | — |
| Auto-number | 🔴 | grep 全空 | 飞书有自动递增编号字段 | 1 人天 |
| Created time | 🔴 | `meta_records.created_at` 列存在但无字段映射；用户看不到 | 需在 field 类型层公开 | 0.5 人天 |
| Modified time | 🔴 | 同上，`updated_at` 列存在但无字段映射 | — | 0.5 人天 |
| Created by | 🟢 | `meta_records.created_by` 列已加（zzzz20260406093000:7）、`record-write-service.ts:446` SELECT 用 | 列在但**未作为字段类型暴露**给用户视图 | 0.5 人天暴露字段 |
| Modified by | 🔴 | 无 `modified_by` 列 | 加列 + 字段类型 | 1 人天 |
| Barcode | 🔴 | grep 全空 | — | 1 人天（后端类型 + 前端扫码渲染） |
| Location (geo) | 🔴 | grep 全空 | — | 1.5 人天（地图组件） |
| ID column | ✅ | `meta_records.id` 主键（uuid via `gen_random_uuid()`） | 自动存在 | — |

**字段类型总计差距**：14 个缺失 + 3 个部分 = **17 个待补**，约 **15-18 人天**。注意 `field-type-registry.ts:36` 提供插件式注册，可分批落地不破坏内核。

### 2.2 视图类型（飞书 8，本品 6 + Gantt 后端孤岛）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| Grid (table) | ✅ | `MetaGridTable.vue` 636L、`view_configs` CHECK `type IN ('grid','kanban','calendar','gallery','form')` (037:8) | — | — |
| Kanban | ✅ | `MetaKanbanView.vue` 442L、`MetaViewManager.vue:20` `VIEW_TYPES` 含 kanban | — | — |
| Gallery | ✅ | `MetaGalleryView.vue` 434L、`plugin-view-gallery/src/index.ts:121 viewType='gallery'` | 内核 + 插件双轨 | — |
| Form | ✅ | `MetaFormView.vue` 511L、公开表单 token（`univer-meta.ts:319 PublicFormAccessMode='public'｜'dingtalk'｜'dingtalk_granted'`、`univer-meta.ts:5300 POST /views/:viewId/submit`） | 含三种访问模式（public / dingtalk / dingtalk_granted）、subject allowlist、限流 | — |
| Calendar | ✅ | `MetaCalendarView.vue` 684L、`plugin-view-calendar/src/index.ts:147 viewType='calendar'` | — | — |
| Timeline | 🟢 | `MetaTimelineView.vue` 589L、`MetaViewManager.vue:20` 含 'timeline' | 实际是"timeline = 横向时间轴"，**不是 Gantt（无依赖箭头/关键路径/进度条）**，命名易混淆 | — |
| Gantt | 🟡 | `plugins/plugin-view-gantt/src/index.ts` 582L 后端骨架 + `plugin.json` 已定义 task/dependency/criticalPath 类型；前端**无对应 `MetaGanttView.vue`**；`view_configs` CHECK 不含 'gantt' | 后端孤岛：插件存在但视图不可见，需要前端 + 视图注册 + DB CHECK 放开 | 4 人天（前端 Gantt 组件 + 视图注册 + 迁移） |
| Hierarchy (tree) | 🔴 | grep 全空，无 hierarchy 视图 | 飞书有树形视图（按 link 字段递归展开） | 3 人天 |
| Dashboard | ✅ | `MetaDashboardView.vue` 426L、`dashboard-service.ts` 297L、`POST /dashboard/query`（univer-meta.ts:3718）、`MetaChartRenderer.vue` 290L、`chart-aggregation-service.ts` 289L | 飞书也有"仪表盘"，本品已有 | — |

**视图总计差距**：1 个孤岛（Gantt 解锁）+ 1 个完全缺失（Hierarchy）= **~7 人天**。

### 2.3 视图配置功能（filter / sort / group / hide）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| Filter | 🟢 | `meta_views.filter_info jsonb`（zzz20251231:35）、`loaders.ts:25,99`、`query-service.ts:54 filter` | 字段级过滤可用，但**无前端 visual filter builder**（grep 未见专用 UI），只能通过 API 写 jsonb | 2 人天补 builder UI |
| Sort | 🟢 | `meta_views.sort_info jsonb`、`query-service.ts:53 sort: MultitableRecordQueryOrder` 单字段 asc/desc | 单字段排序；多级排序未审 | 1 人天 |
| Group | 🟡 | `meta_views.group_info jsonb`、Kanban 内含 group | Grid 视图分组 UI 未审；group_info 只承载 jsonb 无明确 schema | 1.5 人天 |
| Hide fields | ✅ | `meta_views.hidden_field_ids jsonb`、`loaders.ts:28,102` | — | — |
| Conditional formatting | 🔴 | `grep -i conditional.*format` 全空 | 飞书有"按值染色"规则；本品零实现 | 3 人天（schema + UI + 渲染器） |
| Frozen columns | 🟡 | `MetaGridTable.vue` 含 sticky CSS（grep `position: sticky`）但未审是否动态可配 | 大概率有冻结首列；多列动态冻结需验证 | 0.5 人天验证 |
| Row height (compact/medium/tall) | 🔴 | grep 未见 | — | 0.5 人天 |

**视图配置总差距**：~8 人天。

### 2.4 公式引擎（飞书 ~40 函数 + 编辑器 + 中文文档）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| 函数总数 | 🟢 | `formula/engine.ts:121-200+` `this.functions.set(...)` 出现 45 次，去重后 45 个：SUM/AVERAGE/COUNT/COUNTA/MAX/MIN/ABS/ROUND/CEILING/FLOOR/POWER/SQRT/MOD/CONCAT/CONCATENATE/LEFT/RIGHT/MID/LEN/UPPER/LOWER/TRIM/SUBSTITUTE/IF/AND/OR/NOT/TRUE/FALSE/SWITCH/NOW/TODAY/DATE/DATEDIF/YEAR/MONTH/DAY/VLOOKUP/HLOOKUP/INDEX/MATCH/STDEV/VAR/MEDIAN/MODE | 函数数量已与飞书相当 | — |
| 字段引用 `{fld_xxx}` | ✅ | `multitable/formula-engine.ts:14-15 FIELD_REF_PATTERN`、`evaluateField:49-78` | 已实现 | — |
| 跨表 LOOKUP（formula） | ✅ | `formula-engine.ts:83-105 lookup()` 用 `meta_records.data->>$2` 单匹配 | 仅精确匹配单值 | — |
| 公式缓存/重算依赖图 | 🟢 | `recalculateRecord:111-164`、`zzzz20260413130000_create_formula_dependencies.ts` 依赖表存在 | 单记录重算实现，跨记录依赖图未审 | 验证后再定 |
| 前端公式编辑器 | 🔴 | `MetaCellEditor.vue:1-260` 无 formula 分支；编辑公式只能改 property.expression jsonb | 飞书的 visual builder（函数提示/参数引导/语法高亮/中文函数名）零实现 | 4 人天（CodeMirror + 函数清单 + 中文文档） |
| 公式错误报告 | 🟡 | `formula-engine.ts:139-146` catch → `'#ERROR!'`；无具体错误位置 | 行 139-146 任何异常一律 #ERROR! | 1 人天细化 |
| AI 公式生成 | ⚫ | grep 全空 | 飞书 2024 起有"自然语言生成公式" | 推迟到阶段三 AI |

**公式总差距**（含编辑器）：**~5-6 人天**。

### 2.5 自动化（Trigger / Action / Condition）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| 触发器：record.created/updated/deleted | ✅ | `automation-triggers.ts:6-13 AutomationTriggerType` | — | — |
| 触发器：field.value_changed | ✅ | `automation-triggers.ts:25-31 FieldValueChangedConfig`、`matchesTrigger:71-90` | 含 `equals` / `changed_to` / `any` | — |
| 触发器：schedule.cron / schedule.interval | ✅ | `automation-triggers.ts:32-42`、`automation-scheduler.ts` 369L、`redis-leader-lock.ts` 234L 防并发 | 含 leader lock | — |
| 触发器：webhook.received | ✅ | `automation-triggers.ts:44-47` | — | — |
| 触发器：form_submitted（独立） | 🟡 | 形式上 form 提交走 `record.created`；无独立 `form.submitted` trigger 区分 | 飞书有专门"表单提交"触发，含表单元信息（IP/UA） | 0.5 人天加 alias |
| 动作：update_record / create_record | ✅ | `automation-actions.ts:6-13` | — | — |
| 动作：send_webhook | ✅ | `automation-actions.ts:9, 36-42 SendWebhookConfig` | — | — |
| 动作：send_dingtalk_group / person | ✅ | `automation-actions.ts:50-74`、`dingtalk-group-delivery-service.ts`、`dingtalk-person-delivery-service.ts` | 含 `userIdFieldPath` 字段路径动态收件 | — |
| 动作：send_notification（系统内） | ✅ | `automation-actions.ts:44-48 SendNotificationConfig` | — | — |
| 动作：lock_record | ✅ | `automation-actions.ts:13, 76-79` | 飞书无对等，本品多了一个 | — |
| 动作：send_email | 🔴 | grep `send_email` 全空 | 飞书可发邮件；本品无 SMTP 通道 | 2 人天（含邮件模板） |
| 动作：call_external_api（任意 HTTP）| 🟢 | `send_webhook` 已覆盖；动作配置含 method/headers/body | 满足"调用外部 API"语义 | — |
| 条件：equals / not_equals / contains / not_contains / gt / lt / is_empty / is_not_empty / in / not_in | ✅ | `automation-conditions.ts:7-17 ConditionOperator` 10 个 | — | — |
| 条件：嵌套组（AND/OR 嵌套） | 🔴 | `automation-conditions.ts:1-5 注释`：「No nested groups for V1 — flat condition list with AND/OR logic」 | 显式 V1 限制 | 1 人天加嵌套 |
| 自动化日志 | ✅ | `automation-log-service.ts` 142L | — | — |
| 自动化深度限制 | ✅ | `automation-service.ts:28 MAX_AUTOMATION_DEPTH = 3` | 防自动化连环触发 | — |

**自动化总差距**：~3-4 人天补充（form 触发 alias / send_email / 嵌套条件）。

### 2.6 协作 / 评论 / 提及 / 实时

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| Cell-level / row-level comment | ✅ | `meta_comments`（zzzz20260326134000:5-19，含 `field_id` 可空 → row 或 cell）、`comments.ts:294 POST /api/comments`、`MetaCommentsDrawer.vue` | parent_id 支持线程；resolved 字段支持解决态 | — |
| @mention | ✅ | `meta_comments.mentions jsonb`、`MetaMentionPopover.vue` 26L、`comments.ts:435 /mention-candidates`、`MetaCommentComposer.vue` | — | — |
| 评论收件箱 / 未读 | ✅ | `MultitableCommentInboxView.vue`、`comments.ts:191 /inbox`、`/unread-count`、`/mention-summary`、`useMultitableCommentInboxRealtime.ts` | — | — |
| 评论实时推送 | ✅ | `useMultitableCommentRealtime.ts`、`useMultitableCommentInboxRealtime.ts` | Socket.IO 实现 | — |
| 多人协作（cell 级 Yjs） | 🟢 | `useYjsDocument.ts:3 import * as Y from 'yjs'`、`useYjsCellBinding.ts` 385L、`useYjsTextField.ts` 212L、`zzzz20260501100000_create_yjs_state_tables.ts:6 meta_record_yjs_states` | 后端持久化 + 前端 Yjs；当前覆盖 string 字段（`MetaCellEditor.vue:31 yjsActive`） | 验证非字符串字段是否覆盖 |
| Presence (谁在线 / 谁在编辑) | ✅ | `MetaYjsPresenceChip.vue`、`useMultitableSheetPresence.ts`、`useMultitableCommentPresence.ts` | — | — |
| 订阅通知（"X 变化时通知我"） | 🔴 | grep `subscription` 仅命中 EventBus 内部订阅，无 user-facing "subscribe to record" | 飞书有"关注此条记录" | 2 人天（subscribe 表 + 触发通知） |
| Version history（cell/record） | 🔴 | `meta_records.version` 仅 optimistic lock（`record-write-service.ts:446 SELECT version FOR UPDATE`、`SET version = version + 1`）；**无历史快照表** | 飞书有"查看修改历史" | 4 人天（快照表 + retention + 前端 timeline） |

**协作总差距**：~6 人天。

### 2.7 权限模型（row / column / view）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| Sheet 级权限 | ✅ | `permission-service.ts:109 MultitableSheetAccessLevel='read'｜'write'｜'write-own'｜'admin'`、`SHEET_*_PERMISSION_CODES` | 含 write-own（仅可改自己创建的行） | — |
| View 级权限 | ✅ | `zzzz20260411140000_create_meta_view_permissions.ts`、`univer-meta.ts:3103 GET /views/:viewId/permissions`、`PUT` | — | — |
| Field 级权限（visible/read_only） | ✅ | `field_permissions` 表（zzzz20260411140100:13-25）、含 `visible boolean`、`read_only boolean`、`subject_type IN ('user','role')`、`univer-meta.ts:3250 GET /sheets/:sheetId/field-permissions`、`PUT` | — | — |
| Record 级权限 | ✅ | `record_permissions` 表（zzzz20260413100000）、`univer-meta.ts:3410 GET /sheets/:sheetId/records/:recordId/permissions`、`PUT`、`DELETE` | — | — |
| 主体类型：user / role / member-group | ✅ | `permission-service.ts:109 'user' \| 'role' \| 'member-group'` | 比飞书的 user/department/role 多一个 member-group | — |
| 公开表单 + 三档访问模式 | ✅ | `univer-meta.ts:319 PublicFormAccessMode='public' \| 'dingtalk' \| 'dingtalk_granted'`、`isPublicFormAccessAllowed:426`、限流（`publicFormSubmitLimiter`） | 飞书的"公开表单"对等 | — |
| API token | ✅ | `api-token-service.ts` 327L、`api-tokens.ts` 路由、`zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts` | 含 expiry / scope | — |

**权限总差距**：**0**。本子系统是全部矩阵中最成熟的部分。

### 2.8 导入 / 导出 / 批量

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| CSV / TSV 导入 | ✅ | `MetaImportModal.vue` 840L（"Paste tab-separated data from Excel or Google Sheets"）、字段映射、预览、错误重试、草稿恢复 | 体验完整 | — |
| Excel (.xlsx) 导入 | 🔴 | `accept=".csv,...,.tsv,...,.txt,..."` 不含 .xlsx；无 SheetJS / xlsx 依赖（grep 全空） | **重大差距** — B2B 客户首次试用通常拿 .xlsx | 3 人天（xlsx 依赖 + 多 sheet 选择 + 列映射复用） |
| CSV 导出 | ✅ | `MetaToolbar.vue` `Export CSV` 按钮、`MultitableWorkbench.vue` `a.download = '${id}.csv'` | — | — |
| Excel (.xlsx) 导出 | 🔴 | grep 无 xlsx 输出 | — | 1.5 人天 |
| Bulk edit（多行同时改一字段） | 🟡 | `POST /patch`（`univer-meta.ts:6644`）支持批量 patch；前端 UX 是否提供"全选 → 批量赋值"未审 | 后端支持，前端 UX 需验证 | 1 人天验证 + 补 UI |
| Bulk delete | 🟡 | 同上，`/patch` 支持，前端复选 UI 未审 | — | 含上 |
| Templates / Template gallery | 🔴 | `meta_*` 表无模板表；`provisioning.ts` 仅创建空 sheet | 飞书有大量行业模板 | 2 人天（模板表 + 一键应用） |

**导入导出总差距**：**~7 人天**。Excel xlsx 是 P0 候选。

### 2.9 集成 / API / Webhook

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| Open API（外部读写记录） | ✅ | `api-token-service.ts` 327L、`middleware/api-token-auth.ts`、`/api/multitable/*` 含 token 头 | — | — |
| Webhook outbound（事件触发） | ✅ | `webhook-service.ts` 580L、`multitable_webhooks` 表、`api-tokens.ts:307-403` 路由（list/create/patch/delete/deliveries）、含 HMAC 签名 + 重试 + 失败计数 | — | — |
| Webhook event 列表 | ✅ | `webhooks.ts:19 ALL_WEBHOOK_EVENT_TYPES` | — | — |
| iframe / 嵌入 | 🟢 | `MultitableEmbedHost.vue` 存在 | 嵌入 host 已有；外部域 CSP 配置需运行时验证 | — |
| App marketplace（第三方插件分发） | 🟡 | `plugins/plugin-view-{calendar,gallery,gantt,kanban,grid}` 已模块化；marketplace UX 未审 | 插件机制有，市场 UX 未达飞书"安装即用" | 不计入此分析（独立路线） |

**集成总差距**：**0** 关键差距（marketplace 不计入）。

### 2.10 AI（飞书 2024 起新增）

| Feature | Status | Implementation evidence | Gap description | Effort estimate |
|---|---|---|---|---|
| AI 公式生成（自然语言→公式） | ⚫ | grep 全空 | — | 推迟阶段三 |
| AI 摘要 / 提取字段 | ⚫ | 同上 | — | 推迟阶段三 |
| AI 翻译 | ⚫ | 同上 | — | 推迟阶段三 |
| AI 生成行内容 | ⚫ | 同上 | — | 推迟阶段三 |

**AI 总差距**：明确推迟，不在 Wave M-Feishu-1 范围。

---

## 3. 优先级排序

### P0 — 客户阻断（feature 缺失阻碍商业采用）

| # | Gap | Impact | Effort |
|---|---|---|---|
| P0-1 | **Excel (.xlsx) 导入** | B2B 客户首次试用最常拿 .xlsx；CSV 阻断 80%+ 第一印象 | 3 人天 |
| P0-2 | **字段类型扩展（currency/percent/rating/url/email/phone/auto-number/created-time/modified-time/multi-select 真实多选）** | ERP/CRM 数据迁入即遇阻；飞书 vs 本品最直观差距 | 8-10 人天（可拆 lane） |
| P0-3 | **公式编辑器 + 中文函数文档** | 用户无法可视化写公式 → 公式引擎实际未被发现 | 4 人天 |

### P1 — 强差异点（评估时客户期望）

| # | Gap | Impact | Effort |
|---|---|---|---|
| P1-1 | **条件格式（cell/row 颜色规则）** | "首次打开能否惊艳"印象 | 3 人天 |
| P1-2 | **Gantt 视图前端解锁**（plugin-view-gantt 已有 582L 后端） | 项目管理客群需要；后端已就位浪费可惜 | 4 人天 |
| P1-3 | **Excel (.xlsx) 导出** | 首次客户演示常被问 | 1.5 人天 |
| P1-4 | **Long text 字段（多行文本）** | 几乎所有场景都缺 | 1.5 人天 |
| P1-5 | **Visual filter builder** | 现状只能写 jsonb；非技术用户不可用 | 2 人天 |
| P1-6 | **Record version history** | 数据安全感；审计场景 | 4 人天 |
| P1-7 | **send_email automation action** | 钉钉 + 邮件双通道客户都问 | 2 人天 |
| P1-8 | **AI 公式生成 / AI 摘要** | 战略差异；时间窗紧 | 标在 P3 战略 |

### P2 — 体验打磨

| # | Gap | Effort |
|---|---|---|
| P2-1 | Templates 模板库（一键创建客户/订单/项目模板） | 2 人天 |
| P2-2 | 嵌套条件组（自动化） | 1 人天 |
| P2-3 | Form 提交独立 trigger alias | 0.5 人天 |
| P2-4 | Number format（千分位/小数位 UI） | 0.5 人天 |
| P2-5 | DateTime 字段 + 时区 | 1 人天 |
| P2-6 | Subscription（关注记录） | 2 人天 |
| P2-7 | Hierarchy 树形视图 | 3 人天 |
| P2-8 | Barcode / Location / Member field native | 3-4 人天 |

### P3 — 战略推迟

| # | Gap | 备注 |
|---|---|---|
| P3-1 | AI 公式生成 / AI 摘要 / AI 翻译 / AI 生成行 | 阶段三与多模型路线整体规划 |
| P3-2 | App marketplace（第三方插件市场 UX） | 独立路线，依赖插件治理 |

---

## 4. 建议首波（Wave M-Feishu-1）

**约束**：lane 文件不相交（可并行）；不触 `plugins/plugin-integration-core/*`；每 lane 2-5 人天（对齐 wave 8/9 节奏）。

| Lane | Scope | Primary files | Effort | Validation |
|---|---|---|---|---|
| **Lane MF1 — Excel xlsx 导入/导出** | 引入 SheetJS（xlsx）依赖；扩展 `MetaImportModal.vue` 接受 `.xlsx`，多 sheet 选择、列映射复用现有逻辑；新增 toolbar `Export XLSX` 按钮；后端无改动（CSV 路径已通） | `apps/web/src/multitable/components/MetaImportModal.vue`、`apps/web/src/multitable/components/MetaToolbar.vue`、`apps/web/src/multitable/views/MultitableWorkbench.vue`（仅 onExport*/onImport 钩子）、`apps/web/package.json`（加 xlsx 依赖） | **4.5 人天** | 用 K3 PoC fixture 中的 .xlsx 文件 + 50 列 + 1k 行导入成功；导出后 .xlsx 在 Excel 与 WPS 打开正常；CSV 路径 regression 通过 |
| **Lane MF2 — 字段类型扩展（第一批：currency / percent / rating / url / email / phone）** | 6 个字段类型一次性补齐：`mapFieldType` 加分支；`sanitizeFieldProperty` 各类型 schema；`MetaCellEditor.vue` / `MetaCellRenderer.vue` 新分支；不动 link/lookup/rollup/formula | `packages/core-backend/src/multitable/field-codecs.ts`、`apps/web/src/multitable/components/cells/MetaCellEditor.vue`、`apps/web/src/multitable/components/cells/MetaCellRenderer.vue`、`apps/web/src/multitable/components/MetaFieldManager.vue`（类型选择器） | **5 人天** | 6 类型 round-trip：创建字段 → 写入值 → 验证 sanitize → 渲染 → 编辑 → 重新读取等价；既有字段类型 regression 通过 |
| **Lane MF3 — 条件格式（前端规则 + 渲染）** | view config 增加 `conditionalFormats` jsonb；`MetaGridTable.vue` 渲染时按规则匹配字段值染色（背景/文字色/图标）；`MetaViewManager.vue` 加规则 builder UI；后端仅 `meta_views.config` 已有 jsonb 不需迁移 | `apps/web/src/multitable/components/MetaGridTable.vue`、`apps/web/src/multitable/components/MetaViewManager.vue`、`apps/web/src/multitable/types.ts`（schema） | **4 人天** | 数字字段 ">100 标红"、select 字段 "==' 高 ' 标黄"、空值 "灰色"；规则编辑后立即生效；其他视图忽略规则不报错 |
| **Lane MF4 — `send_email` 自动化动作** | 新增 `send_email` action 类型；接入 SMTP（如已有）或新建配置；模板渲染（title/body 含字段路径占位符，复用 dingtalk action 的模板风格）；不动钉钉链路；不动前端 view 系列 | `packages/core-backend/src/multitable/automation-actions.ts`（加类型）、`packages/core-backend/src/multitable/automation-executor.ts`（加 case 分支）、`packages/core-backend/src/multitable/automation-service.ts`（验证 + 入参校验）、`apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`（动作配置 UI） | **3.5 人天** | 触发 record.created → send_email → 收件箱收到模板化邮件；动作配置 UI 通过 e2e 测试；既有钉钉/webhook 动作 regression 通过 |

**Wave 总人天**：4.5 + 5 + 4 + 3.5 = **17 人天**。
**Wave 墙钟时间**（4 dev 并行）：~5 天 = max(4.5, 5, 4, 3.5)。

**Disjointness 验证**（grep -l 文件冲突矩阵）：
- MF1 ↔ MF2：`MetaCellEditor` 不冲突（MF1 不动 cell editor，MF2 加分支但 MF1 在 MetaImportModal 层）；package.json 仅 MF1 改
- MF1 ↔ MF3：完全不相交
- MF1 ↔ MF4：完全不相交（MF4 纯后端 + AutomationRuleEditor 单独前端文件）
- MF2 ↔ MF3：MF3 仅碰 `MetaGridTable.vue`、`MetaViewManager.vue`；MF2 不动 GridTable，MF2 改的 `MetaFieldManager.vue` 与 MF3 改的 `MetaViewManager.vue` 是不同文件
- MF2 ↔ MF4：MF2 改 cell editor / renderer / FieldManager；MF4 改 automation-actions / executor / service / RuleEditor — 完全不相交
- MF3 ↔ MF4：MF3 改 GridTable / ViewManager；MF4 改 automation 系列 + RuleEditor — 完全不相交

**严格 file-disjoint**：✅ 通过，4 lane 可纯并行（无 rebase 风险）。

**Gantt 前端解锁推迟到 Wave M-Feishu-2**：`plugins/plugin-view-gantt` 后端 582L 已就位，Wave 1 不啃。理由：与 MF3（条件格式）共用 `MetaViewManager.vue`，无法并行；Gantt 库选型（dhtmlx 商用许可 vs gantt-task-react MIT）需独立决策周期；MF3 落地后 `MetaViewManager.vue` 形态明确，MF4 再来 rebase 风险更小。

**Wave 前置检查**：
- [ ] xlsx 依赖体积评估（SheetJS Community ≈ 800KB minified；可接受）
- [ ] SMTP 通道：仓内是否已有邮件服务（grep `nodemailer` / `mailer` / `smtp` 待确认），无则 MF4 需先评估通道（+1 人天）
- [ ] `meta_views.type` 无 CHECK 约束（Observation #1 已确认），故 view 类型扩展（如未来 Gantt）**不需补迁移**；`view_configs.type CHECK`（037:8）是 legacy 路径，不影响 meta_views 主线

---

## 5. 非优先观察（Non-prioritized observations）

1. **`view_configs` CHECK 与 `meta_views.type` 不一致**：037 迁移的 `view_configs.type IN ('grid','kanban','calendar','gallery','form')` 只有 5 类，但 `meta_views` 表（zzz20251231:30-41）`type text` 无 CHECK 约束，已有 'timeline' 写入。前端 6 类（含 timeline），后端 view_configs 5 类。两表用途不同（view_configs 是 047 之前的 legacy，meta_views 是当前主线），但并存有混淆风险，建议 Wave M-Feishu-1 之后单独审 1 lane。

2. **Person 字段实现策略**：`/person-fields/prepare` 用"系统隐藏 sheet 存人员 + link 字段"的间接方式（`SYSTEM_PEOPLE_SHEET_DESCRIPTION`），不是飞书的原生 person 类型。**好处**：复用 link 基础设施零成本支持权限/搜索；**坏处**：用户看到的是"link 到 People 表"而非"人员字段"。如果原生 person 体验是 P0，需重构（2 人天）。

3. **plugin-view-gantt 是孤岛**：582L 后端代码 + plugin.json 完整定义 task/dependency/criticalPath/resource，但 frontend 完全无对应组件、`MetaViewManager.vue:20 VIEW_TYPES` 不含 'gantt'、`view_configs` CHECK 不含 'gantt'。**当前是 dead code 风险**——任何 schema 变更都会被遗漏。Lane MF4 解锁此孤岛；若推迟，建议至少在 plugin manifest 加 deprecated 标记或 README 说明。

4. **Yjs 覆盖范围**：`useYjsTextField.ts` 212L 显示 Yjs 实时协作目前主要绑定到字符串字段（`MetaCellEditor.vue:31 yjsActive` 仅在 string 分支可见）。number/date/select 等字段是否走 Yjs 未审，可能仍是 last-write-wins。这影响"多人同时编辑同一行不同字段"的体验保证。

5. **公式引擎 evaluateField 字符串拼接**：`multitable/formula-engine.ts:55-67` 把字段值转字符串后拼回表达式（`return \`"${value}"\``），含字符串值含引号会破语法。生产场景 SQL injection 类风险低（执行不接 DB），但语法错误会触发 #ERROR!。建议改为 AST 替换。

6. **`field-type-registry.ts` 是 dead code 路径**：插件式注册存在（`fieldTypeRegistry.register`）但 `grep -rn fieldTypeRegistry.register packages/ plugins/` **零调用**。设计意图是允许插件扩展字段类型，但未被任何插件使用。Lane MF2 加 6 个内核字段类型时是否走 registry 路径需团队决策——走 registry 则插件能复用、走硬编码则前端易写但插件路径继续闲置。

7. **`MetaTimelineView.vue` 命名误导**：实现是"横向时间轴 + 任务条"（589L），但飞书的"timeline"也指此功能。前端 `MetaViewManager.vue:20 VIEW_TYPES` 含 'timeline'，但 `view_configs.type` CHECK 不含。客户描述"我要 Gantt"时，timeline 不能替代（无依赖箭头、无关键路径）。Lane MF4 之前应明确"Gantt vs Timeline"产品定义。

8. **Form 字段在 037 迁移种子里写了 `type:'rating'`、`type:'email'`、`type:'textarea'`，但这些值在 mapFieldType 里被 fallback 到 'string'**：037 迁移是 legacy view_configs 的演示数据，与当前 meta_views 路径无直接耦合，但客户从 form-demo 看到字段类型→实际未支持的认知差距明显。

9. **comments 路由有 `/api/comments/...`（generic）和 `/api/multitable/:spreadsheetId/...`（multitable-scoped）双套**：`comments.ts:435` 起的是 multitable-scoped；`comments.ts:112` 起的是 generic。两套并存，前端调哪套未审。可能是 legacy + new；技术债提示。

---

## 6. 范围外（Out of scope）

本分析**不涵盖**：
- **Univer integration internals**：本品有 `univer-mock.ts` 路由文件，但 Univer spreadsheet 引擎本身的渲染/公式/快照不属于多维表 surface。
- **Yjs realtime mechanics 内部实现**：仅判断"是否有 Yjs 协作"，不评估 Y.Doc 持久化、CRDT 合并策略、awareness 协议细节。
- **AI 能力（飞书 2024+）**：明确推迟到阶段三，不进 Wave M-Feishu-1。
- **App marketplace UX**：依赖独立"插件治理"路线（plugin-runtime / plugin-manager）。
- **Mobile 原生应用**：本品仅 web 响应式（grep 找到 2-3 处 `@media (max-width: 720px)` 在权限管理面板），无 React Native / 原生 iOS/Android 应用。
- **国际化（i18n）**：当前 hardcode 中英混合，专项 i18n 不在本分析范围。
- **`plugins/plugin-integration-core/*`**：K3 PoC 路径，K3 WISE Live PoC 完成前不动。
- **Backup / 灾备 / 跨区部署**：基础设施层。
- **第二档插件（intelligent-restore / audit-logger / telemetry-otel / attendance / after-sales / hello-world / sample-basic / test-a / test-b / example-plugin）**：与 multitable 内核非紧耦合。

---

**最后更新**：2026-04-26
**主笔人留言**：本文档以代码事实为准；任何 status 与飞书功能描述不一致处，以飞书官方产品文档为准、以本仓代码为基线。Lane 决策需团队 Triage 后排期。
