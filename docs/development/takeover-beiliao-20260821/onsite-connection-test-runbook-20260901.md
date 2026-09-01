# 备料 现场连接测试 Runbook（2026-09-01）

目的：把"现场测试"从**临场发挥**变成**逐条清单**。本文覆盖 (1) 连接切换、
(2) **上场前 30 秒数据体检**、(3) 步骤 1-2-3 的逐步验证与预期结果、(4) 给客户
的**精确数据要求**。

> **纪律**
> - 本文**不含任何凭据/真实主机名/真实数据值**——一律用占位符 `<...>`。
> - 只用**只读账号**连接客户 PLM；**用后立即轮换**该只读口令。
> - 生产 PLM 与测试环境**不是同一 IP/凭据**（测试环境地址见团队私有记录 `<测试环境 IP>`，
>   不入库）——现场以客户当场提供的生产只读端点为准，勿复用测试环境的任何值。
> - 机制背书：本 runbook 的每一步在
>   `plugins/plugin-integration-core/__tests__/stock-preparation-structure-exact-rehearsal.test.cjs`
>   已对"结构一致的合成数据"跑通并 GREEN（见
>   `structure-exact-rehearsal-report-20260901.md`）。现场唯一的变量是客户的**数据**。

---

## 0. 前提与已知形状

- 客户 BOM 家族 = **DN PDM 家族**，我方预设
  `plugins/plugin-integration-core/lib/source-vendor-presets/dn-pdm-family.preset.json`
  正对此。
- 语义列在**视图**上：`DN_BomHead_View` / `DN_Bom_View` / `DN_BomDetails_View`，
  含 `bom_id`、`part_id`、`bom_pid`（父链）、`sort_id`、`project_code`、
  `DrawingType`（图号）、`TargetName`（名称）、`Material`（材料）、
  `Specification`（规格）、`Createtime`/`Creator`，**数量藏在通用槽
  `Bom_ExAttr1`**。基表：`DN_PDM_BomHeadInfo`、`DN_PDM_DesignBom`、
  `DN_PDM_BomDetailsInfo`、`DN_PDM_PartNodeInfo`、`DN_PDM_PartLibraryInfo`、
  `DN_Code_Parts`。SQL Server 2019，库名 `plm`。
- **已知空数据陷阱**：客户测试库里这些列结构在、但 `project_code` 全 NULL、
  `DrawingType` NULL、名称是 GUID——**骨架无业务内容**。第 4 节即为解决它。

---

## 1. 连接切换（指向客户 PLM）

我方读侧走 `data-source:sql-readonly` + external-system（只引用数据源 id，
**绝不**在集成行里存凭据）。切换 = 把只读数据源指到客户生产 PLM 端点。

**方式 A：由部署方注册数据源（推荐，凭据不过我方手）**
让客户/部署方在实例内注册一个只读数据源，我方只需其 `dataSourceId`。

**方式 B：用引导脚本注册**
`scripts/ops/stock-prep-acceptance-bootstrap.mjs` 接受**仅环境变量**（不走 argv，
避免进程表/历史泄露）：

```
MS_API=<https://<host>/api>            # 部署实例 API 根，含 /api
MS_TOKEN=<admin bearer>                # 管理员 bearer
MS_PROJECT_NO=<客户真实项目号>          # 见第 3 步：现场向客户要一个有数据的项目
MS_PACK_ID=<服务端持有的 pack id>
MS_DATA_SOURCE_ID=<只读数据源 id>
MS_EXTERNAL_SYSTEM_ID=<该表动作读取的 external system id>

# 只读连接（作为一组给出，用后轮换）：
MS_DS_TYPE=sqlserver
MS_DS_HOST=<客户生产 PLM 主机>          # 与测试环境不同
MS_DS_PORT=<端口>
MS_DS_DATABASE=plm
MS_DS_USER=<只读账号>
MS_DS_PASSWORD=<只读口令>              # 用后立即轮换
MS_DS_SCHEMA=<schema，如 dbo>
```

脚本按序：preflight → 建表 → 装 pack → **接线数据源并 `.../test` 连接** →
干跑 → 应用 → 幂等复核。任一步失败都打印 `FAIL` 与可粘贴的 `fix.run`。

