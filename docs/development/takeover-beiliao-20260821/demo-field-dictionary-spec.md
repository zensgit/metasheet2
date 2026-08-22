# Demo 字段 & 字典规格说明（备料 / 通用件 → MetaSheet 迁移）

来源代码（客户生产系统 zip，仅引用路径与行号，不摘录任何主机名/IP/密码/授权码/appKey）：

- `frontend/src/utils/defaultFields.js`（字段定义，共 679 行）
- `frontend/src/router/router.js`（路由，确定各页面归属）
- `frontend/src/components/{stockInfo,generalStockInfo,purchaseInfo,warehouseInfo,configContent,configEdit}.vue`
- `backend/src/main/resources/mapper/master/{configInfoMapper,ColumnMapper}.xml`
- `backend/src/main/java/yaguang/stock/order/controller/{ConfigController,ColumnController,GeneralStockInfoController,StockInfoController}.java`
- `backend/src/main/java/yaguang/stock/order/entity/{ConfigInfo,Column,GeneralStockInfo,StockInfo}.java`

> **重要澄清（先读）**：`router.js:65-66` 里 `/stock` 和 `/generalStock` 两条路由的注释都写的是「备料页」——这其实是客户代码里的笔误，两者并不是同一页面：
> - `/stock`（`stockInfo.vue`，组件名 `HomeContent`）是「生产」角色的**主表/备料页**，它的列**不是**从 `defaultFields.js` 读的，而是运行时从后端 `POST /col/listAll` 拉取（`stockInfo.vue:1466-1477`），再按登录用户的角色权限做可编辑标记（见下文"RBAC 列权限模型"）。
> - `/generalStock`（`generalStockInfo.vue`）才是静态引用 `defaultFields.js` 里 `defaultColumnsInfoForGeneral` 的页面（`generalStockInfo.vue:615,651`），文件顶部注释写的是「通用物料页面的默认字段信息」（`defaultFields.js:1`），即题目所说的「通用件」页。
>
> 因此本报告把 `defaultColumnsInfoForGeneral`（38 个字段）当作**备料/通用件共用的主字段字典**来处理——它是 `/generalStock`（通用件页）的权威静态定义，同时其字段集合、identity 命名与 `/stock`（备料主页）在后端 `columns` 表中维护的字段目录（`ColumnMapper.xml:8-12`）在语义上完全对应，只是 `/stock` 页把"谁能编辑哪一列"这件事从写死的布尔值搬到了数据库 RBAC 里（`role` × `role_column` × `columns`，`ColumnMapper.xml:14-22`）。这一点在向客户复刻演示环境时必须讲清楚，否则会把两套不同的权限机制当成一套。

---

## 0. 页面 ↔ 字段来源对照

| 路由 | 组件 | 字段来源 | 说明 |
|---|---|---|---|
| `/stock` | `stockInfo.vue` | 后端 `columns` 表 + `role_column` RBAC（动态） | 生产角色主页；`canEditColumn()` 查 `this.columns[].editable`（`stockInfo.vue:1484-1489`） |
| `/generalStock` | `generalStockInfo.vue` | `defaultColumnsInfoForGeneral`（静态，38 字段） | 题目所指「通用件」页 |
| `/purchase` | `purchaseInfo.vue` | `defaultColumnsInfoForPurchase`（静态，22 字段） | 采购角色页 |
| `/warehouse` | `warehouseInfo.vue` | `defaultColumnsInfoForWarehouse`（静态，35 字段） | 仓库角色页 |

四个页面对应同一批"备料任务"业务数据在不同角色视角下的裁剪视图；`defaultFields.js` 里没有为 `/stock` 单独定义字段数组（`stockInfo.vue` 全文 `grep identity:` 结果为 0）。

---

## 1. 通用件页字段全表（`defaultColumnsInfoForGeneral`，38 个，`defaultFields.js:2-273`）

