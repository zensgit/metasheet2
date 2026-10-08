# 备料接管 · 单项目垂直切片(2026-08-22)

> **这是执行方案,不是通过证明。** 目标是用**一个在制 `product_code`** + **一次性数据导出**,
> 把 (b) PROVISION + MIGRATE 形态里最容易骗过自己的三件事验成真或验成假。
>
> **形态已定**:安装客户 pack 生成全新的 canonical 表,把旧数据迁进来,按 `product_code` 逐项切换。
> 形态 (a) ADOPT 不可能——MetaSheet 的 provisioning 派生的是确定性 id
> (`stableMetaId` = 前缀 + sha1(parts.join(':')) 的前 24 位 hex,
> `packages/core-backend/src/multitable/provisioning.ts:130-136`),客户手工建的 UUID-id 表
> 永远不可能被 pack 安装器寻址,而仓库里**不存在**任何按名称/标签匹配的机制。
>
> **values-free**:本文不含主机名 / IP / 口令 / 库名 / schema owner / 授权码。业务中文列名与
> 迁移方案里的表名不属于此列,照写。
>
> 相邻文档:`mysql-migration-plan.md`(表清单与迁移计划)、`demo-field-dictionary-spec.md`
> (字段字典与命名不一致)、`customer-pack-rehearsal-report.md`(pack 五幕排演)、
> `beiliao-production-go-live-gate.md`(上线门)、`beiliao-takeover-status-ledger.md`(状态账本)。

---

## 1. 这一刀证明什么

三条断言,每条都写成可证伪的形式,并写明**失败意味着什么**。

### C1 — 源 → `ext_` 的数据通路端到端存在

**断言**:给定该项目的一次性导出,在不改动冻结模板的前提下,至少一个 pack 声明的 `ext_`
plm_system 列在 MetaSheet 表格里出现**非空值**,且该值可逐格追溯到导出的某一源列。

**今天的证据说它不存在**:生产代码里**没有任何东西产出 `ext_` 值**。
展开器只发固定的 canonical 行形状,一个 `ext_` 键都没有
(`plugins/plugin-integration-core/lib/stock-preparation-bom-expansion.cjs:500-519`);
没有任何 fieldIdMap 构造器发 `ext_` 条目,而完备性闸只校验模板的 plm_system 字段
(`lib/stock-preparation-table-actions.cjs:188-211`),所以 `ext_` 键缺映射时静默落回原逻辑 id
(`mapFieldName`,`lib/stock-preparation-apply-writer.cjs:108-110`)。
**计划器 → 记录**那一半是真的、有测试的
(`__tests__/stock-preparation-pack-aware-refresh.test.cjs:377-383`、`:590-611`)。

**C1 失败意味着**:pack 的 21 个 `ext_` 列今天是装饰件——建得出、分得了带、写得进去,
但没有任何东西能把源数据放进去。迁移这条腿必须先补 mapper(§5),
在此之前"接管进度"里所有涉及数据落地的说法都要打折。

### C2 — pack 声明的类型扛得住全字符串的旧数据

pack 声明了 **10 个非 string 的 `ext_` 列**:7 个 number
(`ext_parentSortNo` `ext_componentSortNo` `ext_blankLength` `ext_blankWidth`
`ext_blankThickness` `ext_blankQuantity` `ext_blankMass`)、1 个 date(`ext_stockPrepDate`)、
2 个 select(`ext_pickingNode` `ext_handoverSection`),见
`lib/customer-packs/factory-a.rehearsal.cjs:73-74, 94, 96-102`。
而旧库的日期与数量**全是字符串**(迁移方案 §0、§附 4)。

**断言**:这 10 列要么落库,要么**在写入点被明确拒绝**——不允许"看起来成功了但值是垃圾"。

**从代码推出的三条预测**(尚未实测,这正是切片要打的靶)。
下表「插件侧」指 `plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs`,
「宿主侧」指插件 SDK 的写入通路 `packages/core-backend/src/multitable/records.ts`
(`plugin-scope.ts:341-352` → `records.createRecord/patchRecord` → `buildNormalizedPatch:338-380`
→ `normalizeFieldValue:225`):

