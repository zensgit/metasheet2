# 多维表如何引入外部数据、用户端如何"配置出"业务系统 —— 最终设计答复（第三轮，已吸收三份验证）

- 日期：2026-08-20　基线：`C:/Users/zhou/Downloads/dev/metasheet` @ main `9d4a87824`（工作区 clean）
- 用户问题（原文）："另外我们的多维表中没有与数据库或第三方系统API对接的功能代码,你能深入思考下,结合当前在做的以及 怎么在多维表中引入这些数据?或者怎么在用户端配置想做的系统,比如这次备料、crm、售后等?"
- 本稿 = `reports3/synthesis.md` 经三份验证（`verify-code-accuracy-2.md` / `verify-posture-governance-round2.md` / `verify-design-critique-round2.md`）修订后的定稿。所有 HIGH/MEDIUM 更正已逐条处理；被驳回的 3 条在 §7.2 列明理由。本轮我**亲自重读**的锚点见 §7.1。
- 约定：`CB/` = `packages/core-backend/src/`，`MT/` = `CB/multitable/`，`UM` = `CB/routes/univer-meta.ts`，`PIC/` = `plugins/plugin-integration-core/`（**PIC 短名 = `stock-preparation-<短名>.cjs`**，如 `PIC/audit-store.cjs` 实为 `plugins/plugin-integration-core/lib/stock-preparation-audit-store.cjs`），`AS/` = `plugins/plugin-after-sales/`，`web/` = `apps/web/src/`，`docs/` = `docs/development/`。
- values-free：本文不含任何主机、凭据、客户业务值。

---

## 0. 结论（一段话）

用户的判断对了一半：多维表**本体**确实没有"这张表/这列的数据来自外部数据库或第三方 API"这种**一等、可绑定的概念**——`meta_sheets` 迁移里加过的列只有 `base_id / conditional_read_rules / operation_id / recovery_writer_state / row_level_read_permissions_enabled / system_kind`，没有 `source/external/synced`；唯一的"服务端拥有"信号是 `system_kind ∈ {people_directory, approval_projection}`（`MT/system-sheet-predicate.ts:39`）；**30** 种字段类型里没有外部类型（`MT/field-codecs.ts:6-36`，联合成员 `:7-36`；前端 `web/multitable/types.ts:6-36` 同为 30 且是封闭联合）；16 个自动化动作里没有"拉一次外部数据写进表"的动作（`MT/automation-actions.ts:6-32,34-51`）。**但平台并不缺"对接系统"**：宿主已有数据源注册表（6 个类型键 / 5 个适配器类，`postgres` 是 `postgresql` 的别名，`CB/data-adapters/DataSourceManager.ts:54-61`）+ 凭据加密 + **只读 facade**（`data-source-plugin-facade.ts:365-395`），PIC 已有 5 方法适配器合同 + 9 个 kind + 分页/水位/死信/血缘的 pipeline + 写多维表的目标适配器，备料线已有所有权/冲突规划/确认写入的**纯函数同步内核**，多维表已有入站 webhook / API token / xlsx 导入 / 三种调度触发器 / 审批·通知·钉钉动作，平台已有 app manifest + installer + `platform_app_instances` + **模板中心前后端**（`UM:6894,6898,6992`；`web/views/MultitableTemplateCenterView.vue`、`MultitableTemplateDetailView.vue`；`web/router/appRoutes.ts:145-156`）。真正缺的是**两处接线**：(1) 多维表缺 2–3 个原语——**同步表**（sheet 级 `source_binding` + **不可伪造的**字段级 ownership + 一条 `upsertByKey` 受控写路径 + 一个 `sync_from_source` 动作）、**外部查找字段**，以及把已有的**入站推送**治理补齐；(2) "应用"缺一个**数据化蓝图**（AppBlueprint）+ 通用 installer + 绑定向导。**但这条线整体阻塞在一组 owner 门上**：新 issue/charter + 新 operation id + 独立 owner 授权（`docs/stock-preparation-k3wise-first-profile-delivery-plan-20260804.md:24-26`）、S5 重新排期（`docs/generic-integration-design-lock-20260618.md:75`）、GIP-D0 仅窄范围 RATIFIED（`docs/gip-d0-...:247`）、值面读三门（H0 `docs/stock-preparation-ui-humanization-h0-plane-boundary-design-lock-20260712.md:39,41-48,72`）。所以答案是"**给多维表加 2–3 个原语 + 把蓝图升格为数据**"，不是"再造一个集成系统"，也不是把 CRM/售后各写一个 6000 行 Vue 的插件；而**动工前提是先过门，不是先写码**。

---

## 1. 现状与缺口（分层，带 path:line）

| 层 | 已有（实读） | 证据 | 与多维表之间的精确缺口 |
|---|---|---|---|
| 连接/凭据 | 宿主 `data_sources`（6 个类型键 / **5 个适配器类**，`postgres`=`postgresql` 别名；凭据加密、永不回显、保存前测、`/data-sources` UI）；PIC `integration_external_systems`（tenant 级、9 kind、credential-store） | `CB/data-adapters/DataSourceManager.ts:54-61`；`CB/routes/data-sources.ts:864,917,954`；`packages/core-backend/migrations/057_create_integration_core_tables.sql:19-35` | 两套注册表、两种范围；`data_sources` 有 `owner_id`+`workspace_id` **无 `tenant_id`**（`CB/db/migrations/20251206000001_create_data_sources_table.ts:37-39`）；`assertAccess` 只比 `ownerId`、**已存的 `workspaceId` 被忽略**（`DataSourceManager.ts:380-390`）；**没有任何 sheet/field 指向它们** |
| 读适配器 | 宿主 `BaseAdapter.select/getSchema/getTableInfo`、`DATA_SOURCE_MAX_ROWS=10000`、where 含 `$in`（`BaseAdapter.ts:33,83`）；PIC 合同 5 方法；HTTP 适配器已有 tokenProvider 缝（存取 + 请求拦截注入 + 401 重试，`HTTPAdapter.ts:122-125,171-175,197-198,317-318`） | 同左 | `MT/**` 对 `data-adapters` **零 import**（grep 无命中）；**facade 明文拒绝系统/默认/租户/管理员身份**（`data-source-plugin-facade.ts:149-158`），且 `authorize` 调 `assertAccess(owner)`（`:369-382`）→ **任何"以绑定主体读取"的方案在第一步就被拒**；宿主 HTTP Bearer 键名不一致（路由收 `credentials.token` vs 适配器读 `credentials.bearerToken`，静态判定） |
| 同步引擎 | PIC pipeline：分页→transform→validate→幂等键→`target.upsert`，水位/死信/run-log/provenance/dry-run/replay；`metasheet:multitable` 目标形式上通用（任意 sheetId） | `PIC/lib/contracts.cjs:12`；`PIC/index.cjs:251-259`；`PIC/lib/adapters/metasheet-multitable-target-adapter.cjs:110,239-297` | 写形状是**逐行** `queryRecords(limit 1)` + `patchRecord`（`:239-282`，N 行 = 2N 次往返，BOM 规模不可用）；整行投影、**无字段所有权**；无 inactive；**无调度器**（`integration_schedules` 表在但零运行时读者，`057_...sql:165-177`）；目标 UI 只能选 5 张 staging 表（`web/views/IntegrationWorkbenchView.vue:2365-2384`）；runner **恒定**传 `keyFields:['_integration_idempotency_key']`（`PIC/lib/pipeline-runner.cjs:503,657`），与目标适配器的 `resolvedKeyFields`/`shouldWriteField` 过滤（`adapter:150-154,217-221,255`）合成"默认 append" |
| 所有权/冲突内核 | 备料：ownership 词表 `['plm_system','human_preserved']`（`PIC/stock-preparation-templates.cjs:12`）、**代码里 9 个必备 system 字段**（`:16-26`）+ **8 个 human 白名单**（`:28-36`）、`conflictStrategy` 六键（`deleteByDefault=false`、`missingFromPlmPolicy='mark_inactive'`）、planner 决策 `add/update/skip/inactive/manual_confirm`、planner+writer **双锁**不碰 human、dry-run token + revision fence、values-free 审计结构门 | `PIC/conflict-planner.cjs:750-756`；`PIC/apply-writer.cjs:187-196`；`PIC/audit-store.cjs:68-90`（=`stock-preparation-audit-store.cjs`） | 纯插件侧；core/web **零读者**——ownership 写进 `field.property` 后网格照样可编辑。**注**："17 个 plm_system 字段"是客户实例的模板**数据**，不是代码事实；代码里只有 9 个必备 system 字段常量 |
| 入站 | Open API `mst_` token（**6 个 scope，无 `fields:write`**，`MT/api-tokens.ts:24-38`；token 以 `createdBy` 身份行事，`CB/middleware/api-token-auth.ts:70-84`）；`webhook.received`（HMAC + 300s 重放窗 + 60/min 限速 + 1mb 上限，`MT/automation-inbound-webhook.ts:3-11,66-96`）；xlsx 导入（`UM:13085`）；插件 SDK `records.create/patch` | 同左 | OAPI 写面是 `/api/multitable/*` 路由 + `apiTokenAuth/oapiScopeGuard/requireScope`，且受**一张锚定正则白名单 fail-closed** 控制（`MT/oapi-read-allowlist.ts:79-90`，5 条写路由）；`POST /patch` 每条 change **必带 recordId**（`UM:17188-17200`）→ 无按键 upsert；webhook 载荷**进不了字段**（`update_record` 直接用 `config.fields`、`create_record` **裸 INSERT** `config.data`，`MT/automation-executor.ts:2289-2292,2770-2788`，后者注释自承绕过 5 个 validator **且不写 revision**）；事件 `recordId:''`（`MT/automation-service.ts:2396-2405`） |
| 插件 SDK 写路径 | **不是裸 SQL**：`fenceWriterEntry` + `mintOperation` + `version+1` + `recordRecordRevision(source:'plugin')` + `isFieldAlwaysReadOnly` 拒写只读字段 + 记录锁守卫 | `MT/records.ts:360-362,504-509,527-534,580-587,634-673` | 缺：**事件、实时推送、lookup/rollup/formula 重算、按键定位、字段所有权、actor 身份**（`actorId:null`，`:586`）。真正裸 SQL 的是 People 目录（`UM:5266,5283`）与审批投影 |
| 出站 | `send_webhook`（SSRF 守卫、outbox）、钉钉 ×3、邮件、`start_approval`、`wait_for_callback`、webhook 订阅、按钮字段 | `MT/automation-actions.ts:6-32,34-51` | 无"请求-响应"动作 |
| 调度 | `schedule.cron / schedule.interval / schedule.date_field` + `webhook.received` + `form.submitted`，共 11 个触发器，调度器已实现三种 | `MT/automation-triggers.ts:6-31`；`MT/automation-scheduler.ts:508-530,552,568,574` | 调度器在，**缺的是动作** |
| 系统来源先例 | People 目录（**裸 SQL** 按 userId upsert，sheet 由服务端打 `system_kind`，`UM:5180-5182,5266,5283`）、审批投影（`restrictApprovalProjectionCapabilities` 对非管理员 **11 项能力全 false**，含 `canRead/canExport/canComment/canManageAutomation`，`MT/approval-projection-constants.ts:33-46,47-58`）、备料 plm_system 标记 | 同左 | 三处各自手写同一组不变量，无可复用原语；且**"能读不能改"这一档位今天根本不存在** |
| 应用/模板 | 8 个内置 schema-only 模板（类型只有 sheets/fields/views；`sales-crm` **只有一张 deals 表**，`MT/template-library.ts:36-44,119-321,147-173`）+ `GET /templates`（`UM:6894`）+ `install`/`dry-run`（`:6898,6992`）+ **模板中心/详情前端页**（`web/views/MultitableTemplateCenterView.vue`、`MultitableTemplateDetailView.vue`，`web/router/appRoutes.ts:145-156`）；after-sales `app.manifest.json + blueprint.cjs + installer.cjs`（752 行、`runInstall` 11 步）→ `platform_app_instances`（有 `config_json` 与 `instance_key`，唯一索引 `workspace_id/app_id/instance_key`）；`PlatformAppShellView.vue` / `PlatformAppLauncherView.vue` / `MultitableEmbedHost.vue`（`appRoutes.ts:163`）均**已存在** | `AS/lib/installer.cjs:415,468,486,519,551`；`CB/db/migrations/zzzz20260413130000_create_platform_app_instances.ts:8-28` | 蓝图是代码；`manifest.integrations[]` **零运行时消费者**（只透传进 app summary，`CB/platform/app-registry.ts:128,157`；`AS/app.manifest.json:118-129` 只有 `{id,type,direction}`）；两套自动化（`plugin_automation_rule_registry` **只登记不执行**，`CB/services/PluginAutomationRegistryService.ts:74,111,134`）；reinstall ≠ 升级（`ensureFields` 的 `ON CONFLICT (id) DO UPDATE` **覆盖** name/type/property/order，`MT/provisioning.ts:305-321`）；所有插件对象落 `DEFAULT_BASE_ID='base_legacy'`（`:108`）；**多实例真正的阻塞是 id 派生**：`projectId = getProjectId(tenantId, appId)`（`AS/lib/installer.cjs:449`）+ `stableMetaId(projectId, objectId[, fieldId])`（`provisioning.ts:129-148`）⇒ 同租户第二实例撞同一批 id，且 `mode=enable` 已存在直接抛 `ALREADY_INSTALLED`（`installer.cjs:433-437`） |
| 字段策略 | `plugin_field_policy_registry` 由 `PluginRbacProvisioningService.ts:132` 写入，**由 after-sales 自己读**（`AS/lib/field-policies.cjs:87-90`，调用点 `:261` 与 `AS/lib/runtime-admin.cjs:137`） | 同左 | **多维表网格/`field_permissions` 从不读它** ⇒ 一旦把 after-sales 对象搬进通用多维表壳而 fieldPolicies 未落原生 `field_permissions`，`refundAmount` 之类财务列会对客服可写/可见——这是**本方案会引入的回归**，不是既有缺陷 |
| GIP-D0 | **不是空注册表**：`PIC/lib/` 下有 **16 个 `gip-*.cjs`**（profile 认证契约、合规 harness、approved-binding resolver、qualification spike、`bridge.bounded_read.v2` profile、server-bound source executor、SQL Server 快照分页策略等），且 approved read-source config 已带 `actionProfileVersion` 并用 GIP 的 `isValidProfileId` 校验（`PIC/lib/read-source-config.cjs:18,23,288-289,383`） | `ls plugins/plugin-integration-core/lib \| grep ^gip-`；`gip-approved-binding-resolver.cjs:12-25` | 全部 **LATENT**：`gip-approved-binding-resolver.cjs:20` 自述"no route, no scheduled run, no runtime consumer"。缺的是 **runtime wiring 与"多维表 sheet"形态的消费面**，不是词表 |