| # | 中文名 | identity | type | canEdit | sortId | 归属/编辑角色（依据） |
|---|---|---|---|---|---|---|
| 1 | 备料日期 | `prepareDate` | date | true | 2 | 生产（仅本页可编辑） |
| 2 | 任务编号 | `taskCode` | text | true | 3 | 生产（**注意**：采购/仓库页里同一概念叫 `productCode`，见 §5 命名不一致） |
| 3 | 父组件图号 | `parentComponentCode` | text | true | 4 | system（PLM BOM 派生，仅此页存在该字段） |
| 4 | 父组件名称 | `parentComponentName` | text | true | 5 | system（PLM BOM 派生） |
| 5 | 当前组件（零件）图号或标准号 | `componentCode` | text | true | 6 | **system**（题目显式规则：PLM 派生；`StockInfoController.java:97-102 getBomFromPlm`） |
| 6 | 当前组件（零件）名称 | `componentName` | text | true | 7 | **system**（PLM 派生） |
| 7 | 规格 | `standard` | text | true | 8 | **system**（PLM 派生） |
| 8 | 材料 | `material` | select（字典：材料） | true | 9 | 生产（字典 #1，唯一带"显示颜色"的字典） |
| 9 | 总数量 | `totalNum` | text（**非 number**，见 §5） | true | 10 | 生产 |
| 10 | 材料类型 | `rawMaterialType` | select（字典：材料类型） | true | 11 | 生产（字典 #2） |
| 11 | 毛胚类型 | `embryoType` | select（字典：毛胚类型） | true | 12 | 生产（embryo* 规则；字典 #3） |
| 12 | 备注 | `remark` | text | true | 13 | 生产 |
| 13 | 领料节点 | `pickNode` | select（字典：领料节点） | true | 14 | 生产（规则；字典 #4） |
| 14 | 交接工段 | `handoverSection` | select（字典：交接工段） | true | 15 | 生产（规则；字典 #5） |
| 15 | 需求日期 | `requirementDate` | date | true | 16 | 生产 |
| 16 | 提前周期 | `提前周期`（**identity 是中文字面量，非驼峰**） | text | true | 17 | 生产（**见 §5 后端字段名不匹配风险**） |
| 17 | 备料情况 | `preparation` | select（字典：备料情况） | true | 18 | 生产（字典 #6） |
| 18 | 毛胚长度（外径） | `embryoLength` | text（非 number） | true | 19 | 生产（embryo* 规则） |
| 19 | 毛胚宽度（内径） | `embryoWidth` | text（非 number） | true | 20 | 生产（embryo* 规则） |
| 20 | 毛胚厚度（长度） | `embryoThickness` | text（非 number） | true | 21 | 生产（embryo* 规则） |
| 21 | 毛胚数量 | `embryoNum` | text（非 number） | true | 22 | 生产（embryo* 规则） |
| 22 | 毛胚质量（单位：kg） | `embryoQuality` | text（非 number） | true | 23 | 生产（embryo* 规则） |
| 23 | 领料人 | `pickMember` | text | true | 24 | 生产 |
| 24 | 发料情况 | `materialIssuance` | text | true | 25 | **规则建议仓库，但代码里只有本页（生产侧）可编辑、仓库页此字段 canEdit=false**（见 §5 冲突①） |
| 25 | 开单日期 | `billDate` | date | true | 26 | 同上，规则未覆盖，实际仅本页可编辑 |
| 26 | 物料现状及原因 | `materialStatusAndReason` | text | true | 27 | **规则（`materialStatus*`）建议采购，但采购页根本没有此字段、仅本页可编辑**（见 §5 冲突②） |
| 27 | 回复日期 | `purchaseResponseDate` | text | false | 28 | 采购（`purchase*` 规则，采购页 canEdit=true） |
| 28 | 采购员 | `purchaseMember` | text | false | **39（重复，见 §5 冲突③）** | 采购 |
| 29 | 采购备注 | `purchaseRemark` | text | false | 30 | 采购 |
| 30 | 报料情况 | `materialReportIssuance` | text | false | 31 | 仓库（`material*Issuance` 规则，仓库页 canEdit=true） |
| 31 | 实际到料日期 | `actualDeliveryDate` | **date**（此页有 type，仓库页没有，见 §5 冲突④） | false | 32 | 仓库（`actualDelivery*` 规则） |
| 32 | 发料确认 | `materialConfirm` | text | false | 33 | 仓库（规则） |
| 33 | 实际材料类型 | `actualMaterialType` | text | false | 34 | 仓库（与 actualDelivery/materialConfirm 同组） |
| 34 | 设计者 | `designer` | text | true | 35 | 生产 |
| 35 | 创建人 | `createBy` | text | false | 36 | system（审计字段，任何页面均不可编辑） |
| 36 | 创建时间 | `createTime` | text | false | 37 | system（审计字段） |
| 37 | 更新人 | `updateBy` | text | false | 38 | system（审计字段） |
| 38 | 更新时间 | `updateTime` | text | false | 39 | system（审计字段） |