| 类型 | 插件侧 | 宿主侧 | 预测 |
|---|---|---|---|
| number(7) | **不做任何类型检查**:`normalizePayloadForTemplate` 只按**冻结模板**取字段类型(`apply-writer.cjs:120-122, 166-171`),pack 列不在表里,`normalizeValueForTemplateField` 原样返回(`:133-137`) | `records.ts:246-248` → `normalizeNumber`(`:116-123`):可解析的数字串接受,不可解析抛 `Number value must be finite` | 毛胚长/宽/厚/数量/质量在旧库是**含单位字符串**(迁移方案 §1.1、字段字典 §5.8)→ **写入必然被拒**,不会静默变 NaN |
| select(2) | 同上,不检查 | `records.ts:125-137` `normalizeSelectValue`:必须**精确命中** options,否则抛 `Invalid select option` | 旧 `config_info` 里凡 pack optionSets 没有的取值,一律写不进去 |
| date(1) | 同上,不检查 | `records.ts:254-259`:只要求是字符串,**不校验格式** | 任何格式都能落库 → 这是唯一会**静默通过**的类型,也是最需要在 mapper 里归一的一列 |

**C2 失败(预测被实测推翻)意味着**:类型闸的位置和我们以为的不一样,pack 的类型声明
就不能当作数据质量保证;所有"类型规范化在迁移期完成"的说法要重写,归一必须前移到导出侧。

### C3 — 对账表可计算

**断言**:迁移方案 §2(4) 的 7 行对账表里,**行数**、**采购/仓库 1:1 挂接**、**人列值**
这三行能在这一个项目上真的算出确定的 0 / 非 0 数字。

**C3 失败意味着**:T-2(双轨对账零差异窗口)不是"引擎还没写",而是"判据本身不可计算";
那么 go-live gate 的 T-2 / T-3 要重新定义,而不是排期。

---

## 2. 导出请求(可直接转交客户 DBA)

**范围**:**一个** `product_code`。由客户从 `product_status.status = 0`(在制)里任选一个
规模适中的项目——这是迁移方案 §2(2) 判定 in-flight 的依据。

### 2.1 需要的表与列

join 形状取自**迁移方案 §2(2)**,该节把源系统主查询从 legacy mapper XML 逐行转写为
`stock_info si LEFT JOIN config_info c1..c6 LEFT JOIN purchase_info pi LEFT JOIN warehouse_info wi`,
并注明 `craft_info` 是 1:N 的独立视图。

| # | 表 | 过滤条件 | 需要的列 | 为什么 |
|---|---|---|---|---|
| 1 | `stock_info` | `product_code = <该项目号>` | 全部列(迁移方案 §1.1 已逐列列出) | 宽表主行;含 `pli_obj_id` / `component_code` / `version` / 6 个 `*_id` 外键 / provenance |
| 2 | `purchase_info` | `stock_info_id ∈ 上一步的 id 集合` | 全部列(§1.3) | 1:1 采购跟进 |
| 3 | `warehouse_info` | `stock_info_id ∈ 同上` | 全部列(§1.4) | 1:1 仓库跟进 |
| 4 | `config_info` | 上述行引用的 6 个 `*_id`,或整表 | `id`, `type`, `name`, `type_ex_attr1` | 把 6 个外键解成人类可读值;§1.6 |
| 5 | `product_status` | `product_code = <该项目号>` | `product_code`, `status`, `product_type` | 证明该项目在制;§1.5 |

**我们不需要客户执行那个 join。** 三张业务表各自导出 + `config_info` 字典即可,join 在我们这边做:
客户 DBA 的工作量最小,结果也最容易复核。

**交付形式**:CSV 或 Excel,一表一文件,UTF-8。
**不需要**任何连接串、账号、口令、主机名、VPN 或防火墙开孔——这是一次性文件交付,不是开库。
一次性、只读、单项目——这三条就是这次请求可批、而"常设读窗口"至今没批下来的差别所在。

### 2.2 我们**不**需要的(这份清单才是它可批的原因)

- 其他任何 `product_code`;
- `general_stock_info`(通用件线,分区键是 `task_code` 而非 `product_code`,§1.2);
- `craft_info` / `pick_info` / `process_info` / `section_info`(工艺与领料明细,1:N,v1 不进切片,依次见 §1.7 §1.10 §1.9 §1.8);
- `stock_basic_info` / `stock_product_basic_info`(主数据模板,§1.23 §1.24);
- 全部 RBAC 表:`user` / `role` / `user_role` / `permission` / `role_permission` / `menu` / `role_menu` / `role_column` / `table_column_config`(§1.13-§1.21);
- `ding_talk_comment`(§1.22,含钉钉用户 id 与审批实例 id);
- K3/金蝶侧任何表(独立只读 SQL Server,本次不迁——见迁移方案「图号 ↔ K3 物料编码」一节);
- 任何数据库连接凭据、应用配置文件、备份文件、日志。

