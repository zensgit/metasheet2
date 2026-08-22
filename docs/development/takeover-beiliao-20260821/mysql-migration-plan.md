# 备料系统 → MetaSheet 客户接管：MySQL 迁移方案

源系统：`yaguang.stock.order`（雅光 备料/生产备料系统，Spring Boot + MyBatis）
本方案从 zip 后端的 **master MySQL** MyBatis mapper 与 entity 类反推 schema，逐表清点，
再给出接管迁移计划。**所有主机名/IP/口令/授权码/appKey 一律不抄写**，仅注明其所在位置。

> 数据源拓扑（凭据位置，值已略去）：
> - master MySQL（生产真数据）：`spring.datasource.master.*`，见
>   `zip/backend/src/main/resources/application-prod.yml:9-11`（url/username/password），
>   dev 版 `application-dev.yml:9-11`。驱动 `com.mysql.cj.jdbc.Driver`（application-dev.yml:6）。
> - K3/金蝶 ERP（只读 SQL Server，非本次迁移目标库）：`spring.datasource.k3.*`，见
>   `application-prod.yml:20-22` 及 `:31-33`（生产存在多个 K3 端点），驱动
>   `com.microsoft.sqlserver.jdbc.SQLServerDriver`（application-dev.yml:16）。
> - K3 HTTP API 授权码/主机：硬编码于 `controller/ErpController.java:34-36` 及 `:73`（**值不抄**，
>   接管时应改为配置项并轮换）。
> - 应用内明文口令风险：`user.password` 明文比对，见 `mapper/master/userMapper.xml:185-200`
>   （`selectByNameAndPwd ... where name=#{name} and password=#{password}`）——迁移时不得原样保留明文认证。

---

## 第 0 部分：schema 反推方法与全局约定

- 表名一律取自 SQL 字面量（`from <table>` / `insert into <table>`），不臆造。
- 列类型由 entity 字段类型 + MyBatis 用法推断；源系统把**日期/时间几乎全部存成 `String`**
  （`StockInfo.createTime/updateTime` 为 `String`，见 `entity/StockInfo.java:66-67`；
  各 `*Date` 字段亦为 `String`），故推断类型标注为「VARCHAR(存字符串日期)」，迁移时需规范化。
- 乐观锁：`stock_info/general_stock_info/purchase_info/warehouse_info` 均带 `version`，
  update 语句 `version=#{version}+1 where id=#{id} and version=#{version}`（如
  `stockInfoMapper.xml:856-857`）。
- 身份键 **pli_obj_id**：PLM 物料库 id（`entity/StockInfo.java:13 // plm物料库的id`）。
  它是「同一物料在 PLM 中的稳定标识」，配合 `product_code`（项目号）构成备料行的业务身份，
  查询见 `stockInfoMapper.xml:282 selectByPliObjIdAndProductCode`、`:410 selectByPliObjId`。
  **迁移主键映射应以 (pli_obj_id, product_code, component_code) 为自然键，而非自增 id。**

---

## 第 1 部分：逐表清点（table-by-table inventory）

分类图例：**[备料]** 备料单业务行 · **[配置]** 字典/选项集 · **[RBAC]** 用户/角色/列权限 · **[集成]** 审批/审计

### 1.1 `stock_info` — 项目备料主表 **[备料]**
来源：`mapper/master/stockInfoMapper.xml`（`from stock_info`，如 :11, :67）；entity `entity/StockInfo.java`。

