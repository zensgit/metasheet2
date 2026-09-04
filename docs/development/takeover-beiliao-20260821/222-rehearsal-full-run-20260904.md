# 222 彩排:备料四步完整实跑记录(2026-09-04)

> 目的:按客户业务要求把"拉取 → 填报 → 导出 → PLM 变更后刷新"在 222 上**真的跑完一遍**,交给 owner 自行验证后再给客户演示。
> 结论:**四步全部跑通**,证据与复现命令都在本文。数据源用的是与客户库**同构的合成数据**(原因见 §1),客户 PLM 连接保持已绑定、可一键切回。

## 0. 结果一览

| 步骤 | 动作 | 结果 |
|---|---|---|
| ② 拉取 | dry-run + apply `SYN-PROJ-0001` | `add=7`,写入 7 行(1 根件 + 2 子装配 + 4 叶子);总用量逐层相乘正确(B=2×3=6,B 下 D=6×4=24,C 下 E=2×6=12) |
| ③ 填报 | `/api/multitable/patch` 给 3 行填人工列 | `updated=3`:材料类型、备料状态、需求日期、提前周期、自制/外购、领料节点、备料日期、毛胚长度、采购完成/回复日期、仓库完成/到货日期、备注 |
| ④ 导出 | `GET /prep-lines/export?projectNo=SYN-PROJ-0001` | 17 列中文表头、6 行(作废行不导出)、布尔渲染为"是";文件 `备料导出-SYN-PROJ-0001-填报后-20260904.xlsx` |
| 刷新 A | PLM 侧改数(A→C 数量 1→3;B→F 行删除)后 dry-run/apply | `update=3 skip=3 inactive=1`,F 置为无效,C/D/E 总量随之更新 |
| 刷新 B | PLM 改回原状后 dry-run/apply | `update=4 skip=3`,F 重新有效;**三行人工列原样保留**;文件 `备料导出-SYN-PROJ-0001-刷新后-20260904.xlsx`(7 行) |
| 看板 | `/projects/SYN-PROJ-0001/board` | `pulledRowCount=7 activePulledRowCount=7 lastExportAt` 已更新 |

"通知下一步"未配置交接链(设计上未配置即整个 tab 隐藏),本次不在验证范围。

## 1. 为什么用同构合成数据而不是客户测试库

对客户测试 PLM(`10.10.52.16/plm`)的只读枚举结论(2026-09-03,脚本在 222 `output/releases/incoming/tools-r7/`):

- 全库**只有 1 张订单**(项目 `1-20232045`),其 7 个明细零件全部不在 `DN_PDM_PartLibraryInfo`;
- 有 BOM 树的零件(如 600028853)没有任何订单引用;唯一子树里挂着 BOM 的项目 `2-20231625` 的 BOM 也残缺(根零件下 40–60% 子件不在物料表);
- 客户给的 SQL 走法里的 id 在这个库里 0 命中 → 那段 SQL 跑在另一个库(生产库)。

因此**任何项目在测试库都走不完整链**。仓库夹具 `plugins/plugin-integration-core/fixtures/stock-preparation-synthetic-sql-source/` 按"项目号→PathExAttrInfo.FileCode→PathInfo→OrderHead→OrderDetail→PartLibrary→BomHead→BomDetails(递归)"建表,与客户 SQL 和 222 读取计划 `customer-path-exattr.v1` **逐字段一致**(比对见 §3.1),所以代码路径和客户库完全相同,差异只在数据。

## 2. 222 上做了什么(可复现)

### 2.1 合成源修正(此前 `SYN-PROJ-0001` 永远 not_found 的根因)