## 2. 采购页字段全表（`defaultColumnsInfoForPurchase`，22 个，`defaultFields.js:276-417`）

| # | 中文名 | identity | canEdit | sortId | 归属/角色 |
|---|---|---|---|---|---|
| 1 | 备料日期 | `prepareDate` | false | 2 | 生产写入，采购只读 |
| 2 | 生产编号 | `productCode` | false | 3 | system（**与通用件页 `taskCode` 同义，identity 不同**，见 §5） |
| 3 | 父组件名称 | `parentComponentName` | false | 4 | system（PLM） |
| 4 | 当前组件（零件）图号或标准号 | `componentCode` | false | 5 | system（PLM） |
| 5 | 当前组件（零件）名称 | `componentName` | false | 6 | system（PLM） |
| 6 | 名称及规格 | `nameAndStandard` | false | 7 | system（拼接派生字段，通用件页数组里没有它，但后端 `GeneralStockInfo.java:21` 有此列） |
| 7 | 规格 | `standard` | false | 8 | system（PLM） |
| 8 | 材质 | `material` | false | 9 | 生产写入（字典 #1；**注意此页字段名叫"材质"，通用件页叫"材料"**，见 §5） |
| 9 | 总数量 | `totalNum` | false | 10 | 生产写入 |
| 10 | 材料类型 | `rawMaterialType` | false | 11 | 生产写入（字典 #2） |
| 11 | 备注 | `remark` | false | 12 | 生产写入 |
| 12 | 需求日期 | `requirementDate` | false | 13 | 生产写入 |
| 13 | 备料情况 | `preparation` | false | 14 | 生产写入（字典 #6） |
| 14 | 设计者 | `designer` | false | 15 | 生产写入 |
| 15 | 报料情况 | `materialReportIssuance` | false | 16 | 仓库写入，采购只读 |
| 16 | 回复日期 | `purchaseResponseDate` | **true** | 17 | **采购** |
| 17 | 采购员 | `purchaseMember` | **true** | 18 | **采购** |
| 18 | 采购备注 | `purchaseRemark` | **true** | 19 | **采购** |
| 19 | 创建时间 | `createTime` | false | 20 | system |
| 20 | 创建人 | `createBy` | false | 21 | system |
| 21 | 更新时间 | `updateTime` | false | 22 | system |
| 22 | 更新人 | `updateBy` | false | 23 | system |

采购页**没有**：`embryoType`/`pickNode`/`handoverSection`/毛胚四维/`pickMember`/`materialIssuance`/`billDate`/`materialStatusAndReason`/`actualDeliveryDate`/`materialConfirm`/`actualMaterialType`/`parentComponentCode`/`提前周期`。

## 3. 仓库页字段全表（`defaultColumnsInfoForWarehouse`，35 个，`defaultFields.js:420-669`）