| 列 | 推断类型 | 说明 / 来源 |
|---|---|---|
| id | INT PK, auto | `addOne useGeneratedKeys keyProperty=id`（stockInfoMapper.xml:737） |
| pli_obj_id | INT | PLM 物料库 id（StockInfo.java:13）——身份键 |
| prepare_date | VARCHAR | 备料日期 |
| product_code | VARCHAR | **项目号**，分区键（`selectAllProducts group by product_code` :10-13） |
| parent_id | INT | 父组件 stock_info.id（自引用，`selectByProductCodeAndParentId` :346） |
| parent_component_code / _name / _sort_id | VARCHAR/VARCHAR/INT | 父组件图号/名称/排序 |
| component_sys_ver | INT | 版本号（图纸版本） |
| component_code | VARCHAR | **组件图号**（= 图号，工艺/K3 对接 key，StockInfo.java:21） |
| component_name | VARCHAR | 组件名称 |
| component_sort_id | INT | 明细栏排序 |
| name_and_standard / standard | VARCHAR | 名称及规格 / 规格 |
| material_id | INT FK→config_info.id | 材质（join c1，:68） |
| total_num | VARCHAR | 总数量（含单位故存字符串，StockInfo.java:29） |
| raw_material_type_id | INT FK→config_info.id | 材料类型（c2） |
| embryo_type_id | INT FK→config_info.id | 毛胚类型（c3） |
| remark | VARCHAR | 备注 |
| pick_node_id | INT FK→config_info.id | 领料节点（c4） |
| handover_section_id | INT FK→config_info.id | 交接工段（c5） |
| requirement_date | VARCHAR | 需求日期 |
| normal_lead_days | INT | 提前周期（天） |
| preparation_id | INT FK→config_info.id | 备料情况（c6） |
| embryo_length/width/thickness/num/quality | VARCHAR | 毛胚长/宽/厚/数量/质量 |
| designer | VARCHAR | 设计者 |
| create_time / update_time | VARCHAR | 存字符串时间 |
| create_by / update_by | VARCHAR | 创建人/更新人（登录用户名，provenance） |
| version | INT | 乐观锁 |

注：`material_id` join 出的 `config_info.type_ex_attr1` 被 select 为 `type_ex_attr1`（材质前端显示颜色，
StockInfo.java:28），是**展示派生列**，非独立存储。

### 1.2 `general_stock_info` — 通用备料主表 **[备料]**
来源：`GeneralStockInfoMapper.xml`（`from general_stock_info`）；entity `GeneralStockInfo.java`。
结构与 `stock_info` 几乎一致，**差异**：无 `pli_obj_id`、无 `parent_id`；分区键为 **`task_code`（任务编号）**
而非 project_code（`selectTaskCodeList group by task_code` :895-899）。purchase/warehouse 通过
`stock_info_id` 指回本表 id（`selectByGeneralStockInfoId`，PurchaseInfoMapper.xml:1345）。

### 1.3 `purchase_info` — 采购/外购信息 **[备料]**
来源：`PurchaseInfoMapper.xml`；entity `PurchaseInfo.java`。

| 列 | 类型 | 说明 |
|---|---|---|
| id | INT PK auto | :1493 |
| stock_info_id | INT FK→stock_info.id 或 general_stock_info.id | 关联备料行（PurchaseInfo.java:14） |
| product_code | VARCHAR | 项目号（冗余，用于按项目查/删） |
| purchase_response_date | VARCHAR | 采购回复日期 |
| purchase_member | VARCHAR | 采购人 |
| purchase_remark | VARCHAR | 采购备注 |
| is_done | INT | 0/1 采购信息是否已填（PurchaseInfo.java:38） |
| create_time/create_by/update_time/update_by | VARCHAR | provenance |
| version | INT | 乐观锁 |

关系为 **1:1（stock_info ↔ purchase_info）**：主查询 `left join purchase_info as pi on pi.stock_info_id=si.id`
（stockInfoMapper.xml:74）。换行迁移用 `updateStockInfoId`（:1524）重挂。

### 1.4 `warehouse_info` — 仓库/报料信息 **[备料]**
来源：`WarehouseInfoMapper.xml`；entity `WarehouseInfo.java`。

