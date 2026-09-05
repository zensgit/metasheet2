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


---

## 7. 2026-09-04 下午追加:UI 点"从PLM拉取"失败的排障与修复

演示前实点按钮仍失败,排障结果如下(与 §2 的两处修复叠加,四步才全绿)。

### 7.1 根因 A —— workspace 作用域不一致(报 404)

`POST table-actions/plm.stock-preparation.pull-bom.v1/dry-run` 返回 **404 `ExternalSystemNotFoundError`**,详情 `{id: 7130b124…, tenantId: default, workspaceId: default}`。

- Web 端 `persistTenantHint` 把登录租户提示**同时**写进 localStorage `tenantId` 与 `workspaceId`,因此 UI 每个请求都带 `?tenantId=default&workspaceId=default`。
- `integration_external_systems` 按 `workspace_id` **精确**匹配(`scopeWhere: workspace_id = workspaceId ?? null`),而 provisioning 把源建在 `workspace_id = null`(租户级)→ 匹配不到 → 404。看板/交接/项目目录不查外接源,所以那几条都 200,只有拉取炸。
- 更隐蔽:同一次拉取里 `dry-run`/`apply` 从请求取 workspace(=default),而**不接受 steering** 的 `mvp-persist` 从登录身份推出 workspace=**null**(token 不带 workspace claim)。外接源主键只有 `id`,同一 id 不能同时挂两个 workspace,所以**纯数据搬移永远补不平**:挪到 default 则 mvp-persist 炸,留在 null 则 dry-run 炸。

**修法**:外接源按 id 读取时,workspace 精确未命中则回退到**同租户**的租户级(`workspace_id IS NULL`)行,并把实际命中的 workspace 传给连接解析器。租户隔离不变(`tenant_id` 仍须匹配)。已由 **#5471** 合入 main(`5133df1c5`),抽出公共 `selectScopedRow`,同时覆盖 `getExternalSystemForAdapter` 与 `getExternalSystemForSealedSnapshot`。222 已同步为该版本并重启复验。

> 本会话曾并行开出 #5472 做同一修复,发现与 #5471 撞车后已关闭;#5471 是其超集。

### 7.2 根因 B —— MVP 快照行表缺 5 个字段(报 500)

404 修好后,`mvp-persist` 转为 **500 `VALIDATION_ERROR: Unknown fieldId: fld_65a7cff06badc0d8fdb9e5ee`**。

用 `getObjectFieldId` 反查稳定 id,定位到 `plm_stock_preparation_bom_snapshot_line`(projectId `default:integration-core`,sheet `sheet_9ef3c4fcf62fa33a2bed67a8`)缺 5 个字段:`parentName` `childName` `material` `spec` `totalQuantity`。其余 9 张 MVP 表字段完整。用主机 `ensureMissingObjectFields` 补齐后该表 17 字段齐全,`mvp-persist` 返回 **201**(batch 1 / lines 7 / run 1)。

### 7.3 浏览器实操复核(四步全绿)

| 步骤 | 结果 |
|---|---|
| 试算:看看会写入什么 | 成功 |
| 确认:拿不准的交给人 | 跳过(没有需要确认的事) |
| 写入:BOM 落到多维表 | 成功 |
| 批次存档:留一份这次的样子 | 成功 |

汇总 `OK 3 · SKIP 1 · FAIL 0`;项目卡:7 行、已拉进来 7 行可用。

随后在多维表里给 `SYN-F-3200` 填"备料状态 = 10 - 待备料",页面提示"记录已更新";回工作台点"导出物料清单(Excel)"接口 200,导出文件第 3 行的"备料情况"即为刚填的值 —— 拉取 → 填报 → 导出闭环成立。

### 7.4 演示注意

- **Chrome 会拦下载**:站点是 HTTP,导出的 xlsx 被标为"未确认",需在下载栏点"保留"。演示前先说明,或给 222 配 HTTPS。
- **表内有旧测试数据**:备料表里除本项目 7 行,另有 8 月的 `SYNTH-P001`/`SYNTH-P002` 共 5 行;演示前建议清理(删数据需 owner 确认)。