| # | 中文名 | identity | canEdit | sortId | 归属/角色 |
|---|---|---|---|---|---|
| 1 | 备料日期 | `prepareDate` | false | 2 | 生产写入 |
| 2 | 生产编号 | `productCode` | false | 3 | system |
| 3 | 父组件名称 | `parentComponentName` | false | 4 | system（PLM） |
| 4 | 当前组件（零件）图号或标准号 | `componentCode` | false | 5 | system（PLM） |
| 5 | 当前组件（零件）名称 | `componentName` | false | 6 | system（PLM） |
| 6 | 名称及规格 | `nameAndStandard` | false | 7 | system（派生） |
| 7 | 规格 | `standard` | false | 8 | system（PLM） |
| 8 | 材质 | `material` | false | 9 | 生产写入（字典 #1） |
| 9 | 总数量 | `totalNum` | false | 10 | 生产写入 |
| 10 | 材料类型 | `rawMaterialType` | false | 11 | 生产写入（字典 #2） |
| 11 | 毛胚类型 | `embryoType` | false | 12 | 生产写入（字典 #3） |
| 12 | 备注 | `remark` | false | 13 | 生产写入 |
| 13 | 领料节点 | `pickNode` | false | 14 | 生产写入（字典 #4） |
| 14 | 交接工段 | `handoverSection` | false | 15 | 生产写入（字典 #5） |
| 15 | 需求日期 | `requirementDate` | false | 16 | 生产写入 |
| 16 | 提前周期 | `提前周期` | false | 17 | 生产写入 |
| 17 | 备料情况 | `preparation` | false | 18 | 生产写入（字典 #6） |
| 18-22 | 毛胚长度/宽度/厚度/数量/质量 | `embryoLength`/`embryoWidth`/`embryoThickness`/`embryoNum`/`embryoQuality` | false | 19-23 | 生产写入 |
| 23 | 领料人 | `pickMember` | false | 24 | 生产写入 |
| 24 | 发料情况 | `materialIssuance` | **false** | 25 | **规则建议仓库编辑，但此页也是 false**（冲突①的另一侧证据） |
| 25 | 开单日期 | `billDate` | false | 26 | 未知归属，任何页都不可编辑 |
| 26 | 物料现状及原因 | `materialStatusAndReason` | false | 27 | 同上 |
| 27 | 报料情况 | `materialReportIssuance` | **true** | 28 | **仓库** |
| 28 | 实际到料日期 | `actualDeliveryDate` | **true**（**此页无 `type:'date'`**，见 §5 冲突④） | 29 | **仓库** |
| 29 | 发料确认 | `materialConfirm` | **true** | 30 | **仓库** |
| 30 | 实际材料类型 | `actualMaterialType` | **true** | 31 | **仓库** |
| 31 | 设计者 | `designer` | false | 32 | 生产写入，仓库只读 |
| 32-35 | 创建时间/创建人/更新时间/更新人 | `createTime`/`createBy`/`updateTime`/`updateBy` | false | 33-36 | system |

---

## 4. MetaSheet 字段建档表（合并去重后的唯一字段目录）

命名约定：客户系统里"生产/采购/仓库均不可手工编辑、由 PLM 或系统写入"的字段 → `plm_system_<identity>`；"至少有一个角色可以在网格里手工编辑"的字段 → `ext_<identity>`。字典型字段（`归属=dict`）同时挂一个 MetaSheet 选项集（见 §6）。

| 中文名 | fieldId | 多维表类型 | 归属 | 编辑角色 |
|---|---|---|---|---|
| 备料日期 | `ext_prepareDate` | 日期 | human | 生产 |
| 任务编号／生产编号 | `plm_system_taskCode` | 单行文本 | system | 系统/PLM（人工导入行例外，见 §5） |
| 父组件图号 | `plm_system_parentComponentCode` | 单行文本 | system | 系统/PLM |
| 父组件名称 | `plm_system_parentComponentName` | 单行文本 | system | 系统/PLM |
| 当前组件（零件）图号或标准号 | `plm_system_componentCode` | 单行文本 | system | 系统/PLM |
| 当前组件（零件）名称 | `plm_system_componentName` | 单行文本 | system | 系统/PLM |
| 名称及规格 | `plm_system_nameAndStandard` | 单行文本 | system | 系统（派生拼接，无角色编辑） |
| 规格 | `plm_system_standard` | 单行文本 | system | 系统/PLM |
| 材料／材质 | `ext_material` | 单选（字典） | dict | 生产 |
| 总数量 | `ext_totalNum` | 单行文本（源系统为字符串，含用户输入单位） | human | 生产 |
| 材料类型 | `ext_rawMaterialType` | 单选（字典） | dict | 生产 |
| 毛胚类型 | `ext_embryoType` | 单选（字典） | dict | 生产 |
| 备注 | `ext_remark` | 单行文本 | human | 生产 |
| 领料节点 | `ext_pickNode` | 单选（字典） | dict | 生产 |
| 交接工段 | `ext_handoverSection` | 单选（字典） | dict | 生产 |
| 需求日期 | `ext_requirementDate` | 日期 | human | 生产 |
| 提前周期 | `ext_leadTime` | 单行文本（源 identity 为中文字面量，建议迁移时改规范英文 id，见 §5） | human | 生产 |
| 备料情况 | `ext_preparation` | 单选（字典） | dict | 生产 |
| 毛胚长度（外径） | `ext_embryoLength` | 单行文本 | human | 生产 |
| 毛胚宽度（内径） | `ext_embryoWidth` | 单行文本 | human | 生产 |
| 毛胚厚度（长度） | `ext_embryoThickness` | 单行文本 | human | 生产 |
| 毛胚数量 | `ext_embryoNum` | 单行文本 | human | 生产 |
| 毛胚质量（单位：kg） | `ext_embryoQuality` | 单行文本 | human | 生产 |
| 领料人 | `ext_pickMember` | 单行文本／人员 | human | 生产 |
| 发料情况 | `ext_materialIssuance` | 单行文本 | human | 生产侧维护（命名暗示仓库，实测权限只在生产/通用件页开放，见冲突①） |
| 开单日期 | `ext_billDate` | 日期 | human | 生产侧维护（无页面明确授权，需与客户确认） |
| 物料现状及原因 | `ext_materialStatusAndReason` | 单行文本 | human | 生产侧维护（命名暗示采购，实测采购页无此字段，见冲突②） |
| 回复日期 | `ext_purchaseResponseDate` | 日期 | human | 采购 |
| 采购员 | `ext_purchaseMember` | 单行文本／人员 | human | 采购 |
| 采购备注 | `ext_purchaseRemark` | 单行文本 | human | 采购 |
| 报料情况 | `ext_materialReportIssuance` | 单行文本 | human | 仓库 |
| 实际到料日期 | `ext_actualDeliveryDate` | 日期 | human | 仓库 |
| 发料确认 | `ext_materialConfirm` | 单行文本 | human | 仓库 |
| 实际材料类型 | `ext_actualMaterialType` | 单行文本 | human | 仓库 |
| 设计者 | `ext_designer` | 单行文本／人员 | human | 生产 |
| 创建人 | `plm_system_createBy` | 人员（系统字段） | system | 系统（建议用 MetaSheet 内置"创建人"） |
| 创建时间 | `plm_system_createTime` | 日期时间（系统字段） | system | 系统（建议用 MetaSheet 内置"创建时间"） |
| 更新人 | `plm_system_updateBy` | 人员（系统字段） | system | 系统（建议用 MetaSheet 内置"最后修改人"） |
| 更新时间 | `plm_system_updateTime` | 日期时间（系统字段） | system | 系统（建议用 MetaSheet 内置"最后修改时间"） |