**一句话**：连接器在、引擎在、内核在、触发器在、安装骨架在、模板中心在、GIP 词表也在；缺的是 **sheet ↔ 源的绑定对象**、**字段级所有权在 core 的不可伪造读者**、**一条带修订+事件+重算的系统写路径**、**一个能"拉"的动作**、**数据化蓝图**，以及**一组尚未打开的 owner 门**。

---

## 2. 三种原语设计

设计原则：表级绑定源视图 + 字段级所有权；默认 **pull-copy**，按需 **lookup**；**不做 live 虚拟表**；写回是独立 capability class 不是改单元格；连接与模板解耦；解绑 = 降级为普通表。

### 2.0 三条横切纪律（三个原语共同遵守，先于各自设计）

**(a) 绑定输入面纪律（S0:218-228 的直接适用）。** "服务端写、客户端只读"只解决了**伪造**，没解决**授权来源**。S0 锁逐条点名浏览器**永不可提供**：源系统 id 或源对象；目标 sheet id 或字段映射；raw SQL / filter 表达式 / adapter body；max rows/depth/caps；plan 或 apply 载荷；凭据。所以：

- 浏览器**只**提交三样：① 已登记 connection 的**不透明 id**；② 一个**已注册的具名 binding preset / action profile id**；③ allowlist 内的业务参数（如 projectNo）。
- `object|view / fieldMap / keyFieldIds / caps / ownedFieldIds` 一律由服务端从 approved preset/action **装配**，形如 `PIC/lib/gip-approved-binding-resolver.cjs:12-25` 的 closure-bound resolution（"AUTHORITY IS CLOSURE-BOUND, NEVER CALLER-SUPPLIED"）。
- **这与 §2.1 的"绑定向导"直接冲突**，因此"绑定输入面例外"（是否允许管理员在向导里直接选表/选列）**单列为 owner 门**（§6.4 ⑫）。默认取严：向导只做"选 preset + 选连接 + 确认服务端装配结果"。

**(b) 平面归属（H0 值面边界锁）。** 向导的"预览列"和 lookup 字段渲染，一旦出现物料编码/名称/库存/价格/信用额度这类**外部业务值**，即 H0 定义的**平面 B**。H0 明写平面 B 的两把门（**独立 value-read 权限**、**值面读审计动作**）**当前都不存在**，H3-0 契约基础落地前值面读**一律不实现**；值面读若接真实外部数据还叠加 #4194（`h0...20260712.md:32-39,41-48,72`）。因此：

- v1 的绑定向导预览 = **values-free**：只出**列名 / 类型 / 计数 / 通过-未通过**，**不出任何行值**；
- lookup 字段（原语 B）**整体后置到 H3-0 之后**（见 §2.2 的分期）；
- H0 锁的字面范围是备料证据面。它是否延伸到"租户自行登记的普通 `data_source`"是 owner 决定（§6.4 ⑬）；在裁决前**按 fail-closed 处理**，即一律当平面 B。

**(c) 前提旗标。** `fenceWriterEntry` 在 `MULTITABLE_ENABLE_WRITER_FENCE` 未开时**首行直接 return**，而它**默认 OFF**（`MT/canonical-sheet-fence.ts:136-138`；模块头自述 default-off；`fenceWriterEntry` 首行 `if (!isWriterFenceEnabled()) return`）。所以凡以"必经围栏"作为缓解的论述，都**以 `MULTITABLE_ENABLE_WRITER_FENCE=true` 为条件**；开启该旗标进 owner 门与 P1 验收硬判据。

**(d) 连接主体模型（原语 A/B 的前置阻塞，不是附带项）。** `requirePrincipal` 明文"deliberately do NOT fall back to a default / system / tenant / admin identity"（`data-source-plugin-facade.ts:149-158`），`authorize` 调 `assertAccess`（`:369-382`），而 `assertAccess` 要求 `scope.ownerId === ownerId`（`DataSourceManager.ts:380-385`）。**`system:sync:<bindingId>` 在第一步就被拒。** 三选一，必须先裁（§6.4 ④）：

1. 绑定存 `ownerUserId`，以**建绑定那个人**的身份读（简单；但人离职/降权后同步静默失效——需要 binding degraded 语义）；
2. facade 新增 `binding:<id>` 主体类型 + 建绑定时一次性授权登记（干净；改 facade 语义，需 owner）；
3. 放宽 `assertAccess` 到 `tenant ∧ workspace`（**落点最小**：`DataSourceManager.ts:380-390` 一处，`getScope` 已返回 `workspaceId` 却未参与判定；且**不必先加 `tenant_id` 列**）。

推荐 3 + 2 组合：先修 `assertAccess` 用上 `workspaceId`，再加 `binding:<id>` 主体。**这项工作量在 §5.3 单列。**

### 2.1 原语 A：Synced Table / 同步表

**定义**：一张真实的 `meta_sheets` 行，带 `source_binding`；字段分三类——`system`（源拥有、人只读、刷新覆盖）、`human`（人填、刷新不碰）、`ext_`（租户扩展、模板外）。数据通过"读源 → 归一/键 → 读已有 → 规划 → （确认）→ 应用 → 审计"落进 `meta_records`，带修订、过围栏、发实时、可选发事件。

**v1 拆成两级**（设计评审 C：link 在同步侧与蓝图侧都是空白）：

- **A1 标量同步表（v1）**：`fieldMap` 中 `ownership='system'` 的字段类型必须 ∈ `{string,number,boolean,date,dateTime,select,currency,percent,url,email,phone}` 等标量集合；**`link` 一律拒绝**。理由不只是复杂度：若把 link 字段标成 `ownership:'system'` 使 `isFieldAlwaysReadOnly` 为真，精确锚点恢复的 apply 遇到该 link 变更会直接 `ApplyRefusalError('link-integrity')`（`MT/exact-anchor-recovery-execute.ts:1110-1120` 亲读），**整表 PIT 恢复被拒**。
- **A2 关系同步表（押后）**：需要一整层"业务键 → 本仓 recordId"解析（写 link 必须给 recordId，`MT/records.ts:361-372` 的 `validateLinkIds`）、binding 间依赖顺序、前向引用二次通过、悬挂引用策略、link 删除的所有权、planner 决策词表扩展。另外 `MT/provisioning.ts:305-321` 的 `ensureFields` 对 link **零处理**（无 `foreignSheetId` 校验、无 mirror 配对；mirror 配对逻辑只在 `UM:1028-1102,2309-2322` 路由里），且 8 个内置模板 link 出现次数为 **0** ⇒ **多对象 + link 的模板从未被 provisioning 走通**。A2 与"link provisioning 抽服务"各列独立工作项。

**绑定模型（core 新增）**

`meta_sheets.source_binding jsonb NULL`，**服务端专属列**（沿用 `system_kind` 的非伪造纪律，`MT/system-sheet-predicate.ts:34-39` 注释自述"NEVER by a client create/update request"）：

```
{ bindingId, bindingVersion,
  connectorRef: { kind:'data_source'|'integration_external_system'|'read_source_config', id },   // 不透明 id
  actionProfileVersion,        // ← 复用 GIP profileId 词表（read-source-config.cjs:288 同一 isValidProfileId），不新造 readerPreset
  object|view, keyFieldIds[], fieldMap[{externalColumn, fieldId, ownership, requirement}],
  refresh: { mode:'manual'|'auto_discover_manual_confirm'|'auto_insert_confirm_changes', cron?, tz? },  // ← S0:271-286 三档原文
  conflictPolicy: { addMissing, refreshSystemFields, missingFromSource:'mark_inactive',
                    duplicateSourceKey:'hold'|'keep_multiple_rows', deleteByDefault:false /*锁死*/ },
  activeFieldId?, runStampFieldIds?, emitEvents:false, ownerPluginName? }
```

三项**结构性纪律**：

1. **闭合顶层键白名单**（不是拒绝表）：抄 `PIC/lib/read-source-config.cjs:66` 的 `ALLOWED_CONFIG_KEYS` —— 任何未列键一律拒；再叠加 `WRITE_SHAPED_KEYS`（`:58`）与 `INLINE_CREDENTIAL_KEYS`（`:60-63`）两张拒绝表。三件套 + 漂移测试。仅靠拒绝表会随 `source_binding` 长键而漏网。
2. **删除 `writeBack` 键**（原稿有 `writeBack:'none'`）：既然拒写形键，契约里就不该保留写语义键位；写回若开，是**另一个对象、另一条轨**（GIP-D0`:106` "外部写回是独立 capability class、独立认证/审批/审计轨"）。
3. **`refresh.mode` 用 S0 原文三档**（`manual` / `auto_discover_manual_confirm`（recommendedDefault）/ `auto_insert_confirm_changes`），并保留 S0`:288-299` guardrails 逐条：`humanFieldsPreserved` / `neverAutoOverwriteHumanFields` / `missingChildBom=held` / `sourceDeletedRows=markInactive_notDelete` / `auditLogRequired` / `sourceSnapshotRequired` / `dryRunReviewRequiredForChanges`。S0`:455` 的 stop rule 反过来禁止硬编码单一模式。

**字段级所有权（关键更正）**：原稿把 ownership 寄生在 `meta_fields.property.source` 上，这是**可伪造**的——`property` 由客户端经普通字段更新路由提供，`sanitizeFieldPropertyByType` 默认分支透传（`MT/field-codecs.ts:543-551`），本仓既有做法是每个敏感键在写门显式校验。因此：