### 7.5 由此立项的系统性问题

§2.2 的沙箱表缺 8 字段与 §7.2 的快照行表缺 5 字段是**同一个根因**:各 ensure 路径遇到"表已存在但缺模板新增字段"时,只解析已有字段、不补新增字段,把错误推迟到写入期才以"未知 fieldId"的面目出现。目前靠脚本手工补(`scripts/ops/stock-preparation-sandbox-add-missing-template-fields.cjs`)。应有一支系统性 PR 让 ensure 侧安全地自动补齐(纯增量、幂等、不改不删已有字段),该方案正在评估中。


---

## 8. 2026-09-04 晚:r8 就地升级 222(交付版)

演示通过、客户要求尽快交付后,把今天合进 main 的修复打成正式包并升级 222。

| 项 | 值 |
|---|---|
| 包 | `metasheet-multitable-onprem-v2.5.0-r8-20260904.zip`,SHA256 `1fe052fc…38a922`,CI run 33880564195 |
| 钉住的提交 | main `45cca21eec86f15a565e10745cb443d1bf308213`(含 #5471 workspace 回退、#5474 记录、#5475 漂移检测、#5455 列级写权限对账) |
| 升级前备份 | `C:\metasheet\outputackups\pre-r8-20260904-215941.dump`(pg_dump 自定义格式,2 MB)+ 升级脚本自带 `upgrade-backup-20260904-215944` |
| 升级 | must-exist 清单 OK;插件哈希 438 文件 OK;node_modules 泄漏 0;迁移退出 0;pm2 重启后健康 OK(第 3 次探测) |
| `app.env` | 34 行原样保留,`TABLE_ACTIONS_JSON` 在 |
| #5455 回填 | dry-run:0 行需打标、0 行无主、扫描 1 个账本目标 → **无需 `--apply`** |
| 复验 | dry-run 200(skip 7)/ apply 200 / mvp-persist 201 / 导出 200(20681 B) |

两条备注:①升级脚本报 `plugin lib/ file count` 包 178 vs 部署 342 的差异,这是就地升级**不删除**包里已不再发布的旧文件所致,`index.cjs` 不引用它们,不影响运行;②#5455 的回填脚本是 TS、引用 `../src/`,而部署机只有 `dist`,本次用 esbuild 转成 CJS 并把引用改指 `../dist/src/` 后放到 `packages/core-backend/scripts/` 下运行——交付说明已按此写。

## 9. 2026-09-05 配置变更记录:拉取动作补上真实读预算

**为什么**:对抗审查核实,`maxReadCount`/`maxElapsedMs` 是可选项,222 的 `INTEGRATION_CORE_STOCK_PREPARATION_TABLE_ACTIONS_JSON` 只设了 `maxRows`/`maxDepth`;`maxPages` 是每次 `readAll` 内部归零的分页数,不是总量。也就是说一次拉取对 PLM 的总读次数与总耗时**没有任何上限**,唯一刹车是 `maxRows`。

**改了什么**:在 `plm.stock-preparation.pull-bom.v1` 上增加 `maxPages:100`(与代码默认相同,显式化)、`maxReadCount:30000`(约 3 次读/行 × 10000 行上限)、`maxElapsedMs:600000`。按精确字符串替换只改这一行,改后 JSON 重新解析校验;备份在 `output\backups\app.env.pre-readbudget-20260905-215838`。

**踩坑**:`pm2 restart --update-env` 从**当前 shell 的环境**更新,而不是重读 `app.env`;第一次重启后进程仍带旧 JSON(`pm2 env 0` 可见)。正确做法是升级脚本第 7 步的写法:先把 `app.env` 逐行 `SetEnvironmentVariable(...,'Process')` 装进当前进程,再 `pm2 restart <name> --update-env`。

**验证**:重启后 `pm2 env 0` 含新键;对客户测试 PLM 项目 `2-20231625` 试算一次,证据 `expansion.summary` 出现 `maxReadCount:30000`、`maxElapsedMs:600000`(此前不出现);该项目无订单,`readCount:3`、`rowsExpanded:0`、`status:ready`,与之前行为一致。

## 10. 源绑定作用域回退(方向 B)

> 这一节是**设计规则**的记录,不是彩排流水账——先落在这份运行记录里是为了不新开一份文档就能让 owner 看到上下文;W5 阶段会把它挪进正式设计文档,这里到时候只留一个指针。

### 为什么方向和 #5471 相反

§7.1 修的是 `integration_external_systems`:UI 带 `workspaceId=default` 精确查询,而**建源**时挂在 `workspace_id IS NULL`(租户级)——精确命中不了,所以 #5471 让"**具体 hint 未命中**"回退到"**租户级 null 行**"(`selectScopedRow`,`external-systems.cjs:606-615`)。

`integration_stock_prep_source_binding` 是反过来的现象:唯一索引 `(tenant_id, COALESCE(workspace_id,''), action_id)`(migration 079)允许 `workspace_id IS NULL` 与 `workspace_id='default'` 两行并存;**UI 写绑定**走 `POST /source-binding`,带的是 `workspaceId=default` 这个 query hint,所以真实写入的是 `'default'` 那一行,而不是 null 行。麻烦出在**读**这一侧:reconcile、mvp-persist、carry、export、handoff、project board 这些调用点从来不传 `workspaceId`(`applyPersistedSourceBinding` 里 `optionalString(undefined) → null`),于是它们的查询永远是 `workspace_id IS NULL`,天然读不到 `'default'` 那一行。(`stockPreparationSourcePreflight` 不在受益名单里——它在 `http-routes.cjs:6163` 调 `getTableAction({ actionId })` 时**连 tenantId 都没传**,`applyPersistedSourceBinding` 因此直接抛错,被路由自己的 `catch` 吞掉,这个回退它从来碰不到;这是一个独立的既有 bug,本次不修,只是澄清受益范围。)

也就是说:#5471 是"**具体 hint 缺行 → 退到 null 行**";这里恰好相反,是"**null hint 缺行 → 找具体 workspace 行**"。两者是同一类"作用域没对齐"问题在两张表上的镜像表现,但回退方向不能互换——照抄 `selectScopedRow` 解决不了这里(它只在具体 hint 未命中时才查 null 行,null hint 本身从不加宽)。

### 规则

改动只在 `plugins/plugin-integration-core/lib/stock-preparation-source-binding-store.cjs` 的 `get()` 里(唯一读口):

- 调用方传 `workspaceId: null`,精确匹配(`workspace_id IS NULL` 那一行)未命中时,查同 `(tenant_id, action_id)` 下的所有行(`limit: 2` ——唯一索引保证 null 行最多一条,2 条已经足够判定"不止一条"):
  - 若这次扫描里**又看到了** `workspace_id IS NULL` 的行(精确查询与这次扫描不是同一条语句,中间可能夹进一次并发写入)→ 返回 `null`,不贴 `scopeFallback` 标签——两次读互相矛盾时,宁可拒绝也不去猜哪次读是对的;
  - 排除 null 行后**恰好一条** `workspace_id IS NOT NULL` 的行 → 返回它,并在返回对象上附 `matchedWorkspaceId: <那条的 workspace_id>` 与 `scopeFallback: 'single_workspace_binding'`;
  - **零条或两条及以上** → 返回 `null`,不猜测(fail-closed,和今天行为一致)。**这意味着如果之后有人在第二个 workspace 下也给这个 action 绑了源,这条回退会悄悄失效**——退回今天(回退功能上线前)的行为,没有报错也没有日志:store 没有接 logger/onEvent,没地方发这条通知。运维记住这一条:同一 `(tenant_id, action_id)` 下只应该存在一条 workspace 绑定,第二条一出现,没传 workspace 的调用方就又读不到了。
- 调用方传了**非 null** 的 `workspaceId` 但未命中 → 仍然只返回 `null`,**不**回退,即使此时同一 `(tenant_id, action_id)` 下存在另一个 workspace 的单条绑定(这条行为是既有测试 `stock-preparation-source-binding.test.cjs:482` 钉住的;新增的 `stock-preparation-source-binding-scope-fallback.test.cjs` 里 F-07 是真正钉住"不猜到别的 workspace"这条的用例——F-04 只种了 null 行,删掉守卫也不会让它变红,F-07 才会)。
- `workspace_id IS NULL` 那一行**命中**时精确优先,不看其它行(即使同时存在 `'default'` 行也不受影响)。
- HTTP 层:`GET /source-binding`(选源弹窗)直接透传过 `store.get()` 的行,`http-routes.cjs` 里加了 `publicPersistedBinding()` 把 `matchedWorkspaceId`/`scopeFallback` 这两个新字段剥掉,保持 `persistedBinding` 的 7 字段线上契约(`apps/web/src/services/integration/stockPreparation/sourceBinding.ts` 里 `StockPreparationPersistedBinding` 的形状)不变;`resolveSourceBinding` 解析器(`http-routes.cjs` 里喂给 `createStockPreparationTableActionRegistry` 的那个)和 `POST /source-binding` 的响应都只取 `externalSystemId`,新字段本来就流不到那两处。**注意口径**:这只是"未命中路径"逐字节不变——命中路径(不管是精确命中还是回退命中)本身多了 `matchedWorkspaceId`/`scopeFallback` 这两个内部注解键,只是它们的消费方目前只有两处(见下一条),都已经处理过。
- **真正消费 `matchedWorkspaceId` 的地方**:`http-routes.cjs` 的 `loadTableActionSourceAdapter`。回退把 `action.source.externalSystemId` 解到了一个可能只存在于**别的 workspace** 下的外接源行,但这个函数原来取外接源用的还是**请求自己的** workspace hint(null)——而 `external-systems.cjs` 的 `selectScopedRow` 对 null hint 从不加宽,于是绑定明明解出来了,取外接源那一步照样 404。修法:仅当"请求本身没带 workspace hint"且"回退确实是这次解析的原因"(重新问一次 store,`scopeFallback==='single_workspace_binding'` 且 `externalSystemId` 对得上)时,把 `matchedWorkspaceId` 作为取外接源的 workspace hint——这样无论外接源本身建在 `'default'` 还是建在 null,都能取到(非 null hint 未命中会退到 null 行,两种布局都覆盖)。测试见 `stock-preparation-source-binding-routes.test.cjs` 的 R-22。

### 222 上线后的清理步骤

回退只是让"读不到"变成"读得到",不会自动清掉冗余的那一行——`'default'` 与 null 两行会一直并存,直到有人手工清理。上线新代码、确认拉取/reconcile 等路径都正常读到源之后,按下面顺序清:

```sql
-- 1) 先核对两行绑定的是同一个外接源(占位租户,替换为实际 tenant_id 再执行)
SELECT workspace_id, external_system_id, updated_at
FROM integration_stock_prep_source_binding
WHERE tenant_id = '<TENANT_ID>'
  AND action_id = 'plm.stock-preparation.pull-bom.v1';

-- 2) 两行 external_system_id 一致时,只删 workspace_id IS NULL 那条
--    (workspace_id = 'default' 那条留着 —— 它才是 UI 和大多数调用点实际认的)
DELETE FROM integration_stock_prep_source_binding
WHERE tenant_id = '<TENANT_ID>'
  AND action_id = 'plm.stock-preparation.pull-bom.v1'
  AND workspace_id IS NULL;
```

若两行 `external_system_id` **不一致**,先别删——说明有人分别在两个 scope 下点过"保存",需要先确认哪个是当前应生效的源,再决定删哪条或是否需要 owner 介入。**更正**:这张表并非没有 UPDATE 入口——`POST /source-binding` 重新绑定同一 scope 时,store 的 `set()` 就是走 `updateRow` 改写那一行的 `external_system_id`(`stock-preparation-source-binding-store.cjs` 的 `set()` 函数,rebind 分支);没有的是**跨 scope 的编辑入口**——没有 API 能把一条已存在的行从一个 `workspace_id` 改挂到另一个,也没有"解绑"(store 头注释 "NO DELETE SURFACE" 说的正是这个,不是"不能删错行")。跨 scope 的合并/清理因此只能走上面这条直接 SQL,不是绕过了什么本该用的入口。