> **读计划改绑（关键）**：客户列名 ≠ 默认读计划名。现场需在该表动作的
> `action.source.readPlan`（`INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON`）
> 里把字段绑到客户词汇——与合成排练里的 `REBIND_READ_PLAN` **一模一样**：
>
> | 计划 role.field | 客户列 | 落到 |
> |---|---|---|
> | `matchField` / `pathExAttr.matchField` | `project_code` | 项目搜索键 |
> | `part.codeField` | `DrawingType` | `componentCode` 图号 |
> | `part.nameField` | `TargetName` | `componentName` 名称 |
> | `part.materialField` | `Material` | `material` 材料 |
> | `bomDetail.quantityField` | `Bom_ExAttr1` | `rawQuantity`→`totalQuantity` 总数量 |
> | ext 映射 | `Specification` | `ext_spec` 规格 |
>
> **规格/材料码等去规范化列**由 ext-field 映射（`stockPreparationExtFieldMapping`）
> 从 part 行读取；数量务必绑到 `Bom_ExAttr1`（预设已默认此槽）。

**测试完成后**：立即轮换 `MS_DS_PASSWORD` 对应的只读口令；从环境/临时文件清除。

---

## 2. 上场前 30 秒数据体检（先跑，再演）

**在演示任何东西之前**，用只读账号连客户 PLM 跑下面的 SQL。目标是在
**30 秒内**判断"库里到底有没有可演的业务数据"，而不是演到一半才发现空。

> 均为只读 `SELECT`。`WITH (NOLOCK)` 仅为避免读锁；若客户库为 RCSI 可去掉。
> 表/视图名以第 0 节为准，若客户命名有出入，按其 `INFORMATION_SCHEMA` 调整。

**体检 1 — 有多少非空 project_code（有没有项目）**
```sql
SELECT COUNT(DISTINCT project_code) AS projects_with_code
FROM DN_Bom_View WITH (NOLOCK)
WHERE project_code IS NOT NULL AND LTRIM(RTRIM(project_code)) <> '';
```
预期：> 0。若为 0 → **空数据**，转第 4 节（要客户造数）。

**体检 2 — 挑一个"数据完整"的项目（图号+材料+数量都在）**
```sql
SELECT TOP 5 project_code,
       COUNT(*)                                   AS bom_lines,
       SUM(CASE WHEN DrawingType   IS NOT NULL THEN 1 ELSE 0 END) AS with_drawing_no,
       SUM(CASE WHEN Material      IS NOT NULL THEN 1 ELSE 0 END) AS with_material,
       SUM(CASE WHEN Bom_ExAttr1   IS NOT NULL THEN 1 ELSE 0 END) AS with_qty
FROM DN_Bom_View WITH (NOLOCK)
WHERE project_code IS NOT NULL
GROUP BY project_code
HAVING COUNT(*) > 0
ORDER BY bom_lines DESC;
```
预期：至少一行的 `with_drawing_no / with_material / with_qty` 都接近 `bom_lines`。
记下这个 `project_code`，即第 3 步的 `MS_PROJECT_NO`。

**体检 3 — 数量确实在 Bom_ExAttr1（而非别的槽）**
```sql
SELECT TOP 20 bom_id, part_id, DrawingType, Material, Specification, Bom_ExAttr1
FROM DN_BomDetails_View WITH (NOLOCK)
WHERE project_code = '<体检2选出的项目>'
  AND Bom_ExAttr1 IS NOT NULL;
```
预期：`Bom_ExAttr1` 是数字（总数量）。若数量其实在别的 `Bom_ExAttr*`/字典槽 →
按 dn-pdm-family 预设的字典发现，改 `bomDetail.quantityField`。

**体检 4 — 项目→根 BOM 的绑定（唯一需现场确认的拓扑）**
```sql
-- 该项目的根/顶层装配是如何锚定的？看 bom_pid 为空/自引用的行，或
-- project_code 到 BOM 头/PartNode 的关系。
SELECT TOP 20 h.bom_id, h.part_id, h.bom_able, h.SysVer
FROM DN_BomHead_View h WITH (NOLOCK)
WHERE h.project_code = '<体检2选出的项目>';

SELECT TOP 20 d.bom_pid, d.part_id, d.sort_id, d.Bom_ExAttr1
FROM DN_BomDetails_View d WITH (NOLOCK)
WHERE d.project_code = '<体检2选出的项目>'
ORDER BY d.sort_id;
```
预期：能看出"项目号 → 根 part/bom_id → 子行(bom_pid=父 bom_id)"的链路。**这条链
就是排练里 `DN_Project_View/DN_ProjectRoot_View/DN_ProjectRootLine_View` 抽象的
真实绑定**——把它填进读计划的 `pathExAttr/orderHead/orderDetail` 三段。