- **`ownership` 提为服务端拥有的来源**：或者一列 `meta_fields.source_ownership`（等价于 `meta_sheets.system_kind` 的非伪造地位），或者把 `property.source` 定为**服务端专属键**——字段写门剥离客户端提交的 `source`，仅 `MT/source-binding.ts` 可写。
- 更严重的一条（设计评审新发现）：若 `connectorRef` 可由 `canManageFields` 的用户经普通字段 PATCH 写入，而 resolver 以"绑定主体"读取，正好**旁路 `assertAccess` 的 owner 校验 → 跨 owner 读越权**。所以 `connectorRef` 必须建绑定时以**操作者身份**授权一次、每次 resolve 时以**存储的 principal 再校验**；任一失败字段进 `broken` 态**返回空值**而非错误文本（values-free）。
- 若确定保留 `property.source` 形态，则必须把 `source` 加进 `sanitizeFieldProperty` 的**跨切面合成链**（与 `visibilityRule`/`requiredWhen`/layer-2 visibility 同位，`MT/field-codecs.ts:239-245`），否则 `person`/`button` 两个 allowlist 分支会丢弃它（`:252-256` 注释实测指名这两类）。**逐分支补是错的落点。**
- **只读实现不需要新分支**：`isFieldAlwaysReadOnly` 末行已判 `property.readonly/readOnly === true`（`MT/permission-derivation.ts:58-67` 亲读），四条写门 + 客户端网格都读它（`UM:17241-17246`；`CB/index.ts:3613,3652`；`MT/records.ts:360-362`；`web/multitable/components/MetaGridTable.vue:1079-1080`）。同步表 system 列**由服务端在 provisioning 时置 `readonly:true`** 即全线生效。要做的是**不可伪造性**，不是新分支。

**写姿态（RecordSyncService.upsertByKey）**

```
MT/record-sync-service.ts::upsertByKey({ sheetId, rows, keyFieldIds, ownedFieldIds,
                                         actor /*服务端 mint*/, source:'sync', runId, emitEvents })
```

- **分批事务，不是单事务。** `fenceWriterEntry` 取的是 per-sheet `pg_advisory_xact_lock`，**持有到 COMMIT**（`MT/canonical-sheet-fence.ts:176-186`）。10k 行单事务会长时间独占整表写锁，阻塞 REST/Yjs/表单/插件的**全部**用户写，并与 recovery 的 `applying` 持久块互斥。既有代码在派生写上刻意选了相反取舍（`MT/derived-write-fence.ts:18-21`："per-record independence … partial-progress the bulk-recompute contract depends on"）。因此：**200–500 行/批，每批一个 fenced 短事务；run 级 `lastAppliedCursor` 断点续跑；批间让出锁；apply 期间 human 列仍可编辑。**
- 每批：`fenceWriterEntry`（前提旗标见 §2.0c）→ `mintOperation` → **按键批量定位**（`WHERE data->>keyFieldId = ANY($1)`，`meta_records.data` 有 GIN 索引，`CB/db/migrations/zzzz20260413110000_add_meta_records_query_indexes.ts:14`）→ **只合并 `ownedFieldIds`** → codec `validate*` → `version+1` → `recordRecordRevision({source:'sync'})`（`MT/record-history-service.ts:20` 的 `RecordRevisionSource` 以 `| string` 收尾，可接受 `'sync'`）→ `sealOperation` → 实时推送 → **可选**事件 → 重算。
- **`ownedFieldIds` 绝不可由请求提供**（S0:218-228）：服务端从 `source_binding` 推导，服务内再断言 `owned ∩ {formula, lookup, rollup, 系统类型, mirrorOf} = ∅`，违反即内部错误拒绝。否则持 `records:write` 的 token 把公式/lookup/mirror 字段 id 塞进 `ownedFieldIds` 就能破坏 spine 不变式（`MT/records.ts:355-372` 的注释解释了 mirror 写为何会造第二条 canonical edge）。
- **并发去重**：`meta_records` 对业务键**没有任何唯一约束**（键在 `data` jsonb 里，只有 GIN 索引；迁移里全部是普通索引）。upsert 只能 SELECT-then-write，天然 TOCTOU：cron run 与手动 apply 重叠、同 binding 两次 apply、sync 与 OAPI upsert 并发、重试/replay 都会造同键重复行。`duplicateSourceKey` 是**规划期**策略，挡不住**运行期**竞态。三件套：(a) apply 入口取 `pg_advisory_xact_lock(hash(bindingId))` 串行化同 binding；(b) 为启用 binding 的 sheet 建**部分表达式唯一索引** `ON meta_records((data->>keyFieldId)) WHERE sheet_id=…`，建绑定时 dry-run 检测既有重复并**拒绝启用**；(c) OAPI upsert 与 sync 复用同一把锁。
- **集成身份（actor）**：**不做前缀字符串约定**。`resolveBaseWritable` 是 fail-closed（`MT/permission-service.ts:1866-1874`，`:1872` "no identity → no write"），复合判定在 `MT/cross-base-write-authority.ts:47-70`。把"null → 拒"改成"前缀匹配 → 放行"等于新增一条**以字符串为凭**的写权来源。正确做法：合成 actor **只由 binding 记录在服务端 mint**（closure-bound，不接受任何请求/规则参数传入），写权由 binding 的 approved `targetBaseId` 派生；并加**负控测试**：请求或自动化配置里出现 `system:` 前缀 actor → reject。该 actor 还须在**四处**被认：`resolveBaseWritable`、`ensureRecordNotLocked`、`created_by/modified_by` 列、审计 UI 展示名。
- **为什么带修订而不走 derived-write-fence**：派生写不升版本、不写修订（`MT/derived-write-fence.ts:42-70`），混合了 human 列的同步表不再"可再生"，PIT/Reset 会看不见它。
- **重算规模**：N 行 × 每行 `recalculateFormulaFields` + `computeDependentLookupRollupRecords` 的跨表扇出是 O(N × 依赖表数)。需要**批量重算一次**的入口；这组依赖今天是 `RecordWriteService` 的**注入依赖类型声明**（`MT/record-write-service.ts:406-435`），实现由 `UM` 注入——"复用"= 复用同一组注入依赖，不是复用那段声明。
- **与 PIC 现有目标适配器的迁移事故（必须同批处理）**：`MT/records.ts:360-362` 的 SDK 写路径会**拒绝只读字段**。一旦把 system 列标 `readonly:true`，现有 PIC `metasheet:multitable` 目标适配器（走 `recordsApi.patchRecord`）**立刻写不进去** ⇒ 备料/pipeline 全断。所以：`upsertByKey` 是绕过该断言的**独立入口**，且 **PIC 适配器必须在同一批切换到它**（顺带解决 2N 往返：改为 `WHERE data->>key = ANY($1)` 一次取全批 + 分批 UPDATE/INSERT，旧逐行路径标 deprecated）。

**所有权/冲突（planner 泛化）**

- 决策词表不变：`add/update/skip/inactive/manual_confirm`（S0`:252-257` 同形）。
- **保留双锁**（planner 的 `assertNoHumanFields` + writer 的独立断言，`PIC/conflict-planner.cjs:750-756`、`PIC/apply-writer.cjs:187-196`）。原稿"改一致性断言"是**单锁化**，削弱 S0`:454` stop rule（"overwrites a human-owned field without an explicit field-ownership contract"）。允许两处从同一模板角色声明取值，但**不共享同一变量**。
- 新增 **fail-closed 未分类分支**：目标表上"无 `ownership` 且不在模板/`ext_` 命名空间"的字段 → planning/readiness **fail-closed**（S0`:199-200`："Any unclassified field must fail closed … A refresh must not overwrite a field merely because it exists on the target table"）。**不得**默认按 human 保留。写进 P1 验收。
- **K2 人工确认内核必须一起带过来**（原稿完全缺席）：`manual_confirm` 行若无人可解，这一档就是空的。K2 的机制点：`confirmedBy` = **路由身份**、`confirmedAt` = **服务端写**、**body 两者皆不可携带**、XOR 确认模式、create-only、`human_preserved` 结构性剥离、**8 类异常闭词表**（`missing_mapping / multi_candidate / version_conflict / erp_item_missing / unit_missing / unit_conflict / invalid_qty / missing_child_bom`）。来源：`docs/stock-preparation-existing-capability-overview-20260722.md:52-56,85`；`docs/stock-preparation-generalization-and-scenario-packaging-proposal-20260717.md:47`。
- **rekey（源侧业务键改值）**：今天会表现为"旧键 inactive + 新键 add"，**人填列与 link 全丢**。需要 rekey 通道或新增一类 `manual_confirm` 决策。列为 A1 的已知缺口，v1 至少要**检出并 hold**。
- **同一 sheet 多 binding**（备料主表既绑 PLM BOM 又绑 ERP 物料）：字段所有权按 binding 分区、两 binding 争同一列的 plan 冲突、刷新顺序与互斥——v1 **限制为每 sheet 最多一个 binding**，多 binding 列入 A2/A3。
- **binding 删除/停用与 sheet 删除的级联**：sheet 删除后 binding 残留、binding 删除后 system 列的降级时机——v1 规定：解绑 ⇒ `source_binding=null` + system 列**原地转 human**（清 `readonly`，冻结最后快照）；sheet 软删 ⇒ binding 自动 `revoked`。
- **记录锁 / 行级读权限 / 条件读规则的交互**：被用户锁定的行，sync **不覆盖**，进 `manual_confirm`（备料 writer 有 human 不碰断言但**无记录锁概念**）。

**调度与 apply 姿态（重大更正）**

- 新增自动化动作 `sync_from_source { bindingId, mode:'plan' }`。**删除 `plan_and_apply` 这一 mode** —— 它本身即"盲 apply"。FOS-4b-3 明写：apply 必须携带由**被委托动作的真实 dry-run** 产出的、绑定该次 plan 的 `dryRunToken`，缺/失配/过期 → fail-closed，且 **dry-run 与 apply 之间 target revision 变化 ⇒ token 失效**（`docs/data-factory-fos-4b-3-action-apply-design-lock-20260622.md:21`）；生产闸要求 `requireFreshDryRun=true`、`noScheduledOrBatchRollout=true`（`docs/data-factory-fos-4b-3-prod-apply-gate-design-lock-20260625.md:40,62-66`）。
- 因此：`sync_from_source` **只产 plan + token**；apply 永远是**第二个动作 / 人工两步**并消费该 token。
- 对 **approved-source 绑定**（备料 / K3 / 任何 GIP profile 绑定）：cron 触发**默认不可用**；要调度必须携带**有效期内的 owner 授权 id**。理由：S0`:302` "S0 does not authorize background polling, automatic inserts, automatic Apply"；delivery-plan`:68` "使用新的、不可复用的 operation id，并重新获得 owner 对只读窗口的明确授权"。对**租户自登记的普通 `data_source`** 是否放宽，同属 §6.4 ⑬ 的 owner 裁决。
- `integration_schedules`（零读者）退役或作为 cron 镜像。
- **pipeline-runner 的键传递必须改**：runner 恒定传 `keyFields:['_integration_idempotency_key']`（`PIC/lib/pipeline-runner.cjs:503,657`），与同步表的业务键冲突。让 pipeline 复用同步表 writer 需要改 runner 的键传递——这是 §4"泛化"格里此前漏掉的改动点。

**权限**

- **不复用审批投影降权**。`restrictApprovalProjectionCapabilities` 对非管理员把 **11 项能力全部置 false**，含 `canRead/canExport/canComment/canManageAutomation`（`MT/approval-projection-constants.ts:33-46`，注释自述"zero read/write/manage capability"），照抄会让普通用户**连表都看不见**——与同步表存在的理由相反。
- 新建 `restrictSyncedTableCapabilities`：deny 集合**限定** `canCreateRecord / canEditRecord / canDeleteRecord / canManageFields`，**显式保留** `canRead / canExport / canComment`；`canManageAutomation` 单独决策。**加测试断言其 deny 集合与审批投影不同**（防止后来者"顺手复用"）。
- 混合表（有 human 列）只锁 system 列，不做 sheet 级降权。
- 谁能建绑定：目标 base 的 manage + 连接的使用权；**approve 由非保存者执行**（请求方 ≠ 决定方）。
- **G10 前置**：`assertPluginOwnsSheet` 对未登记 sheet 返回 `false`（`MT/plugin-scope.ts:152-169`），而调用点 `assertSheetScope` **丢弃返回值**（`CB/index.ts:1848-1863`）⇒ 未登记 sheet 放行。修复成本一行，但必须在"同步到我的表"UI 开放**之前**落，否则集成管理员等于对任意表有写权。
- 连接凭据服务所有读者、**无行级安全下推** → 向导必须明示"此源无行级过滤，请用源视图/filters 裁剪"，行级读权限交给多维表（`meta_sheets.row_level_read_permissions_enabled` 已有）。