- 旧 `synth_plm` schema 里的 7 张表是**带引号的大小写表名**,而读取计划按 Postgres 规则把未加引号的 `DN_PDM_PathExAttrInfo` 折叠成小写查询 → 永远查不到。已 `DROP SCHEMA synth_plm CASCADE`(仅我们自己的合成数据)。
- 夹具 `01-schema.sql` + `02-seed-pull-1.sql`(不带引号)灌进 `metasheet` 库的 **public**(角色 `metasheet` 无 CREATEDB,不能按 README 单独建库);`data_sources.synthetic-plm` 的 `connection.schema` 改为 `public`,与客户 MSSQL "表在默认 schema dbo" 的形态一致。
- 计数:pathex 1 / pathinfo 1 / orderhead 1 / orderdetail 1 / part 7 / bomhead 4 / bomdet 7。

### 2.2 沙箱表缺 8 个模板字段(子件写不进的根因)

现象:apply 返回 `partial`,`written=1 failed=6`,错误码 `target_record_validation_failed`;根行成功、6 行子件失败。

根因:沙箱表 `sheet_32df959afa3cecfa564e5486`(`备料表(试用)`,objectId `plm_stock_preparation_sandbox_r6_trial`)是 8/30 用旧模板建的;r7 模板新增了 8 个字段,`fieldIdMap` 里有它们的物理 id,但表上不存在:

`parentComponentCode` `parentComponentName` `componentSpec` `makeOrBuy` `procurementDone` `procurementReplyDate` `warehouseDone` `actualArrivalDate`

冲突规划器会给子件行反规范化 `parentComponentCode/Name`(根件没有父件所以不带)→ 主机 `createRecord` 对未知字段 id 报 `VALIDATION_ERROR` → 写入器归为 `target_record_validation_failed`。

修法(用应用自己的代码,不手写 SQL 建字段):

```text
node add-missing-fields.cjs [--execute]
  projectId = default:integration-core (resolveIntegrationStagingProjectId)
  template  = sandboxStockPreparationTemplate({objectId}) → buildStockPreparationTargetDescriptor
  host      = dist/src/multitable/provisioning.js ensureMissingObjectFields({query, projectId, objectId, fields})
  结果      = addedFieldIds 8,表字段 48 → 56;随后把 8 个字段名改成模板 labelZh
```

脚本入库:`scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs`。

### 2.3 "自制/外购"下拉选项

新字段的 select 没有选项,填报被拒 `Invalid select option`。选项只能经 `POST /api/integration/stock-preparation/sandbox-target/ensure` 的 `optionSets.make_or_buy` 传入(独立的 `options/sync` 路由只认主表,不认 `objectId`):

```json
{"objectId":"plm_stock_preparation_sandbox_r6_trial","label":"备料表(试用)",
 "optionSets":{"make_or_buy":[{"value":"10 - 自制","order":10},{"value":"20 - 外购","order":20}]}}
```

### 2.4 源绑定

- 当前 `POST /source-binding` → `7130b124-2b77-4804-bfb8-d669e0ce8dee`(合成源),`takesEffectWithoutRestart=true`。
- 切回客户 PLM:`POST /api/integration/stock-preparation/source-binding {"externalSystemId":"104e9bad-3400-42bb-b427-e7a1d9cf9174"}`(需 admin token + `x-tenant-id: default`)。

## 3. 证据

### 3.1 读取计划 ⟷ 夹具列(222 实际配置,逐对象)

| 计划对象 | 计划字段 | 夹具列 |
|---|---|---|
| DN_PDM_PathExAttrInfo | FileCode, Parent_OBJ_ID | 同 |
| DN_PDM_PathInfo | OBJ_ID | 同 |
| DN_PDM_OrderHeadInfo | OBJ_ID, path_id | 同 |
| DN_PDM_OrderDetailInfo | order_id, part_id, quantity, sort_id | 同 |
| DN_PDM_PartLibraryInfo | OBJ_ID, IdentityNo, IdentityName, Material, SysVer | 同 |
| DN_PDM_BomHeadInfo | part_id, bom_id, SysVer, bom_able | 同 |
| DN_PDM_BomDetailsInfo | bom_pid, part_id, Bom_ExAttr1, sort_id | 同 |