| 列 | 类型 | 说明 |
|---|---|---|
| id | INT PK auto | :1800 |
| stock_info_id | INT FK→stock_info.id | :1551 |
| product_code | VARCHAR | 项目号（冗余） |
| material_report_issuance | VARCHAR | 报料情况 |
| actual_delivery_date | VARCHAR | 实际到货日期 |
| material_confirm | VARCHAR | 发料确认 |
| actual_material_type | VARCHAR | 实际材料类型 |
| is_done | INT | 是否完结 |
| create_time/create_by/update_time/update_by | VARCHAR | provenance |
| version | INT | 乐观锁 |

同为 1:1（`left join warehouse_info as wi on wi.stock_info_id=si.id`，stockInfoMapper.xml:75）。

### 1.5 `product_status` — 项目状态 **[备料/配置边界]**
来源：`ProductStatusMapper.xml`。列：`id`(PK auto), `product_code`(项目号),
`status`(INT 0在制/1已发货，ProductStatus.java:16), `product_type`(INT FK→config_info.id,
join `ci.name as product_type_name` :1861), `create_time`, `update_time`。
每项目一行，作为「项目是否 in-flight」的判据来源。

### 1.6 `config_info` — 字典/选项集主表 **[配置]** ★迁移最先
来源：`configInfoMapper.xml`；entity `ConfigInfo.java`。
列：`id`(PK auto), `type`(VARCHAR 字典类别), `name`(VARCHAR 选项名),
`type_ex_attr1/2/3`(VARCHAR 扩展属性；attr1=材质显示颜色), `create_time`, `update_time`。
**这一张表以 `type` 区分承载了 6+ 类字典**（被 stock_info 的 6 个 `*_id` 外键引用）：
材质 material、材料类型 raw_material_type、毛胚类型 embryo_type、领料节点 pick_node、
交接工段 handover_section、备料情况 preparation、项目类型 product_type。
`selectByType`(:57)/`selectAllType`(:72) 证明按 type 取子集。

### 1.7 `craft_info` — 工艺行 **[备料]**
来源：`craftInfoMapper.xml`；entity `CraftInfo.java`。
PK `id`(auto)。关键列：`stock_info_id`(FK→stock_info.id), `pli_obj_id`, `product_code`,
`component_material`, `number1/number2`, `section`, `responsibility_group`,
`process_procedure`, `procedure_sort_id`, `cycle_time`, `finish_date1`(insert 有该列 :556，
select 时用 `si.requirement_date as finishDate1` 覆盖 :503), `finish_date2`, `process_step`,
`welding_process`, `inspection_requirement`, `photography_requirement`, `standard_work_hour`,
`remark`, `inspection_classification`, `component_name2`, `material`, `placement`,
`explanation`, `pressure_component/value/duration`, `create_time`, `update_time`。
与 stock_info 通过 `inner join ... on si.id=ci.stock_info_id`（:507）。**注意**：`craft_info`
无 version 列，update 不做乐观锁（:610-650）。

### 1.8 `section_info` — 工段/责任组字典 **[配置]**
来源：`sectionMapper.xml`。列：`id`(PK auto), `section`(工段), `responsibility_group`(责任组),
`create_time`, `update_time`。被 `process_info.section_id` 与 craft 展示引用。

### 1.9 `process_info` — 工序模板 **[配置]**
来源：`ProcessInfoMapper.xml`。列：`id`(PK auto), `section_id`(FK→section_info.id),
`process_procedure`, `inspection_requirement`, `photography_requirement`, `process_step`,
`create_time`, `update_time`。是按工段预设的「工序/检验/拍照要求」模板，供 craft 行套用。

### 1.10 `pick_info` — 领料信息 **[备料]**
来源：`PickInfoMapper.xml`。列：`id`(PK auto), `process_id`, `pick_member`(领料人),
`material_issuance`(发料情况), `bill_date`(开单日期), `material_status_and_reason`,
`create_time`, `update_time`。
> ⚠ 数据质量隐患：`insert`/`batchInsert` 的 VALUES 中 `#{item.billDate} #{item.materialStatusAndReason}`
> 之间缺逗号（PickInfoMapper.xml:824, :833），列与占位符数量不匹配——接管前应核对该表实际写入是否正常，
> 迁移时以实际落库列为准。

