# ADR — 首载写手（first-load writer）：迁移人列所有权的一次性写入

- **日期**：2026-08-23
- **状态**：PROPOSED（待 owner 裁定，见 §5）
- **范围**：备料接管线第 3 步（历史迁移）的**首次装载**，只谈"人列值第一次落进 MetaSheet"这一件事。
  不谈对账引擎、不谈按项目号切换、不谈 MySQL 只读窗口——那三项各有其门（`beiliao-production-go-live-gate.md` T-1/T-2/T-3）。
- **values-free**：全文只出现 schema id、冻结枚举 token、文件路径与行号、计数与业务列的中文标签。
  无主机名 / IP / 口令 / 凭据 / 客户行数据。

---

## 0. 一句话结论

**不放宽刷新墙，也不用通用 records API 做迁移主路径**：新建一个**只能 create、且只能在"该项目在画布上一行都没有"时 create** 的独立首载模块——
一次性把人列写进去，此后对该项目**永久关闭**；因为"改"必须先有行，而它拒绝碰任何已存在的行，
所以它在结构上不可能成为"写人列的通用办法"，刷新墙一个字节都不用动。

---

## 1. 问题

### 1.1 墙是什么

刷新路径上有两道**同形**的守卫，拒绝任何携带 `human_preserved` 列的载荷：

| 位置 | 函数 | 行 |
|---|---|---|
| apply 写手 | `assertNoHumanFields(payload, context, humanFields)` | `plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs:190-199` |
| 冲突规划器 | `assertNoHumanFields(payload, humanFields, context)` | `plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs:879-888` |

两者的 `humanFields` 都来自同一个投影函数
`derivePackAwarePlmWritableFields`（`stock-preparation-conflict-planner.cjs:299-406`），
它把冻结模板的 human 段（`stock-preparation-templates.cjs:28-37`，8 列）
与 pack 声明的 `ext_` human 段合并；**fail-closed**——未分类的 pack 列既不进可写段也不进 human 段
（`conflict-planner.cjs:375-380`）。

规划器侧的调用点覆盖全部四种决策：
`makeAddDecision`（`:931-943`）、`makeUpdateDecision`（`:945-958`）、`makeInactiveDecision`（`:968-980`）。
写手侧覆盖 add（`apply-writer.cjs:324`）与 patch（`:347`）。
另有一道模板漂移检查：模板的 human 段与 `HUMAN_PRESERVED_FIELD_IDS` 不一致直接抛错
（`conflict-planner.cjs:991-995`）。

**这道墙对刷新是对的**——它就是所有权模型本身。

### 1.2 迁移要写的正是这些列

`mysql-migration-plan.md` §2(2) 要把源系统的在制行落成 MetaSheet 镜像行：
系统字段进 `ext_`，**人可编辑字段进 human 列**。具体是冻结模板的 8 列
（`materialType` / `blankType` / `stockPreparationStatus` / `demandDate` / `leadTimeDays` /
`notes` / `procurementReply` / `warehouseConfirmation`，`stock-preparation-templates.cjs:28-37`）
加上 pack 的 8 列 `ext_` human 列（备料日期 / 领料节点 / 交接工段 / 毛胚长·宽·厚·数量·质量，
见 `customer-pack-rehearsal-report.md:48-51`）——共 **16 列**（同文件 :40-44 的 46 列分带表）。

### 1.3 一处必须先说清的机制细节

`applyAddDecision`（`apply-writer.cjs:320-342`）**不是 create-only**：
它先按 `idempotencyKey` 查（`findExistingRecord`，`:201-217`），
命中就 `patchRecord`，未命中才 `createRecord`。
所以 ADD 决策也必须过 `assertNoHumanFields`——**一个 ADD 完全可能落到已存在的行上**。

这条细节决定了本 ADR 的整个走向：
"create-only 因此不可能覆盖人值"这个论证**只有在写手连 `patchRecord` 都不持有时才成立**。
复用现有 ADD 路径拿不到这个性质。

---

## 2. 先穷尽已有机制

### 2.1 判定表

| # | 机制 | 判定 | 关键限制（全部来自代码） |
|---|---|---|---|
| A | 通用 records API `POST /records` | **viable-with-caveats**（但不作主路径） | 无幂等：纯 create，无按键查重，重跑即翻倍；revision `source='rest'`，与人手编辑不可分辨 |
| B | 通用 records API `PATCH /records/:recordId` | **not viable** | 只能改已存在的行——首载没有行可改；且它是"改人列"的通用口，正是要防的形态 |
| C | `POST /patch`（批量单元格） | **not viable** | 每条 change 必带 `recordId`（`univer-meta.ts:17194`），同 B |
| D | XLSX 导入 | **viable-with-caveats**（单项目试点可用） | 全单元格字符串化；表头按列名不区分大小写首命中；50 000 行静默截断；纯 create 循环，无查重 |
| E | 通用落表适配器 `metasheet-multitable-target-adapter.cjs` | **not viable** | main 上**没有**所有权守卫（PR #5067 未合并）——它现在就能写人列，推荐它等于把要防的漏洞制度化 |
| F | `ensureMissingObjectFields` / provisioning | **not viable** | 结构上只写 `meta_fields`，没有行/值面 |
| G | 放宽 apply 写手 / 规划器的墙 | **not viable** | 见 §2.7 |
| H | 复用 `persistStockPreparationSyncRun` 的**形状** | **viable-with-caveats**（推荐的蓝本） | 它写的是内部 staging 的 MVP 卫星表，不是画布主表；宿主原语硬编码"恰好 4 张表" |