### 2.3 必须排除的机密/凭据列

即使它们所在的表出现在别的请求里,这次也不要给:

- **`user.password` —— 明文口令**(迁移方案 §附1 风险 1;`userMapper.xml` 里是明文比对)。
  整张 `user` 表本就不在请求内,这里再点一次名,是为了在 DBA "顺手多导一点"时有明确红线。
- `user.login_ip` / `user.mobile` —— PII,不需要。
- 应用配置里的 datasource url / username / password、K3 授权码 / appKey ——
  迁移方案第 0 节只标了它们的位置、没抄值;本次请求同样一个字都不要。

**需要但要先拍板的一列**:`stock_info.create_by` / `update_by`(purchase / warehouse 同名列)
存的是**登录用户名字符串**(迁移方案 §2(5))。它是 provenance,切片需要它来验证 §2(5) 的
`ext_` 溯源列;但它是人名。请客户选:原样给,或给一份稳定的假名映射。**两种我们都能用。**

---

## 3. 供数之前必须钉死的决定

这四条一旦跑过 provisioning 就**改不动或代价极高**,必须先裁。

### D-1 projectId / 租户 —— 决定确定性 sheet id

`ext_` 列 id 与 sheet id 全部由 projectId 派生:
`stableMetaId(prefix, ...parts)`(`provisioning.ts:130-136`)、
`getObjectSheetId(projectId, objectId)`(`:138-140`)、
`getObjectFieldId(projectId, objectId, fieldId)`(`:146-148`)。
而 pack 的 dry-run / install 路由的 projectId **不接受请求参数**,一律由认证租户派生:
`resolveIntegrationStagingProjectId(tenantId, undefined)` → `` `${tenantId}:integration-core` ``
(`lib/http-routes.cjs:648-651`;调用点 `:4337` dry-run、`:4356` install)。
安装器再用同一个 projectId 算每个 `ext_` 列的物理 id(`customer-pack-installer.cjs:462`)。

**后果:唯一的自由度是租户。** staging 租户跑出来的 sheet id 与 field id 和生产租户的**不同**,
不能改名、不能搬迁——生产上线时必须在生产租户重新 provision + install + 重灌。

**必须裁定**:切片跑在哪个租户。
(a) staging 租户 —— 数据一次性、结论可迁移、执行面日后要重跑;
(b) 生产租户 —— 一次到位,但要求 G-1(备份与恢复演练)先过,而 G-1 现状未达成
(`beiliao-production-go-live-gate.md` §1)。
**建议 (a)**:这一刀的产物是**结论**,不是上线的数据。

### D-2 `ext_materialCode` 物料ID 的承载:v1 吃 string,还是字典表 + link

真实字典 203 条,`MAX_OPTIONS_PER_FIELD = 200`(`lib/stock-preparation-option-sync.cjs:28`)——
所以这一列**在任何 pack 版本上都不可能是 select**,pack 注释已把这条写死
(`lib/customer-packs/factory-a.rehearsal.cjs:76-90`),v1 声明为 `string`(`:91`)。

**为什么必须在 provision 之前定**:安装器是**只增不改**的。
`ensureExtensionFields` 走 `ensureMissingObjectFields`,只创建缺失列
(`customer-pack-installer.cjs:454-489`);而冲突前扫只比 `ownership` 与 `preserveOnRefresh`
两个键,**根本不看列的 type**(`classifyExistingField`,`:209-254`)。
因此:列一旦以 `string` 建出来,之后把 pack 改成 link 或别的类型,安装器**既不报冲突、也不改它**,
那一列会永远是 string —— **dry-run 也不会告诉你**。

**建议**:v1 就吃 string,把它作为切片的**已知债务**记账。改 link 需要给 pack 的 `type` 词表
加 `link`,那是冻结模板变更,属独立评审(排演报告 Open decision 1)。

### D-3 两个 select 列的词表必须换成客户真实字典

宿主在写入点对 select 做**精确命中**校验(`records.ts:125-137`)。
pack 现有的 optionSets 是排演用的合成词表(`factory-a.rehearsal.cjs:119`、`:133`)。
不换成 `config_info` 里 领料节点 / 交接工段 的真实取值,这两列**每一行都会写失败**。

好消息:optionSets 在**每次**安装都会重新 patch(`syncPackOptionSets`,
`customer-pack-installer.cjs:492-511`),所以词表是**装后可改**的——但仍必须在**灌数之前**改对。
另:任一词表一旦超过 200 条,就重演 D-2 的困境。