**UI（v1 values-free）**

sheet 设置"数据来源"面板：选连接（不透明 id）→ 选**已注册 preset/profile** → 服务端返回装配后的字段契约 → **values-free 预览**（列名/类型/计数/校验通过与否，**不出行值**，见 §2.0b）→ 确认 → 试跑 plan（只出计数与决策分布）→ 启用。字段编辑器"来源"页签（外部列、所有权、刷新时保留，只读展示）。表头 system 列锁徽标 + "最后同步/状态"条。解绑 = system 列原地转 human。
**注**：`/schema` 与 `/tables/:table` 是 GET，**`/select` 是 POST**（`CB/routes/data-sources.ts:864,917,954`）；且这三个端点返回**行值**，属平面 B —— v1 向导**不调 `/select`**。

**run 的可观测面**（原稿缺）：谁能看 run 历史；失败原因如何 values-free 呈现给非管理员（只给错误码 + 计数）；连续失败 N 次自动停用 + 告警；binding 的 `degraded`/`broken` 产品语义。

**复用清单**：`PIC/contracts.cjs` / transform-engine / validator / idempotency / watermark / dead-letter / run-log / payload-redaction（原样）；`PIC/extension-namespace.cjs`（仅改名）；`PIC/snapshot-diff.cjs` hash 工具；`PIC/audit-store.cjs:68-90` 的 `assertValuesFreeDetail` 结构门；`PIC/table-actions.cjs` 的 `createTargetScopedRecordsApi` + token store；`read-source-config` 的四种读模式与三张键表；`canonical-sheet-fence` / `record-history-service`；`RecordWriteService` 的同一组注入依赖（实现在 `UM`）。

**新建清单**：`meta_sheets.source_binding` / `source_last_run`；`meta_fields.source_ownership`（或受控 `property.source`）；`MT/source-binding.ts`、`MT/record-sync-service.ts`、`MT/synced-table-capabilities.ts`；PIC `lib/synced-table-{template,planner,apply-writer,actions,runner}.cjs`；`integration_synced_table_runs`；自动化动作 `sync_from_source`；路由 `POST /api/multitable/sheets/:id/source-binding[|/plan|/runs]`；SDK `records.upsertByKey`、`runUnitOfWork({sheetIds, lockKeys})`（替代硬编码恰好 4 个 sheetIds 的 `stock-preparation-persist-unit-of-work.ts:37-38`）。

### 2.2 原语 B：External Lookup Field / 外部查找字段（**整体后置到 H3-0 之后**）

**定义**：任意普通 sheet 上的一个字段，声明"按本表某键字段的值，到某连接的某对象里查一列，把值带回来"。只读、批量解析。

**分期（更正）**：lookup 字段渲染的就是**外部业务值**，即平面 B。H0 明写两把门（独立 value-read 权限、值面读审计动作）**当前都不存在**，H3-0 未落地前值面读一律不实现（`h0...:41-48`）。因此原语 B 的**产品化**排在 H3-0 之后（§5.4 P3+），v1 只做**契约与只读派生的骨架**且默认 OFF。

**如何挂进字段体系**：**不新造字段类型**——`FieldTypeRegistry` 后端确实可扩（`register → mapFieldType 保留 → sanitizeProperty 委派 → records.ts 用 customDef.validate`，`MT/field-type-registry.ts:1-7`；`field-codecs.ts:165,547-550`；`records.ts:283-286`；`CB/core/plugin-service-factory.ts:231-235`），但 `FieldTypeDefinition` **只有** `validate/sanitizeProperty/serialize/deserialize`（无渲染/编辑/筛选/聚合钩子），前端 `FIELD_TYPES` 硬编码（`MetaFieldManager.vue:949-953`）且 `MetaFieldType` 是**封闭联合**（`web/multitable/types.ts:6-36`），全仓**无插件调用** `fieldTypes.register`。→ 在现有标量类型上加受控的 `property.source`。

```
property.source = { mode:'lookup', connectorRef, actionProfileVersion, object|view,
                    keyFieldId, externalKeyColumn, valueColumn,
                    resolverRule:'exactly_one'|'first_when_sorted'|'field_equals',   // 必填
                    resolverSortDirection?, resolverDiscriminatorValue?,
                    ttlSec, staleness:'blank' }
```

- **`resolverRule` 必填**（原稿漏）：`PIC/lib/read-source-config.cjs:30-33` 明写"The default MUST NOT be 'take the first row' — resolverRule is REQUIRED"，`MODE_REQUIRED_FIELDS.resolver_lookup = ['keyField','containerPaths','resolverRule']`（`:47-51`），缺 `resolverRule` 的旧配置 fail-closed 无效。并规定 `exactly_one` 违约（多行/零行）时字段呈现 **blank + 错误码**，绝不取第一行。
- **执行面留在 PIC，不在 core 建语句缝**（重大更正）。GIP B1a 的 owner 决策 δ 明确："B1a admits connector-owned, NAMED, CERTIFIED HTTP probe actions only; SQL builders stay unreachable — that is the accepted v1 outcome, not a gap to work around"，且"The bounded CORE-BACKEND statement seam is NOT built here … ⟲OD3 (#4619) … is UNRULED … The fence is `plugins/plugin-integration-core/`"（`PIC/lib/gip-server-bound-source-executor.cjs:5-7,12-15`，亲读）。所以 resolver 的**执行**只经 PIC 的**已注册具名 action**（`read-source-config` 的 `resolver_lookup` 模式 + 认证 profile）；**core 只保留字段契约、只读派生与重算调度**。若确要建 core-backend 语句缝，作为独立 owner 门（引用 ⟲OD3/#4619）单列（§6.4 ⑭）。
- **缓存不落盘**（更正）：原稿的"先内存、后 `plugin_kv`"违反 H0`:36`"**值面结果不得进入日志 / telemetry / 共享缓存 / 错误消息**"。改为：**请求级 / 租户+角色隔离**的进程内缓存，缓存键与值不得出现在日志/遥测；或**不缓存**，每次经服务端投影解析并写值面读审计。
- 只读：由 `property.readonly=true` 承载（同 §2.1，无需新分支）；`connectorRef` 与 §2.1 同样是服务端专属、每次 resolve 二次校验 principal。
- 值物化：走派生路径（`applyFencedDerivedDataMerge`，`MT/derived-write-fence.ts:42-70`，不升版本、不写修订）——它是**可再生缓存**。
- 批量：facade `select` where 含 `$in`（`BaseAdapter.ts:33,83`），但 `DATA_SOURCE_MAX_ROWS=10000` 且 `limit>MAX` 直接抛 ⇒ 键列表必须**自行分批**。

### 2.3 原语 C：Inbound Push / 入站推送（已有，补治理）

**定义**：外部系统主动推数据进来——Open API `mst_` token（`POST /api/multitable/records`（`UM:16338`）、`PATCH /api/multitable/records/:recordId`（`UM:15198`）、`POST /api/multitable/patch`（`UM:17188`））与 `webhook.received` 触发器 → 自动化 `create_record/update_record`。这是今天**唯一**不写代码就能用的对接面，应作为第三种一等路径文档化。

**补治理（小刀、高价值）**：

1. **载荷插值**：`renderAutomationTemplate` 引擎已在（`MT/automation-executor.ts:204-208`），但**三处 `templateData` 只有 `sheetId/recordId/actorId/record`**（`:3662-3666, :4191-4195, :4802-4806` 亲读）——`trigger.*` 命名空间**今天不存在**。所以这不是纯接线：需**新增 `trigger` 命名空间**（含 `trigger.webhook.body`，webhook 载荷在 `MT/automation-service.ts:2396-2405` 的 `data/webhook.body`）+ 接到 `create_record.data` / `update_record.fields`。
   **且必须带字段白名单**：这两个动作的写是裸 UPDATE `data = data || jsonb` / 裸 INSERT，**不写 `meta_links`**（`:2289-2292, 2770-2788, 2395-2400`）。一旦载荷可插值进 `fields`，外部系统只要命名一个 link 字段 id 就能造出"有 `data` 无 `meta_links`"的记录，破坏 link 读路径与 mirror 反向读，并让 PIT/恢复的 link 完整性检查拒绝（`MT/exact-anchor-recovery-execute.ts:1110-1120`）。→ **拒绝 link 类型、拒绝 `isFieldAlwaysReadOnly` 为真的字段**；link 写入统一走 `buildNormalizedPatch`，或 v1 干脆不支持自动化写 link。
   **同时补 revision**：`create_record` 的裸 INSERT 不仅不过 codec，**也不写 revision** ⇒ PIT 缺口（记录在每个 T 都不可见）。P0 一并修。
   **兼容性**：给既有动作加插值 + codec 校验会**改变现存规则行为**（今天写脏类型的规则会开始失败）→ 需旗标或 config 级 `interpolate:true` 的兼容判定。
2. **按键定位与按键 upsert**：`webhook.received` 事件 `recordId:''`（`:2396-2405`），`trigger_config` **无 `matchField`**（`MT/automation-inbound-webhook.ts:3-11,66-96`）→ 增 `matchFieldId + matchExpression`。端点改为 **`POST /api/multitable/records:upsert`**（**不是** `/api/oapi/…`——该命名空间不存在；OAPI 面就是 `/api/multitable/*` + `apiTokenAuth/oapiScopeGuard/requireScope`）。**必须同批把新路由登记进 `MT/oapi-read-allowlist.ts:79-90` 的 `OAPI_WRITE_ROUTES`**（锚定正则、fail-closed），否则 token 请求在全局门就 401。请求体**只含** `{keyFieldIds, rows}`；`ownedFieldIds` **不接受请求提供**，由服务端从 binding 推导（§2.1）。
3. **集成身份**：token 增 `principal_kind:'integration'` + 显示名，审计落 `system:oapi:<tokenId>` 而非冒充 `createdBy`（`CB/middleware/api-token-auth.ts:70-84`）。**system 列的写：单一 fail-closed 规则** —— OAPI/webhook 路径对 `ownership==='system'` 的字段**一律拒写**，system 列只能由服务端绑定运行时写。（原稿"只允许来自绑定的同一 connector（或拒绝）"把关键判定留成开放项，且在"请求无可信输入"前提下无法判定 connector 同一性。）
4. **幂等与配额**：`Idempotency-Key` 头 + 已有写限速；补每 token 的行/分钟配额与 payload 上限。
5. **不新增 `fields:write` scope**（原稿说"仍不开"，但该 scope **今天并不存在**——`ApiTokenScope` 只有 6 个值，`MT/api-tokens.ts:24-38`）。保持"结构变更人工"。

### 2.4 v1 明确不做的

- **Live 虚拟表（直连外部库、可筛可排可改写）**：与零外部写、有界读（`DATA_SOURCE_MAX_ROWS=10000`）、围栏/修订/PIT/审批/行级权限/lookup-rollup 全部冲突。已死的 `CB/services/DataMaterializationService.ts`（零 importer，`CB/db/migration-provider.ts:92` 明文记录）是上一次尝试，**不复活**。
- **通用写回**：**v1 禁用**（不是"永久禁止"——原稿措辞过强）。开启需：独立 capability class + 独立认证/审批/审计轨（GIP-D0`:106`，`EXTERNAL_WRITE_TARGET` v1 禁用 `:134`）+ 新 issue + 新 operation id + owner 授权（delivery-plan`:24-26`）。
- **A2 关系同步表 / 多 binding / rekey 自动处理 / 跨源协调快照**（GIP-D0`:170-181` 的 `COORDINATED_SNAPSHOT` v1 不设）。
- **原语 B 的产品化**（H3-0 之前）。
- **core-backend 语句缝**（⟲OD3/#4619 UNRULED）。