### 2.2 A / B / C — 通用 records API

`POST /records`（`packages/core-backend/src/routes/univer-meta.ts:16338-16437`）：

- **完全没有所有权概念**。它走 `RecordService.createRecord`；写侧只看
  `isFieldAlwaysReadOnly`（formula/lookup/rollup/system/mirror/`property.readonly`，
  `packages/core-backend/src/multitable/permission-derivation.ts:58-68`）与 `canCreateRecord`。
  `property.stockPreparation.ownership` 不在任何判断里——全仓 `packages/core-backend/src/multitable/`
  下检索不到该字段名。
- 该路由自己的注释确认了这一点：create 写侧是 **layer-2 only**，
  `createRecord` 既不查 `field_permissions.visible` 也不查 `read_only`
  （`univer-meta.ts:16374-16377` 的 F4 注释；`:16443-16456` 的 duplicate 路由注释复述同一事实）。
- **没有幂等**：请求体只有 `{viewId?, sheetId?, data?}`（`:16339-16343`），没有 key 字段、没有 upsert 分支。
  `idempotencyKey` 在画布上只是一个普通 string 列（`stock-preparation-templates.cjs:561`），
  `meta_records` 是 jsonb 存储，**没有唯一约束**。重跑一次 = 整项目行数翻倍，且没有任何东西会报错。
- **没有跨行事务**：一行一个 HTTP 请求、一个事务。中途失败留下半载项目，且没有任何标记说明载到哪。
- **溯源不足**：revision 写 `source: 'rest'`（`packages/core-backend/src/multitable/record-service.ts:758`），
  与人手编辑（`:913` delete-restore、`:1515` patch）在 `source` 列上**完全一致**，只有 `actorId` 不同。
  §3.3 要求的"后来的读者能分辨迁移值与人打的值"在这条路上只能靠 actor 猜。
- 认证面是 `apiTokenAuth` + `requireScope('records:write')` + `apiTokenWriteRateLimit`（`:16338`）。
  一个有 create 权的 token 可以写**每一列**，包括全部 `plm_system` 列——比迁移需要的口子宽得多。
  这是**平台既有**的姿态，不是本 ADR 开的口子；但把迁移建在它上面，等于把迁移的正确性完全押在操作纪律上。

`PATCH /records/:recordId`（`:15198-15290`）确实**有** layer-3 逐主体列写守卫
（`isFieldWriteForbidden`，`:15258-15264`）——比 create 严。
但它按 `recordId` 定位，首载无行可改；且它正是"写人列的通用办法"本身。

**"直接用 records API 做首载"是不是对的答案？**
认真评估过，结论是**不是**——不是因为它不安全（它和任何人手编辑一样安全），
而是因为它**不可重跑、不可对账、不可分辨**。
迁移的验收判据（T-2 连续 N 日零差异、T-3 provenance 完整，
`beiliao-production-go-live-gate.md:95-106`）要求首载是一个**有身份、可复核、失败可重来**的事件。
`POST /records` 提供不了其中任何一项。它可以做**一个项目的手工试点**，不能做迁移机制本身。

### 2.3 D — XLSX 导入

路由 `POST /api/multitable/sheets/:sheetId/import-xlsx`
（`packages/core-backend/src/routes/univer-meta.ts:13085-13205`），服务
`packages/core-backend/src/multitable/xlsx-service.ts`。

**拒绝导入的列类型**（`isXlsxImportableField`，`xlsx-service.ts:127-133`）：

1. `formula` / `lookup` / `rollup`；
2. `isFieldAlwaysReadOnly`（含 system 类型、mirror 链接、`property.readonly`/`readOnly`）；
3. `isFieldPermissionHidden`（`property.hidden === true` 或 `visible === false`）；
4. `property.readonly === true` 或 `property.readOnly === true`（第 2 条已含，此处再判一次）。

**没有**任何一条与 `stockPreparation.ownership` 有关——16 个人列**全部可导入**。

其余实测限制：

- 表头映射按**列名**（不是 id）、`trim().toLowerCase()`、**首命中先占**（`:143-149`）。
  46 列里若有两个中文标签归一后相同，第二个静默进 `unmappedHeaders`。
- 所有单元格经 `normalizeRowCell`（`:52-61`）**一律字符串化**；`raw: false`（`:84`）。
  date / number 类人列（`demandDate` / `leadTimeDays` / 毛胚五维）拿到的是字符串，
  由 `RecordService` 侧的类型归一决定是强转还是 422。