### 1.11 `columns` — 主备料表「人列」注册表 **[配置/RBAC 桥]**
来源：`ColumnMapper.xml`。列：`id`(PK, Long), `name`(列名), `sort_id`(列顺序),
`identity`(唯一性描述 = 列的稳定 key), `type`(字段类型)。`listAll order by sort_id`（:404-408）。
**这是「哪些人列存在、顺序如何、稳定标识是什么」的权威表**，直接对应 MetaSheet 的列注册表。

### 1.12 `craft_columns` — 工艺表「人列」注册表 **[配置]**
来源：`CraftColumnMapper.xml`，结构同 `columns`（`from craft_columns`，:445）。

### 1.13 `role_column` — 角色↔列 授权（列级权限） **[RBAC]** ★
来源：`RoleColumnMapper.xml`。列：`id`(PK auto), `role_id`, `column_id`。
`ColumnMapper.selectByUserId`（:410-418）由 user→user_role→role→role_column→columns
解出「某用户可见哪些列」——**列级权限的核心**。

### 1.14 `user` — 用户 **[RBAC]**
来源：`userMapper.xml`；entity `User.java`。列：`id`(PK, Long), `name`, `password`(**明文**,
见 1 节风险), `mobile`, `dept_name`, `login_time`, `logout_time`, `login_ip`, `is_online`(INT),
`create_time`, `update_time`。

### 1.15 `role` — 角色 **[RBAC]**
来源：`RoleMapper.xml`。列：`id`(PK Long), `name`, `description`, `create_time`, `update_time`。

### 1.16 `user_role` — 用户↔角色 **[RBAC]**
来源：`UserRoleMapper.xml`。列：`id`(PK auto), `user_id`, `role_id`。

### 1.17 `permission` — 权限点 **[RBAC]**
来源：`permissionMapper.xml`。列：`id`(PK), `name`, `description`, `attr1`, `attr2`。

### 1.18 `role_permission` — 角色↔权限 **[RBAC]**
来源：`RolePermissionMapper.xml`。列：`id`(PK auto), `role_id`, `permission_id`。

### 1.19 `menu` — 菜单/功能树 **[RBAC/配置]**
来源：`MenuMapper.xml`。列：`id`(PK), `name`, `menu_code`, `parent_id`, `node_type`,
`icon_url`, `sort`, `link_url`, `level`, `path`。`selectAuthByUserIdAndMenuCode`（:1012）做功能鉴权。

### 1.20 `role_menu` — 角色↔菜单 **[RBAC]**
来源：`RoleMenuMapper.xml`。列：`id`(PK auto), `role_id`, `menu_id`。

### 1.21 `table_column_config` — 用户个人列布局 **[RBAC/偏好]**
来源：`TableColumnConfigMapper.xml`；entity `TableColumnConfig.java`。列：`id`(PK auto),
`user_id`, `json_config`(TEXT/JSON 字符串), `create_time`, `update_time`。每用户一份表格列偏好。

### 1.22 `ding_talk_comment` — 钉钉审批评论/审计 **[集成]**
来源：`DingTalkCommentMapper.xml`；entity `DingTalkComment.java`。列：`id`(PK auto),
`approval_instance_id`(待办实例 id), `user_id`(钉钉用户 id), `user_name`, `user_dept_name`
(生产/采购/仓库), `comment_info`, `edit_ids`(被改物料 id 逗号分隔), `use_tag`(0评论/1已改 ids),
`create_time`。