---

## 3. 用户端配置业务系统：App Template 模型

### 3.1 把蓝图升格为数据

今天 after-sales 的 blueprint 是运行时由代码拼出的对象，templateId 白名单只有一个值，installer 手写校验；多维表 `template-library.ts` 是 8 个 schema-only 常量（类型只有 sheets/fields/views）。两者都装不了"自动化 + 角色 + 来源绑定"。

**`AppBlueprint`（zod，`CB/platform/blueprint-schema.ts`）**：

```
{ id, version, appId, displayName, category,
  objects: [{ id, name, backing, substitutable?, fields:[{id,name,type,property, ownership?, requirement?}], primaryViewId }],
  views: [...],
  links: [...],                       // A2 才启用；v1 校验器拒绝非空
  automations: [ 与 automation_rules 行 1:1：{ triggerType, triggerConfig, conditions?, actionType, actionConfig, actions? } ],
  approvals: [...], roles:[...], fieldPolicies:[...], notifications:[...],
  integrationBindings: [{ roleId,
      roleType:'EXTERNAL_READ_SOURCE'|'INTERNAL_APPLY_TARGET',      // GIP-D0:132-134 三类，v1 只用两类
      shape:'synced_table'|'lookup_field'|'inbound_endpoint'|'outbound_topic',
      canonicalObject, targetObjectId, fieldMapDefaults,
      requirementPredicate,          // 各模式的必要条件（GIP-D0:132-137 角色声明四要素）
      absencePolicy }],              // 可选角色的缺席/降级规则
  configSchema, configDefaults, navigation }
```

三点更正：

- **`automations` 必须与表结构对齐**：`automation_rules` 是"一行 = 一个 `trigger_type` + 一个 `action_type`（NOT NULL + CHECK）+ `action_config`"（`CB/db/migrations/zzzz20260413120000_create_automation_rules.ts:29-33,40-50`），`conditions/actions` 是后补的可空 jsonb（`zzzz20260414100000_extend_automation_rules.ts:24-27`）。蓝图若只声明 `actions[]`，installer 无法决定 `action_type` 写什么。→ 蓝图显式带 `actionType`，或先做一条迁移把 `action_type` 放宽为可空。**在 ST-0 设计锁里定死。**
- **`integrationBindings` 是角色声明 + 字段契约，不含连接/凭据**；并且必须带 `roleType` + `requirementPredicate` + `absencePolicy`（GIP-D0`:132-137` 的角色声明四要素）。
- **绑定的持久化形态是 owner 决策**：GIP-D0`:193` 要求 binding **版本化 + 审批**（`draft_candidate → preflight_passed → approved → superseded/revoked`，`active` 是指针派生谓词），`:237` 把"客户 Binding + 版本化审批"列为实施序第 5 项。原稿把它落成 `platform_app_instances.config_json.bindings`——**无版本、无审批的自由 JSON**。→ 方案 A（v1 用 config 语义，接受降级）/ 方案 B（有版本、有 approve 记录的绑定表）列为 **owner 决策 ③**，不由本文自裁。

**BindingQualification 整层（原稿完全缺席，必须补）**：GIP-D0`:79-94` 定义 qualification 为 **server-generated / values-free / input-bound / 可过期 / 客户不能提交或复用**；`:155-166` 定义时序——**probe 只在 Preflight 且事务外**；**Activate 与 Run-start 只做纯本地 verify**；**资格过期 ⇒ fail-closed `QUALIFICATION_EXPIRED`，须重新 Preflight**。代码侧 spike 已存在（`PIC/lib/gip-binding-qualification-spike.cjs`）。→ `source_binding` 不能只有 `approve`：需 **qualification digest + run-start 重验 + 过期 fail-closed**。
并补 GIP-D0`:123`：**Preflight 只能提前发现问题；运行时仍须对完整快照重新验证**——plan→apply 之间除 dryRunToken + revision fence 外，还要有对**完整快照**的重验语句。

**其他必补的 GIP 语义**（原稿缺席）：
- **`modeAvailable` / 逐角色缺口 UI**（`:139-153,168`）：能力非线性等级，**禁止 `min()` 归约**，按 `roleType` 分流判定，内部落库目标不套 read profile；UI 展示**逐角色缺口**，双向不静默。
- **跨角色时序政策**（`:170-181`）：冻结词表 `DISCLOSE_ONLY / MAX_CAPTURE_GAP / COMMON_EFFECTIVE_CUT / COORDINATED_SNAPSHOT`（v1 不设 coordinated）。CRM/售后模板同时绑多个源时必须声明其一。
- **预算合法域**（`:210`）：`binding 预算 ≤ min(profile 认证上限, 租户配额)`，preflight 校验。不能只有 `DATA_SOURCE_MAX_ROWS` 单点上限。
- **逐字段 requirement 类**（`:116-121`）：每字段冻结 `ALL_ROWS_REQUIRED / NON_EMPTY_WHEN_PRESENT / OPTIONAL` + 标准化规则 + 类型 + 闭词表映射 + 身份键唯一性；并注意 `assertEveryConfiguredFieldResolved` 的"≥1 行出现过"语义**不可直接泛化**。`fieldMap` 不能只是列对列。

**表与服务**：`app_templates` / `app_template_versions`（blueprint JSON + content-key + changelog）/ `app_template_installs`（**含 `id_map jsonb`**，见 §3.2）；`CB/services/BlueprintInstallerService.ts`（搬 `AS/lib/installer.cjs:468-620` 的步骤，自动化改**原生可执行** rule，插件只留 pre/post 钩子）；`BlueprintExportService`（反向导出，见下）。

**反向导出 `POST /api/multitable/bases/:id/export-blueprint`**（"先在多维表里搭、再一键变模板"，CRM 的主要生产方式）——**必须处理环境相关 id**：自动化 `action_config` 里的钉钉 destination id、审批模板 id、通知 topic、webhook 目标、`targetSheetId/targetBaseId` 一律改写成蓝图**相对角色/占位符**，否则导出的模板一装即指向源环境。

### 3.2 目录 + 安装向导 + 版本升级 + 客户差异 + 运行时管理

- **目录**：**扩展现有模板中心**，不新建。后端 `GET /api/multitable/templates`（`UM:6894`）、`install`（`:6898`）、`dry-run`（`:6992`）与前端 `MultitableTemplateCenterView.vue` / `MultitableTemplateDetailView.vue`（`appRoutes.ts:145-156`）**已存在**；把 app 蓝图与 PIC `integration_templates` 引用**并入同一目录**（新 `GET /api/templates` 若要存在，需明确与既有路由的合并/共存关系，建议**直接扩展既有路由的返回体**，不新增命名空间）。
- **安装向导**（GIP-D0`:224` 基础五步）：① 选模板/版本 + 实例名 + `configSchema` 表单；② **绑定角色**：逐 `integrationBindings` 选连接（不透明 id）+ 选已注册 preset；`optional` 角色按 `absencePolicy` 跳过；③ **确认服务端装配的映射**（values-free）；④ provisioning（每实例独立 base + `instanceKey`，见下）；⑤ **Preflight**：逐角色跑一次 qualification probe（**事务外**）并**逐角色**显示"基础同步可用 / 增量可用 / 无法证明完整性"（**不做 `min()` 归约**）；⑥ 启用（Activate 只做本地 verify）。
- **多实例的真正阻塞是 id 派生，不是 base**（更正）：`projectId = getProjectId(tenantId, appId)`（`AS/lib/installer.cjs:449`）+ `stableMetaId(projectId, objectId[, fieldId])`（`MT/provisioning.ts:129-148`）⇒ 同租户第二实例撞同一批 id、写进同一张表；且 `mode=enable` 且已存在直接抛 `ALREADY_INSTALLED`（`:433-437`）。→ **把 `instanceKey` 纳入 `getProjectId`**，legacy 实例固定 `instanceKey='default'` 以保持既有 id **byte-identical**；installer 模式改 `install(instanceKey)/upgrade/reinstall`；**加 legacy id parity fixture**。该项从"待定决策"提升为 **P2 前置任务**。
- **安装时替换（substitution）落点更正**：仅在 blueprint 上加 `substitutable:true` **解决不了**——稳定 id 契约是"蓝图逻辑 id → 派生物理 id"，而替换成已存在的用户表意味着物理 id 与派生值无关，所有 installer 路径今天直接用派生函数取 id（`AS/lib/installer.cjs:461-470`）。→ `app_template_installs` 增 **`id_map jsonb`**（logicalObjectId/logicalFieldId → 物理 id），provisioning 与升级 diff 全部**改为查 map、缺失才派生**。**必须在第一个蓝图安装落地前做。**
- **版本升级**：`diff(installed, target)` → **仅 additive**（新对象/新字段（`CB/index.ts:648-662` 的加性-only rung 已存在）/新视图/新自动化 upsert/角色合并/新绑定角色提示"待绑定"）；**禁止** drop/alter/覆盖用户改过的字段名与选项——今天 `ensureFields` 的 `ON CONFLICT (id) DO UPDATE` 会覆盖 name/type/property/order（`MT/provisioning.ts:305-321`），**升级"只加不覆盖"必须改写该函数**。
- **客户差异如何存活升级**：蓝图字段 id 由 sha1 稳定派生；客户新增列走 `ext_` 前缀；客户新增视图/自动化不在蓝图 id 空间；客户对蓝图字段的**名称/选项**改动视为实例覆盖层（升级只动缺省项，不动 name）。与源字段同名的本地字段**拒绝创建**而非静默。
- **运行时管理**（通用页替代 `AS/lib/runtime-admin.cjs`）：自动化开关、字段策略矩阵、绑定状态/最后同步/手动刷新（values-free）、配置参数、升级按钮。
  **硬前置**：`plugin_field_policy_registry` 今天**由 after-sales 自己读**（`AS/lib/field-policies.cjs:87-90`，调用点 `:261`、`AS/lib/runtime-admin.cjs:137`），但**多维表网格从不读它**。因此"把 after-sales 对象暴露到通用多维表壳"之前，`fieldPolicies` **必须**先落原生 `field_permissions`，并加集成测试断言——否则财务列对客服可写/可见，是**本方案引入的回归**。

### 3.3 三个域如何映射

| 维度 | 备料 stock-prep | CRM | 售后 after-sales |
|---|---|---|---|
| 今天 | 无 manifest；冻结模板 + approved read-source config + table-action；安装散在三路由 | 仅 `sales-crm` **单表** schema 模板，`account/contact` 是普通 string 字段、**零 link**（`MT/template-library.ts:147-173`） | 完整 manifest+blueprint.cjs+installer(752 行)+runtime-admin+**5964 行** `web/views/AfterSalesView.vue`；`integrations[crm-sync, erp-warranty]` 零实现 |
| objects | 冻结主表（代码里 9 个必备 system + 8 个 human 白名单；客户实例模板另有更多 plm_system 列）+ MVP 九表；`ext_` ≈20 列（客户 #1） | accounts / leads / contacts / deals / activities（**v1 全部标量同步表或普通表，link 手工建**） | serviceTicket / installedAsset / … 从 `AS/lib/blueprint.cjs` 序列化 |
| integrationBindings | `plmBom`（synced_table，`actionProfileVersion` = 待认证 profile 候选 → 主表）、`erpMaterial`（synced_table → 物料字典表）、`dingtalkTodo`（outbound_topic ×6）。**`k3Stock` lookup 后置到 H3-0 之后** | `erpCustomerMaster`（synced_table 只读 → accounts 的 system 列，可选）、`webLeadInbound`（inbound_endpoint：官网表单 webhook → leads，含插值 + 按手机号 matchField）、`imNotify`（outbound_topic）。**`erpCredit` lookup 后置** | `crmAccount`（synced_table 或 substitution = 复用 CRM 的 accounts）、`dingtalkApproval`（outbound_topic + `start_approval`）。**`erpOrderSerial` lookup 后置** |
| automations | 刷新后通知部门、缺子 BOM 异常进待办（**K2 八类异常闭词表**）、备料单 `start_approval` | 阶段变更通知、逾期跟进（`schedule.date_field`）、新线索分配 | 工单 SLA、退款审批、逾期 webhook |
| roles/fieldPolicies | 设计/采购/仓库/PMC/管理员；system 列全员只读（原语 A 天然给）；human 列按部门 | 销售/销售主管/管理员；金额列 | 客服/技术/财务；`refundAmount` 矩阵（**必须先落 `field_permissions`**） |
| 留在代码 | BOM 展开、物料匹配、单位规则、生成/异常、**大 BOM 作业**（GIP-D0`:241` 业务安全规则不可配置化） | **零插件代码**（首个纯数据蓝图验证） | **v1 不迁 UI**：`AfterSalesView.vue`（5964 行）留在插件；只把安装/权限/自动化换成通用件。UI 通用化标 P4+ |