- `XLSX_MAX_ROWS = 50_000`（`:5`）超出即截断，响应里只有一个 `truncated: true`（`:13181`）。
- 写入是**纯 create 循环**（`univer-meta.ts:13147-13153`），逐行 `createRecord`，
  **无查重、无事务**；失败行进 `failures[]`，成功行已落库。重跑必然翻倍。
- 权限只要 `canCreateRecord`（`:13114`），无 API token 作用域要求。

**判定：viable-with-caveats。** 它是唯一一条**零新增代码**、客户 IT 自己就能走的路。
适用条件必须写死：单个 `product_code`、行数在人眼可核范围、
且接受"重跑 = 先把该表该项目的行删干净"。**不适合**做 24 表全量迁移的机制。

### 2.4 E — 通用落表适配器

`plugins/plugin-integration-core/lib/adapters/metasheet-multitable-target-adapter.cjs`（663 行）。

**已核实：main 与 `origin/main` 上都没有所有权守卫。**
在该文件中检索 `ownership` / `human_preserved` / `preserveOnRefresh` **零命中**；
对 `origin/main` 版本同样零命中。PR #5067（"通用落表适配器所有权写守卫"，
`beiliao-takeover-status-ledger.md` §2）**未合并**。

也就是说：**今天，一个配置了 `objects[].sheetId` 指向备料主表的管线，
就能通过这个适配器写任意 human 列**——刷新墙管不到它。
这不是本 ADR 要开的口子，是**已经开着的**。

**判定：not viable。** 推荐走这条路等于把"迁移写手 = 写人列的通用办法"这个失效模式直接兑现。
反过来，#5067 合并后它会被守卫挡住，那时这条路连"能写"都不成立。
→ 派生 owner 决策 **O-A**（§5）。

### 2.5 F — provisioning / `ensureMissingObjectFields`

`packages/core-backend/src/multitable/provisioning.ts:531-558`：
函数体只有一条 `INSERT INTO meta_fields ... ON CONFLICT (id) DO NOTHING`，
返回 `{addedFieldIds, skippedExistingFieldIds}`。**没有任何行/值写入面。**

pack 安装器同理：`ensureExtensionFields`（`stock-preparation-customer-pack-installer.cjs:454-490`）
建列，`stampExistingExtensionFields`（`:341-378`）打所有权戳，
`syncPackOptionSets`（`:492-538`）同步选项字典，`ensureRoleViews`（`:540-578`）建角色视图。
**四件事都在 schema 层，一行业务数据都不写。**

**判定：not viable（结构上不可能）。** 与 brief 的猜测一致，已确认。

### 2.6 H — 已发货的先例：`persistStockPreparationSyncRun`

这是本次盘点最有价值的发现：**"一次性把业务行写进 MetaSheet"这件事，仓里已经有一个经过评审的答案**。

`plugins/plugin-integration-core/lib/stock-preparation-sync-run-persist.cjs`
（路由 `POST /api/integration/stock-preparation/mvp/sync/persist`，
`http-routes.cjs:82`、处理器 `:4446-4474`）。它的性质，逐条对应本 ADR 需要的性质：

| 需要的性质 | 该模块的做法 | 位置 |
|---|---|---|
| admin 前置、fail-closed | `requireAccess(req, 'admin')` 在任何 I/O 之前 | `http-routes.cjs:4447` |
| 写不出目标表 | `createTargetScopedRecordsApi` 绑定单张已解析 sheet；`sheetId` 不符即 403 `TABLE_ACTION_TARGET_SCOPE_VIOLATION` | `stock-preparation-table-actions.cjs:476-524`（守卫在 `:491-496`） |
| 目标不可由请求体操纵 | `targetProjectId` 由路由从**认证租户**推导，绝不取自请求体 | `http-routes.cjs:4452-4453`；模块侧 fail-closed 于 `sync-run-persist.cjs:626-630` |
| 原子性 | 宿主一次事务 + 四张表的 canonical fence + 两把 advisory 锁 | `sync-run-persist.cjs:642-655`；宿主 `packages/core-backend/src/index.ts:1873-1920`；锁 `packages/core-backend/src/multitable/stock-preparation-persist-unit-of-work.ts:76-96` |
| 幂等：命中键即跳过 | 按 batch key 查；命中则 `assertExactReplay` 全量比对后返回 `skipped_existing`；**部分/冲突重放 fail-closed** | `sync-run-persist.cjs:658-718` |
| 只 create、绝不改旧行 | 明确注释 "create-only path ... createRecord ONLY — no existing row is ever mutated" | `sync-run-persist.cjs:737-746` |
| 唯一的 upsert 例外仍保人列 | 项目行 patch 载荷是**封闭白名单**，结构上不含 `owner`（human_preserved） | `sync-run-persist.cjs:13-19`、`:463-486` |
| 行数上界 | `PERSIST_MAX_PLAN_LINES = 500 × 50 − 1 = 24 999`，超出 422 | `sync-run-persist.cjs:76-86`、`:596-605` |
| values-free 证据 | 只出计数 / 状态 / 列名 / 布尔 | `sync-run-persist.cjs:31-33`、`:505-514` |