### D-4 pack 必须先进服务端 allowlist,ledger 必须在位

catalog 默认是空的:`resolveCustomerPackCatalogConfig` 只认 `config.stockPreparationCustomerPacks`
(`lib/stock-preparation-customer-pack-catalog.cjs:33, 53-58`),缺省 `{}` → 任何 packId 都被拒(`:105-113`)。
install 还硬性要求安装 ledger 在位,否则 501
(`requireStockPreparationPackInstalls`,`http-routes.cjs:2648-2653`;调用点 `:4352`)——
ledger 带 migration 076(状态账本 §2)。

---

## 4. 跑法(runbook)

每步给出:路由 + 方法 + 权限闸 + PASS 长什么样。没有实现的一律点名。

### Step 0 —— 部署前置(无路由)

把 factory-a pack 放进 `config.stockPreparationCustomerPacks`;确认 ledger migration 已上。
**PASS**:`GET /api/integration/stock-preparation/customer-packs`
(路由表 `http-routes.cjs:132`,handler `:4287`,`requireAccess(req, 'admin')`)返回 `packCount ≥ 1`。

### Step 1 —— provision canonical 目标

`POST /api/integration/stock-preparation/target/ensure`(路由表 `:71`,handler `:4200-4210`)。
闸:`requireAccess(req, 'admin')`;租户与 projectId 由**认证主体**派生,请求带 `baseId` 直接 400
(`assertNoRequestBaseId` `:1331-1335`;write input `:1337-1346`)。
**PASS**:201(`mode === 'canonical_create'`)或 200;再 `GET .../target/readiness`
(`:70`,handler `:4189`)确认 `ready: true`。

### Step 2 —— pack dry-run(零写)

`POST /api/integration/stock-preparation/customer-packs/:packId/dry-run`
(`:135`,handler `:4332-4344`),admin。它复用安装器自己的只读前扫,所以"报告的"与"安装做的"不会漂移。
**PASS**:21 个 `ext_` 列全部落在 `missing`(全新表),`conflicts` 为空。
**注意**:dry-run **不检查列 type**(D-2),"conflicts 为空"不等于"类型对"。

### Step 3 —— install(增量、幂等)

`POST .../customer-packs/:packId/install`(`:136`,handler `:4348-4369`),admin + ledger 必需。
安装是 validate-all-then-write:任一 ownership 冲突在第一次写之前**整单中止**
(`customer-pack-installer.cjs:322-339`,由 `installCustomerPack` `:742` 调用)。
**PASS**:201 且 `createdFields` 21 条;**再跑一次同一请求** → 200 且 `createdFields` 为空。

### Step 4 —— 源 → `ext_` 映射

**没有实现。** 这是切片里唯一真正要写的东西,规格与规模见 §5。

### Step 5 —— 落行(今天走不通,先裁定)

三堵独立的墙,必须分别处理:

**(a) 数据从哪来。** apply 路由从**已注册的外部系统**取 source adapter
(`loadTableActionSourceAdapter`,`http-routes.cjs:2842-2864`);而 stock-prep 动作只接受
`data-source:sql-readonly` 与 `bridge:legacy-sql-readonly` 两种 kind
(`stock-preparation-table-actions.cjs:132-137`);现成的 sql-readonly adapter 明写只支持
Postgres / SQL Server(`lib/adapters/data-source-sql-readonly-source-adapter.cjs:3-5`)。
**仓库里没有 MySQL 源适配器。**
→ 一次性 CSV 必须先落进**我们自己的**一个只读 Postgres schema,再注册成外部系统。
这既是最短路,也顺带守住了"不要客户的连接"这一条。

**(b) canonical 目标在 sandbox 闸下永远不可写。**
`assertStockPrepApplySandboxAllowed` 对 `plm_stock_preparation_main` **无条件 403**
(`stock-preparation-table-actions.cjs:882-889`)。要往 canonical 落行只能配 production policy——
服务端 config 独有、**无 env 开关**、默认休眠(`resolveStockPrepApplyProductionPolicy` `:923-928`)。
而 pack **只能装在 canonical 上**(`requireCanonicalTargetSheet`,installer `:580-592`;
`targetObjectId` 由主模板硬派生,`lib/stock-preparation-customer-pack.cjs:446`)——
所以 sandbox 目标上根本没有 `ext_` 列,替代不了。

