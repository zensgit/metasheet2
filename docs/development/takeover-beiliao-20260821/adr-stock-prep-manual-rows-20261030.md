# ADR：备料项目表的人工补充行（PR-B 系列）

- 补充（2026-11-19）：§12 提议让人工行可以指定、修改父组件，修订 OQ5，**待 owner 确认**；确认前本文其余部分照旧有效。
- 状态：**已裁决**。owner 在 2026-10-30 对 OQ1–OQ8 答复「按建议」。设计经过两轮独立评审，第 2 轮结论是可以交 owner，无阻断项。实现尚未开始。
- 基线：文中所有 `path:line` 都指 main `2006826d772b9f693d878bff7d18bf275dead299`（简写 2006826d7）。写成 `r78:` 的，指 onprem-r78 = `2747f688b`。
- 登记号：本系列新增一行 **R-??**，合并时取号（R-65 留给批次标识，R-66 已用，R-67 已被一个草稿 PR 占用）。同时修订 R-66 ①（§10）。

## owner 裁决（2026-10-30，「按建议」）

这一节可以单独阅读。本文把「已登记的项目表」简称为「登记表」。

- **OQ1 交付顺序：RULED**
  - 先在 main 上按 B1 → B2 → B3 → B4 依次合入。
  - R79 在 R 线上重新实现这四支。R 线代码和 main 差得多，所以要在 R 线上单独做对抗核验和真库核验。
  - R 线缺哪些模块，用 `git diff --name-status onprem-r78 <当时的 main>` 机械地列出。
  - 这一条取代 10-27 的「不移植 R 线」。原因：按 10-26 的裁决，客户在第 4 步试点就绪前一直用 R 线的包，所以「等第一个基于 main 的包」实际上没有日期。
  - R79 打标签，需要 owner 另行批准。
- **OQ2 修订 R-66 ①（「谁都不能删 PLM 行」）：RULED**
  - 原则不变，只放行两类行：
    - 人工补充行：唯一键正好是 `manual:v1:<本行记录 id>`，有建行人，并且在登记表上。
    - 唯一键以 `manual:` 开头、但不是本行的人工键，并且有建行人的行。拉取今后不再维护这类行。
  - 除这两类以外的 PLM 行，仍然任何人都不能删，包括平台管理员。
- **OQ3「来源」：RULED**
  - 表里不新加「来源」列。这一条偏离了 10-27 原话「服务器盖来源」，属于有意偏离。
  - 正式导出只在含有非 PLM 行时才多出一列「来源」，取值为：人工补充、人工（非补充）、PLM。只有 PLM 行的导出与今天逐字节相同。
  - 网格里，人工补充行的行首显示「人工补充」。
  - 导出的列数会随内容变，「沿用说明」可能在第 31 列，也可能在第 32 列。所以下游读导出时一律按表头取列，不按列号。
- **OQ4 提醒：RULED**
  - 只把本次拉取里新出现的 PLM 行（也就是新增的行）拿来和人工行比较。
  - 判断「同一物料」：图号相同即算；人工行没填图号时，名称、规格、材料三项都相同才算。
  - 提醒显示在项目同步面板。
  - 每次拉取的提醒计数要落盘，只存数字，不存具体值；这样无人值守的拉取也不会把提醒丢掉。
  - v1 只在常规（小 BOM）车道上提醒。
  - 永远不自动合并。
- **OQ5 复制与可填列：RULED**
  - 「复制为新行」不复制父组件图号和父组件名称，复制出来的行会落在填写视图的「无父件」组。
  - v1 不加「单位」列。
  - **2026-11-19 修订提议（待 owner 确认）**：人工行可以指定、修改父组件，复制是否带父组件改由 OQ-P1 决定，见 §12。
- **OQ6 谁拨开关：RULED**
  - 「允许人工补充行」开关由备料主管理员（`stock-prep:admin`）拨，平台管理员也可以拨。
  - 每次切换都记审计。
- **OQ7 表单：RULED**
  - 表单不改，保留 R-66 ③ 写明的效果。
  - 要知道的差别：在没加锁的登记表上，补锁之前，网格、接口、导入的新建会被拒绝，表单的新建却仍然可用。补锁之后这个差别就没有了。
- **OQ8 上线清单：RULED**
  1. 上线前的只读探针要读客户数据，由 owner 执行或批准。
  2. 探针 1 的范围扩到 env 表和主表，另加一项「人建行」计数。
  3. 先清理唯一键以 `manual:` 开头的异常行，再补锁。
  4. 没加锁的登记表，在装包的窗口里补锁。补锁是生产写，届时另行批准。
  5. 提前告诉客户：「允许人工补充行」默认打开，上线后已加锁的项目表都会出现「新增人工补充行」；env 表和「复制数据表」做出的副本不在本次范围内。

### 客户会看到什么

- **已加锁的登记表**
  - 多出「新增人工补充行」：只需填名称和总用量，项目号由系统自动填。
  - 多出「复制为新行」。
  - 人工行可以改、可以删，行首标「人工补充」。
  - PLM 行照旧不能删，PLM 来的列照旧不能改。
- **拉取**
  - 拉取不修改人工行，也不把它们标成无效。
  - 如果 PLM 新出现了同一物料，项目同步面板会提醒，但不会合并。
  - 键被手改成 `manual:` 开头的异常行，拉取不再处理，面板显示它们的数量和处理办法。
- **正式导出**
  - 导出里包含人工行，出现非 PLM 行时多一列「来源」。
  - 只有 PLM 行的项目，导出和今天完全一样。
- **开关**
  - 备料主管理员可以按表关闭这个功能。
  - 关闭后按钮隐藏；有人用别的方式提交，服务器会拒绝并说明原因。
- **没加锁的登记表**：补锁之前，新建入口显示「需管理员修复本表」；补锁之后与已加锁的表相同。
- **env 表、副本**：没有任何变化。

### 拆分

按顺序合入：**B1 → B2 → B3 → B4**。B4 也可以在 B2 合入后与 B3 并行。

- **B1（插件）**：拉取不碰人工行；导出加上「来源」；计算提醒并落盘。只合入 B1 时没有可见效果。
- **B2（主机）**：新增、复制、修改人工行的路由；删除豁免；开关在服务器端生效。仍然没有界面。
- **B3（多维表网页）**：新增、复制、修改人工行的界面；通用新建按状态拒绝。
- **B4（插件路由与项目面板）**：开关的界面；提醒和异常行的数量。
- **B5（加「来源」列）：不做。** OQ3 已裁定不加这一列。

## 1. 背景

- 现场在项目表上点「新增记录」，报「项目号 is required」。这句话来自服务器端的必填校验：
  - 模板有 6 个必填列（`stock-preparation-templates.cjs:700-701`、`:704`、`:738`、`:758`、`:759`），在 `:502` 被转成校验规则。
  - 建行时由 `record-service.ts:873-881` 执行（字段组装见 `:589-604`），文案出自 `field-validation-engine.ts:27`。
- 已加锁的项目表从 R70 起就隐藏了新建入口（`MultitableWorkbench.vue:1078-1079`，用在 `:253` 和 `:333-480`）。所以报错的那张表一定没加锁。

## 2. 人工行的身份

### 2.1 为什么用 `manual:v1:<id>`，而不是空键加「来源」列

**空键方案的问题**
- 规划器会把有建行人的空键行判成待确认 `foreign_existing_row_missing_idempotency_key`，计划因此无效（`stock-preparation-conflict-planner.cjs:1604-1615`、`:1887-1888`）。
- 要让空键方案成立，就得有一个正向标记。唯一不需要迁移的做法是新加一列，而给存量表加列是 O 层的生产写。
- 只看 created_by 也不行：会把遗留的人建行悄悄改判成人工行。GOV-05 正是为了让这类行显形才加的（`:110-129`）。

**键前缀方案的依据**
- 标记就放在现有的唯一键列里，这一列在项目表上对人加锁（`stock-preparation-project-targets.cjs:299`、`:339-341`）。
- 记录 id 由服务器在事务前生成（`record-service.ts:666`）。
- 键与 created_by 由同一条 INSERT 写入（`:904-908`）。
- 这也是 owner 的原话。
- 代价是 R-66 ① 要修订，见 OQ2 和 §10。

### 2.2 判定式

**主机侧 M**（新模块 `packages/core-backend/src/multitable/stock-preparation-manual-rows.ts`），四条同时成立：
- (a) 主机登记表里有这张表的行，plugin_name 为 `plugin-integration-core`，object_id 匹配 `^plm_stock_preparation_sandbox_p_[0-9a-f]{24}$`。这与 R-66 ② 的定义相同（`stock-preparation-project-sheet-schema-clamp.ts:53-57`、`:82-83`、`:95-110`；`stock-preparation-project-sheet-grant-contract.ts:44`）。
- (b) 带精确 stanza 且 `key === true` 的列恰好一列，记作 K（`plm-row-delete-guard.ts:127-138`）。
- (c) `meta_records.created_by` 非空。
- (d) `data[K]` 与 `'manual:v1:' + 本行 id` 全等。

**插件侧 M′**（新模块 `plugins/plugin-integration-core/lib/stock-preparation-manual-rows.cjs`）：
- (a′) `action.target.objectId` 匹配同一模式（`stock-preparation-own-base.cjs:130`）。目标绑定取的是登记行（`stock-preparation-project-targets.cjs:181-186`）。
- (c′) 信封里的 `createdBy` 非空（`stock-preparation-table-actions.cjs:1118-1129`；信封来源 `query-service.ts:272-281`）。
- (d′) 信封数据里键列的值与 `'manual:v1:' + 信封 id` 全等。
  - 直接读信封，不依赖 main 才有的 `EXISTING_ROW_RECORD_REF`；r78 的读取口没有这个字段（`r78:stock-preparation-table-actions.cjs:1100-1125`）。

**前缀行**：键是以 `manual:` 开头的字符串。这一段命名空间保留给人工行。
- 满足 M′ 的前缀行就是人工行。
- 其余前缀行称为「未绑定前缀行」。

**删除豁免 E**（OQ2）：在 R-66 ① 守护的任何表上，前缀行只要有建行人，就可以删。M ⊂ E。

**两边一致**：主机和插件的实现用契约测试钉在一起：同一张真值表，前缀常量逐字节相等（做法同 `stock-preparation-project-sheet-schema-clamp.ts:112-117`）。判定式两边都不看锁，理由见 §2.3 ④。