**它不是可以直接用的东西**——它写的是内部 staging 项目下的 MVP 卫星表
（`plm_stock_preparation_bom_snapshot_batch` / `_line` / `_run` / `_project`，
`stock-preparation-templates.cjs:620/642/599`），不是画布主表 `plm_stock_preparation_main`（`:524`）。

**并且宿主原语当前不接受一张表**：
`validateStockPreparationPersistUnitOfWorkInput` 硬要求 `sheetIds.length !== 4 || new Set(sheetIds).size !== 4` 即抛
（`packages/core-backend/src/multitable/stock-preparation-persist-unit-of-work.ts:37-39`），
且 `project` / `batch` 两把锁键是必填的
（`:39-53`，锁键构造 `:56-72`）。
首载若要复用这把原语，**需要一次 core-backend 改动**（把"恰好 4 张"放宽为"非空且互异"，
并让 project/batch 键成为可选或换成首载自己的两把键）。
这是本 ADR 唯一的宿主侧依赖，必须显式立项。→ **O-B**（§5）。

**判定：viable-with-caveats——作为蓝本，不是作为实现。**

### 2.7 G — 放宽墙本身，为什么不行

三种"放宽"的写法都失败，理由各不相同：

1. **给 `assertNoHumanFields` 加 `allowHumanFields` 开关**——一个布尔参数就把两处守卫变成建议。
   任何调用方（含未来的、含 bug）都能传 true。这正是 brief 点名的失效模式。
2. **加一种新 DECISION（如 `FIRST_LOAD`）绕过守卫**——决策枚举
   （`conflict-planner.cjs:18-24`）与 apply 循环（`apply-writer.cjs:491-521`）耦合；
   新增分支意味着同一个 `applyStockPreparationPlan` 既能刷新又能首载，
   而它的沙箱/生产门（`assertStockPrepApplyAllowed`，`stock-preparation-table-actions.cjs:937-959`）
   是按"刷新"这一个动作设计的（`allowedActionId` 硬绑
   `plm.stock-preparation.pull-bom.v1`，`stock-preparation-production-policy.cjs:94-98`）。
   两个动作共用一个门 = 门失去含义。
3. **让 pack 把这 16 列声明成 `plm_system`，载完再改回 human**——
   这会让**刷新**在那段窗口里获得覆盖人列的权利，是三者中最危险的。
   且 `derivePackAwarePlmWritableFields` 明确规定"冻结模板拥有自己的列，installed property 永远不能挪动一列"
   （`conflict-planner.cjs:331-334`，reason `template_governed`），8 个冻结 human 列**根本改不动**。

**判定：not viable，三条全否。**

---

## 3. 若需新路径：最窄的那一条

以下每一条都取立场，不留"看情况"。

### 3.1 once-only：靠什么"只有一次"

**立场：首载 = CREATE ONLY，模块内不持有 `patchRecord`；且"该项目在画布上一行都没有"是唯一准入条件。**

论证分两步：

**(a) create-only 为什么足够。** 覆盖一个人值需要那个值先存在；create 不改任何已存在的行；
所以一个真正 create-only 的写手在结构上不可能覆盖人值。
这个论证是**闭合**的——不依赖调用方纪律、不依赖配置、不依赖门。

**(b) 为什么"create-only"必须是模块级而非分支级。**
§1.3 已证：现有 `applyAddDecision` 在键命中时会 patch。
所以"create-only"不能写成"在 add 分支里不 patch"，
必须写成**该模块的 records API 句柄上根本没有 `patchRecord`**——
即从 `createTargetScopedRecordsApi` 拿到的作用域 API 里把 `patchRecord` 删掉再传下去
（该工厂当前无条件挂载 `createRecord` 与 `patchRecord`，
`stock-preparation-table-actions.cjs:511-522`；`readOnly: true` 只给 `queryRecords`，`:509`）。
建议给该工厂加第三档 `createOnly`，与既有 `readOnly` 同形，
这样"不能改"是**类型面**的事实，不是代码审查的事实。

**(c) 准入条件用哪一级。**
`idempotencyKey` 是画布上的普通列，**没有唯一约束**（§2.2），
所以"逐行查键"这一档只在同一事务内可靠。三档粒度：

| 粒度 | 语义 | 评价 |
|---|---|---|
| 逐行按 `idempotencyKey` | 该行不存在才建 | 可用但弱：允许"半载"状态长期存在，破坏对账基线 |
| **按 `projectId`（= `product_code`）** | 该项目**零行**才载 | **采用。** 一次调用 = 一个项目的全量，全成或全不成 |
| 按整张表 | 表为空才载 | 过粗：多项目分批切换（T-3 按项目号）就做不了 |