policy 的形状恰好就是"一个项目、有界、有期限":`maxCleanRows` 为正整数上界、`expiresAt` 严格 ISO
且不得超出 7 天窗口、`requireFreshDryRun` 必须为 true、`authorizedTargetObjectId` 只能是 canonical、
`allowedActionId` 只能是 `plm.stock-preparation.pull-bom.v1`
(`lib/stock-preparation-production-policy.cjs:75-131`、`:137-147`;apply 侧分支
`stock-preparation-table-actions.cjs:937-958`,行数上界后检 `:962-966`)。
**这正是这一刀该向 owner 要的授权:一个项目的行数上界 + 一周内到期。**

**(c) 人列灌不进去。** apply 写入器**结构上**拒绝一切 human_preserved 列,包括 pack 的 8 个
`ext_` 人列(`assertNoHumanFields`,`apply-writer.cjs:190-196`,调用点 `:324` `:347`;
墙由 `derivePackAwarePlmWritableFields` 按**已安装属性**扩展,`:474-478`)。
刷新写入器**本来就不该**写人列——它是刷新墙,这个拒绝是对的。
但迁移**首灌**需要写 备料日期 / 领料节点 / 交接工段 / 毛胚五维,**那是另一个写入器,今天不存在。**

因此 Step 5 拆两半:

- **5a(在本切片内)** 只灌 plm_system 半边:canonical 17 列 + pack 13 个 `ext_` plm 列
  (分带计数见排演报告「The 46-column shape」)。
  `POST /api/integration/table-actions/:actionId/dry-run`(`:56`,handler `:3857`,`requireAccess(req,'read')`)
  → `POST /api/integration/table-actions/:actionId/apply`(`:58`,handler `:3933`,
  `requireAccess(req,'write')`,admin 提权见 `applyPermissionForUser` `:2866-2868`)。
  **PASS**:apply 返回 `counts.created` = 导出行数、`counts.failed = 0`,且表格上 `ext_legacyRowId`
  等列非空 —— 这就是 **C1 的判定**。
- **5b(明确留白)** 人列半边不灌。切片对它的产出是一份"实测哪些值会被宿主拒 + 拒因"的清单
  (即 **C2 的判定**),不是把数据塞进去。

### Step 6 —— 算对账

**没有实现**(状态账本 §1 第 3 步:计划完整、零可执行面)。
切片阶段用一次性脚本算三行:
① 行数(导出行数 vs `queryRecords` 行数);
② 采购/仓库 1:1 挂接(pi/wi 计数与 `stock_info_id` 对应);
③ 人列值(切片里人列为空 → 这一行的期望是"源有值、目标空",本身就是 5b 缺口的量化)。
**PASS**:三行都得出确定数字,而不是"算不了" —— 这是 **C3 的判定**。

### Step 7 —— 改一个 PLM 值再刷一次,证明人手格子活着

在表格上人工改一个 human 列(canonical 的 `notes` 或 `demandDate` 即可,它们在冻结模板里,
`lib/stock-preparation-templates.cjs:588`、`:590`),同时在只读源里改一个 plm 值,重跑 dry-run + apply。
**PASS**:plm 列被刷新、human 列**逐字节不变**;且刷新计划发布的 `humanPreservedFields` 确实包含
pack 的 8 个 `ext_` 人列 —— 这一条今天已有测试守着
(`__tests__/stock-preparation-pack-aware-refresh.test.cjs:364-372`),切片只是把它在真实数据上再验一次。

---

## 5. mapper —— 唯一真正新写的那件东西

### 5.1 它属于哪个边界

两个候选边界,答案不是二选一,而是**两个都要,这一刀只做后者**:

- **展开边界**(`stock-preparation-bom-expansion.cjs:500-519 createRow`)。它的源是 PLM BOM 读计划
  (`PLM_STOCK_PREPARATION_BOM_READ_PLAN` `:157-204`,读的是 DN_PDM_* 对象),产出固定的
  canonical 行形状。pack 里那 7 个 PLM 派生的 `ext_` 列(规格 / 名称及规格 / 标准 / 设计者 /
  父组件图号 / 父组件名称 / 创建来源,`factory-a.rehearsal.cjs:59-65`)将来要靠这里填 ——
  那是**长期刷新**的通路。
- **导入边界**(一次性迁移)。旧 备料 宽行不是 PLM BOM:它带 `stock_info.id`、`version` 乐观锁、
  6 个 `config_info` 外键、以及 pi/wi 的跟进值,进不了 PLM 读计划的形状。**这一刀做的是它。**