---

## 5. 代码里发现的命名/数据一致性问题（复刻 demo 前建议先向客户确认）

1. **发料情况 (`materialIssuance`) 权限矛盾**：字段语义（"发料"）像是仓库动作，但三个静态页里只有通用件页 `canEdit:true`（`defaultFields.js:167-172`），仓库页反而是 `canEdit:false`（`defaultFields.js:585-590`），采购页压根没有这一列。
2. **物料现状及原因 (`materialStatusAndReason`) 权限矛盾**：字段名带"物料现状"像采购跟进动作，但采购页没有此列，仅通用件页可编辑（`defaultFields.js:181-187`），仓库页只读（`defaultFields.js:599-605`）。
3. **`sortId` 重复**：通用件页 `采购员/purchaseMember` 的 `sortId` 写成了 `39`（`defaultFields.js:199`），与 `更新时间/updateTime` 的 `sortId:39`（`defaultFields.js:271`）撞车；`generalStockInfo.vue` 模板里 `td v-for="(column, colIndex) in scrollColumns" :key="column.sortId"` 直接拿 `sortId` 当 Vue 的 `:key`，两个字段落进同一个渲染组会触发重复 key，属于潜在渲染 bug，正常应为 `29`。
4. **`actualDeliveryDate`（实际到料日期）的 `type` 字段不一致**：通用件页声明了 `type:'date'`（`defaultFields.js:219`），仓库页同一 identity 却完全没写 `type` 键（`defaultFields.js:613-619`），退化成普通文本输入框——同一字段在两个页面渲染成不同的控件类型。
5. **"材料"vs"材质"命名不一致**：identity 同为 `material`，通用件页显示名是"材料"（`defaultFields.js:54`），采购页/仓库页显示名是"材质"（`defaultFields.js:319`, `:472`）。迁移到 MetaSheet 时字段列名需要客户拍板统一用哪一个。
6. **任务编号 (`taskCode`) vs 生产编号 (`productCode`)**：通用件页用 identity `taskCode`（`defaultFields.js:12-16`，可编辑），采购/仓库页用 identity `productCode`（`defaultFields.js:284-289`，只读）——语义上是同一个 PLM 项目号，但 identity 字符串不同，直接按 identity 做字段映射会在 MetaSheet 里生成两个独立字段。
7. **`提前周期` 的 identity 是中文字面量**（`defaultFields.js:112`, `:530`），不是驼峰命名（对比其余 36 个字段全是英文 camelCase）。对照后端实体 `GeneralStockInfo.java:37`，对应的 Java 属性名是 `normalLeadDays`（`Integer` 类型，单位"天"），两者字符串不匹配；若后端没有针对该字段的自定义序列化/Map 透传逻辑（`StockInfoController.java` 里已有先例用 `Map` 而非实体做 PLM 字段透传，如 `:1800`, `:1852`），这一列的读写路径需要单独验证，不能默认假设它会通过标准的 JSON↔实体绑定正常落库。
8. **`totalNum`/毛胚长宽厚数量质量都是字符串而非数字，是有意为之**：`GeneralStockInfo.java:26` 注释明确写着"总数量 = mxNum * 父组件的数量（用户手动输入的会带有单位，所以改为 String）"——即客户系统允许在数量框里直接输入带单位的文本（如"10件"）。迁移到 MetaSheet 时若选"数字"类型会丢失这个使用习惯，建议保留"单行文本"或提供文本+可选解析数字两套。
9. **`componentCode`/`componentName`/`standard` 并非总是 100% 系统写入**：`StockInfoController.java:60` 定义了 `importTag = -1111` 标记"用户导入、非 PLM 拉取"的记录（另见 `:1955-1957` 的注释说明），这类行的 PLM 派生字段实际上是人工录入的。归档为 system 字段是主路径，但演示脚本如果要覆盖"手工导入"场景，需要单独说明这批字段此时允许人工改写。
10. **`nameAndStandard`（名称及规格）只出现在采购/仓库页，通用件页数组里没有**，但后端 `GeneralStockInfo.java:21` 确实有这个属性——说明它是后端拼接后下发的派生列，只是通用件页前端没有单独渲染它。