采用中间档后，**"这一行不存在"退化成"这个项目不存在"**——一次查询、一个布尔、一个事务。
brief 提出的"create-only 成立则其余约束多余"在这一档上**基本成立**：
剩下真正必要的只有 §3.2 的范围绑定与 §3.5 的原子性；
过期时间、新鲜 dry-run、行数上界都从**安全必需**降级为**运维护栏**（仍建议保留，但性质不同）。

### 3.2 scope：绑到什么

**立场：一次调用绑定 (tenant, staging-derived projectId, 一个 `product_code`, 一个已安装的 pack)。**

- **tenant + 目标 project**：不可由请求体给。沿用 `http-routes.cjs:4452-4453` 的推导
  （`resolveAuthUserTenantId` → `resolveIntegrationStagingProjectId`），
  以及 `sync-run-persist.cjs:626-630` 的 fail-closed。
- **单一 `product_code`**：这是源系统的分区键
  （`mysql-migration-plan.md` §1.1：`selectAllProducts group by product_code`），
  也是 T-3 切换的粒度。首载与切换用同一把粒度，对账才有意义。
- **pack 绑定**：目标表上必须有一条**活的** pack 安装记录
  （`integration_stock_prep_pack_installs`，migration 076），
  否则 16 个人列里的 8 个 `ext_` 列根本不存在。
  读法沿用 refresh 侧：从 ledger 取候选 id，再经 `readObjectFieldsContent` 复核实际存在
  （migration 076 头部注释 :9-10 明确了"ledger 不是真相，宿主才是"）。

**关于复用生产策略对象**：已核实 `stock-preparation-production-policy.cjs` 的形状与 brief 描述一致——
`maxCleanRows` 正整数（`:105-107`）、严格 ISO-8601 带时区的 `expiresAt`（`:109-116`，
`parseStrictIsoTimestamp` 在 `:45-66`）、`requireFreshDryRun === true`（`:119`），
外加 `MAX_PRODUCTION_POLICY_WINDOW_MS = 7 天` 的窗口上界（`:25`，检查在 `:140-146`），
以及"沙箱形状不可当生产策略用"的显式拒绝（`:79-81`）。

**立场：不改它，另立同形的姊妹策略。**
理由：该策略把 `authorizedTargetObjectId` 钉死为生产 canonical（`:84-89`）、
把 `allowedActionId` 钉死为唯一那个刷新动作（`:94-98`）——
**这两条钉死正是它的价值**。为了容纳第二个动作而松开，等于削弱 apply 门。
姊妹策略复用 `parseStrictIsoTimestamp` 与 `assertProductionPolicyNotExpired`（`:137-147`）这两个纯函数，
把 `maxCleanRows` 换成 `maxFirstLoadRows`，`allowedActionId` 换成首载自己的动作 id。
另注：该模块**至今未接入 apply 路径**（`:3-10` 的 LOCK-SAFE 注释；
`assertStockPrepApplyAllowed` 只在 `stockPrepApplyProduction` 存在时才走生产分支，
`stock-preparation-table-actions.cjs:937-956`）。首载策略若立，应**一次性接线**，不留同样的悬空态。

### 3.3 auditability：后来的读者靠什么分辨

三个候选载体，逐个判定：

**(a) pack 安装 ledger（`integration_stock_prep_pack_installs`，migration 076）——不是载体。**
它按 `(tenant_id, project_id, object_id, pack_id)` 一行 UPSERT（migration 076 唯一索引，
文件末 `idx_..._identity`），记录的是**哪些列存在、谁拥有**
（`installed_fields_json` 的 `{fieldId, ownership, preserveOnRefresh, extension}`，
migration 076 注释 :28-31），并且 store 侧强制 values-free
（`stock-preparation-pack-install-store.cjs` 的 `assertValuesFreeInstalledFields` 等，`:382-384`）。
它答的是"表长什么样"，不是"哪些值是载进来的"。**驳回。**

**(b) 行级溯源（migration 060 视图 `integration_provenance_by_row`）——可用，作叙事层。**
事件词表是封闭的，且**恰好含 `row_imported`**
（`plugins/plugin-integration-core/lib/provenance-contracts.cjs:5-17`），
读取面 `listProvenanceByRow`（`plugins/plugin-integration-core/lib/pipelines.cjs:727-753`）
按 `rowId` 跨 run 拉时间线，`attrs` 在写入时已脱敏（`provenance-contracts.cjs:70-75`）。
**限制**：它挂在 `integration_runs.provenance_events` 上（migration `060_integration_runs_provenance.sql`
的 `ALTER TABLE` + `CREATE OR REPLACE VIEW`），需要一条 run 记录；
且 `rowId` 是调用方自定义字符串（`provenance-contracts.cjs:83`），
**没有任何约束保证它等于 `meta_records.id`**。所以它能证明"这次 run 处理了这些 rowId"，
不能独立证明"画布上这一格的值是载进来的"。