**体检 5 — 活跃版本过滤（可选，防止拉到废弃 BOM）**
```sql
SELECT bom_able, COUNT(*) FROM DN_BomHead_View WITH (NOLOCK)
WHERE project_code = '<体检2选出的项目>' GROUP BY bom_able;
```
预期：`bom_able` 用 0 表示停用；读计划 `bomHead.activeField=bom_able` 会过滤。

> **判定**：体检 1-3 全部有数据 → 可演步骤 1-2-3。体检 4 给出根绑定 → 填读计划。
> 任一为空 → **停，转第 4 节**，别硬演。

---

## 3. 步骤 1-2-3 逐步验证与预期

前置：第 1 节连接已 `test` 通过（external-system status=active），读计划已按第 2 节
体检结果改绑，`MS_PROJECT_NO` = 体检 2 选出的项目。

### 步骤 1 — 项目搜索 + 分支
- **动作**：以该 `project_code` 触发一次表动作 **dry-run**。
- **预期**：
  - 命中 → `status=expanded`、`rootMatches>=1`、`rowsExpanded>0`；干跑
    `canApply:true` 并给出 `dryRunToken`。
  - 目标表为空 → 计划全部为 `add`（**首拉 = PULL**）。
  - 若搜一个不存在的 project_code → `status=not_found`、0 行（**空项目护栏**，不应
    产生半拉结果）。
- **排练对照**：`SYN-XM-0001 → 7 行`、`SYN-XM-9999 → not_found`、空目标 → `add 7`。

### 步骤 2 — 拉取 → 快照批次 → 落表列映射
- **动作**：**apply**（body 用 `{ parameters:{projectNo}, confirm:{ dryRunToken } }`，
  token 放 `confirm.dryRunToken`，顶层放会 400）。
- **预期落表列**：`图号(componentCode←DrawingType)`、`名称(←TargetName)`、
  `材料(←Material)`、`总数量(totalQuantity 逐层累乘)`、`规格(ext_spec←Specification)`；
  快照行另含 `父组件图号(parentDrawingNo，批内父连接)`。
  > **更新**：七个字段现已全部落到**持久化的快照行**上（父组件图号 / 父组件名称 /
  > 当前组件图号 / 当前组件名称 / 规格 / 材料 / 总数量）。`规格` 不再只走 `ext_spec`：
  > 读计划新增**声明式** `part.specField`（默认**不声明**，即绝不猜列），声明后落为
  > 快照行的规范列 `spec`。物料匹配器的 `plmNameOf`/`plmSpecOf` 本就读
  > `childName`/`spec`，只是从来没有数据；字段落地后名称+规格自动匹配随之生效，
  > 映射表单的 PLM 侧（`plmMaterialName`/`plmSpec`）不再需要人工敲入。
- **同项目两批次按创建小时区分**：同一 `project_code` 的两次拉取，若物料
  `Createtime` 落在不同**小时**，应落到两个不同批次（`snapshotBatchId` 携小时桶），
  快照行 id 不重叠。
  > **更新（排练报告 gap #3 已关闭）**：按小时分批**已进发货代码**
  > （`lib/stock-preparation-batch-identity.cjs`，由 table-action MVP-persist 路由在
  > `snapshotBatchId` 铸造处调用），不再需要手工铸造。但它**按部署声明启用**：在读计划
  > 上写 `batchIdentity: { mode: 'material_create_hour' }`，并声明 `part.createTimeField`
  > （如 `Createtime`）。**不声明 = 保持今天的行为**（内容修订摘要 id + 持久化层单调
  > `snapshotVersion`）——批次 id 同时是持久化幂等键、advisory lock 键和每个派生子 id 的
  > 哈希输入，默认切换会改变"哪些拉取算同一批"，所以必须由部署选择。声明了但源里没有
  > 可用 `Createtime` 时，**回落到今天的行为，并在响应的 `batchIdentity` 证据里以编码
  > 原因明确报告降级**，绝不静默落错桶。
- **排练对照**：批 #1 `...|2026-08-30T09` vs 批 #2 `...|2026-08-30T10`，0 行 id 重叠。