---

## 6. 字典（选项集）定义——7 个类型

来源：`backend/src/main/resources/mapper/master/configInfoMapper.xml`（通用 `config_info` 表：`type`/`name`/`type_ex_attr1-3`，无预置类型枚举——类型字符串完全数据驱动）+ `ConfigController.java`（纯 CRUD，不写死类型列表）+ 各页面 `selectColumns` 数组（`generalStockInfo.vue:676`, `purchaseInfo.vue:643`, `stockInfo.vue:833`, `warehouseInfo.vue:688`，四个页面数组内容完全相同）+ 后端校验调用点（`GeneralStockInfoController.java:652-674`、`StockInfoController.java:1995-2018`，两处对 6 个 `type` 字符串做 `selectByTypeAndName` 校验）+ `defaultFields.js:672-680` 的 `defaultToDoTypeDict`（第 7 个字典，硬编码在前端，**不进 `config_info` 表**）。

| # | 字典类型（中文 label，即 `config_info.type` 的取值） | 建议英文 key | 对应字段 identity | 数据来源 | 显示颜色 |
|---|---|---|---|---|---|
| 1 | 材料 | `material` | `material` | `config_info` 表，动态；后端校验点 `GeneralStockInfoController.java:653`, `StockInfoController.java:1996` | **有**——业务页面用 `item.typeExAttr1` 做单元格背景色（`generalStockInfo.vue:385,434,482`；`stockInfo.vue:535,584,632`；`purchaseInfo.vue:461`；`warehouseInfo.vue:519`），仅这一个字典在业务表格里真正渲染颜色 |
| 2 | 材料类型 | `material_type` | `rawMaterialType` | `config_info` 表，动态；`GeneralStockInfoController.java:658`, `StockInfoController.java:2000` | 管理页支持设色（`configContent.vue:98-105` 的颜色选择器对所有类型通用），但业务表格未渲染 |
| 3 | 毛胚类型 | `blank_type` | `embryoType` | `config_info` 表，动态；`GeneralStockInfoController.java:662`, `StockInfoController.java:2004` | 同上，未渲染 |
| 4 | 领料节点 | `pick_node` | `pickNode` | `config_info` 表，动态；`GeneralStockInfoController.java:666`, `StockInfoController.java:2008` | 同上，未渲染 |
| 5 | 交接工段 | `handover_section` | `handoverSection` | `config_info` 表，动态；`GeneralStockInfoController.java:670`, `StockInfoController.java:2012` | 同上，未渲染 |
| 6 | 备料情况 | `preparation_status` | `preparation` | `config_info` 表，动态；`GeneralStockInfoController.java:674`, `StockInfoController.java:2016` | 同上，未渲染 |
| 7 | 待办类型 | `todo_type`（客户代码里叫 `useTag`） | 无独立业务字段，挂在每条"待办"记录的 `useTag` 属性上 | **硬编码于前端 `defaultFields.js:672-680`，不经过 `config_info` 表/管理页**，7 个取值：`0`常规、`1`生产修改待办、`2`仓库修改待办、`3`采购修改待办、`4`生产确认待办、`5`仓库确认待办、`6`采购确认待办 | 无（纯文本徽标，见 `stockInfo.vue:235`, `generalStockInfo.vue:144`） |