**(c) `meta_record_revisions` 的 `source` 列——采用，作主判据，且零成本。**
插件路径的 create 写 `source: 'plugin'`、`actorId: null`
（`packages/core-backend/src/multitable/records.ts:667-673`），
而人手编辑的三条路径（REST create / delete-restore / patch）一律写 `source: 'rest'`
（`record-service.ts:758`、`:913`、`:1515`）。
`RecordRevisionSource` 是开放联合（`record-history-service.ts:20`，末尾带 `| string`），
所以未来若需要更细的 token 也留有余地。
**判据成立**：某行 version 1 的 revision，`source='plugin'` 且 `changedFieldIds` 覆盖那 16 列
= 这些值是机器载入的；后续任何 `source='rest'` 的 revision = 人动过。

**采用组合**：(c) 作机器可判的主判据 + (b) 作 run 级叙事 +
`mysql-migration-plan.md` §2(5) 的 `ext_src_create_by` / `ext_src_create_time` 承载**源系统的**溯源
（源表有 `create_by/update_by/create_time/update_time`，见该文 §1.1 表），
三者互不替代：(c) 说"MetaSheet 侧谁写的"，`ext_src_*` 说"源系统侧谁写的"，(b) 说"哪一次 run 写的"。

### 3.4 与墙的关系：怎么保证墙还算数

四条，全是结构性的，没有一条靠纪律：

1. **零共享写路径。** 首载模块不 `require` `applyStockPreparationPlan`，不产出 `decisions`，
   不进 `apply-writer.cjs` 的循环（`:492-522`）。共享的只有只读件：
   模板常量与 `derivePackAwarePlmWritableFields`（用来**校验**16 列确实在 human 段里，
   而不是用来绕过它）。
2. **create-only 是模块级事实**（§3.1b）。
3. **项目级一次性**：载完之后该 `product_code` 在画布上有行了，准入条件永久为假。
   **一个项目上线之后，这条路对它永远关闭。**
4. **动作分离**：首载有自己的 action id、自己的策略对象、自己的门（§3.2），
   与刷新的沙箱/生产门不共享判断（`stock-preparation-table-actions.cjs:937-959` 保持原样）。

**要防的失效模式的正式否定**：
"迁移写手成为写人列的通用办法"要求它能作用于**已有数据的项目**。
条件 3 使这个前提为假。剩下的唯一滥用方式是"先删光一个项目的行再重载"——
那是一次 `deleteRecord` 风暴 + 一次首载，两者都留 revision，
在 History 上和"悄悄改一格"完全不是一回事。**接受这个残余风险，不再加门。**

### 3.5 重跑 / 部分失败

**先更正 brief 的一处事实认定。**
brief 称"pack 安装器的 ledger 已经在这件事上错过一次（先改动、后写终态 ledger）——见状态账本 §4"。
**核对结果：状态账本 §4 没有这一条**（该节六项是：V3 抽取债、`ext_` 守卫接线缺口、提案文档 stale、
大 BOM 路径未接、迁移必须先做身份归一、本机 pin 重算不可信，
`beiliao-takeover-status-ledger.md:65-76`）。
而代码里的顺序是**刻意如此、且有文档**：
`installCustomerPack` 的 ledger 写是"TERMINAL-ONLY LEDGER WRITE — the LAST thing the install does,
after every host mutation has succeeded"（`stock-preparation-customer-pack-installer.cjs:834-838`），
migration 076 头部 :16-19 给出理由：**永不存在 pending 行；崩在中途就没有行，"没有行"= "什么都没落"，重试安全**。
对**加列**这种加性幂等操作，这个顺序是对的。

**真正的窗口是另一件事，且代码给它起了名**：
`CUSTOMER_PACK_LEDGER_WRITE_FAILED`（`installer.cjs:908-920`）——
宿主改动全部成功、ledger 写失败，留下"表上有列、账上无记录"。
错误信息自己解释了为什么这对加列无害："a re-install is safe and idempotent"。

**对写值，这个窗口就不无害了**——因为账本正是读者判断"载过没有"的依据。
所以：

**立场：首载不采用"先改动、后记账"的形态。装载与其标记必须在同一个事务里；
而最干净的做法是根本不要外部标记——行本身就是标记。**

具体：

- 准入探测（该 `product_code` 零行）与全部 `createRecord` 在**同一个** unit-of-work 里
  （蓝本 `sync-run-persist.cjs:641-655`）。
- 因为准入条件就是"零行"，**不存在会失配的外部标记**：
  行在 = 载过，行不在 = 没载过。这是自洽的，不需要第二处真相。
- 部分失败 = 事务回滚 = 零行 = 重跑准入条件仍然成立 = **重跑安全且是全量重跑**，
  永远不会出现"接着上次载"的半状态。
- 若确需一条运维用的证据行（谁在何时载的、载了多少），它必须是**同一事务内、锁集合内某张表上的一行**，
  不能是事务外的插件 SQL 写——因为宿主原语只交回一个 records API，
  不交回事务句柄（`packages/core-backend/src/index.ts:1897-1919`），
  跨库事务在当前原语下**做不到**。