**通用基础设施 vs 每模板内容**：基础设施 = 原语 A/(B)/C + 蓝图 schema/表/installer/导出/升级 + 绑定向导 + qualification + 通用壳（改造**已存在**的 `web/views/PlatformAppShellView.vue` 与 `MultitableEmbedHost.vue`）；每模板内容 = objects/views/automations/roles/notifications/integrationBindings 声明 + 可选 profile/算法动作。客户差异 = 连接、绑定、`ext_`、字典行、角色成员、通知规则、参数——**全在数据**。

---

## 4. 与当前在做的线的关系与姿态继承

| 既有线 | 原样复用 | 泛化 | 留下不动 |
|---|---|---|---|
| PIC 通用 pipeline | 合同/registry/transform/validator/idempotency/watermark/dead-letter/run-log/provenance；source 适配器；`integration_templates` instantiate 单事务原子（`PIC/integration-templates.cjs:376-386,470-472`） | `metasheet:multitable` 目标 → 改走 `upsertByKey` 批量写（消灭 2N 往返）；**runner 的 `keyFields` 传递必须改**（`pipeline-runner.cjs:503,657` 恒定传幂等键）；目标空间**不是"任意 sheet"**，而是"binding 已 approve 且目标在该 binding 授权 `targetKind` 内的 sheet"（生产闸`:74` "must not permit arbitrary non-canonical targets"） | ETL 型 pipeline 保留给 staging/清洗 |
| 备料 stock-prep 线 | `extension-namespace`、`snapshot-diff`、`audit-store` 结构门、`createTargetScopedRecordsApi` + token store、approved read-source config 存储模式、冻结模板（作为第一个模板实例） | templates→`synced-table-template`（ownership 改名保留旧名别名 + 冻结模板 byte-parity）、conflict-planner（**保留双锁** + 新增未分类 fail-closed）、apply-writer、table-actions、target-provisioning、**K2 确认内核** | `bom-expansion`、物料匹配、单位规则、生成/异常、MVP 九表、**large-BOM checkpoint 路由**、sealed-export |
| FOS-4b-3 动作/apply 线 | dryRunToken 语义、per-row 隔离、dead-letter 收口、凭据只经 credential store、values-free evidence | — | **§3a owner 推荐"复用 stock-prep apply-writer、零新写路径"**（`docs/...action-apply-design-lock-20260622.md:33`）。→ **本设计不与之冲突的定位**：`upsertByKey` **不是** FOS-4b-3 的 generic apply writer，而是**多维表新原语自己的写门**；**备料动作线 v1 不切换**到它（ST-7 押后，须先证明 dry-run/apply 零漂移 + byte-parity）。若 owner 要求合并，则须重开 §3a |
| 通用对接 lock S5 / GAP-6 | "吸收进通用 table-action seam、`apply_to_target_table` latent kind"（`docs/generic-integration-design-lock-20260618.md:30,53`） | 本文 §2.1 = S5 的可执行拆解；**需 owner 对 S5 重新排期**（`:75` 裁"低优先、渐进吸收、短期不重写专用链路"） | S1a/S1b 写 profile 形态；C6 Save-only；K3 红线 |
| GIP-D0 | 四层语义、可配/禁配清单、角色声明形（`:132-137`）、基础模式向导（`:224`）、**`actionProfileVersion` 词表**（`read-source-config.cjs:288` 已用同一 `isValidProfileId`） | `source_binding` = Customer Binding 的多维表投影（字段集与 `:187` 客户可配清单同形）；`integrationBindings` = Scenario 角色声明进蓝图 | **16 个 `gip-*.cjs` 已是 latent 一方实现**（profile 认证契约/合规 harness/approved-binding resolver/qualification spike/`bridge.bounded_read.v2`/server-bound executor/SQL Server 快照策略），缺的是 **runtime wiring 与多维表消费面**。→ **不新造 `readerPreset` 词表**（GIP-D0`:191` "两种对象、两套已定语义，不发明第三套"） |
| after-sales 线 | installer 步骤、Shell 安装协议、`platform_app_instances`、`applyRoleMatrix`、notification topic 表 | blueprint.cjs → JSON；自动化改多维表原生 rule（`plugin_automation_rule_registry` 退役或作镜像） | **UI 不迁（v1）**；域专属页面与真正的业务逻辑 |
| 多维表先例 | People 目录 / 审批投影 / 备料 ownership 作为三次验证 | 迁到 `source_binding` + `upsertByKey`（People 整段裸 SQL 可删成一次 upsert） | 审批投影的 revision-exempt 与**零能力降权**保留（它确实要"零读"档位） |

**冻结姿态如何带进原语**：

- **零外部写**：契约里**不设**写语义键位；`WRITE_SHAPED_KEYS` 拒绝表 + **闭合顶层键白名单**（`read-source-config.cjs:58,60-63,66`）；lookup 字段只读；K3 红线不动。
- **values-free**：绑定/蓝图存储拒 `FORBIDDEN_CONTENT_KEYS`（主干 `PIC/lib/material-reconciliation-templates.cjs:197`、`reference-integration-templates.cjs:25`）；审计过 `assertValuesFreeDetail`（`PIC/audit-store.cjs:68-90`）。
  **新增结构必须区分两个面**：`integration_synced_table_runs` / `source_last_run` 默认会携带 `sheetId`、`fieldId`、外部 object 名，而 FOS-4b-3 与 S0 把这些明确列为**禁止出现在证据**的内容（`action-apply:27,55`；`prod-apply-gate:123`；`S0:396,158-160`）。→ **租户内私有运行态**（可含 sheetId/fieldId）与**公开/issue 证据面**（只出计数、错误码、opaque hash）分离；公开 GET 与任何导出必须过同型结构门 + 漂移测试。
- **fail-closed**：未 approved / qualification 过期的绑定不可运行；合成 actor 只由服务端 mint；未注册 profile/connector kind → 422；G10 钩子。
- **默认 OFF**：`MULTITABLE_SOURCE_BINDING_ENABLED`、`MULTITABLE_SYNC_ACTION_ENABLED`、`MULTITABLE_EXTERNAL_LOOKUP_ENABLED`、`PLATFORM_APP_TEMPLATES_ENABLED`（`trim().toLowerCase()==='true'` idiom；OFF 时路由不注册、byte-identical；登记 ledger + `health/capabilities`）。**另加前提**：`MULTITABLE_ENABLE_WRITER_FENCE=true`。
- **自动 apply 恒关**；**请求方 ≠ 决定方**（approve 由非保存者执行）。
- **重冻结**：`PIC/lib/http-routes.cjs` 的"一次重冻结窗口"是**流程约束**（仓内未见 digest/freeze 门；只有一条结构性 parity 断言，`PIC/__tests__/k3-save-body-composer.parity.test.cjs:173`），本文按流程约束处理，**不作为代码事实陈述**。

---

## 5. 分层落点、新增清单、迁移、规模、P0–P3 与验收

### 5.1 分层

| 层 | 新增 | 名字 |
|---|---|---|
| **core / multitable** | sheet 绑定列、**服务端拥有的字段 ownership**、同步写路径（分批）、服务端 mint actor、`sync_from_source`、`trigger.*` 插值命名空间、webhook matchField、按键 upsert（+ `OAPI_WRITE_ROUTES` 登记）、同步表降权、G10 钩子 | 迁移 `..._add_meta_sheets_source_binding.ts`（`source_binding`/`source_last_run`）+ `..._add_meta_fields_source_ownership.ts`；`MT/source-binding.ts`、`MT/record-sync-service.ts`、`MT/synced-table-capabilities.ts`；`MT/field-codecs.ts` 跨切面链加 `source`；`MT/automation-actions.ts` + `automation-executor.ts`（`trigger` 命名空间 + 字段白名单 + create 补 revision）；`MT/automation-inbound-webhook.ts`；`MT/oapi-read-allowlist.ts` 增写路由；`MT/plugin-scope.ts` + `CB/index.ts:1860-1863` 修返回值丢弃；SDK `records.upsertByKey`、`runUnitOfWork` |
| **core / platform** | 蓝图 schema、模板表（含 `id_map`）、通用 installer、导出（占位符化）、升级 diff、`instanceKey` 进 `getProjectId` | `CB/platform/blueprint-schema.ts`；迁移 `app_templates/app_template_versions/app_template_installs`；`BlueprintInstallerService/ExportService/UpgradeService`；**扩展**既有 `UM:6894/6898/6992` 与模板中心页，不新建命名空间；`MT/provisioning.ts` 支持非 legacy base + 查 `id_map` + `ensureFields` 改"只加不覆盖" |
| **core / data-adapters** | **`assertAccess` 用上已存的 `workspaceId`**（一处，`DataSourceManager.ts:380-390`）；`binding:<id>` 主体类型（facade）；Bearer 键名修复；**在既有 tokenProvider 缝上补 client-credentials 实现 + 配置持久化**（缝已存在：`HTTPAdapter.ts:122-125,171-175,197-198,317-318`） | 同左 |
| **plugins / PIC**（执行层，围栏在此） | Synced Table 引擎（ST-1..ST-3）+ K2 确认内核 + qualification 接线 + 绑定运行记录 + 调度回调 + 目标适配器批量化 | `lib/synced-table-{template,planner,apply-writer,actions,runner,confirm}.cjs`；`integration_synced_table_runs`；路由收敛为**一个新文件、一处 require** |
| **plugins / 各域** | after-sales：blueprint JSON + pre/post 钩子（**UI 不迁**）；stock-prep：`app.manifest.json` + blueprint JSON + profile 候选 + 算法动作；CRM：无插件 | `AS/blueprint.json`；`PIC/app.manifest.json`、`PIC/blueprints/stock-prep.default.v1.json` |
| **apps/web** | sheet 来源面板、字段来源页签（只读）、锁徽标/同步状态条、自动化编辑器新动作分支（逐动作硬编码配置块，`MetaAutomationRuleEditor.vue:365,384-385,447`）、**扩展**模板中心 + 安装向导（绑定/映射/预检步）、**改造**已存在的 `PlatformAppShellView.vue`、运行时管理页、Workbench "选我的表" | `web/multitable/components/MetaSheetSourceBindingPanel.vue`、`MetaFieldSourceTab.vue`、`MetaSyncStatusBar.vue`；`TemplateInstallWizard.vue`；`AppRuntimeAdminView.vue` |

### 5.2 迁移需求

- `meta_sheets.source_binding`、`source_last_run`；`meta_fields.source_ownership`（服务端专属列）。
- **`automation_rules` 的 CHECK 约束放宽**（原稿漏）：`trigger_type` 与 `action_type` 都有 DB 级白名单 CHECK（`zzzz20260413120000:40-50`，`zzzz20260414100000:29-59` 扩展），本仓惯例是**每加一个动作写一条迁移**（先例 `zzzz20260611120000/zzzz20260614120000/zzzz20260705150000/zzzz20260720120000`）。→ 补 1 条（合并三动作）或 3 条，并决定 `action_type` NOT NULL 与新 `actions` jsonb 的取舍。
- `app_templates / app_template_versions / app_template_installs`（**含 `id_map jsonb`**）。
- **`multitable_api_tokens.principal_kind`**（表名是 `multitable_api_tokens`，不是 `api_tokens`——`CB/db/migrations/zzzz20260414100002_create_multitable_api_tokens_and_webhooks.ts:7`）。
- `integration_synced_table_runs`（或复用 `integration_runs` + `kind`）。
- **部分表达式唯一索引**（每个启用 binding 的 sheet 一条，见 §2.1 并发）。
- `data_sources.tenant_id`：**降级为可选**——G2 的最小落点是 `assertAccess` 用上 `workspaceId`（`DataSourceManager.ts:380-390`），不必先加列。
- 数据迁移：People 目录 → `source_binding{connector:'internal:users'}`；审批投影 → `system_kind` 保留 + `source_binding`；备料主表 `property.stockPreparation.ownership` → 服务端 ownership 列（双写一个版本）；after-sales 安装账本 → `app_template_installs`（并写 `id_map`，legacy `instanceKey='default'`）。