### 1.23 `stock_basic_info` — 组件基础信息 **[配置/主数据]**
来源：`stockProductBasicInfoMapper.xml`（`from ...` 无 select，仅被引用）；entity `StockBasicInfo.java`。
列：`id`(PK auto), `component_code`(组件图号), `component_name`, `component_sort_id`,
`name_and_standard`, `material_id`, `total_num`(INT), `create_user`, `update_user`,
`create_time`, `update_time`。看作「图号→基础属性」主数据模板。

### 1.24 `stock_product_basic_info` — 项目↔基础信息桥 **[配置]**
来源：`stockProductBasicInfoMapper.xml`。列：`product_code`, `stock_basic_info_id`（PK 未显式）。
> ⚠ insert 语句 bug：向 `product_code` 写入 `#{prepareDate}`（stockProductBasicInfoMapper.xml:1138）。
> 接管前核对该表真实内容，迁移以实际数据为准。

### 分类汇总
- **[备料] 业务行**：`stock_info`, `general_stock_info`, `purchase_info`, `warehouse_info`,
  `product_status`, `craft_info`, `pick_info`。
- **[配置] 字典/选项/注册/主数据**：`config_info`, `section_info`, `process_info`, `columns`,
  `craft_columns`, `stock_basic_info`, `stock_product_basic_info`, `menu`。
- **[RBAC]**：`user`, `role`, `user_role`, `permission`, `role_permission`, `role_menu`,
  `role_column`, `table_column_config`。
- **[集成/审计]**：`ding_talk_comment`。

---

## 关于「图号 ↔ K3 物料编码」映射（重要发现）

**master MySQL 中不存在持久化的 图号↔K3 material-code 映射表。**
- 备料侧用 **`component_code`（图号）** 与 **`pli_obj_id`（PLM id）** 标识物料。
- K3/金蝶侧在**独立只读 SQL Server** 中，用 **`FItemID`（K3 物料内部 id）** 与
  **`FNumber`（物料编码，形如点分层级码）** 标识；只读查询见 `mapper/k3/K3Mapper.xml`
  （`selectInventoryBatch where FItemID in ...`、`selectPoo where pooe.FItemID=#{FItemID}` 等）。
- 二者的对应关系在运行时通过 K3 HTTP API 现算，**并未落到 MySQL**。`ErpController.java:88` 注释明确写道
  「待推送的数据中需要有一个存储 k3 物料 id 的字段」——即该字段**尚未进 schema**，属未竟事项。

**接管含义**：图号↔K3 编码映射需要在迁移期**重建为 MetaSheet 侧的 registry**（见 2.1），
不能指望从源 MySQL 直接搬。K3 侧本身**不迁**（保持源系统只读集成或按需重接）。

---

## 第 2 部分：迁移计划（MIGRATION PLAN）

### (1) 必须最先导入的配置/主数据（config/master data first）

导入顺序遵守外键依赖：**字典 → 注册表/主数据 → RBAC**。每项给出 源表 → MetaSheet 目标。

| 优先级 | 源表 | 内容 | MetaSheet 目标 |
|---|---|---|---|
| P0 | `config_info`（按 `type` 拆） | 材质/材料类型/毛胚类型/领料节点/交接工段/备料情况/项目类型 | **每个 type 建一个 option-set**；`type_ex_attr1`(材质颜色) 作为选项元数据带入。原 `config_info.id` 建 **id→选项** 对照表供业务行外键改写 |
| P0 | `section_info` | 工段/责任组 | option-set（section）+ 关联属性 responsibility_group |
| P0 | `process_info` | 按工段的工序/检验/拍照模板 | 工序模板 registry（key=section_id→工段选项） |
| P0 | `columns` | 主备料表人列定义（name/sort_id/identity/type） | **列注册表 registry**；`identity` 作为 MetaSheet 列稳定 key，`sort_id` 定顺序 |
| P0 | `craft_columns` | 工艺表人列定义 | 工艺视图列注册表 |
| P0 | 新建（重建） | **图号↔K3 FItemID/FNumber 映射**（源无此表，见上节） | **专用 registry / ext_ 映射表**：key=`component_code`(图号)，value=K3 FNumber+FItemID。由 K3 API 批量拉取一次性物化 |
| P1 | `stock_basic_info` + `stock_product_basic_info` | 图号→基础属性、项目→基础信息桥 | 主数据 registry（图号维度） |
| P1 | `user` | 用户（**password 明文**） | RBAC 用户；**不迁明文口令**，接管时强制改用 MetaSheet 认证/重置 |
| P1 | `role`, `permission`, `menu` | 角色/权限点/菜单 | 角色、权限、菜单定义 |
| P2 | `user_role`, `role_permission`, `role_menu` | 关系 | 角色分配 |
| P2 | `role_column` | **列级权限**（role→column_id） | MetaSheet **列级权限**：role→列注册表 key（需经 `columns.id→identity` 换算） |
| P2 | `table_column_config` | 用户个人列布局 json | 用户偏好（可选，低价值可后置） |