### 2.3 证明

**① PLM 键不会以 `manual:` 开头**
- 展开层生成的键以 `{` 开头（`stock-preparation-bom-expansion.cjs:1633-1640`），去重后的键也一样（`stock-preparation-conflict-planner.cjs:893-903`、`:104-108`）。
- ADD 只来自展开行（`:1703-1740`）。
- B1 之后，UPDATE 和 INACTIVE 的键取自读取口，而前缀行已被摘出（§5.1）。
- 写入口在 ADD 上硬拒前缀键（§5.2）。

**② 拉取维护的行，在任何表上都不满足 M，也不满足 E**
- 理由在 (d) 和前缀，不在 created_by：
  - 拉取只按 PLM 键寻址并写入：ADD 碰到已有行时改它（`stock-preparation-apply-writer.cjs:610-640`），UPDATE 和 INACTIVE 见 `:786-792`。
  - 所以凡是拉取维护的行，键都以 `{` 开头。
- 例外：#6598 之前的右击副本，created_by 是人，拉取照样维护它，但它的键同样以 `{` 开头。
- 另外，插件 SDK 建行时不写 created_by（`records.ts:761-768`），src 里也没有任何语句改 `meta_records.created_by`。给 created_by 赋值的只有 field_permissions 和 delegated_role_admin_* 两类表（`univer-meta.ts:8295`、`:10721`，`stock-preparation-field-permissions.ts:1165`，`admin-users.ts:2939`、`:3016`、`:3180`、`:3194`）。

**③ 已加锁的项目表上，人不能写、伪造或清除这个键**
- 每个人员写入口都按锁拒绝：
  - 建行：`record-service.ts:735-738`
  - /patch：`univer-meta.ts:21299-21306` 和 `record-write-service.ts:557-564`
  - PATCH /records：`:19139-19146`
  - 表单：`:18486`
  - Yjs：`index.ts:5106`
  - 自动化：`automation-executor.ts:2889-2904`
- 通用复制整条拒绝（`univer-meta.ts:20488-20489`）。
- 新行 id 由服务器生成（`record-service.ts:666`，表单在 `univer-meta.ts:18653`），人无法事先知道。

**④ 没加锁的表**
- 包括：env 表和主表（从不加锁，`stock-preparation-project-targets.cjs:332`、`:345-353`）、R67 之前登记且没修复的项目表、副本。这些表上人能写键列。
- B2 不允许在这些表上新增人工行，所以这里不存在真正的人工行。
- 有人手写前缀键能做到的事，今天先清空键再删也能做到。所以这并不比现在多给能力。
- 由插件建的行（created_by 为空）即使被写成前缀键，也不满足 E，仍然不可删。

### 2.4 B1 之后：拉取与回收站

**拉取**
- add_missing 按 PLM 键找行（`stock-preparation-apply-writer.cjs:258-266`），永远找不到前缀行。
- duplicate_existing_key（`stock-preparation-conflict-planner.cjs:1642-1653`）、foreign 待确认（`:1604-1615`）、置无效扫描（`:1826-1859`）这几步，前缀行一律不进入。
- 今天未绑定前缀行会被置无效，B1 之后改为摘出、不碰、计数。原因：对真人工行来说这是失败安全的；万一 M 与 M′ 不一致，人工行也不会被置无效。
- 代价：未绑定前缀行会一直留着，所以面板显示它们的数量，并且按 E 允许删除（OQ2、B4）。

**不经过读取口的消费方**：会看到前缀行，符合预期。
- 他项目守卫（`stock-preparation-table-actions.cjs:1219-1262`）：人工行的项目号就是登记表的 project_no，不需要改。
- 总览计数（`stock-preparation-project-overview.cjs:541-586`）。
- 交接时判断「项目有没有主表行」（`stock-preparation-prep-line-export.cjs:998-1014`，由 `http-routes.cjs:12984` 调用）。这两处都会把人工行算进去，T 层默认接受。

**回收站**
- 恢复时按「有没有同键的活行」判断（`plm-row-delete-guard.ts:220-239`）。人工键是唯一的，所以放行。
- 恢复后保留原 id 和原 created_by（`record-service.ts:1451-1455`）。

## 3. 主机侧

### 3.0 适用范围

- P_reg 的定义：满足 (a)，并且插件登记表 `integration_stock_prep_project_target` 里有这张表的行，不论状态。
- 只有 P_reg 成立的表才有：人工行功能、/context 里的人工行块、通用新建的拒绝。
- 其余表保持现状：env 表、主表、副本、领养的旧沙箱表，以及只做过 provision、没有插件登记行的表（例如真库用例 PB-05 用的那张表，`stock-preparation-fieldperm-write-gate-realdb.test.ts:1431-1432`）。
- 主机读登记表时只用 087 就有的列：sheet_id、project_no、status、object_id、tenant_id（`087_create_integration_stock_prep_project_target.sql:49-100`）。SQL 是固定的。
- 读取失败时：
  - 报 42P01（表不存在），视为 P_reg 不成立，保持旧行为。
  - 其他错误：写路由回 503，/context 报 `unavailable/registry_unreadable`，网页照样隐藏通用新建。这一边失败关闭。
  - 按 SQLSTATE 判断，不看报错文字。

### 3.1 门：哪些变、哪些不变

**不变**
- canCreateRecord 仍由 `record-service.ts:661-663` 检查；新增和复制都要求它。
- 修改要求 canEditRecord、行策略允许、记录未锁定。
- 删除的门不变，豁免见 §3.5。
- recordCreateBlockedByLock 语义不变（`univer-meta.ts:9628-9630`、`human-write-lock.ts:106-113`）。但它在没加锁的表上为假，网页靠它隐藏不了入口，所以 B3 改看人工行块（§3.7）。

**通用新建按状态拒绝（B3）**
- 适用于 P_reg 表上的 POST /records（会话和 mst_ 令牌走同一条路由）和导入 xlsx（`univer-meta.ts:16712` → `:16774`）。
- 拒绝放在调用 createRecord 之前，回 409，原因和文案按状态区分：

| 人工行状态 | 码 / reason | 文案 |
|---|---|---|
| allowed | `STOCK_PREP_PROJECT_SHEET_CREATE_USE_MANUAL_ROW` | 备料项目表上请用「新增人工补充行」新增行；PLM 行由拉取写入。 |
| disabled | `STOCK_PREP_MANUAL_ROWS_DISABLED` | 本项目表已关闭「允许人工补充行」，不能新增行；如需新增请联系备料管理员。 |
| unavailable / lock_missing | `STOCK_PREP_MANUAL_ROWS_UNAVAILABLE` | 本表的 PLM 列锁还没有补齐，暂时不能新增行；请联系管理员修复本表。 |
| unavailable / project_archived | 同上 | 本项目的备料表已归档，不能新增行。 |
| unavailable / project_sheets_off | 同上 | 「一个项目一张备料表」功能未开启，不能在这张表上新增行。 |
| unavailable / contract_mismatch | 同上 | 本表结构与备料模板不一致，暂时不能新增行；请联系管理员核对本表。 |
| unavailable / registry_unreadable（503） | 同上 | 暂时读不到项目登记信息，请稍后重试；仍不行请联系管理员。 |

- 只有 `allowed` 一种状态会引导人去点「新增人工补充行」。
- 没有插件登记行的表（例如 PB-05）仍回原来的 422 或 403。

### 3.2 新增：`POST /api/multitable/sheets/:sheetId/manual-rows`

**请求**：`{ data: { <物理字段 id>: 值 } }`，只接受会话请求。