补充说明：
- `config_info` 表结构本身是通用键值字典（`type`/`name`/`type_ex_attr1/2/3`），**没有代码层面的枚举白名单**——上表 6 个业务字典类型（1-6）完全靠"哪些页面/哪些后端方法拿这个中文 `type` 字符串去查"来反推，属于隐性契约，不是 schema 强约束的。迁移 MetaSheet 时建议把这 6 个类型名固化为选项集配置，而不是继续留成自由文本 `type`。
- `type_ex_attr2`/`type_ex_attr3` 在 `ConfigInfo.java:17-18` 有字段、`configInfoMapper.xml` 增删改查全部透传，但前端管理页（`configContent.vue`）只暴露了 `type_ex_attr1`（显示颜色，第 5 列表头"显示颜色"，`configContent.vue:179`），`type_ex_attr2/3` 目前在整个前端代码库里找不到任何读取/展示点——是预留但未使用的字段，迁移时可以不建模，或作为"备注1/备注2"暂存。
- `material`（材料/材质，字典 #1）与其余 5 个业务字典的关键区别：**只有它在四个业务页面里被专门判断 `column.identity==='material'` 来渲染颜色**（见上表"数据来源"列引用行号），其余 5 个字典虽然 schema 上支持设色，实际业务表格不消费该颜色，做 demo 时如果要"看起来和客户一样"，只需要给"材料"字典配色，其余 5 个字典的颜色可以留空而不影响观感真实度。
- 待办类型（`todo_type`/`useTag`）字典**不在** `/config` 系列接口管辖范围内，客户如果想在演示环境里改"待办类型"文案，必须改前端代码常量而不是走后台配置页——这是与前 6 个字典体验上最大的不同点，做客户演示脚本时要提前说明，避免客户以为它和其余字典一样能在"系统配置"页里改。

---

## 7. `/stock`（备料主页）的动态列权限模型——与静态三页的差异

`/stock` 页面不读 `defaultFields.js`，字段目录与编辑权限完全落在数据库里：

- 字段目录表 `columns`（`id`/`name`/`sort_id`/`identity`/`type`），由 `ColumnMapper.xml:8-12` 的 `listAll` 查询整表，结构与 `defaultFields.js` 里单条字段对象的 4 个核心属性（`name`/`sortId`/`identity`/`type`）一一对应。
- 编辑权限走 RBAC 三表联查：`user` → `user_role` → `role` → `role_column` → `columns`（`ColumnMapper.xml:14-22`），由 `ColumnController.java:42-55` 的 `handle()` 方法为登录用户拼出每列的 `editable` 布尔值。
- 前端 `stockInfo.vue:1484-1489` 的 `canEditColumn()` 直接读这个后端算好的 `editable`，而不是像其余三页那样读写死在 JS 数组里的 `canEdit`。

对于面向客户的 Demo，如果客户主要日常操作的正是 `/stock` 主页（大概率如此，因为它是唯一動態、多角色共用的入口），**字段清单本身建议照抄本报告 §1 通用件页的 38 个字段（identity/中文名/type 完全对应），但"谁能编辑哪一列"这件事要在 MetaSheet 里配成按角色的字段级权限规则，而不是照抄某一个静态页面的 `canEdit` 布尔值**——因为客户生产环境里 `/stock` 页的权限是可以按角色再分配的（`role_column` 是数据库表，运营可自行调整），静态三页的 `canEdit` 只是三个"预置好的角色模板"快照。