- 行数上界：沿用 `PERSIST_MAX_PLAN_LINES` 的立法方式（`sync-run-persist.cjs:76-86`），
  以"读分页可证完整"为界，超界 422 而不是静默截断（对比 XLSX 的静默截断，§2.3）。

---

## 4. 决策

### 4.1 推荐（RECOMMENDED）

**新建 `stock-preparation-first-load-writer.cjs`（暂名），
形状照抄 `stock-preparation-sync-run-persist.cjs`，但只 create、只对零行项目、只写画布主表。**

最小规格：

| 项 | 规格 | 依据 |
|---|---|---|
| 入口 | 新路由 + 新 action id，**不复用** `plm.stock-preparation.pull-bom.v1` | §2.7-2、§3.2 |
| 权限 | `requireAccess(req, 'admin')` 在任何 I/O 前 | `http-routes.cjs:4447` |
| 目标推导 | tenant ← 认证主体；projectId ← staging 推导；**绝不取自请求体** | `http-routes.cjs:4452-4453` |
| 作用域 API | `createTargetScopedRecordsApi(..., {createOnly: true})`（需新增该档） | `table-actions.cjs:476-524` |
| 准入 | 目标 `product_code` 在主表零行；命中即 409，**不跳过、不续载** | §3.1c |
| 原子性 | 一次 unit-of-work，全成或全不成 | §3.5 |
| 人列校验 | 载荷的 16 列必须**恰好等于** `derivePackAwarePlmWritableFields(...).humanPreservedFieldIds` 的子集；出现非 human、非 `ext_`、未分类列即拒 | `conflict-planner.cjs:299-406` |
| pack 前置 | ledger 有活记录 + `readObjectFieldsContent` 复核列真实存在 | migration 076 :9-10 |
| 策略 | 姊妹策略对象（`maxFirstLoadRows` + 严格 ISO `expiresAt` ≤7d + `requireFreshDryRun`），**立即接线**，不留悬空 | §3.2 |
| 行上界 | 按"读分页可证完整"立法，超界 422 | `sync-run-persist.cjs:76-86` |
| 溯源 | 依赖插件路径的 `source='plugin'` revision；另写 `row_imported` provenance 事件 | §3.3 |
| 墙 | **一个字节不动** | §3.4 |

宿主侧唯一依赖：放宽 unit-of-work 的"恰好 4 张表"约束（§2.6，→ **O-B**）。

### 4.2 被否方案

| 方案 | 否决理由（一句话） |
|---|---|
| 用 `POST /records` 做迁移主路径 | 无幂等、无跨行事务、revision `source` 与人手编辑不可分辨——T-2/T-3 的验收判据在这条路上无法满足 |
| 用 XLSX 导入做迁移主路径 | 同上，外加全字符串化、按标签首命中、50 000 行静默截断 |
| 用通用落表适配器 | main 上无所有权守卫，等于把"要防的失效模式"制度化；且 #5067 合并后即失效 |
| 给 `assertNoHumanFields` 加旁路开关 | 一个布尔参数把两处守卫降为建议 |
| 新增 `FIRST_LOAD` 决策类型 | 让刷新门同时管两个动作，门失去含义 |
| pack 临时把 16 列声明成 `plm_system` | 在窗口期把覆盖人列的权利交给**刷新**；且 8 个冻结列 `template_governed` 根本改不动 |
| 复用/放宽 `stock-preparation-production-policy.cjs` | 它把目标与动作钉死是它的价值，松开即削弱 apply 门 |

### 4.3 诚实的更便宜答案（有条件成立）

如果 owner 的意图是**先跑通一个项目看看**，而不是建迁移机制：
**XLSX 导入 + 人工核对**是合法且零代码的做法。成立条件（缺一不可）：

1. 单个 `product_code`，行数在人眼可核范围；
2. 接受"重跑 = 先删光该项目在该表的全部行"；
3. 接受该批值在 revision 上与人手编辑同 `source`，只能靠 actor + 时间窗判断；
4. 明确它**不是** T-2 双轨对账的基线——对账基线必须来自 §4.1 的路径。

这条路不与 §4.1 冲突：它是试点，§4.1 是机制。

---

## 5. 需要 owner 裁定的事项

| # | 决策 | 为什么必须先裁 |
|---|---|---|
| **O-A** | PR #5067（通用落表适配器所有权守卫）是否**先于**任何首载工作合并 | 它不合并，通用适配器就是一条绕过刷新墙写人列的现成路；首载再窄也挡不住它 |
| **O-B** | 是否批准一次 core-backend 改动：放宽 `validateStockPreparationPersistUnitOfWorkInput` 的"恰好 4 张表"约束（`packages/core-backend/src/multitable/stock-preparation-persist-unit-of-work.ts:37-39`） | 首载的原子性依赖它；不批准则只剩"逐行事务"，§3.5 的性质全部失去 |
| **O-C** | 首载准入粒度取 `product_code`（推荐）还是逐行 | 决定"半载"状态是否可能存在，进而决定对账基线是否可信 |
| **O-D** | 首载策略是姊妹对象（推荐）还是扩展现有生产策略 | 后者会松开 apply 门的目标/动作钉死 |
| **O-E** | 试点是否走 §4.3 的 XLSX 路径，以及是否接受其四条成立条件 | 决定短期是否需要写任何代码 |
| **O-F** | 首载动作的权限词表：沿用 `integration:write` 还是等 O-4（`stock-prep:read/operate/admin`）落定 | 现状权限过宽（状态账本 §3 O-4） |