### 5.3 规模（感受值，置信 ≈0.45；**不含** owner 门等待与重冻结窗口）

| 块 | 人周 |
|---|---|
| **连接主体模型**（facade `binding:<id>` + `assertAccess` 修 + 负控） | 0.5–1 |
| P0 小刀：`trigger.*` 插值（含字段白名单 + create 补 revision + 兼容旗标）+ webhook matchField + 按键 upsert（含 `OAPI_WRITE_ROUTES` 登记）+ 集成 actor（服务端 mint + 四处认） | 1.5–2 |
| 原语 A core（绑定列/服务端 ownership/不可伪造性/`upsertByKey` 分批+advisory lock+唯一索引/事件/**批量重算入口**/SDK） | 3–4 |
| **原语 A 引擎泛化 + parity 回归**（待泛化的备料内核实测 3,492 行冻结纯函数：conflict-planner 964 + apply-writer 584 + templates 889 + table-actions 1055，外加 byte-parity fixture 门） | **4–6** |
| **K2 确认内核泛化**（confirmedBy/At 服务端、XOR、create-only、8 类异常闭词表） | 1–1.5 |
| **BindingQualification 层**（digest/preflight/run-start 重验/过期 fail-closed/逐角色 modeAvailable UI） | 1.5–2 |
| 原语 A UI（来源面板/字段页签/徽标/状态条/Workbench 选表，values-free） | 2 |
| `sync_from_source` + 调度回调 + G10 钩子 + `automation_rules` 迁移 | 1–1.5 |
| PIC 目标适配器批量化 + runner keyFields 改造 | 1 |
| 原语 B 骨架（契约 + 派生接线，**产品化后置**） | 0.5（骨架）/ 1.5–2（H3-0 后） |
| 蓝图 schema + 表（含 `id_map`）+ 通用 installer + 导出（占位符化）+ `instanceKey` 进 `getProjectId` + legacy parity fixture | 3–4 |
| **link provisioning 抽服务**（mirror 配对 + `foreignSheetId` 校验从路由抽出） | 1–2 |
| 通用壳改造 + 安装向导（绑定/映射/预检）+ 运行时管理页 + **fieldPolicies → `field_permissions`** | 3–4 |
| 升级 diff（additive，含 `ensureFields` 改写）+ 覆盖层语义 | 1–2 |
| CRM 纯数据蓝图（手搭 → 导出 → 入库 → 安装验收，**标量 + 手工 link**） | 1 |
| 备料包装（manifest/blueprint/profile 候选/薄包装 ST-7） | 3–4 |
| after-sales 迁移（blueprint JSON、自动化映射；**UI 不迁**） | 1.5–2 |
| 三先例迁移（People/审批投影/备料 ownership） | 1 |
| **合计** | **≈ 28–40 人周**（可并行 3 条线：multitable core、PIC 引擎、platform/web） |

### 5.4 阶段计划与验收

> **前置条件（本表全部阶段阻塞于此）**：① 新 issue / charter + 新 operation id + 独立 owner 授权（`delivery-plan:24-26`）；② S5 重新排期（`generic-integration-design-lock:75`）；③ GIP-D0 范围裁决（`gip-d0:247` 仅解锁三件）；④ §2.0d 连接主体模型裁决；⑤ `MULTITABLE_ENABLE_WRITER_FENCE` 开旗标决定。**未过门不开工。**