**换算要点**：业务行的 6 个 `*_id`（material_id 等）都是 `config_info.id` 外键。导入 config_info 时
必须保留 **旧 id → 新 option** 映射，供 (2) 步改写备料行的选项值。

### (2) 在制备料单行（in-flight）→ S1 镜像/人列

**判定 in-flight**：`product_status.status = 0`（在制）的 `product_code` 集合即在制项目；
`status=1`（已发货）归历史（见 (3)）。

**每个在制备料行的组装形状（join shape）**——直接取自源系统主查询
`stockInfoMapper.xml:67-83`：

```
stock_info  si
  LEFT JOIN config_info c1..c6  ON si.material_id / raw_material_type_id / embryo_type_id
                                   / pick_node_id / handover_section_id / preparation_id = c.id
  LEFT JOIN purchase_info  pi   ON pi.stock_info_id = si.id      -- 1:1
  LEFT JOIN warehouse_info wi   ON wi.stock_info_id = si.id      -- 1:1
  (craft_info ci ON ci.stock_info_id = si.id                    -- 1:N 工艺行，单独视图)
WHERE si.product_code IN (在制项目集)
ORDER BY si.parent_component_code, si.component_sort_id
```

- **一行备料 = si + 其 pi + 其 wi 的宽表**。config join 只为把 `*_id` 解成人类可读名字
  （`c1.name as material` 等），迁移时改为 option-set 值。
- 目标：把该宽表落成 MetaSheet 备料表的 **S1 镜像行**；系统字段（`*_id`、id、version）进
  **ext_ 列**（保留源身份与乐观锁），人类可编辑字段（备注、采购人、报料情况、实际到货日期等）
  进 **human 列**（受 (1) 的 `columns/role_column` 权限约束）。
- **身份键**：MetaSheet 行自然键用 **(pli_obj_id, product_code, component_code)**；
  `stock_info.id` 存 ext_（供 pi/wi/craft 回连与增量对账）。`general_stock_info` 行以
  `(task_code, component_code)` 为键（无 pli_obj_id）。
- purchase/warehouse 的 `product_code` 冗余列与 si 一致，用于换挂
  （`updateStockInfoId`）；迁移后以 stock_info_id 为准。
- craft_info 作为**子表/明细视图**单独迁（1:N，按 `component_code, procedure_sort_id` 排序，
  craftInfoMapper.xml:509），键 `(pli_obj_id, product_code, procedure_sort_id)`。

### (3) 已完成/历史行 → 只读归档

- `product_status.status = 1`（已发货）的项目、以及超出对账窗口的旧 `create_time` 数据，
  **不进可写主表**，整体导入 **MetaSheet 只读归档**（原样保留 create_by/create_time）。
- 归档保留完整 si+pi+wi+craft 宽表快照即可，不建列级权限、不参与乐观锁。
- 判据字段：`product_status.status`、`stock_info.create_time`（字符串日期，归档窗口按项目号+日期切）。

### (4) 双跑对账（dual-run reconciliation）