---

## 6. 未能从代码核实的事项

1. **"形态 (b) PROVISION + MIGRATE"与状态账本"§3b"**：
   `beiliao-takeover-status-ledger.md` 的 §3 是 owner 决策队列（O-1…O-6），**没有 §3b**；
   全目录检索 `PROVISION` / `MIGRATE` / `形态` 零命中。
   本 ADR 因此按账本 §1（五步路线的第 3 步）与 `mysql-migration-plan.md` §2(1)(2) 的实际描述工作——
   两者描述的是同一件事（先建表建列，再镜像在制行），但"形态 (b)"这个措辞在 main 上不存在。
2. **`vertical-slice-one-project.md`**：base 上不存在，全仓 `*vertical-slice*` 零命中。未读到。
   若其中已定下准入粒度或标记形态，可能与 §3.1/§3.5 冲突，需复核。
3. **PR #5111 / #5067 的正文**：未取（本任务不联网/不查 PR）。
   #5067 的**代码**已确认不在 `origin/main`（§2.4），但其守卫的**具体形状**未读到，
   §2.4 关于"合并后即失效"的推断基于账本对该 PR 的一句话描述，非代码。
4. **人列 `ext_` id 的两套命名**：
   `customer-pack-rehearsal-report.md:48-51` 用 `ext_stockPrepDate` / `ext_pickingNode` /
   `ext_handoverSection` / `ext_blankLength|Width|Thickness|Quantity|Mass`；
   `demo-field-dictionary-spec.md:146-168` 用 `ext_prepareDate` / `ext_pickNode` /
   `ext_handoverSection` / `ext_embryoLength|Width|Thickness|Num|Quality`。
   **两份 main 上的文档对同一批列给了不同 id。** 首载载荷按哪一套映射，未决——
   这与账本 §4"迁移必须先做身份归一"是同一类问题，但账本没有点名这一处。
5. **毛胚五维的类型**：rehearsal 说 `(number)`（`:50-51`），
   `demo-field-dictionary-spec.md:164-168` 说"单行文本"，
   且 §附:197 论证源系统刻意存字符串（含单位）。类型选择未决，影响首载的值归一。
6. **`meta_record_revisions` 的建表迁移**：在 `packages/core-backend/migrations/` 下检索不到该表名，
   只在 `src/` 里被读写。因此 `source` 列**是否有 CHECK 约束**未能核实；
   §3.3 的判据只依赖"插件路径写 `plugin`、REST 路径写 `rest`"这一对已核实的调用点，不依赖约束存在。
7. **本 ADR 未做任何运行时验证**：未跑测试、未起服务、未连库。全部结论来自静态阅读。

---

*本文属技术负责人(T)层的设计提案；§5 全部条目属 owner(O)层，先批后动。
任何一项状态变化应就地更新本文，不另起快照（沿用状态账本的纪律）。*

---

## 附录:必须在 mapper 之前解决的文档矛盾(2026-08-23 核实)

**已合入 main 的两份文档,对同样 8 个人工列给出了两套不同的 `ext_` 逻辑 id**,而逻辑 id 决定确定性物理字段 id —— 按哪一套写 mapper,就决定值落进哪一列:

| 语义 | `customer-pack-rehearsal-report.md` | `demo-field-dictionary-spec.md` |
|---|---|---|
| 备料日期 | `ext_stockPrepDate` | `ext_prepareDate` |
| 领料节点 | `ext_pickingNode` | `ext_pickNode` |
| 毛胚长度/宽度/厚度/数量/质量 | `ext_blankLength` … | `ext_embryoLength` / `ext_embryoWidth` / `ext_embryoThickness` / `ext_embryoNum` / `ext_embryoQuality` |
| 交接工段 | `ext_handoverSection` | `ext_handoverSection`(一致) |

两者还在"毛胚五维是 `number` 还是 text"上不一致。

**后果**:任何照文档写的 mapper 会挑中其中一套,另一套对应的列**永远收不到值**,并在表上留下第二组语义重复的空列。这正是账本 §4 记录的身份归一陷阱(源系统 10 处字典不一致、"直接按 identity 映射会生成两个独立字段"),只是它**已经发生在我们自己的文档之间**,而不是在客户的遗留库里。

**处置**:mapper 动工前必须先裁定一套权威 `ext_` id 与类型,并把落选的一份就地更正(不是删除——按本目录惯例,失效要留痕)。**在此之前不要写 mapper。** 这一条与 O-6(物料字典载体)一样,属于"改了才能开工"的前置,不是可以边做边定的细节。