### 3.2 三次 dry-run / apply 计数

```text
pull#1  dry-run add=7 update=0 skip=0 inactive=0 manual_confirm=0 → apply created=6 skipped=1(根行在修字段前已写入)
pull#2  dry-run add=0 update=3 skip=3 inactive=1 → apply updated=3 inactive=1 skipped=3
pull#3  dry-run add=0 update=4 skip=3 inactive=0 → apply updated=4 skipped=3
```

### 3.3 刷新后行状态(SQL 直读 meta_records)

```text
code        parent      total active decision  mat_type     status      demand      makebuy   notes
SYN-D-3000  SYN-B-2000  24    true   add       40 - S30408  30 - 已到货  2026-09-15  20 - 外购  彩排填报-外购件
SYN-F-3200  SYN-B-2000  30    true   update
SYN-B-2000  SYN-A-1000  6     true   add       30 - Q345R   20 - 已下单  2026-09-18  10 - 自制
SYN-D-3000  SYN-C-2100  4     true   update
SYN-E-3100  SYN-C-2100  12    true   update
SYN-C-2100  SYN-A-1000  2     true   update
SYN-A-1000              2     true   add       10 - Q235B   10 - 待备料  2026-09-20  10 - 自制  彩排填报-根件
```

## 4. owner 怎么验证(浏览器)

1. 登录 `http://192.168.1.222/`(管理员账号;密码不在我手里,可用 bootstrap-admin 脚本重置)。
2. 工作台 → **项目备料页** tab → 项目号 `SYN-PROJ-0001`:看板应显示拉取 7 行、7 行有效、最近导出时间。
3. 多维表 `备料表(试用)`(base `base_stockprep_trial`):三行有人工列值(见 §3.3);列末尾多了 8 个新字段。
4. 点导出(或直接 GET `/api/integration/stock-preparation/prep-lines/export?projectNo=SYN-PROJ-0001`):对照 `备料导出-SYN-PROJ-0001-刷新后-20260904.xlsx`。
5. 想看"PLM 变更后刷新":在 222 用 psql 灌 `03-seed-pull-2.sql` 再点刷新;灌回 `02-seed-pull-1.sql` 即还原。两份 SQL 在 `C:\metasheet\output\releases\incoming\syn-load-pull{1,2}.sql`。

## 5. 给客户演示前要决定的事

- **数据**:客户测试库无法走完整链(§1)。三选一:客户往测试库插一张订单指向有 BOM 的零件;客户同步缺的零件;给生产 PLM 只读账号。在此之前,演示用同构合成数据,口径要对客户说清。
- **切源**:客户数据就绪后只需 §2.4 一条 POST,读取计划和映射不用改。

## 6. 发现的 main 上问题(待补 PR,不阻塞演示)

1. `sandbox-target/ensure` 在模板字段物理缺失时仍返回 `ready` 与计算出的 fieldIdMap(`ensureStockPreparationTarget` 的 `inspected.ready` 早退),使 apply 到写入时才暴露;应在 inspect 时核对字段存在或在 `sandbox_existing` 路径调用 `ensureMissingObjectFields`。
2. 模板字段 `parentComponentCode/Name`、`componentSpec` 的中文名与租户扩展字段 `ext_parentDrawingNo/ext_parentName/ext_spec` 同名(父组件图号/父组件名称/规格),表上会出现两列同名;导出已用 fallback 合并,UI 侧需要 owner 裁决保留哪一套。
3. 新 select 字段(makeOrBuy)不带选项,`options/sync` 路由不认 `objectId`,沙箱只能靠 ensure 的 `optionSets`;建议 ensure 在 `sandbox_existing` 时也返回 fieldIdMap(现在返回 0 项)。
4. 写入器把主机"未知字段 id"归为 `target_record_validation_failed`(`VALIDATION_ERROR` 分支先于 `/unknown field/` 正则),应归为 `field_mapping_failed` 才能一眼定位。