**前置条件**（按顺序检查，任何一条不满足都在写入前拒绝）：
1. canCreateRecord。
2. P_reg 成立；否则 reason 为 not_project_sheet。
3. K、项目号、有效三列都带 `humanWriteLock`；否则 lock_missing。
4. 插件登记行为 active，且 object_id 与主机登记一致；否则 project_archived、registry_unreadable 或 contract_mismatch。
5. `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 精确等于 `'true'`，每次请求都读，读法与插件相同（`stock-preparation-project-targets.cjs:101-103`）；主机读备料开关有先例（`services/stock-preparation-members.ts:294`）。否则 project_sheets_off。
6. 开关不是 disabled；否则回 `STOCK_PREP_MANUAL_ROWS_DISABLED`。

第 3、4、6 条在建行事务里、拿到栅栏之后检查（`record-service.ts:686-691`）：用事务内重读的字段（`:696-699`），登记行也在同一事务里读。

**物理字段 id**
- 由主机登记行的 (project_id, object_id) 加逻辑 id 推导（`provisioning.ts:207-225`）。
- 推导出的 K 必须等于 (b) 的 K，否则失败关闭。

**实现**：在 `RecordService.createRecord` 上加一个「人工补充」扩展。
- capabilities 仍是操作人在这张表上解析出来的那份，并照旧检查 canCreateRecord。开启扩展靠一个模块私有的令牌对象。
  - 这和「复制数据表」不同：那条路径直接把服务器常量当作能力对象（`:642-651`）。
- 锁豁免只给 6 个可填的锁定列：componentCode、componentName、componentSpec、material、rawQuantity、totalQuantity（`stock-preparation-templates.cjs:743-757`）。
  - 写盖章列或身份列，照旧回 403 `FIELD_READONLY_PLM_SYSTEM`。
  - 人工列照常可写，逐人字段权限照常生效。
- 盖章：
  - 项目号 = 登记行的 project_no；
  - 唯一键 = `'manual:v1:' + recordId`；
  - 有效 = true；
  - 身份列和 RUN 列留空。
- 必填改写只作用于这一次建行：去掉 componentSourceId、path 的必填，给 componentName 加上必填。
- created_by 写操作人（`:904-908`）。

### 3.3 复制为新行：`POST /api/multitable/records/:recordId/manual-copy`

- **为什么另开路由**：通用复制拷的是「能读又能写」的列（`univer-meta.ts:20434` 起），而且在插件维护表上被拒。这里改用显式白名单。
- **源行**：
  - 必须在同一张 P_reg 表上，操作人在记录级能读到它。
  - 只拷操作人对源列有读权限的列。人工列还要能写。
- **白名单**：由普查测试钉住。测试从主机侧 require 插件模板，模板 33 列要求每列恰好归入一类：

| 类 | 列（`stock-preparation-templates.cjs`） | 规则 |
|---|---|---|
| 人工可填（6） | componentCode :743、componentName :744、componentSpec :754、material :755、rawQuantity :757、totalQuantity :758 | 拷 |
| 谱系显示（2） | parentComponentCode :736、parentComponentName :737 | 不拷（OQ5） |
| 备料计划（5） | materialType :767、blankType :771、demandDate :779、leadTimeDays :780、makeOrBuy :813 | 拷 |
| 进度与回复（8） | stockPreparationStatus :775、notes :781、procurementReply :782、warehouseConfirmation :783、procurementDone :840、procurementReplyDate :841、warehouseDone :842、actualArrivalDate :845 | 不拷 |
| 身份与 RUN（9） | componentSourceId :704、parentSourceId :705、path :738、depth :739、sourceVersion :756、lastPlmRefresh* :760-762、lastPlmConflictSummary :766 | 不拷 |
| 盖章（3） | projectNo :700、idempotencyKey :701、active :759 | 只由服务器写 |

> **修订 2026-11-06（R-71 ⑦.4 PR-4）**：模板末尾加了 `issueConfirmDate`（发料确认日期，宜搭回写的机器列）和 `projectSpecModel`（项目规格型号，空列，来源待 F1）两列，普查变为 **35 列**；两列都归入「身份与 RUN」类，该类由 9 列变为 **11 列**（「身份与 RUN 与机器列」，不拷；主机侧 `stock-preparation-manual-rows.ts` 的 `MANUAL_ROW_IDENTITY_RUN_FIELD_IDS`，普查测试 K-05 钉住）。上表的行号与列数是 2026-10-30 的原文，不改写。`projectSpecModel` 有来源之后（F1 的 PR）要重新判断它该不该拷。

- **谱系两列为什么不拷**：
  - 它们属于 `DERIVED_LINEAGE_DISPLAY_FIELD_IDS`（`stock-preparation-continuation-pairing.cjs:162`），机器摘要也包含它们（`:812-820`）。
  - 拉取不会改人工行，所以拷过去以后会永久过期。
- **模板以外的列**：
  - `ext_` 列：ownership 为 human_preserved 的拷，其余不拷。
  - 没有 stanza 的列：能读又能写才拷。
- **建行**：之后走 §3.2 的同一个扩展，新行有自己的键，不会和源行同键。

### 3.4 修改：`PATCH /api/multitable/records/:recordId/manual-fields`

- **只改哪些列**：只改那 6 个可填的锁定列。/patch 不动：网页的编辑都走它（`client.ts:3698`），在它上面加逐行逐列的豁免，一个缺陷就会把所有 PLM 行的锁打开。
- **前置条件**：
  - 这一行满足 M，K 已加锁；
  - canEditRecord，行策略允许，记录没被锁定；
  - 提交的字段都在那 6 列里。
- **写入**：
  - 走 `RecordWriteService.patchRecords`，只写这一条记录。
  - 字段守卫表只对这 6 列去掉锁带来的只读，其余限制照旧；`record-write-service.ts:557-564` 不改。
  - 名称、总用量不能清空，否则回 422。
- **网页侧的配合**：
  - 抽屉里一次保存分两步：6 列走这条路由，其余列走 /patch。这两步不是原子的；第二步必须带第一步返回的 version，冲突就重新加载。
  - 网格里对这 6 列的撤销和重做，走和编辑相同的路由选择；做不到的单元格，从撤销栈里排除，不回放到 /patch。否则会回 403。
- **仍然只读的场景**：区域填充、粘贴、Yjs 协作对这些单元格仍按只读处理（`index.ts:5106`）。

### 3.5 删除与恢复（改 `plm-row-delete-guard.ts`）

- **表画像**：画像（`:169-178`）的登记表查询顺带取出 object_id 和 plugin_name，仍然只有一条语句。
- **判断函数**：`plmRowDeleteRefusalReason`（`:193-201`）加一个可选参数 `row: { id, createdBy }`。满足 E 的行返回 null，即可删。
- **传入行身份的调用点**：
  - 人的删除入口：`record-service.ts:1059-1064`（`:1036` 已经读出 createdBy）；
  - 4 处展示：GET /view（`univer-meta.ts:18000-18007`、`:18080-18093`）、GET /records/:id（`:19576-19585`）、表单 context（`:18276-18289`）。
  - 创建人用 `loadRecordCreatorMap` 只查前缀行。
- **不传行身份的入口仍然拒删**（保守）：
  - 插件 SDK（`records.ts:1002-1006`）；
  - 自动化（`automation-executor.ts:3643-3648`）；
  - 时光机的 reset（`recovery-plan-authorization.ts:100-108`）。
- **恢复**：不改（§2.4）。

### 3.6 表单（OQ7：不改）

- R-66 ③ 原文写明视图管理打开「表单分享（可发布匿名表单，匿名提交会在表里新建记录）」，层级 O，RULED（`decision-register.md:70`）。表单的 INSERT（`univer-meta.ts:18812-18822`）因此保持原样。
- **表单造不出人工行**：
  - 表单不盖章；
  - id 由服务器预先生成（`:18653`）；
  - 加了锁的表上键列只读（`:18486`）。
- **created_by**：匿名提交时为空，已登录的填表人则记为本人（`:18812`）。
- **实际效果**：
  - 加了锁的表上，表单新建过不了必填校验（`:18615-18633`）。
  - 没加锁的 P_reg 表上，补锁之前表单新建仍可用（OQ7 已写明），填表人手写的前缀键可能产生未绑定前缀行（B4 面板会计数）。

### 3.7 /context 与 /view

- **/context**：只在 P_reg 表上下发，且只给能新建、修改或删除记录的人。内容：`stockPreparationManualRows: { state: allowed | disabled | unavailable, reason?, editableFieldIds, requiredFieldIds }`。
  - 放在 `canCopySheet` 之后（`univer-meta.ts:9619`），避开 r78 与 main 有差异的那几行（`:9631-9638`）。
  - 没有 stanza 的表不多发一条语句；普通表和非 P_reg 表的返回体逐字节不变。
- **/view 和 /records/:id**：满足 M 的行，rowActions 带 `manualSupplement: true`（`univer-meta.ts:18080-18093`；类型在 `access.ts:39-46`）。
- **网页（B3）**：只要 /context 带人工行块，不论处于哪种状态，就隐藏全部通用新建入口，并按状态显示人工行入口或原因。

## 4. 开关

- **存储**：存在 K 的字段属性 `stockPreparationManualRows` 上。
  - 缺省（没有这个属性）就是允许；值为 `'allowed'` 也是允许。
  - 有值但不是 `'allowed'` 的，一律算关闭。
  - 插件通过 `provisioning.patchObjectFieldProperty`（`provisioning.ts:678-732`）写入。包装层没有键白名单（`plugin-scope.ts:1003-1017`），合并是逐键覆盖（`provisioning.ts:268-291`）。不需要迁移。
- **净化**：写（`provisioning.ts:699`）和读（`field-codecs.ts:565`）两头都要跑。
  - B2 在横切链（`field-codecs.ts:246-255`）里加 `withManualRowPolicyKey`：值存在但不是 `'allowed'` 时规范成 `'disabled'`，不丢弃。
  - 照搬 `withHumanWriteLockKey`（`human-write-lock.ts:125-135`）那种丢弃做法不行：值被丢掉就等于缺省允许，变成失败开放。
- **谁能拨**：
  - `stock-prep:admin`；平台管理员同样满足（`stock-preparation-workbench-access.cjs:681-686`）。
  - 路由：`GET` / `POST /api/integration/stock-preparation/projects/:projectNo/target/manual-rows`，加进路由表（`http-routes.cjs:244-270`）。
  - 租户用 `resolveOperatorValueScope` 解析（`:11392-11397`），不读请求头。
  - POST 要求请求体里键入的项目号一致，写完后回读确认。
  - 已归档时 POST 回 409 `STOCK_PREPARATION_PROJECT_ARCHIVED`，GET 照常回答。
  - 总开关不是精确 `'true'` 时回 404。主机此时同样拒绝新增（§3.2 第 5 条），两边一致。
- **审计**：
  - 复用 088 的动作 `project_fields_update`（`stock-preparation-audit-store.cjs:100`；用法见 `http-routes.cjs:11400-11414`），mode 为 `manual_rows_allowed` 或 `manual_rows_disabled`。
  - 一个动作配多个 mode 有先例（`plainLanguage.ts:3748-3764`）。
- **人的字段路由改不了这个值**：
  - POST /fields 剥掉它（`univer-meta.ts:6312`）；
  - PATCH /fields 保留原值（`:14534`）；
  - 配置回滚同样保留原值（`config-restore.ts:27-33`）。
- **关闭的含义**：只挡新增和复制为新行。已有的人工行照旧可以改、删、恢复。
- **部署级开关**：不加。将来如果要加，只能做成急停：精确 `'true'` 才关闭新建，并登记进 flag manifest。

## 5. 插件侧

### 5.1 读取口：摘出全部前缀行，分页按原始页长

- **逐页处理** `readExistingStockPreparationRows`（`stock-preparation-table-actions.cjs:1144-1169`）的原始 `pageRows`，逐条判断：
  - 前缀行里，满足 M′ 的放进人工行列表，其余记入未绑定前缀行计数（另记最多 50 个记录 id）。两种都不进入返回给规划器的行。
  - 其余行照旧处理（`:1163`）。
- **两条写死的规则**：
  - 末页判断用原始页长：`if (pageRows.length < limit)`（`:1164`）。默认 1000 行一页（`:162`）。
  - 页数上限按原始页计算（`:163`、`:1166-1168`）。
- **返回值**：前缀行放在数组的 Symbol 属性上，不进数组本体，也不参与哈希（同 `:1131-1142` 的做法）。没有前缀行的表，读出的行、修订号和令牌都逐字节不变，由 `stock-preparation-continuation-golden.test.cjs` 钉住。
- **消费方**：
  - 小车道：`:2450` → `:2467-2469`，结果进 buildRevision（`:2502`）；
  - 大车道：`http-routes.cjs:8774-8778` → `stock-preparation-large-bom-jobs.cjs:1667`、`:1705`；
  - change-plan 页与复核：`http-routes.cjs:4801-4808`；
  - 正式导出门：`:12381`；
  - 试点就绪：`stock-preparation-pilot-readiness.cjs:271-277`；
  - 结算摘要：`stock-preparation-refresh-lanes.cjs:375-379`。
- **代价**：未绑定前缀行不进结算摘要。这只会发生在没加锁的表上，而受治理项目必过 `plm_column_lock`（`stock-preparation-pilot-readiness.cjs:245-247`），所以在受治理项目上不会发生。
- **结果字段**：试算和执行的结果都带 `manualSupplement: { rowCount, unboundKeyCount, matchedManualCount, matchedManualRecordIds, unboundRecordIds }`。
  - 只在 rowCount 或 unboundKeyCount 大于 0 时出现；不进 plan，也不参与哈希（先例 `:2442-2447`）。
  - 两个 id 列表最多各 50 个，都是人工行或前缀行的记录 id。试算时新增的 PLM 行还没有记录 id。

### 5.2 写入口：只在 ADD 上拒收 `manual:` 键

- 拒收放在 `applyAddDecision` 里，取到键之后立即判断（`stock-preparation-apply-writer.cjs:610-611`），回 `APPLY_MANUAL_KEY_RESERVED`，只让这一条决定失败。
- 不放进共用的 `decisionKey`（`:229-243`）：它的调用点有 `:363`（批量预取）、`:611`、`:787`、`:1054`、`:1060`、`:1094`，放进去会让 UPDATE 和 INACTIVE 逐条失败（`:1099`）。
- 要有一条测试证明批量预取路径不会因此抛错。

### 5.3 提醒与落盘（OQ4）

- **比对范围**：只比对本次计划里的 ADD 决定（`stock-preparation-conflict-planner.cjs:1740`）。规则：
  - 图号去掉首尾空格后相同；
  - 人工行没有图号时，看名称、规格、材料三项。
- **落盘**：每次小车道的试算或执行结束后，都把最近一次的结果写进插件的持久存储 `context.storage`（`plugin_kv`，`packages/core-backend/src/plugins/plugin-durable-storage.ts:100-126`；大 BOM 作业也存在这里，`http-routes.cjs:5092`）。
  - 键：`stockPrepManualRows:lastPull:v1:<sheetId>`。
  - 值：`{ at, mode, rowCount, unboundKeyCount, matchedManualCount, matchedManualRecordIds, unboundRecordIds }`。只有时间、计数和记录句柄，不含业务值。
  - 有这份落盘，定时任务的执行（`scripts/ops/stock-preparation-scheduled-pull.mjs:25-30` 默认只试算，`--apply` 才执行）也不会让提醒丢掉。
- **展示**：项目同步面板显示最近一次拉取的提醒（B4）。PLM 行作为新增只出现一次；落盘的值保留到下一次拉取覆盖为止。
- **大车道 v1 不提醒**：大车道不经过 `computeDryRun`；`normalizeExistingRows` 用 `cloneJson` 复制，Symbol 会丢（`stock-preparation-large-bom-jobs.cjs:1186`）。前缀行在进大车道之前已在读取口被摘出，这一点不受影响。

### 5.4 步骤 5：change-plan、受控更新、复核失效

人工行永远不会进入这三者：
- change-plan 的记录来自第一遍规划产生的待确认项，规划的输入就是读取口的结果（`stock-preparation-conflict-planner.cjs:1501-1531`）。
- 受控更新绑定的是「记录 id + 键」（`stock-preparation-continuation-pairing.cjs:1917-1923`）。
- 复核登记只按写过的键和 id 建索引（`:1892-1902`）。
- 内容检测只看读取口的行（`:1935-1948`、`:1982-2021`；规划器在 `:1811-1818`）。

### 5.5 与批次标识 BI-1（未提交草稿）的关系

- 没有硬依赖，人工行可以先交付。两支里后合的那支负责把「按批次列标记盖章」接进 B2 的盖章列表，并把已有人工行回填成「人工补充」。
- 前向要求：BI 草稿判断人工行用的是「建行人非空 ∧ 键以 `manual:v1:` 开头」，必须改用 §2.2 的共享判定式；被归为未绑定前缀行的，BI 也不得处理。
- R-65 仍然留给 BI。

## 6. 导出、正式导出门、归档对比

**「来源」列**
- **实现方式**：与沿用说明一样，做成独立常量，不放进 `EXPORT_COLUMNS`，因此不参与字段解析。字段解析的列由 `EXPORT_COLUMNS` 派生（`stock-preparation-prep-line-export.cjs:194-197`），解析逻辑在 `:788-823`。
- **何时出现**：只要打印的有效行里有一行不是 PLM 就出现，不论在 env 表还是项目表。与沿用说明的先例一致（`:182-191`、`:950`）。
  - 只有 PLM 行时，工作簿和审计行逐字节不变（导出门的 C09）。
  - 导出夹具不带 createdBy，所以纯 PLM 金样保持不变。
- **位置**：紧跟第 30 列（`:178`）之后。沿用说明仍是最后一列，可能在第 31 列，也可能在第 32 列，交付说明要写「按表头取列」。
- **取值**：
  - 满足 M′ 的行：人工补充；
  - 其他前缀行（不论有没有建行人）和其他有建行人的行：人工（非补充）；
  - 其余行：PLM。
- **判断依据**：判断放在 `unmapRow`（`:825-838`），createdBy 从信封带出。`target.objectId` 由 `normalizeExportTarget` 保留下来（`:294-311`）。键在排序阶段已经解析好（`:228`、`:809-813`）。

**去重吞行（必须修）**
- 原因：
  - 没有 path 的行当根处理（`:716-721`）；
  - 根层也按显示键去重（`:577-587`、`:747-766`）；
  - 被合并的一方连子树一起不打印（`:737-742`）；
  - 排序依次比排序号、图号、唯一键（`:506-522`），`manual:` 排在 `{` 之前。
- 独立评审用合成数据的只读探针证实，以下情况都会丢行：
  - 前缀行复制了根行、根行没有排序号：PLM 根行连同子树被吞，未绑定前缀行也一样；
  - 根行有排序号：前缀行被吞；
  - 孤立子行与前缀行冲突：其中一行被吞。
- 修法：所有前缀行都不参与树身份和去重，追加在树和孤立行之后，按 `sortExportRows` 排序。

**金样与审计**
- 逐个重跑：XR-01（`__tests__/stock-preparation-export-gate.test.cjs:111-126`）、prep-line-export R1、demo runner、真库 cases（`stock-preparation-project-write-lock-realdb.cases.ts:5388`）。
- 哪个样例里有建行人的行，哪个就重采，并写明原因。
- 导出出现来源列时，审计里的 columnCount 变为 31；再有沿用说明时为 32（`http-routes.cjs:12421`）。

**正式导出门（R-60）的边界**
- 门的顺序：先读导出行，再用读取口读一遍并算机器摘要（`stock-preparation-export-gate.cjs:13-27`；`http-routes.cjs:12369-12384`）。
- 前缀行会出现在导出里，但不进摘要（机器字段见 `stock-preparation-continuation-pairing.cjs:805-843`）。
- 所以受治理项目在结算之后再新增、修改、删除人工行，正式导出照样交付，不会回 409 `SHEET_CHANGED_SINCE_SETTLEMENT`，待遇与人工列相同。这一点写进登记行（§10）。

**归档对比**
- A-08 要求归档前后，每条读路由的回答都相同（`__tests__/stock-preparation-project-target-archive.test.cjs:397`）。归档不碰行，所以仍然相同。
- 归档后不能新增、不能复制，修改和删除不受影响。

## 7. 迁移与交付

**不需要迁移**
- 开关放在字段属性里，项目号用 087，审计用 088，落盘用已有的 plugin_kv。
- Kysely 的「已执行却缺文件」检查总会执行（`migrator.js:437-451` → `:484-490`），而顺序检查只在 `allowUnorderedMigrations` 为 false 时执行（`:441-443`）；main 设为 true（`migrate.ts:28-32`）。R79 不带新迁移，以后基于 main 的包会补跑 100–104 和网格导出关闭的迁移。
- 如果以后需要迁移：105 给 BI-1，106–108 给步骤 6，下一个空号是 109，发布时复核。迁移文件必须和 main 同名、逐字节相同，并且不依赖 100–104。

**R79：在 R 线上重写（OQ1）**
- **清单**：用 `git diff --name-status onprem-r78 <main>` 机械生成，以切 R79 时的 main 为准。在 2006826d7 上：
  - 插件 lib 缺 13 个模块：`stock-preparation-` 开头的 continuation-pairing、continuation-store、continuation-support、demand-evidence、export-gate、governed-sheet-probe、pilot-gate、pilot-readiness、project-write-lock、refresh-decisions、refresh-governance、refresh-lanes、refresh-state。
  - 主机缺 3 个：`multitable/plugin-write-fence.ts`、`multitable/sheet-grid-export-closure.ts`、`services/sheet-grid-export-closure-service.ts`。
  - 迁移缺 100–104，以及 `zzzz20261022150000`。
  - 测试缺 50 个：插件 43 个，主机 7 个。
- **可直接拣的部分**：
  - 主机的 B2 文件，r78 与 main 的 blob 相同；只有 `univer-meta.ts` 差 3 块（:138、:9628-9638、:16866）。
  - B3 的多维表网页文件相同；只有 `MultitableWorkbench.vue` 差 4 块。
- **需要重写的部分**：B1、B4 的插件和插件网页。
  - main 上 B1 的受治理部分（导出门、结算摘要、change-plan、试点就绪）在 R79 上不适用。
  - r78 的读取口和规划器各只有两处调用（`r78:stock-preparation-table-actions.cjs:2242`、`:2254`；`r78:http-routes.cjs:8144`；`r78:stock-preparation-large-bom-jobs.cjs:1391`），摘出仍是一处改动。

## 8. 各切片的实现条件

### B1 插件：前缀行摘出、写入口拒收、导出、提醒

1. 前缀判断、末页判断和 maxPages 都基于原始 `pageRows`。人工行和未绑定前缀行挂在数组的 Symbol 上，不参与哈希。
   - 单测：limit=2 跨页，人工行在第 1 页，PLM 行在第 2 页，PLM 行必须全部返回。
   - 真库：行数超过页长，人工行落在第 1 页，测试里直接调用读取口并传一个小的 limit。
2. 未绑定前缀行三种情况都要测：created_by 为空、键是别行 id、env 目标。三种都要求：计划有效、0 条失败决定、这一行不被写。
3. 写入口的拒收只放在 `applyAddDecision`；另有测试证明批量预取路径不会抛错。
4. 导出：
   - 所有前缀行都不参与树身份和去重，追加在树之后；
   - 「来源」按打印的有效行判断是否出现，常量放在 `EXPORT_COLUMNS` 和 `EXPORT_SOURCE_FIELD_IDS` 之外；
   - 测三种取值，测第 31、32 列；
   - 显式映射的目标上，来源列不进 `unresolvedColumns`；
   - 纯 PLM 金样逐字节不变；
   - 去重回归要覆盖探针的三种情况。
5. `manualSupplement` 只在计数大于 0 时出现，不进 plan，也不参与哈希。`matchedManualRecordIds` 指的是人工行的 id。落盘的键和值见 §5.3。
6. 提醒只按 ADD 比对；要测复制出来的行不会触发提醒。
7. 不变量测试：人工行永远不带 componentSourceId。这样沿用路由的防伪检查（`stock-preparation-confirm-writes.cjs:1091-1103`）无从命中人工行。
8. 主机与插件的前缀常量和真值表用契约测试钉住。
9. 新测试插在 `test-chain.txt` 的尾窗（`:316-318`）之前；重算 s6a 的 pluginHttpRoutes，本地跑 provenance 测试。
10. 真库：新的 cases 文件由已登记的 `stock-preparation-p4-repair-once-realdb.test.ts`（`vitest.config.ts:1710`、`plugin-tests.yml:1901`）引入，覆盖：
    - 人工行在执行后 version 不变；
    - 导出带来源列；
    - 受治理项目上编辑人工行之后，正式导出不回 409。
11. 这是保证型 PR，要做对抗核验和真库执行核验。
12. 客户可见：
    - 纯 PLM 项目没有任何变化；
    - 有人建行的项目，导出会出现来源列（env 表也一样）；
    - 未绑定前缀行不再被置为无效。

### B2 主机：人工行路由、删除豁免、/context、开关的执行

1. 读 087 用固定 SQL，只用 087 的列，并加契约测试；读取失败时的方向按 §3.0。
2. 锁豁免只给推导出的那 6 个物理 id；推导出的 K 与 (b) 的 K 不一致时失败关闭。
3. capabilities 用操作人自己的；扩展令牌是模块私有对象。
4. 第 3、4、6 条前置检查在事务里、栅栏之后，用重读的字段做。
5. 开关属性：
   - 两个净化入口都把「存在但不是 `'allowed'`」规范成 `'disabled'`；
   - POST /fields 剥掉；
   - PATCH /fields 和配置回滚保留原值。
6. 删除豁免按 E 判断：1 个删除入口和 4 处展示都要传行身份。测试：
   - 人工行能删；
   - 有建行人的未绑定前缀行能删（env 表上也一样）；
   - created_by 为空的前缀行仍然拒删；
   - PLM 键的行仍然拒删。
7. flag manifest：主机现在也读 `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED`，这个开关已登记（`global-history-flag-manifest.mjs:696-705`）。照成员页的先例把扫描范围扩到主机（`global-history-flag-manifest.test.mjs:412-424`），并更新 purpose。
8. 按调用点归类：GW7 写路径普查（`multitable-w13-write-path-layer3-gate.guard.test.ts`）、出口守卫 GOLDEN（`multitable-egress-coverage-guard.test.ts`）。补真库锁定用例。
9. /context 字节夹具（`multitable-grid-export-closure-byte-identity.test.ts`）：普通表和非 P_reg 表逐字节不变。
10. `multitable-human-write-lock.test.ts` 两半都保持绿。单元测试里的 supertest 一律用 `usePinnedServer()`。
11. 真库：扩展已登记的 `multitable-record-duplicate.test.ts`（`vitest.config.ts:1703`、`plugin-tests.yml:1897`），覆盖：
    - 盖章；
    - 盖章列回 403；
    - 关闭、缺锁、已归档、总开关关闭、登记表读不出时，写入前就拒绝；
    - 复制不带身份列和 RUN 列；
    - 修改只放行那 6 列；
    - 删除和恢复。
12. 文档：在 `decision-register.md` 写 R-?? 新行，并修订 R-66 ①。这个文件是 CRLF，保持 CRLF。ADR `adr-stock-prep-project-sheets-20261008.md` 加一节，指向本文。
13. 保证型 PR，要做对抗核验和真库执行核验。
14. 客户可见：没有变化。

### B3 多维表网页，以及通用新建的拒绝

1. **主机侧的拒绝**：放在调用 createRecord 之前。覆盖 POST /records（`univer-meta.ts:20309`，会话和 mst_ 令牌是同一条路由）和导入；文案用 §3.1 的整张表。
2. **PB-05**（`stock-preparation-fieldperm-write-gate-realdb.test.ts:1542-1555`；`plugin-tests.yml:1677`、`vitest.config.ts:1718`）：
   - 保持绿，并改掉注释里「项目表上的行只由拉取来」那句；
   - 新增 PB-05b，逐个状态验证。
3. **网页入口**：
   - 只要有人工行块，就隐藏全部通用新建入口：工具栏、底栏、行内、看板。R68 的提示换成人工行入口或原因。
   - 新增对话框 `MetaManualRowDialog.vue`：名称*、总用量*、图号、规格、材质、用量、备注。
   - 抽屉里有「复制为新行」。
   - 新增或复制成功后调用 `resolveDeepLink`（`MultitableWorkbench.vue:3163-3171`）。
4. **网格**：
   - 人工行行首显示「人工补充」；
   - 那 6 列可以单格编辑，走专用路由；
   - 撤销和重做按 §3.4；
   - 区域填充和粘贴仍按只读处理；
   - 抽屉分两步保存，第二步带 version。
5. **改动范围与测试**：
   - 避开 #6507 在 `MultitableWorkbench.vue` 改过的那几块。
   - 网页代码不得 import `plugins/` 下的文件（main 镜像构建守卫 #6511）。
   - spec 文件名要落在已有的 token 前缀里（`run-required-web-tests.tokens:355`、`:415`、`:462`）；如果必须新加，按字母序插入、重新生成清单，并改 `multitable-web-guard.yml` 的 paths。
   - 跑真实的 vue-tsc。
6. **客户可见**：
   - 已加锁的登记表出现「新增人工补充行」和「复制为新行」；
   - 没加锁的登记表显示 lock_missing 的原因。

### B4 插件开关路由与项目面板

1. **开关路由**：行为按 §4（租户、项目号确认、回读、归档回 409、总开关关闭回 404、审计 mode）。加进以下几处：
   - A-08 的写路由表；
   - `stock-preparation-workbench-access.cjs` 的清单；
   - 权限矩阵 M-01、M-04、M-08。
2. **GET 的返回**：带上开关状态，以及 §5.3 落盘的最近一次提醒。
3. **面板**：
   - 显示人工行数和同物料提醒，附「查看这些行」；
   - 显示 unboundKeyCount，并给出处理办法：
     - 有建行人的，可以直接删；
     - 没有建行人的，要在补锁前把键改掉；补锁之后只能走 owner 批准的数据库操作。
4. **文案与夹具**：
   - `plainLanguage.ts` 在 `:3757-3764` 的 mode 表里加一行，并补拒绝码的文案；OpsPanel 审计词表镜像的计数不变。
   - `apps/web/verification/stock-prep-fixtures.ts` 补夹具。
   - 网页 token 用 `:523`、`:524`。
5. **重算与真库**：
   - 重算 pins 和 test-chain；
   - 真库测试：插件写开关之后，主机拒绝新建。
6. **客户可见**：
   - 备料主管理员可以按表开关；
   - 拉取之后看得到提醒和异常行的数量。

### R79（OQ1）

1. 从切版时最新的 onprem 标签切出。缺失清单按 §7 的命令机械生成。
2. 在 onprem-r78 上先采「逐字节不变」的金样：没有前缀行时的试算修订号和令牌，以及导出工作簿。R 分支必须复现这些金样。
3. 在 R 分支上重算 test-chain 和 s6a pins。
4. R 线版本的 B1、B2 单独做对抗核验和真库核验。真库用例放进 r78 已有的文件：
   - `stock-preparation-p4-repair-once-realdb.test.ts`、`stock-preparation-fieldperm-write-gate-realdb.test.ts`；
   - `multitable-record-duplicate.test.ts`，它与 main 的 blob 相同。
5. 主机只读 087 的列。
6. B1–B4 四支一起进 R79。
7. 打标签由 owner 另批。

### 上线（OQ8）

1. 附录 A 的探针由 owner 执行或批准。
2. 先清理前缀行，再补锁。
3. 没加锁的登记表，在装包窗口里补锁，用现有接口 `POST …/options/sync { projectNo }`。这是生产写，届时另批。
4. 提前告诉客户：默认允许，上线后会出现新按钮；env 表和副本不在范围内。
5. env 表上「项目号 is required」的症状不由本系列解决。如果项目表开关不是精确 `'true'`，要不要打开由 owner 另行决定。

## 9. 风险

1. **主机读插件表**是新的耦合。缓解：用固定的只读 SQL，加契约测试，并定义好失败方向（§3.0）。main 上已有先例（`plugin-write-fence.ts:1-12`），r78 上没有这个文件。
2. **逐行锁豁免**只开在 §3.4 这一条路由上。这里一旦有缺陷，PLM 行的锁就被打开了。必须做对抗核验和真库执行。
3. **导出去重吞行**（§6）。B1 不修就会丢行。
4. **区域操作和 Yjs 仍是只读**。Yjs 只有 `ENABLE_YJS_COLLAB==='true'` 时才开（`index.ts:4924`），现场的值要核对。
5. **未加锁表上的伪造面和未绑定前缀行**。这两者在面板上显示数量，有建行人的可以删。上线前要先清理。
6. **默认允许**：要先告诉客户。
7. **R79 是重写**（§7）。
8. **自动化**：delete_record 删不掉人工行，这是保守取舍。create_record 在项目表上照旧会建出无键的行，属于已有的遗留问题。
9. **时光机（已封存）**：时点回滚按当前的必填规则校验整行（`exact-anchor-restore-validate.ts:146-176`），人工行回滚不了；reset 也会拒绝。回收站不受影响。
10. **平台管理员改键列的类型或删除键列**：属于已有风险，结果是失败关闭（`key_column_missing`）。
11. **领养的旧沙箱表**不满足 (a)，没有人工行。
12. **大车道 v1 不提醒**。
13. **R-60 的边界**：人工行不在结算摘要里（§6），已经写进登记行。

## 10. 登记册

### R-66 ① 修订（在 R-66 行的 ① 里改写，O 层，owner 2026-10-30「按建议」）

原文：
> 无键行（人工补充行、无键外来行）照常可删

改为：
> 无键行（无键外来行）照常可删；唯一键以 `manual:` 开头且有建行人的行可删：其中唯一键为 `manual:v1:<本行记录 id>` 且在已登记项目表上的是人工补充行，其余为拉取不再维护的未绑定前缀行（ADR adr-stock-prep-manual-rows-20261030 §2.2 E）；唯一键以 `manual:` 开头但没有建行人的行，与其他 PLM 行一样任何人都不能删。

R-66 其余文字不变，包括「平台管理员也不能删 PLM 行」、键列解析不出时整表失败关闭，以及回收站恢复的规则。

### 新行（合并时插在 R-66 之后，保持 CRLF）

```
| **R-??** | 备料项目表上的人工补充行（PR-B 系列）：身份、开关、拉取、导出、交付 | 按 ADR adr-stock-prep-manual-rows-20261030 执行。owner 裁决（2026-10-30「按建议」，O 层）：OQ1 main 先合，R79 在 R 线重写并单独核验，取代 10-27「不移植 R 线」，打标签另批；OQ2 修订 R-66 ①（唯一键以 `manual:` 开头且有建行人的行可删）；OQ3 不加「来源」列（偏离 10-27「服务器盖来源」），导出含非 PLM 行时才出现「来源」，下游按表头取列；OQ4 只比对本次 ADD 的同物料提醒，计数落盘，v1 只在小车道，永不合并；OQ5 复制不拷父组件两列，v1 不做单位；OQ6 开关由 stock-prep:admin 拨并记审计；OQ7 表单不改，保留 R-66 ③；OQ8 上线清单（探针由 owner 执行或批准、先清理前缀行再补锁、补锁属生产写届时另批、告知客户）。T 层执行口径：人工行键为 `manual:v1:<本行记录 id>`，由服务器在建行的同一条 INSERT 里写入；读取口摘出全部 `manual:` 前缀行，规划器不修改、不置无效、不比对它们；写入口只在 ADD 上拒收前缀键；开关存放在唯一键列的字段属性 `stockPreparationManualRows`，缺省为允许，值不是 `'allowed'` 即为关闭；审计复用 `project_fields_update`，mode 为 `manual_rows_allowed` / `manual_rows_disabled`；项目号只读插件登记表 087 的列；全系列不需要迁移、不新增 env 开关。R-60 边界：人工行与前缀行不在结算摘要里，受治理项目结算之后对人工行的增删改不会让正式导出回 409。 | O（OQ1–OQ8）/ T（执行口径） | RULED（OQ1–OQ8）；实现待 B1–B4 | owner 2026-10-30「按建议」；ADR 经两轮独立评审（第 2 轮：可以交 owner，无阻断项） |
```

## 11. 修订记录

| 稿 | 内容 |
|---|---|
| 第 1 稿（2026-10-30） | 初稿。人工行身份、拉取摘出、主机路由、开关、导出、交付，以及 3 支拆分加 1 支可选。 |
| 第 2 稿（2026-10-30） | 回应第 1 轮评审 RF-01 至 RF-19，见下表。 |
| **第 3 稿 = 定稿（2026-10-30）** | owner 对 OQ1–OQ8 答「按建议」，整理为 ADR。并入第 2 轮评审 N1–N12：<br>N1：导出时所有前缀行都不参与去重，未绑定前缀行标为非 PLM。<br>N2：面板显示 unboundKeyCount；删除规则 E 写进 OQ2 和 R-66 ①。<br>N3：提醒计数落盘到 plugin_kv。<br>N4：R79 清单改为机械生成。<br>N5：拒绝文案表补全，只有 allowed 指向按钮。<br>N6：登记表读取失败的处理方向。<br>N7：OQ7 写明表单与网格的差别。<br>N8：来源列在 env 表也会出现；沿用说明的位置会变，下游按表头取列；B1 的客户可见补写。<br>N9：§2.3 ① 改为「B1 之后」。<br>N10：改名为 matchedManualRecordIds。<br>N11：R-60 边界写进登记行。<br>N12：撤销和重做。<br>另外：拆分改为 B1–B4，B5 标为不做。 |
| 补充（2026-11-19，提议） | 新增 §12：人工行可以指定、修改父组件，修订 OQ5；经 1 轮独立对抗审阅（无阻断项，12 条已并入，见 §12.10）；待 owner 确认 OQ-P1–P3。 |

第 2 稿对 RF 的处理：

| RF | 处理 | 位置 / 依据 |
|---|---|---|
| RF-01 | 已修 | 读取口摘出全部前缀行，规划器效果等同于「跳过并计数」（§5.1）；写入口只在 ADD 上拒收（`stock-preparation-apply-writer.cjs:610-611`，不放进 `decisionKey`，因为 `:363`、`:787`、`:1054`、`:1060`、`:1094`、`:1099` 都会用到它） |
| RF-02 | 已修 | 末页和页数上限都按原始页长计算（`:1164`、`:163`）；补跨页单测和真库测试 |
| RF-03 | 已修 | 拒绝原因按状态区分（§3.1）；网页靠人工行块隐藏通用新建（§3.7）；补锁和探针列为上线前置（§8 上线）；env 表和副本不在范围内 |
| RF-04 | 已修 | 明确 P_reg 的定义（§3.0）；PB-05 保持绿（`stock-preparation-fieldperm-write-gate-realdb.test.ts:1431-1432`），新增 PB-05b；通用新建的拒绝放到 B3 |
| RF-05 | 已修 | 表单不改，交给 OQ7（`decision-register.md:70`）；改正 created_by 的措辞（`univer-meta.ts:18812`） |
| RF-06 | 已修 | 谱系两列不拷（`stock-preparation-continuation-pairing.cjs:162`、`:812-820`） |
| RF-07 | 已修 | 提醒只比对 ADD（`stock-preparation-conflict-planner.cjs:1740`） |
| RF-08 | 已修 | 来源列做成独立常量、按条件出现、三种取值；补齐金样清单和审计 columnCount（`stock-preparation-prep-line-export.cjs:194-197`、`:788-823`；`http-routes.cjs:12421`） |
| RF-09 | 已修 | R79 在 R 线上重写，有单独的验证计划（§7、§8 R79） |
| RF-10 | 已修 | 值存在但不是 `'allowed'` 一律规范成 `'disabled'`（`provisioning.ts:699`、`field-codecs.ts:565`） |
| RF-11 | 已修 | 开关路由按 operator-scope 定租户、处理归档和总开关（`http-routes.cjs:11392-11397`）；主机读同一个开关 |
| RF-12 | 已修 | 大车道 v1 不提醒（`stock-preparation-large-bom-jobs.cjs:1186`） |
| RF-13 | 已修 | capabilities 用操作人自己的（`record-service.ts:661-663`、`:642-651`） |
| RF-14 | 已修 | 理由改为 (d) 加写入口的不变量（`stock-preparation-apply-writer.cjs:610-640`） |
| RF-15 | 已修 | 加入表单 context 的调用点（`univer-meta.ts:18276-18289`） |
| RF-16 | 已修 | 新增 OQ2；OQ3 写明偏离；探针由 owner 执行或批准 |
| RF-17 | 已修 | 通用新建的拒绝与网页同在 B3 |
| RF-18 | 已修 | 部署级开关只能做急停 |
| RF-19 | 已修 | componentSourceId 不变量；复制前先检查读权限；总览和交接的口径；抽屉分两步保存；开关在事务内检查 |

## 附录 A　上线前探针

只读，只输出计数和布尔值，不输出任何值。要读客户数据，由 owner 执行或批准。

1. 唯一键以 `manual:` 开头的行，范围是已登记项目表、env 表和主表，按有无建行人分开计数。期望都是 0。不为 0 的，先清理再补锁。
2. 每张已登记项目表上，键、项目号、有效三列是否带 `humanWriteLock`，只计数。
3. 客户报错的那张表，查：
   - 是不是「打开备料多维表」打开的那张；
   - 是否已登记、是否已加锁；
   - `MULTITABLE_STOCK_PREP_PROJECT_SHEETS_ENABLED` 是否精确等于 `'true'`（`stock-preparation-project-targets.cjs:101-103`）。
   - 这一项是上线前置门槛。
4. 每个项目里有建行人的行数，用来预判来源列会在哪些导出里出现。
5. `ENABLE_YJS_COLLAB` 是否等于 `'true'`。

## 12. 补充：人工行可以指定、修改父组件（2026-11-19，修订 OQ5，待 owner 确认）

- 状态：**提议，待 owner 确认**。确认前不写代码。
- 基线：本节的 `path:line` 都指 main `df83192d9`。
- 需求（owner 2026-11-19）：新增人工补充行时能选父组件图号和父组件名称，让人工加的物料自动成为某个父组件的子件，或者成为新的父组件；加错了能重新指定，或者自己建一个新的父组件。
- 目标：进第 3 个包，不影响 R85 签收。
- 评审：第 1 轮独立对抗审阅（Fable max）结论「原则上安全，无阻断项」，提出的 12 条已全部并入本节（§12.10）。

### 12.1 现状（为什么今天做不到）

- 父组件两列 `parentComponentCode`、`parentComponentName` 属于「谱系显示」类（`stock-preparation-manual-rows.ts:176`），这一类在「人工行路由永不写」的名单里（`:222`）。
- 所以新增时提交父组件会被拒（`univer-meta.ts:8405-8407`，回 403 `FIELD_READONLY_PLM_SYSTEM`）；修改路由只收 6 个可填列（`:21125-21136`，回 400 `STOCK_PREP_MANUAL_FIELDS_NOT_FILLABLE`）。
- 结果：人工行父组件全空。填写视图按父组件图号分组、排序（`stock-preparation-templates.cjs:982-983`），人工行都落在空值组；网格把这一组的组头显示为「(无值)」（`apps/web/src/multitable/utils/meta-core-labels.ts:367-369`），本文此前称它「无父件」组。

### 12.2 改成什么样

**新增时选父组件**
- 「新增人工补充行」弹窗多一栏「父组件」，三种选法：
  1. **不挂父组件**（默认）：和今天一样，落在空值组。
  2. **选本项目已有的**：下拉可搜索，图号和名称成对带出，不能只改一半。候选有两类：
     - 「已有父组件」：本表里出现过的父组件图号 + 名称（图号为空的不列）；
     - 「本项目物料」：本表里任意一行自己的图号 + 名称，包括 PLM 行和人工行（图号为空的不列，本行自己不列）。所以人工加的物料，下一次就能被选作父组件。
     - 同一个图号既是「已有父组件」又是「本项目物料」时，只列一条，名称取「已有父组件」那一条。原因：PLM 子行上的父组件名称是父件**未切分**的「名称及规格」（`stock-preparation-conflict-planner.cjs:1239-1248`），而父件自己那一行的「名称」是切分后的首段（`stock-preparation-bom-expansion.cjs:1971`）；取前者，人工子件和 PLM 子件的父组件名称才一致。
     - 选中的值原样保存，不去空格、不改写：分组按原始文本比较（`apps/web/src/multitable/components/MetaGridTable.vue:1207-1208`），PLM 图号也是原样存的（`stock-preparation-bom-expansion.cjs:1967`），改写一个字符就会分到另一组。
  3. **新建父组件**：自己填图号（必填）和名称（必填），这两个手填值去掉首尾空格后保存。
- 「新建父组件」只是给这一行写上父组件，不会自动为父组件本身建一行。父组件本身也要备料的，先把它新增成一行人工补充行，再给子件选它。弹窗里写明这句话。

**加错了能改**
- 人工行的记录抽屉里多一个「修改父组件」，打开同一个选择器：可以改成另一个父组件、新建一个父组件，或者「移出父组件」（回到空值组）。
- 不做右键菜单入口：网格从 2026-10-27 客户反馈起就不绑右键菜单（`MetaGridTable.vue:1478-1483`，回归测试 `apps/web/tests/multitable-grid-duplicate-context.spec.ts:1-11`）。要加回右键菜单须 owner 另裁。
- 网格里人工行的父组件两格**不能**直接单格编辑：两列必须一起改，单格编辑会把图号和名称改得对不上。实现上两列不进 /context 的 `editableFieldIds`（`stock-preparation-manual-rows-gate.ts:406`，网页在 `apps/web/src/multitable/utils/manual-rows.ts:121-129` 读它）。
- PLM 行没有这个入口，父组件两列照旧锁定。

**客户会看到什么**
- 填写视图里，人工行出现在所选父组件的分组里，和 PLM 子件排在一起（组内按图号排）。
- 正式导出里，人工行的「父组件图号」「父组件名称」两列有值；位置见 §12.5。
- 行首仍标「人工补充」，导出的「来源」列仍是「人工补充」。
- **v1 的限制**：抽屉里的「查看子件」「查看所有使用位置」按 PLM 身份过滤，不按图号（`apps/web/src/multitable/utils/bom-relations.ts:10-14`），没有 PLM 身份的行这两个按钮不可用（`:49-54`、`:98`）。所以：
  - 在 PLM 父件上点「查看子件」，看不到挂在它下面的人工子件；
  - 人工父组件上这两个按钮不可用。
  - 要看人工子件，用填写视图的分组。是否把这两个按钮扩到人工行，见 §12.9 之外的后续。

### 12.3 规则

| 编号 | 规则 |
|---|---|
| P1 | 父组件两列只能经三条人工行路由写入：新增 `POST /sheets/:sheetId/manual-rows`、复制 `POST /records/:recordId/manual-copy`、修改 `PATCH /records/:recordId/manual-fields`。修改要求这一行满足 M（§2.2）。 |
| P2 | /patch、PATCH /records、Yjs、区域填充、粘贴、导入、表单、自动化，对父组件两列一律照旧只读。§3.4 的结论不变：不在通用 /patch 上加逐行逐列豁免。 |
| P3 | 两列成对提交：修改路由提交其中一列时，另一列也必须一起提交，否则回 400。 |
| P4 | 成对取值：两列只收字符串或 null（`record-service.ts:906` 原样落值，所以要在路由上挡住其他类型）。两列都空 = 不挂父组件；图号非空、名称可空 = 挂上（兼容 PLM 里父件没有名称的情况）；名称非空、图号空 = 回 422（填写视图按图号分组，只有名称的父组件分不了组）。判断「空」时看去掉首尾空格后的值，但保存的是原值（§12.2）。 |
| P5 | 父组件图号不能等于本行自己的图号，否则回 422。两个方向都要挡：改父组件时，和改本行图号时（图号本来就能在网格里改，`stock-preparation-manual-rows.ts:172-174`、`univer-meta.ts:21125-21126`）。判断放在写事务里、行已加锁之后（`preWriteGuard`，`univer-meta.ts:21171-21173`；加锁见 `stock-preparation-manual-rows-gate.ts:548`），对合并后的整行判断，因为路由先读的那一次（`univer-meta.ts:21100-21103`）在事务外。 |
| P6 | 服务器不检查父组件是否存在于本表，「新建父组件」靠这一条成立。父组件只是这一行的显示属性，不建立任何引用。 |
| P7 | 逐人字段权限照常生效：操作人对父组件两列中任一列没有写权限时，选择器不显示，提交回 403。 |
| P8 | 开关关闭、项目已归档时，与其他可填列相同（§4「关闭的含义」）：只挡新增和复制，已有人工行仍可修改父组件。 |

**锁豁免的边界变化**
- 今天：锁豁免只给 6 个可填列（`stock-preparation-manual-rows.ts:172-174`）。
- 改后：给 6 + 2 = 8 列，仍然只在上面三条路由上，仍然只对新建的人工行或满足 M 的行。
- 实现上把父组件两列从「永不写」名单（`:222`）里拿出来，单设一类「人工可指定父组件」，普查测试照旧要求 35 列每列恰好一类。新类不进 `fillable`，所以不会顺带进 `editableFieldIds`。
- 门今天检查的锁只有键、项目号、有效三列（`stock-preparation-manual-rows-gate.ts:281-282`），不检查父组件两列有没有锁。P1 的「只能经人工行路由写入」在**已加锁**的父组件两列上成立；P1 实现时要求门在两列缺锁时按 `lock_missing` 拒绝，免得在缺锁的表上出现两套写法。

### 12.4 为什么安全

1. **PLM 行的父组件改不了**。修改路由先判 M（`univer-meta.ts:21117-21123`），PLM 键永远以 `{` 开头，不满足 M（§2.3 ①）；新增和复制建出的是新行，键由服务器盖章。/patch 等通用入口不变（P2），所以 PLM 行的父组件只来自拉取。
2. **PLM 行挂不到人工父组件下**。PLM 行的父组件两列只由规划器从**展开行**的父件索引写入（`stock-preparation-conflict-planner.cjs:1221-1248`，索引只由展开行建，`:1608`），人不能改，拉取也不读人工行。人工行改父组件只改它自己这一行。
3. **拉取与机器摘要看不到这两列的变化**——这一条**只**靠读取口摘出前缀行（§5.1；`stock-preparation-table-actions.cjs:1197-1242`，正式导出门在 `http-routes.cjs:14318-14321` 用的也是它）：
   - 父组件两列在规划器里属于 `DENORMALIZED_PLM_FIELD_IDS`（`stock-preparation-conflict-planner.cjs:1155-1157`），会被比对；
   - 沿用配对把它们排除在内容触发之外（`stock-preparation-continuation-pairing.cjs:793`），但结算摘要**包含**它们（`:823-832`、`:840`）。
   - 人工行在规划和摘要之前已被摘出，所以改人工行的父组件既不会被拉取改回，也不会让正式导出回 409（与 §6 R-60 边界相同）。读取口的摘出因此是本补充的承重点，P1 的真库用例要覆盖「改人工行父组件后执行拉取、再正式导出」。
4. **豁免面只多 2 列，入口不变**。OQ5 当时不拷父组件的理由是「拉取不改人工行，拷过去会永久过期」。现在人工行的父组件是人主动指定的，过期的后果由指定的人负责（§12.7 写明会在哪些情况下过期），不再是不能写的理由。
5. **values-free 不变**。新路由和拒绝文案都不带具体值；候选接口只返回操作人本来就能读到的行和列（§12.6）。

### 12.5 一并考虑的面

**填写视图分组**
- 不改代码：视图本来就按父组件图号分组（`stock-preparation-templates.cjs:983`），人工行填了图号就进对应的组。
- 父组件名称不参与分组。同一图号下名称不一致时，组名按图号显示。

**正式导出（插件，B1 的导出代码）**
- 今天：所有前缀行不进树，排在树后面（`stock-preparation-prep-line-export.cjs:1006-1012`），树尾内部按父组件图号排序（`sortExportRows`，`:530-539`，只看内容）。
- 提议（OQ-P2）：把挂了父组件的人工补充行**插回树里**。规则：
  - 做成对 `orderRowsAsBomTree` 结果（`ordering.rows`）的**后处理**。前缀行仍然不进 `orderRowsAsBomTree`、不进去重、不进沿用说明（`continuationNotesFor(treeRows…)`，`:1016`），B1 修的「去重吞行」不会回来。
  - 只插满足 M′ 的人工补充行；「人工（非补充）」的前缀行照旧留在表尾。
  - 锚点：父组件图号等于某一行**已打印**的树行的图号，取第一次出现的那一行。被合并掉的孪生行（`:787-792`）和无效行（`:996`）不打印，不当锚点。
  - 「子树末尾」按 `path` 前缀判定：`orderRowsAsBomTree` 不返回子树范围（`:820-826`），只有按 path 建树的模式能判定；退回平比较器的老部署，人工行一律留在表尾。
  - 同一锚点下的人工行，按 `compareSiblingRows`（`:556`）排，排在该子树全部 PLM 行之后。
  - 父组件是另一行人工补充行：跟在那一行（及其已插入的人工子行）后面。
  - 找不到锚点（新建的父组件、锚点行已无效）、人工行之间成环、自己挂自己：留在表尾，按今天的规则排序。
- **图号会重复**：同一图号可能对应不同零件，所以「查看子件」不按图号过滤（`bom-relations.ts:10-14`）。按图号找锚点因此可能挂到另一处同图号的零件下面；v1 接受这一点（只影响导出位置，不影响数据），在交付说明写明。
- 不变的部分：
  - 只有 PLM 行的项目，以及人工行都没挂父组件的项目，工作簿逐字节不变（C09；`:1012` 在没有前缀行时不拼尾，尾部排序只看内容）；
  - 人工行的「层级」仍留空，不推算。

**OQ4 同物料提醒**
- 不受影响。提醒按图号比，或在没有图号时按名称 + 规格 + 材料比（`stock-preparation-manual-rows.cjs:152-153`），不看父组件。

**推宜搭（外接数据源线，写给协调者转）**
- 示例映射把父组件直接映射过去：`parentComponentCode → parentDrawingNo`、`parentComponentName → parentPartName`（`yida-static-plan.mjs:1119-1120`，同样见 `automation-operation-catalog.ts:191-192`）；父组件名称还被复制进 `partCategory`（`yida-static-plan.mjs:1121`）。
- **要集成线确认的点**：
  - 示例的业务主键里含 `parentDrawingNo`（`yida-static-plan.mjs:1101`）。如果人工行会被推到宜搭，那么改父组件就是改业务主键：宜搭那边会多出一条新记录，旧的那条留下。
  - 示例里 `versionNo` 必填，来自 `sourceVersion`（`:1118`），而人工行没有 `sourceVersion`；`drawingNo`、`materialGrade` 也是必填（`:1114`、`:1117`），人工行的图号、材质可以不填。所以按示例映射，人工行今天很可能推不过去。
- 建议集成线先定：人工行推不推宜搭；如果推，用 `sourceLineId`（即唯一键 `manual:v1:<id>`，不随父组件变）定位记录，而不是用含父组件的业务主键。
- 本系列不改任何宜搭代码，宜搭发送开关保持关闭。

**复制为新行（修订 OQ5，OQ-P1）**
- 提议：复制时**带上**源行的父组件两列，不论源行是人工行还是 PLM 行。复制的人多半是要加一个兄弟件，挂在同一个父组件下正是想要的；不对的话用「修改父组件」改。
- 带上的条件：两列都对操作人可读、可写，并且满足 P4、P5。今天复制是逐列判断的（`univer-meta.ts:8502-8508`），而 PLM 行可能只有父组件名称、没有图号（父件没有图号时，`stock-preparation-conflict-planner.cjs:1238`、`:1246-1248`），逐人权限也可能只覆盖其中一列。任一条不满足时**两列都不带**，复制照常成功（落在空值组），不因为父组件回 422。
- 备选：维持 OQ5，复制不带父组件，复制后再自己指定。

### 12.6 接口与页面

**/context 人工行块**：多带 `parentFieldIds: { code, name }`（物理 id）。操作人对两列中任一列没有写权限时不带，网页据此隐藏选择器。

**候选接口（新）**：`GET /api/multitable/sheets/:sheetId/manual-rows/parent-options?q=&limit=`
- 门：只接受会话请求；canRead 且表是活的（与 GET 读路由同口径，`univer-meta.ts:5141-5160`）；再要求 canCreateRecord 或 canEditRecord；P_reg 按修改的口径判断（关闭或归档时也能用，供修改父组件）。
- 读什么：只看操作人能读到的有效行（行级策略照常生效）；四列（图号、名称、父组件图号、父组件名称）各自要在操作人的第 2 层 ∧ 第 3 层读权限允许集里，不在的列不参与匹配也不返回——`q` 只在允许的列上匹配，防止拿搜索当探测（先例 `univer-meta.ts:5707-5718`）。`childCount` 只数操作人能读到的行（`:5772-5786`）。
- 怎么读：用 SQL 只投影这四列，固定排序（图号、名称、记录 id），不逐页拉整行；结果按去重后的条目数封顶（`limit` 默认 20、上限 50），超出回 `truncated: true`。网页输入防抖。
- 出口守卫：这是一条新的 `data->>` 投影读，出口变更守卫看不到它（`packages/core-backend/tests/unit/multitable-egress-coverage-guard.test.ts:17-19`），所以 P1 要走 `maskStoredRecordFieldIds`，在追踪表里登记，并补一条真库锁定用例。
- 返回 `{ items: [{ code, name, kind: 'parent' | 'component', childCount? }], truncated }`，「已有父组件」排在前面。
- 不沿用导出的 20000 行上限：导出那个数是有效行上限、读满 50000 行后超限直接拒绝（`stock-preparation-prep-line-export.cjs:74-79`、`:996-999`），而一张表可以到 100000 行（`stock-preparation-table-actions.cjs:192-193`），候选接口是逐次搜索，不应整表扫。

**页面**：原型见 `beiliao-manual-row-parent-prototype-20261119.html`（同目录），包括：
- 新增弹窗里的「父组件」栏和三种选法；
- 下拉搜索的样子；
- 抽屉里的「修改父组件」和它的小弹窗；
- 填写视图分组前后对比；
- 正式导出按 OQ-P2 建议插回树的样子。

### 12.7 风险与取舍

1. **父组件会过期**。人工行的父组件是一份快照，拉取不碰人工行。下面几种情况下它会和实际脱节：
   - **人工父组件被改或被删**（最常见）：人工父组件那一行自己的图号、名称可以在网格里改，这一行也可以删。按 P6 它的人工子件不会跟着变，会留在旧图号的组里，导出时找不到锚点落到表尾。
     - 处理：修改人工行图号、删除人工行时，如果有别的人工行把它当父组件，弹窗提示「有 N 行人工补充行以它为父组件，修改/删除后它们不会跟着变」，只给数字。不自动改子行。
   - **PLM 父件改名**：分组按图号，不受影响；名称显示旧值。
   - **PLM 父件被拉取置为无效或删掉**：填写视图里这一组只剩人工行；导出时锚点行不打印，人工行落到表尾。
   - 后续可选：在项目同步面板加一条「人工行的父组件在本次 BOM 里找不到」的计数，只存数字，与 OQ4 落盘同法。**v1 不做**。
2. **人工行之间成环**（A 挂 B、B 挂 A）：服务器只挡自己挂自己（P5），不做全表环检测。成环只影响导出位置（留在表尾），不影响数据。
3. **按图号找锚点可能挂错处**（图号会重复，§12.5）。只影响导出位置。
4. **撤销**：「修改父组件」不进网格的撤销栈，改错了再改一次。
5. **R79 / R 线**：本补充只在 main 上做，跟第 3 个包走，不进 R85。

### 12.8 拆分（确认后）

| 支 | 内容 | 类型 |
|---|---|---|
| **P1 主机** | 父组件两列移出「永不写」、单设一类且不进 `fillable`；P1–P8（含 P5 两个方向、事务内判断）；门在两列缺锁时拒绝；修改路由收两列；复制按 OQ-P1 成对带或成对不带；/context 加 `parentFieldIds`；候选接口（门、读权限、投影、封顶、出口守卫登记）；改人工行图号或删除时返回「被当作父组件的行数」供提示。测试：普查、GW7、出口守卫、真库用例（新增带父组件、修改、PLM 行拒改、/patch 仍拒、成对规则、两个方向的自挂自、复制拆半对时两列都不带、改父组件后拉取再正式导出不回 409、候选接口不泄露不可读行和列）。 | 保证型：对抗核验 + 真库执行核验 |
| **P2 网页** | 弹窗加「父组件」栏、抽屉加「修改父组件」、网格里两格只读、改图号和删除时的提示；vue-tsc 与网页 spec。 | 普通实现 |
| **P3 插件导出** | 按 OQ-P2 把挂了父组件的人工补充行插回树（§12.5 的全部规则）；纯 PLM 和人工行都没挂父组件的金样逐字节不变；补插入、找不到锚点、锚点无效、成环、自挂自、同图号多处六类用例。 | 普通实现，金样要重跑 |

- 顺序：P1 → P2；P3 可以和 P2 并行。不需要迁移，不新增 env 开关。
- 登记册：合并 P1 时在本系列的 R 行后追加一条，写明 OQ5 的修订和 OQ-P1–P3 的答复。

### 12.9 要 owner 确认的点

- **OQ-P1 复制带不带父组件**：建议「带上源行的父组件」（两列都能带时才带，否则都不带）。
- **OQ-P2 导出位置**：建议「插到父组件的子件后面」；备选是「仍排在表尾，按父组件图号分组」。
- **OQ-P3 下拉候选范围**：建议「已有父组件 + 本项目任意物料」；备选是「只列已有父组件」。
- 其余（P1–P8、宜搭交集成线确认、过期只提示不做面板计数、v1 不扩「查看子件」）按本节执行。

### 12.10 第 1 轮审阅的处理

| 条 | 处理 |
|---|---|
| 1 引用 | 改正：父组件写入处是规划器 `:1221-1248`；两列属 `DENORMALIZED_PLM_FIELD_IDS`；结算摘要包含两列，安全只靠读取口摘出（§12.4 ②③）。 |
| 2 「提醒兜底」 | 删去，改为写明过期情形（§12.4 ④、§12.7）。 |
| 3 右键菜单 | 去掉，只留抽屉入口（§12.2）。 |
| 4 查看子件 | 写为 v1 限制；导出锚点的同图号问题写入 §12.5、§12.7。 |
| 5 复制拆半对 | 两列都能带才带，否则都不带（§12.5 OQ-P1）。 |
| 6 自挂自 | 两个方向都挡，事务内对合并后的整行判断；只收字符串或 null（P4、P5）。 |
| 7 候选取值 | 同图号合并取父组件名称；选中值原样保存；排除空图号和本行（§12.2）。 |
| 8 候选接口 | 补 canRead 与活表、按允许集匹配、childCount 只数可读行、投影与封顶、出口守卫；不沿用导出上限（§12.6）。 |
| 9 导出插回 | 写成后处理，锚点、子树末尾、只插 M′、同级排序、表尾回退的全部规则（§12.5）。 |
| 10 人工父组件被改或删 | 列为最常见的过期情形，加提示（§12.7、§12.8）。 |
| 11 锁与可编辑列 | 门在两列缺锁时拒绝；两列不进 `editableFieldIds`（§12.2、§12.3）。 |
| 12 宜搭与组头 | 补 `partCategory` 和必填项；组头文案改正为「(无值)」（§12.1、§12.5）。 |