**关键约束(决定了 mapper 不能做成离线预处理)**:apply 会用 source adapter **重算** dry-run
再比对 revision(`applyStockPreparationAction` 内 `const dryRun = await computeDryRun({ action,
parameters, sourceAdapter, ... })`,`stock-preparation-table-actions.cjs:968`、`:993`;
两条路由用同一个 `resolveInstalledFieldProperties` 取带宽,`http-routes.cjs:2733-2746`、`:3874`、`:3950`)。
所以"先把 CSV 转成计划、再喂给 apply"的离线脚本**没有落点**——mapper 必须坐在
**source → 行**的路径上,让 apply 重算时能得到同样的行。

### 5.2 配置形状(建议;尚未实现)

```
mapping: {
  id, version,
  keyOf: ['pli_obj_id', 'product_code', 'component_code'],   // 迁移方案 §0 的自然键
  columns: {
    '<源列名>': { to: '<ext_ 逻辑 id>', normalize: '<归一规则 id>' },
    ...
  },
  dictionaries: {                      // config_info.id -> 选项字面量
    '<源外键列>': { fromType: '<config_info.type>', to: '<ext_ 逻辑 id>' }
  }
}
```

三条硬规则:

1. `to` 必须落在 `ext_` 命名空间内(`lib/stock-preparation-extension-namespace.cjs:36`,
   校验入口 `assertExtensionFieldIdValid` `:117`)**且该 pack 声明过**。落在冻结模板 id 上即为配置非法
   ——pack 契约已经这样处理模板碰撞(`lib/stock-preparation-customer-pack.cjs:205`)。
2. `to` 若指向 pack 的 human_preserved 列,mapper **必须**把它标成"首灌专用",绝不能进刷新路径的行
   ——否则 `assertNoHumanFields` 会把整批 apply 打掉(§4 Step 5c),而那个拒绝是对的。
3. 归一在 mapping **之前**(§6)。

### 5.3 它必须怎样撬动 fieldIdMap 完备性闸

**今天的闸**只在 `fieldIdMap` 有**任何显式绑定**时才生效,且只要求**模板的 plm_system 字段**齐全:
`targetFieldMapHasExplicitBindings` + `plmSystemFieldIds(template)`
(`stock-preparation-table-actions.cjs:188-211`)。pack 的 `ext_` 列**不在** `template.fields` 里,
所以缺映射既不 422,也不报警 —— 只会在写入时静默拿逻辑 id 当物理 id
(`mapFieldName`,`apply-writer.cjs:108-110`)。

**要求的改法(规格,不是代码)**:把 `assertTargetFieldMapCompleteness` 的 required 集合
从 `plmSystemFieldIds(template)` 改成
**「模板的 plm_system 字段 ∪ 已安装 pack 的 plm_system `ext_` 列」**。
后者已经有现成的读回口子:`installedFieldProperties`
(`lib/stock-preparation-pack-installed-fields.cjs:60`,路由侧 `resolveInstalledFieldProperties`,
`http-routes.cjs:2733-2746`),分带函数 `derivePackAwarePlmWritableFields`
(`lib/stock-preparation-conflict-planner.cjs:299`)是 **fail-closed** 的
——未分类的列既不可写、也不进人墙(`:191-201` 的四级优先序)——正好可以直接复用它的
`plmWritableFieldIds`。
**闸必须沿用同一个 fail-closed 语义**:未分类的 `ext_` 列不进 required 集合,但也不允许被写。

### 5.4 证明它的测试

- **`__tests__/stock-preparation-source-ext-mapper.test.cjs`(新)**
  ① 一条合成旧宽行 → 映射出的行带全部 13 个 plm `ext_` 键;
  ② `to` 指向模板 id → 抛;
  ③ `to` 指向未声明的 `ext_` id → 抛;
  ④ `to` 指向 human 列且未标首灌 → 抛;
  ⑤ 字典列 `config_info.id` 解不出 → **阻断**(迁移方案 §2(4):映射命中率 100%,未命中即阻断)。
- **`__tests__/stock-preparation-table-actions.test.cjs`(扩)** —— 闸真的长大了的唯一证据:
  装了 pack、`fieldIdMap` 有显式绑定但漏掉某个 plm `ext_` 列 → `TARGET_SCHEMA_INCOMPLETE` 422;
  把该列从 `installedFieldProperties` 拿掉 → 回到今天的行为(不 422)。
- **`__tests__/stock-preparation-pack-aware-refresh.test.cjs`(扩)**:
  把 `:377-383` 的既有断言改成用 **mapper 真实产出的行**来跑 —— human `ext_` 键一个都不进
  add record / update patch。