| 阶段 | 内容 | 正向验收 | **负控验收（缺一不可）** |
|---|---|---|---|
| **P0（2–3 周）小刀 + 设计锁** | `trigger.*` 插值（+字段白名单 +create 补 revision +兼容旗标）；webhook `matchFieldId`；`POST /api/multitable/records:upsert` + `OAPI_WRITE_ROUTES` 登记 + 集成 actor；ST-0 设计锁（binding 对象/闭合键白名单/不变式/旗标名）+ AppBlueprint schema 草案 + owner 门清单提交 | "官网表单 webhook 推一条 JSON，自动化按手机号 upsert 进 CRM leads 表，字段值来自载荷，写 revision，重放不重复"；"脚本用 token 按客户编码 upsert 500 行，只改声明列，审计主体为集成 token 而非创建者" | 载荷里放 link 字段 id → 拒；放公式/lookup/rollup/mirror 字段 id → 拒；请求体带 `ownedFieldIds` → 拒；未登记进 `OAPI_WRITE_ROUTES` 的新路径 → 401；请求/规则里出现 `system:` 前缀 actor → 拒 |
| **P1（8–10 周）原语 A1 最小闭环** | core 绑定列/服务端 ownership/`upsertByKey`（分批+advisory lock+唯一索引）/`sync_from_source`（**只 plan**）/事件+批量重算；PIC ST-1..ST-3 + K2 + qualification；连接主体模型；G10 钩子；来源面板 + 字段页签 + 徽标；People 目录迁移 | "一张用户自建的客户表绑到 SQL Server 视图：选连接→选 preset→**values-free 预览**→选键→生成 system 列→plan 显示 add/update/skip/inactive/manual_confirm 计数→**人工两步 apply（凭 dryRunToken）**→网格 system 列灰显不可改、human 列可改并在下次刷新后保留、`ext_` 列不动；**cron 只自动 plan**；PIT 能看到 sync 修订；解绑后 system 列变普通列"；"People 目录经 `upsertByKey` 结果与旧实现逐行一致" | **无 token apply → 拒**；**token 失配/过期/target revision 变化 → 拒**；目标不在 binding 授权 targetKind 内 → 拒；qualification 过期 → `QUALIFICATION_EXPIRED` fail-closed；目标表存在**未分类字段** → planning fail-closed；同 binding 两次 apply 并发 → 无重复行；写 human 列 → planner 与 writer **两处**各自拒；证据面不含 sheetId/fieldId/值/token |
| **P2（8–10 周）App Template** | 蓝图表（含 `id_map`）/installer/导出（占位符化）/`instanceKey`；扩展模板中心 + 向导（绑定/映射/**逐角色 preflight**）+ 运行时管理；**fieldPolicies → `field_permissions`**；CRM 纯数据蓝图（标量 + 手工 link）；after-sales blueprint JSON 化（**UI 不迁**）；升级 diff additive | "CRM 模板零代码安装：目录→参数→把 `erpCustomerMaster` 绑到 SQL Server 视图→确认映射→**逐角色**预检→启用；安装后 accounts 是同步表、leads 入站 webhook 可用、阶段变更通知生效、角色矩阵落 RBAC、独立 base；**同租户再装一次为第二实例互不干扰**；发布 v1.1 新增字段后升级只加不覆盖用户改名"；"after-sales 用通用 installer 安装，`after-sales-plugin.install.test.ts` 绿" | **legacy id parity fixture**：`instanceKey='default'` 产出的 sheet/field id 与今天 **byte-identical**；升级尝试 drop/rename 蓝图字段 → 拒；after-sales 对象在通用壳可见时 `refundAmount` 对客服**不可写不可见**（集成测试断言）；导出的蓝图不含任何环境 id |
| **P3（6–8 周）备料上模板 + 先例收敛** | `PIC/app.manifest.json` + blueprint + profile 候选 + ST-7 薄包装 + 审批/钉钉 topic + 备料 ownership 迁移 + 审批投影迁移；Workbench"选我的表"；C6/table-action token 合一 | "备料客户 #2（或同客户第二套测试环境）**在 owner 为该客户单独授权的只读窗口内、使用新 operation id**，仅靠：登记连接 → 安装模板 → 绑定角色 → 审批 → 只读 smoke 上线；仓库零提交；audit 零外部写；主表 system 列在网格里不可改" —— **本项不构成通用集成平台完成声明**（`delivery-plan:74-75` `CONTROLLED_TEST_ONLY_FUNCTIONAL_DRY_RUN`） | 备料 table-action 经新内核产生的 plan 与冻结 fixture **byte-parity**；**首笔真实执行按 sandbox-first 序列**：多样本只读 dry-run → sandbox apply → **re-pull 幂等 + 人工保留字段验证** → 生产（`action-apply:25`；`generic-integration-design-lock:39`）；**回滚/恢复计划齐备**（values-free run id 识别、pre-apply 计数、逐行结果保留、新建行如何反转或置 inactive、失败行/死信 values-free 复核、apply 后 re-pull 幂等复核、至少一行人工保留字段验证——**即使预期全是 add 也必须有回滚证据**，`prod-apply-gate:149-162`）；**large-BOM 双入口路由平价重新证明**（`S0:268-269`；`prod-apply-gate:80-89`） |
| **P4+（门后）** | 原语 B 产品化（H3-0 + OD-W3-1 + #4194 之后）；A2 关系同步表 + link 同步键解析层；after-sales UI 通用化；多 binding / rekey 通道 | — | — |

---

## 6. 风险、反对意见、替代方案、owner 决策点

### 6.1 风险

| # | 风险 | 缓解 |
|---|---|---|
| 1 | core 改动面（permission-derivation / fence / cross-base authority / executor）触碰多维表不变量 | 全部旗标默认 OFF；**以 `MULTITABLE_ENABLE_WRITER_FENCE=true` 为前提**（否则围栏缓解无效）；`upsertByKey` 必带修订；先迁 People 目录做低风险验证 |
| 2 | **字段 ownership 可伪造**（`property` 客户端可写）→ 用户自行解除只读；`connectorRef` 可改指别人的 `data_source` → **跨 owner 读越权** | ownership 提为服务端专属列/受控键；`connectorRef` 建绑定时授权、每次 resolve 二次校验 principal；失败进 broken 态返回空值 |
| 3 | **标只读 → 备料/pipeline 全断**（`MT/records.ts:360-362` 拒写只读字段，PIC 适配器走 `patchRecord`） | `upsertByKey` 是独立入口；PIC 适配器**同批切换**；迁移前跑 pipeline 全量回归 |
| 4 | 插件 records API 权限缺口（G10）在"同步到我的表"开放前未补 → 集成管理员等于对任意表有写权 | P1 前置；`CB/index.ts:1860-1863` 修返回值丢弃 + 校验绑定存在/租户一致/目标 base 可写 |
| 5 | 单事务 10k 行长持整表写锁，阻塞全部用户写 | 200–500 行/批的 fenced 短事务 + `lastAppliedCursor` 断点续跑 |
| 6 | 业务键无唯一约束 → cron/手动/OAPI 并发造重复行 | binding 级 advisory lock + 部分表达式唯一索引 + 建绑定时重复检测拒绝启用 |
| 7 | 同步表发 `record.*` 引发自动化风暴/环 | `_automationDepth` 上限（`MT/automation-service.ts:2409-2414`）+ **绑定级 `emitEvents` 需新造**（今天 `handleEvent` 只要 `sheetId && recordId` 非空即派发，`:2415-2417`；审批投影的"事件静默"是靠**根本不调用** automation，不是开关）+ 环检测；v1 默认 `emitEvents:false` |
| 8 | 蓝图自动化 ↔ 多维表自动化语义鸿沟（`ticket.created` vs `record.created`） | CRM 先证明原生 rule DSL 足够；after-sales 迁移时把 hybrid 对象事件映射为 `record.created(sheet=serviceTicket)`；留 pre/post 钩子 |
| 9 | 泛化 planner/writer 破坏备料冻结 fixture（3,492 行冻结纯函数） | 旧名别名 + byte-parity fixture 门 + 薄包装（FOS-2 先例）；ST-7 押后 |
| 10 | **fieldPolicies 未落 `field_permissions` 就把对象搬进通用壳** → 财务列对客服可见可写（本方案引入的回归） | 设为硬前置 + 集成测试断言 |
| 11 | 多实例 id 撞车（`getProjectId(tenantId, appId)` + `stableMetaId`） | `instanceKey` 进 `getProjectId` + legacy `'default'` + byte-parity fixture，**P2 前置** |
| 12 | 值面泄漏（向导预览/lookup/run 证据） | v1 预览 values-free；lookup 后置 H3-0；run 分私有态/公开证据面 + `assertValuesFreeDetail` 同型结构门 + 漂移测试；缓存不落盘 |
| 13 | 工作量低估 | 已按实测行数上调（内核泛化单列 4–6 人周）；三线并行 |
| 14 | 配置化被误读为"写回/常开/通用平台已成熟" | charter 明写；契约无写面；自动 apply 恒关；P3 验收带反声明 |
| 15 | 未读/未核 | 见 §7.3 |

### 6.2 反对意见与回应

- **"全部留在插件，core 不动"**：执行层确实该留 PIC（GIP B1a 的围栏就是 `plugins/plugin-integration-core/`）。但"系统可写、人只读"的**不可伪造**字段档位、带修订+事件+重算的写路径、服务端 mint 的集成身份、非伪造的绑定标记**只能在 core 做**。**更正原稿的论据**：插件 SDK 路径**已有** fence/operation/version/revision + 只读字段拒写（`MT/records.ts:360-362,504-509,527-534,580-587,634-673`），它不是裸 SQL；真正裸 SQL 的是 People 目录（`UM:5266,5283`）与审批投影。所以理由不是"否则又是第四个裸 SQL 同步器"，而是"**否则又是一条不发事件、不重算、无字段所有权、无集成身份的旁路**"。core 的增量因此**小于原稿描述**（六步里已有四步）。
- **"直接做 live 虚拟表更省事"**：与零外部写/有界读/围栏/PIT/行级权限全部冲突；`DataMaterializationService.ts` 零 importer 就是上次尝试的残骸。
- **"买 iPaaS/用钉钉连接器，不自研"**：iPaaS 解决"推/拉 + 映射"，解决不了表内所有权、冲突规划、审批/PIT 一致性，也改变不了冻结姿态。原语 C 已让 iPaaS 可以推数据进来；原语 A/B 是 iPaaS 做不到的表内语义。
- **"先把 GIP 接线再说"**：**更正原稿前提** —— GIP 不是空注册表，`PIC/lib/` 有 16 个 `gip-*.cjs`（含 approved-binding resolver、qualification spike、`bridge.bounded_read.v2` profile、server-bound executor、SQL Server 快照策略），且 `read-source-config` 已用 GIP 的 `isValidProfileId` 校验 `actionProfileVersion`（`:288`）。它们**全部 LATENT**（`gip-approved-binding-resolver.cjs:20` 自述）。所以本方案**不新造第三套 profile 词表**，binding 直接引用 `actionProfileVersion`；缺的是 runtime wiring 与多维表消费面——那正是本方案要建的东西，两者互补而非竞争。
- **"每个域一个插件已经能交付"**：after-sales 证明"一个域 = 752 行 installer + 5964 行 Vue + 40 条路由"，第二个域照抄就是第二份；且 `integrations[]` 零实现、reinstall 覆盖用户改动、所有对象落 `base_legacy`、多实例撞 id。没有"蓝图即数据 + 通用壳"，"模板"永远等于"插件"。

### 6.3 替代方案（若 owner 不批主线）

- **B1：只做原语 C + 治理**（P0 那一档）。成本 1.5–2 人周，立刻让"用户端配置对接"有一条不写码的路（webhook/token 按键 upsert）。**代价**：没有字段所有权、没有刷新、没有 plan/confirm，外部数据是"谁推谁负责"。
- **B2：同步表引擎全留插件 + 手工 runbook**（core 只加 `readonly` 呈现）。**代价**：ownership 仍可伪造、无集成身份、无事件/重算 —— 等于第四条旁路，且备料/CRM/售后各自再实现一次。
- **B3：先做 App Template（P2）不做原语 A**。CRM 纯数据蓝图可以先跑通"零插件装一个业务系统"，但 `integrationBindings` 只能落到原语 C 的形状（inbound_endpoint / outbound_topic），备料落不进来。

### 6.4 需要 owner 决定的事

1. **主线取舍**：接受"core 加原语 + 蓝图数据化"，还是 B1/B2/B3。
2. **新 issue/charter + 新 operation id + 独立 owner 授权**（`delivery-plan:24-26`）；**S5 重新排期**（`lock:75`）。
3. **GIP-D0 范围**：`source_binding` 是否构成"客户 Binding 平台化"的提前实现；绑定持久化 **A（config 语义）/ B（版本化五态 + 审批，`gip-d0:193,237`）**。
4. **连接主体模型**（§2.0d）：绑定存 ownerUserId / facade 新增 `binding:<id>` 主体 / 放宽 `assertAccess` 到 tenant∧workspace —— 三选一或组合。**这是原语 A/B 的前置阻塞。**
5. **`MULTITABLE_ENABLE_WRITER_FENCE` 是否随本线开启**（否则围栏缓解无效）。
6. 权限层归属：G10 修在 host `plugin-scope` 还是 PIC 路由门；绑定 **approve 分权**（请求方 ≠ 决定方）。
7. 连接注册表收敛：`data_sources` 加 tenant 还是折入 `integration_external_systems`。
8. 首个验证模板 = **CRM（零插件）**，备料第二、售后第三 —— 接受该顺序。
9. **`instanceKey` 进 `getProjectId`**（影响已装 after-sales；有 parity fixture 兜底）。
10. 事件策略：同步表默认是否发 `record.*`（建议默认关、绑定级开，需新造开关）。
11. 备料模板冻结门（sortLine / human 所有权）、钉钉审批产品替换等客户可见语义变更签字。
12. **绑定输入面例外**（§2.0a）：是否允许管理员在向导里直接选表/选列/选键，即 S0`:218-228` 的局部豁免。默认取严。
13. **H0 平面 B 的适用范围**（§2.0b）：是否延伸到租户自登记的普通 `data_source`；以及 OD-W3-1 / H3-0 / #4194 三门的排期。
14. **是否建 core-backend 语句缝**（⟲OD3 / #4619 UNRULED；GIP B1a δ 决定"SQL builders stay unreachable — the accepted v1 outcome"）。
15. **FOS-4b-3 §3a 关系**：确认 `upsertByKey` 定位为"多维表新原语自己的写门"、备料动作线 v1 不切换；若 owner 要求合并，须重开 §3a。
16. 旗标与 ledger 登记、`http-routes.cjs` 重冻结窗口排期。

---

## 7. 附：验证记录

### 7.1 本轮我亲自重读的锚点（用于裁决冲突）

`MT/approval-projection-constants.ts:33-46,47-58`（11 项 deny，含 canRead）；`MT/canonical-sheet-fence.ts:136-138,176-186`（default-OFF + 锁持到 COMMIT）；`data-source-plugin-facade.ts:149-158,365-395`（拒系统/默认/租户/管理员身份 + authorize→assertAccess）；`DataSourceManager.ts:54-61,380-390`（6 键/5 类 + `workspaceId` 被忽略）；`MT/records.ts:350-375,500-540,575-595,630-680`（SDK 路径已有 fence/operation/version/revision + 只读拒写）；`MT/field-codecs.ts:6-36`（30 类型）、`:235-260`（跨切面链 + person/button 实测）、`:543-551`（默认透传）；`MT/oapi-read-allowlist.ts:29-47,79-90`（读白名单 + 5 条写路由）；`UM:6894,13518,15198,16338,17188`（模板路由 + POST /records 真实行号）；`packages/core-backend/migrations/057_create_integration_core_tables.sql:19-35`；`MT/permission-derivation.ts:58-67`（readonly 分支已存在）；`MT/system-sheet-predicate.ts:34-39`；`MT/permission-service.ts:1866-1874`；`MT/api-tokens.ts:24-38`（6 scope）；`MT/exact-anchor-recovery-execute.ts:1110-1120`（link ApplyRefusalError）；`CB/db/migrations/zzz20251231_create_meta_schema.ts:65-66` + `zzzz20260413110000:12-14`（无唯一约束）；`zzzz20260413120000:29-33,40-50`（automation CHECK）；`MT/provisioning.ts:100-150,300-325`；`AS/lib/installer.cjs:428-470`；`AS/lib/field-policies.cjs:87-90` + `runtime-admin.cjs:137`（**registry 确有读者**）；`web/views/` 列目录（模板中心/详情/Shell/Launcher 均已存在）+ `appRoutes.ts:140-170`；`MT/automation-executor.ts:3660-3670`（templateData 键集）；`PIC/stock-preparation-templates.cjs:12,16,28`（9 + 8）；`PIC/read-source-config.cjs:18,23,26,33,47-51,58,60-66,288`；`PIC/pipeline-runner.cjs:503,657`；`PIC/adapters/metasheet-multitable-target-adapter.cjs:151,217-220,239,254,268`；`ls PIC/lib | grep ^gip-`（16 个）+ `gip-approved-binding-resolver.cjs:1-30` + `gip-server-bound-source-executor.cjs:1-20`；`docs/h0...20260712.md:28-48,70-74`；`docs/gip-d0...:116-123,132-137,208-212,247`；`docs/S0...:196-200,218-232,268-302`；`docs/fos-4b-3-action...:20-36`；`docs/fos-4b-3-prod...:38-42,62-66,74,149-162`；`docs/delivery-plan...:24-26,74-75`；`wc -l AfterSalesView.vue` = 5964。

### 7.2 被驳回的更正（3 条，均 low）

1. **"`SYSTEM_SHEET_KINDS` 应引 `:38`"** —— 驳回。实读 `grep -n` 显示该常量在 **`:39`**，原稿正确。
2. **"`READ_SOURCE_MODES` 应引 `read-source-config.cjs:25`"** —— 驳回。实读 `grep -n` 显示在 **`:26`**（`:25` 是注释行），原稿正确。
3. **"`plugin_field_policy_registry` 是只写表，全仓无 `FROM`"（code-accuracy M3）** —— 驳回。`plugins/plugin-after-sales/lib/field-policies.cjs:90` 有 `FROM plugin_field_policy_registry`，调用点 `:261` 与 `AS/lib/runtime-admin.cjs:137`。正确结论（采纳 design-critique 版本）：**它有读者，但读者只在 after-sales 自己的面上；多维表网格/`field_permissions` 从不读它** ⇒ 迁移顺序风险，见 §3.2 与风险 #10。

### 7.3 未读 / 未核（不据以下结论）

`UM` 大部分 handler 正文；Yjs 桥完整路径（但 `CB/index.ts:3613,3652` 确调 `isFieldAlwaysReadOnly` + `isFieldWriteForbidden` 并抛 `FieldWritePermissionDeniedError` —— 此项已关闭）；`automationRecipes.ts`；`history-integrity-precheck.ts` 完整处理；`PIC/lib/http-routes.cjs` 大部分（其"pin/freeze 门"是**流程约束**，仓内未见 digest 门，只有 `PIC/__tests__/k3-save-body-composer.parity.test.cjs:173` 一条结构性 parity 断言）；`AfterSalesView.vue` 正文；宿主 HTTP Bearer 键名 bug 的**运行**验证；任何测试执行。
**FOS-4b-3 家族另 7 份文档未读**：`prod-apply-runbook-20260625` / `sandbox-validation-runbook-20260623` / **`fos-4b-action-binding-generalization-design-lock-20260622`** / `fos-plan-and-verification-20260621` / `connection-line-gate-closure-plan-20260625` / `k3-poc-conclusion-gateA-20260625` / **`system-integration-standardization-template-20260625`** / `multitable-onprem-windows-default-deploy-path-hardening-20260624`。加粗两份很可能直接约束本文的"动作绑定泛化"与"系统对接标准模板"两个核心提案，**建议在 ST-0 设计锁之前补读**。