对账**按项目号（product_code）逐项目**进行，源系统继续在制、MetaSheet 并行镜像：

| 对比项 | 取数（源） | 取数（MetaSheet） | 容差 |
|---|---|---|---|
| 行数 | `selectCountByProductCode`（stockInfoMapper.xml:214）按 product_code | 镜像行数 | **0**（必须完全一致） |
| 每项目备料行明细完整性 | si 全列 | ext_ 镜像列 | 0 差异（系统字段逐列等值） |
| 采购/仓库 1:1 挂接 | pi/wi 计数与 stock_info_id 对应 | 同 | 0 |
| 人列值 | pi.purchase_*, wi.material_report_issuance / actual_delivery_date / material_confirm 等 | human 列 | 文本 trim 后等值；日期字符串归一后等值 |
| 每项目汇总 | 按 product_code 的物料条数、is_done 计数（purchase/warehouse） | 同 | 0 |
| 选项解析 | c*.name（material 等 6 类） | option-set 值 | 0（映射表命中率 100%，未命中即阻断） |
| 工艺行数 | `craftInfoMapper.selectCountByProductCode`（:489） | craft 子表 | 0 |

- **数值/日期容差**：源系统 total_num/毛胚尺寸为**含单位字符串**，对账按「去空白后字符串相等」；
  日期字符串统一 `yyyy-MM-dd` 归一后比较（源多为字符串，注意 `create_time` 全量字符串）。
- **对账频率**：每日快照 diff，直至连续 N 日（建议 3 日）某项目 0 差异。

**切换判据（cut-over，按项目号粒度）**：某 `product_code` 满足
①行数/明细/人列连续 0 差异达标窗口，②该项目全部 in-flight 物料已在 MetaSheet 建立列权限，
③option 映射命中率 100%，④provenance 完整（见 5）——则该项目**单向切到 MetaSheet 为准，源系统对该项目转只读**。
未达标项目继续双跑。项目全部切完后源库整体归档。

### (5) provenance（createBy/updateBy/createTime）承载

- 源 provenance 字段：`stock_info.create_by / update_by / create_time / update_time`
  （StockInfo.java:66-69）；purchase/warehouse 同名字段；`stock_basic_info.create_user/update_user`。
- `create_by/update_by` 存的是**登录用户名字符串**（非 user.id），迁移时：
  - 若能与 `user.name` 对上，映射到 MetaSheet 用户身份；对不上的保留原始字符串于 ext_ 审计列。
  - **不覆盖** MetaSheet 的系统 created_by（导入操作者），源 provenance 落 **ext_ 溯源列**
    （ext_src_create_by / ext_src_create_time 等），保证「谁在源系统何时建/改」可追。
- `version`（乐观锁）随行进 ext_，作为增量对账与冲突检测依据。
- `ding_talk_comment` 作为**审批溯源**整表归档（edit_ids 关联被改物料 id），不进主表。

---

## 附：接管风险清单（迁移前必须处理）

1. **明文口令**：`userMapper.xml:185-200` 明文比对，`user.password` 明文存储——迁移不得保留明文认证，切 MetaSheet 认证并强制重置。
2. **硬编码 K3 授权码/主机**：`ErpController.java:34-36, :73`（值不抄）——改为配置项并轮换。
3. **图号↔K3 映射缺表**：源无持久化映射（`ErpController.java:88` 注释确认未竟），需在迁移期由 K3 API 物化为 MetaSheet registry。
4. **时间/数值全字符串**：全库日期、数量含单位存 String——迁移做类型规范化并保留原字符串于 ext_。
5. **两处 SQL 疑似 bug**：`PickInfoMapper.xml:824/833`（占位符缺逗号）、`stockProductBasicInfoMapper.xml:1138`（product_code 写入 prepareDate）——以实际落库数据为准，导入前核对。
6. **craft_info 无乐观锁**：并发更新风险，切换期避免源/目标同时写工艺行。