- **`__tests__/stock-preparation-apply-writer.test.cjs`(扩)**:C2 的三条预测各一条
  (number 含单位串被拒、select 未命中被拒、date 任意串通过),用假 recordsApi 复刻宿主
  `records.ts` 的校验语义。
- 新增文件要接进 `__tests__/test-chain-completeness.test.cjs` 的链(排演报告 Verification 一节的既有纪律)。

### 5.5 规模(诚实估)

- mapper 本体 + 配置校验:一个**中等模块**,与 `lib/stock-preparation-expansion-snapshot-mapper.cjs` 同量级。
- 完备性闸扩展:十几行 + 一处依赖注入(读回口子已存在)。
- CSV 落只读 Postgres 并注册成外部系统:一次性运维动作,**无新代码**。
- **5b 的人列首灌写入器不在本切片内** —— 它是独立的一件事,需要自己的 owner 闸(理由见 §4 Step 5c)。

---

## 6. 身份归一化的坑

**规则:先归一身份,再做映射。**
mapper 的 `columns` 按源列名索引;两个源列名指向同一个概念,mapper 就会老老实实生成
**两个独立字段** —— 而 pack 的 `ext_` 列是**只增不改**的(§3 D-2),多建出来的那一列**删不掉**。

下面十条来自 **`demo-field-dictionary-spec.md` §5**(该文逐条给出了 `defaultFields.js` 的行号)。
**更正一处**:这份不一致清单在**字段字典文档**里,不在 `mysql-migration-plan.md` 里。
迁移方案自己的风险清单(§附)是另外六条(明文口令、硬编码 K3 授权码、图号↔K3 映射缺表、
时间/数值全字符串、两处 SQL 疑似 bug、`craft_info` 无乐观锁);其中与"先归一"直接相关的两条
列在本节末,其余在 §2.3 与 §8 各归各位。

| # | 坑 | 出处 | 归一裁定 |
|---|---|---|---|
| 1 | 任务编号 `taskCode` vs 生产编号 `productCode` —— 同一个项目号,两个 identity | 字段字典 §5.6 | 归一到一个;canonical 侧对应 `projectNo`(`stock-preparation-templates.cjs:560`) |
| 2 | 提前周期 的 identity 是**中文字面量** `提前周期`,后端 Java 属性叫 `normalLeadDays`(Integer,天);库列 `stock_info.normal_lead_days` INT(迁移方案 §1.1) | 字段字典 §5.7 | 归一到英文 id;canonical 侧**已有** `leadTimeDays`(number,human_preserved,`templates.cjs:589`)——**不要**再建 `ext_` 列 |
| 3 | "材料" vs "材质" —— identity 同为 `material`,显示名两套 | 字段字典 §5.5 | 只是标签,拍板一个;不影响 id |
| 4 | 发料情况 `materialIssuance` 权限自相矛盾(仓库语义,却只有生产侧可编辑) | 字段字典 §5.1 | 归属需客户拍板;影响的是列权限,不是 id |
| 5 | 物料现状及原因 `materialStatusAndReason` 同类矛盾(采购语义,采购页无此列) | 字段字典 §5.2 | 同上 |
| 6 | `sortId` 重复(采购员 与 更新时间 都写成 39) | 字段字典 §5.3 | 迁移时重排;**别把 sortId 当稳定 key** |
| 7 | 实际到料日期 `actualDeliveryDate` 的 `type` 两页不一致(一页 date、一页无 type) | 字段字典 §5.4 | 定成 date,并在 mapper 里归一格式 |
| 8 | 总数量 / 毛胚五维是**故意的字符串**(允许用户输入带单位) | 字段字典 §5.8 | 直接撞 C2 的 number 预测:要么 mapper 拆成"数值 + 单位"两列,要么这几列别做 number |
| 9 | `componentCode` / `componentName` / `standard` 并非总是系统写入(有 `importTag` 标记的人工导入行) | 字段字典 §5.9 | 这些行的 plm_system 归属是假的;迁移时须单独标记 |
| 10 | `nameAndStandard` 只在采购/仓库页出现,通用件页数组里没有,但后端实体有 | 字段字典 §5.10 | 是后端拼接的派生列;对应 pack 的 `ext_nameAndSpec`(`factory-a.rehearsal.cjs:62`) |

来自**迁移方案本身**、同样必须"先归一"的两条:

- **日期/时间全库存字符串**(迁移方案 §0、§附 4)。归一到 `yyyy-MM-dd` 是对账"人列值"那一行
  的前提(§2(4) 容差),也是 C2 里唯一会静默通过的 date 列的唯一保险。
- **6 个 `*_id` 是 `config_info.id` 外键**,必须保留**旧 id → 新选项**对照表
  (迁移方案 §2(1) 换算要点);命中率不足 100% 即阻断(§2(4))。

---

## 7. 退出判据,以及它解锁什么

### 7.1 退出判据(每条都要 values-free 证据)

1. 一次性导出到手,且**只**含 §2.1 的五张表 / 一个 `product_code`;§2.3 的机密列一个没混进来。
2. canonical 目标 ready、pack 安装完成,且**第二次**安装返回 200 且零新建(§4 Step 1-3)。
3. mapper 落地,§5.4 的五组测试全绿;完备性闸对"漏映射的 plm `ext_` 列"确实 422。
4. 该项目的 plm 半边行落进 canonical,`counts.failed = 0`,表格上至少 `ext_legacyRowId` 有值
   —— **C1 判定**。
5. 10 个非 string `ext_` 列各有一份实测结论(落库 / 被拒 + 拒因),与 §1 C2 的三条预测逐条对照
   —— **C2 判定**。预测被推翻同样算通过,结论是"我们对类型闸的理解要改"。
6. 对账三行算出确定数字 —— **C3 判定**。
7. 改一个 PLM 值 + 一次刷新后,human 列逐字节不变(§4 Step 7)。

### 7.2 明确**不**在退出判据里

人列首灌;`craft_info` 子表;RBAC 列权限;`general_stock_info` 通用件线;
图号 ↔ K3 编码 registry;第二个 `product_code`;任何外部写回。

### 7.3 它解锁什么

- **常设只读窗口的对话。** 今天 T-1 卡在"客户没批备料库的读授权"
  (`beiliao-production-go-live-gate.md` §2 T-1、状态账本 §1 第 2 步)。
  这一刀把请求从"给我们开一个持续的库读窗口"换成"给我们一个项目的一次性文件"——
  不需要网络打通、不需要凭据、可复核、可撤回。等切片跑完再谈常设窗口时,
  我们手里是一份**具体的失败清单**(哪些值宿主会拒、哪些列今天填不了),而不是一份计划。
- **T-2 对账引擎。** §4 Step 6 的一次性脚本就是引擎的第一版规格:它会告诉我们 7 行里
  哪几行是"算法问题"、哪几行只是"数据还没进来"。go-live gate 把 T-2 记成"引擎尚未实现",
  这一刀把它降级成"引擎的输入形状已确定"。
- **production apply policy 的第一次真实使用。** 闸已经接进 apply 路径
  (`stock-preparation-table-actions.cjs:937-958`),但**默认休眠**:policy 只能来自服务端 config,
  没有 env 开关,缺省即 `undefined` → 回落 sandbox 闸 → canonical 被拒
  (`:923-928`)。(注:`lib/stock-preparation-production-policy.cjs:3-11` 的文件头还写着 P1 的
  "NOT wired into the apply path",那段注释已经**过时**,以 table-actions 的实际分支为准。)
  单项目切片是它最小、最可控的首用场景,也让"有界授权"这件事第一次有实物。

---

## 8. 本文没有验证的事

- `ext_supplementId` 补充信息ID 的语义:pack 只声明了标签(`factory-a.rehearsal.cjs:70`),
  仓库里没有任何代码定义它对应源库的哪一列。把它映射到 `purchase_info.id` 或 `warehouse_info.id`
  属**未经验证的猜测**,须客户确认。
- 宿主 `records.ts` 的校验语义是从代码读出的,**未在真实实例上跑过**;C2 的三条预测正是为此设计。
- 迁移方案 §附 5 记录的两处源系统 SQL 疑似 bug(占位符缺逗号、`product_code` 写入了 `prepareDate`),
  本文未复核;导出到手后应以**实际落库数据**为准,而不是以 schema 推断为准。
- `craft_info` 无乐观锁(迁移方案 §附 6)对切换期并发的影响,本切片不涉及,也未评估。

---

*本文由 2026-08-22 的接管盘点触发创建,是**活文档**:状态变化就地更新,不另起快照
(沿用状态账本与上线门的纪律)。§3 的 D-1 / D-2 与 §4 Step 5b 的 production policy 属 owner(O)层,
先批后动;其余属技术负责人(T)层,"默认前进 + 24h 异步否决"。*