### 步骤 3 —（已存在的部分）人工填列 + 人列墙 + 导出
- **动作**：在落地表上由人填 `human_preserved` 列：`备料日期`、`材料类型`、
  `毛胚类型`、`备注`、`领料节点`、`需求日期`、`提前周期`、`备料情况`、`毛胚尺寸`。
- **人列墙**：再拉一次（步骤 2 的刷新）。**预期**：人填列**逐字节不变**；只有
  `rawQuantity/totalQuantity` 会改；任何刷新决策都不携带人列。计划为
  `add 0 / update N / skip N / inactive N`。
- **导出**：调 `/api/multitable/sheets/:sheetId/export-xlsx`。**预期**：导出仓库/采购要
  的物料行（图号/名称/规格/材料/总数量 + 备料情况/需求日期/领料节点/备料日期/毛胚尺寸），
  活跃行齐全、人填值在列。
- **排练对照**：16 人列全保、刷新仅动 `rawQuantity/totalQuantity`、无过滤对照会破坏
  16 列；导出 6 活跃行 × 10 列。

### 现场**不**演（净新、未接线——如实说明，勿假装）
1. **多人审批 hand-off 链到 备料 的接线**——平台有审批运行时，但**未接**到备料流。
2. **钉钉待办推送**——无连接器接线。
3. ~~**按创建小时分批的推导**~~——**已进发货代码，现可演**（见步骤 2 更新）。前提是
   现场读计划声明 `part.createTimeField` 与 `batchIdentity.mode = 'material_create_hour'`；
   不声明则维持内容修订摘要 + 单调 `snapshotVersion` 的旧行为，源里缺 `Createtime` 时
   带编码原因降级。**要如实说明的是它是"按声明启用"，不是默认。**

---

## 4. 给客户的精确数据要求

若第 2 节体检显示空数据，**端到端测试需要客户先把测试 PLM 填上（或另给一个已填的
实例）至少一个真实项目**。请客户在库 `plm` 内，对**至少一个** `project_code` 落齐
下列内容（列/表名以第 0 节为准）：

1. **项目号**：`DN_Bom_View.project_code`（及 `DN_BomHead_View` / `DN_BomDetails_View`
   上对应行）**非空**，唯一可识别。
2. **BOM 树**：`DN_BomHead_View.bom_id` 为该项目根/各层 BOM 头；
   `DN_BomDetails_View` 以 `bom_pid`（父 = 父级 `bom_id`）、`part_id`（子件）、
   `sort_id`（排序）构成**多层**父子树（至少 2 层）。
3. **图号**：`DrawingType`（图号）在 part/BOM 明细行**非空**（不要 GUID/占位）。
4. **名称**：`TargetName`（名称）为可读名称。
5. **材料**：`Material`（材料）非空。
6. **规格**（可选但推荐）：`Specification`（规格）。
7. **数量**：**总数量落在通用槽 `Bom_ExAttr1`**（预设默认读此槽）；若客户实际把数量
   放在别的 `Bom_ExAttr*` 或字典槽，请**明确告知是哪个槽**，我方改
   `bomDetail.quantityField`。
8. **创建时间**：`Createtime`（含小时）——用于"物料创建日期精确到小时"的分批。
9. **项目→根绑定**：明确 `project_code` 如何定位到根/顶层装配（体检 4 的链路）。

> 一句话给客户：**"给我们一个填齐的项目——项目号、带图号/名称/材料/数量(在
> Bom_ExAttr1)的多层 BOM 树、以及项目到根 BOM 的对应关系；只读账号即可。"** 有了它，
> 步骤 1-2-3 即可现场端到端跑通；我方侧已在结构一致的合成数据上证明为 GREEN。

---

## 附：相关文件

- 结构一致合成夹具：`plugins/plugin-integration-core/fixtures/stock-preparation-structure-exact-plm/`
- 排练驱动（无 DB，自检）：`plugins/plugin-integration-core/__tests__/stock-preparation-structure-exact-rehearsal.test.cjs`
- 排练报告：`docs/development/takeover-beiliao-20260821/structure-exact-rehearsal-report-20260901.md`
- 供应商预设：`plugins/plugin-integration-core/lib/source-vendor-presets/dn-pdm-family.preset.json`
- 引导脚本：`scripts/ops/stock-prep-acceptance-bootstrap.mjs`
