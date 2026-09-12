# 托管表导入的另一半：野行（foreign rows）— 设计（2026-09-12）

分支 `docs/managed-sheet-import-foreign-rows-design`，基于 `origin/main` @ `f8cdc2ca1`。**零代码**：本文只定位、判定、给第一刀。

- **日期**：撰写时 `date` 为 2026-09-11 18:49 CST；文件名按派工指定的 `20260912`，两者不一致，此处点名。
- **values-free**：全文只出现 file:line、冻结枚举 token、schema id、计数与中文列标签。无客户行数据、无主机名、无凭据。
- **前置**：#5638（分支 `fix/managed-sheet-schema-write-gate` @ `90406d019`，本文撰写时**尚未合入 main**）把托管表的 **schema 写**在能力层拦住了非 admin。本文谈的是它没有覆盖、也不打算覆盖的另一半：**记录写**。

---

## 1. 缺口的形状

**野行**（foreign row）= 落在托管表（备料主表 / 快照表）里、不是插件写的那些行。典型来路是导入：

- `apps/web/src/multitable/views/MultitableWorkbench.vue:4063` `onBulkImport` → `apps/web/src/multitable/import/bulk-import.ts:207` `bulkImportRecords` → `:135` `client.createRecord(...)`；
- `apps/web/src/multitable/api/client.ts:2804` → `POST /api/multitable/records`（`packages/core-backend/src/routes/univer-meta.ts:18019`）；
- 路由 `:18041` 取能力 → `packages/core-backend/src/multitable/record-service.ts:545` `if (!capabilities.canCreateRecord) throw`。

这些行**没有 PLM 键**（模板的 `idempotencyKey`，`plugins/plugin-integration-core/lib/stock-preparation-templates.cjs:690`），也**没有 `ext_` 关联**。

而记录写的可写性守卫 `packages/core-backend/src/multitable/record-write-service.ts:548`（hidden）、`:552`（readOnly）、`:562`（formula/lookup/rollup/button）只认**列**的四种性质。全仓的记录写路径里**没有「这张表的行由插件所有」这个概念**：#5638 加的那道门（`packages/core-backend/src/multitable/managed-sheet-schema-write-guard.ts:69`，接线在 `permission-service.ts:1787-1800`）明写「其余能力位一律不动」，`canCreateRecord` 正是"不动"的那些位之一。

所以问题不是"能不能插进去"（能），而是**插进去之后它的命运是什么** —— 下面四节，各给一句结论。

---

## 2. 野行在刷新/对账里的命运

### 2.1 配对只看一个键，没有第二判据

- `plugins/plugin-integration-core/lib/stock-preparation-conflict-planner.cjs:479` `keyOf(row)`：行的身份**只是** `row.idempotencyKey`（trim 后非空的 string），别无其它。
- `:485` `groupByKey(rows)`：取不到键的行进 `missing` 桶，**不进** `keyed`。整条对账链（`:1370` 起的主循环、`:1432` 起的 missing-from-PLM 扫描）只读 `keyed`。
- `:992` `pickFields(row, fields)` 本身不做配对 —— 它只在决策已经做出之后，从 **PLM 侧**的行里把 `row[field] !== undefined` 的键抄进 payload。既有行的值只在 `:988 changedFields` 里被**读**来比较，从不被它取值。这一点值得点名：`pickFields` 是"写什么"，不是"配给谁"。

### 2.2 刷新读进来的是哪些行

`plugins/plugin-integration-core/lib/stock-preparation-table-actions.cjs:785` `readExistingStockPreparationRows` 的 filters 只有一项：`{ [projectNo]: projectNo }`（`:790-792`）。**野行是否进入刷新视野，完全由它的 projectNo 单元格决定**。由此分三种野行：

| 野行形态 | 刷新里的命运 | file:line |
| --- | --- | --- |
| (i) projectNo 命中、无 `idempotencyKey` | 进 `existing.missing`，**每次刷新各发一条** `manual_confirm`（type `missing_existing_idempotency_key`，source `existing_row`）；不新增、不重复、不报错、**也不改它** | `conflict-planner.cjs:1305-1310` |
| (ii) projectNo 命中、`idempotencyKey` 恰好等于 PLM 会给的某个键 | 它**就是**"既有行"：走 `:1450` 的 lineage/identity 比对，然后 UPDATE 或 SKIP —— PLM 值写进去，野行被**收编** | `conflict-planner.cjs:1370-1458` |
| (iii) projectNo 为空或写错 | 刷新读不到它，**永远不被看到**（既不挂起也不停用） | `table-actions.cjs:790-792` |

还有一种 (ii) 的变体值得单列：**野行的键与真行撞**（例如从导出/复制回填了 `唯一键` 列）。那时 `:1340-1348` 发 `duplicate_existing_key` 挂起，而 `:1372` 的 `if (duplicateExpandedKeys.has(key) || duplicateExistingKeys.has(key)) continue` 让**那个键的真行这一轮也不再刷新**。即：一行野行可以让一行真行停止更新。

### 2.3 「从 PLM 消失」的扫描看不见野行

`:1432-1447` 的 inactive 扫描遍历的是 `existing.keyed.entries()`。形态 (i)/(iii) 的野行不在 `keyed` 里，所以 `makeInactiveDecision`（`:1228`，写 `active:false`）**永远不会落到野行头上**。野行不会被"停用"，它只会一直在。

### 2.4 挂起不阻断 apply

`table-actions.cjs:1508` `canApply: !hasGlobalErrors && !hasHardRowErrors` —— `manual_confirm` 的计数不在其中。野行制造的挂起**不会挡住这次 apply**，只会一轮一轮累积。

### 2.5 写入侧对野行的两个硬边

- `plugins/plugin-integration-core/lib/stock-preparation-apply-writer.cjs:438` `findExistingRecord` 用 `LIMIT 2` 查键；`:449` 查到 >1 行就抛 `duplicate_target_key`。撞键的野行会让该键的 ADD/UPDATE 在写手层直接失败。
- `:555` `applyAddDecision` **不是纯 create**：查到同键行就 `patchRecord`。所以形态 (ii) 的野行会被 ADD 决策以 patch 方式收编，而不是再插一行。

> **一句话**：*刷新对野行不写、不删、不停用；形态 (i) 每轮产出一条永远解决不掉的挂起，形态 (ii) 被静默收编成一行正式行，形态 (iii) 对刷新完全隐形；撞键的野行还会顺带冻结同键真行这一轮的刷新（`stock-preparation-conflict-planner.cjs:1305-1310`、`:1370-1458`、`:1372`、`:1432-1447`）。*

---

## 3. 客户包升级 / provisioning 对既有行做什么

结论：**什么都不做，也发现不了野行。**

- `packages/core-backend/src/multitable/provisioning.ts` 全文**零处** `meta_records` —— 它的 SQL 只落在 `meta_bases`（`:252`）、`meta_sheets`（`:320`/`:345`）、`meta_fields`（`:426`/`:497`/`:712`）、`meta_views`（`:558`/`:593`）。
- `plugins/plugin-integration-core/lib/stock-preparation-target-provisioning.cjs` 全文无 `createRecord` / `patchRecord` / `deleteRecord`。它的两道守卫 `:654 assertNoExistingFieldMutated` 与 `:707 assertRepairableFieldOwnership` 都是**列**的事。
- 升级补列走的是 `provisioning.ts:712` 的 `ensureMissingObjectFields`（`ON CONFLICT (id) DO NOTHING`）—— 只加列，不回填任何行。新加的列在野行上就是空单元格。

> **一句话**：*客户包升级 / provisioning / repair 对主表既有行零语句，野行在升级前后逐字节不变，也不会被任何升级步骤发现（`packages/core-backend/src/multitable/provisioning.ts` 无 `meta_records` 语句；`stock-preparation-target-provisioning.cjs:654`、`:707` 只判列）。*

---

## 4. 导出、交付计数、确认队列、快照批次

### 4.1 导出：野行**会**进去，而且算"有效行"

- `plugins/plugin-integration-core/lib/stock-preparation-prep-line-export.cjs:326` `queryAllMainRows` 只按 projectNo 过滤（`:332`）。
- `:374` `const activeRows = allRows.filter((data) => data.active !== false)` —— 野行的 `active` 单元格是 `undefined`，`undefined !== false` 为**真** → **进导出，且计入 `activeRowCount`**。
- `:369` 的 `PREP_LINE_EXPORT_PROJECT_NOT_FOUND` 只在**零行**时抛。一个只有野行的 projectNo 能导出成功，不是 404。
- 导出列是 `:121-139` `EXPORT_COLUMNS` 的 17 个 logical id；野行如果列名对不上，就是一行空白单元格（`:278 columnSourceValue` 取 `undefined`，`:261 formatCellForColumn` 不抛）。

> **一句话**：*野行只要 projectNo 对得上就进交付工作簿，而且因为 `active` 缺省被当作有效行计入（`stock-preparation-prep-line-export.cjs:326`、`:374`）。*

### 4.2 交付计数与看板：同一条缺省，外加"凭空造项目"

- `plugins/plugin-integration-core/lib/stock-preparation-pull-target-scan.cjs:508` `const active = data[bindings.active] !== false` —— 与导出同一条缺省。
- `:520-531`：扫描**按行自己的 projectNo 开组**。一行 projectNo 打错的野行，会在运营项目目录里**开出一个从未拉取过的"项目"**（并入 `stock-preparation-operator-project-directory.cjs:620-624` 那条只有 pull-target 来源的目录行）。
- `stock-preparation-project-board.cjs:394-395` 的 `pulledRowCount` / `activePulledRowCount` 都来自这个扫描；`:353-356` 的 `if (!match && pullTarget.rowCount === 0)` 意味着**一行野行就能让一个陌生 projectNo 在看板上从 404 变成"存在"**。
- 导出路由的审计与响应头同样把野行算进去：`plugins/plugin-integration-core/lib/http-routes.cjs:8387-8388`（`totalRowCount` / `activeRowCount`）、`:8404`（`X-Stock-Prep-Export-Row-Count`）。

> **一句话**：*野行计入 `pulledRowCount` / `activePulledRowCount` 与导出审计计数；projectNo 打错的野行还会在运营目录/看板里造出一个不存在的项目（`stock-preparation-pull-target-scan.cjs:508`、`:520-531`；`stock-preparation-project-board.cjs:353-356`、`:394-395`）。*

### 4.3 确认队列：两极 —— 要么看不见，要么永远挂着

野行的挂起能不能进账本，取决于它带不带血缘判据：

- `conflict-planner.cjs:602` `anonymousRowIdentity`：身份只从 `componentSourceId` / `parentSourceId` / `path` / `depth`（`:110-118` `ANONYMOUS_ROW_IDENTITY_FIELDS`）里取；`:604` 一个都没有就返回 `undefined`（projectNo 单独不算判据，`:106-109` 有明确说明）。
- 有身份 → `plugins/plugin-integration-core/lib/stock-preparation-confirmation-decisions.cjs:744-764` 按 `(conflictType, rowIdentity)` **归组**落账本，`pendingDecisionCount` 每组 +1（不是每行 +1）。
- 无身份 → `:746` `identityLessByConflictType` 只计数、不落账 → 队列里看不见，只在 plan 的 `counts[manual_confirm]` 里 +1。

两种结局都不好：看不见的那类是静默；看得见的那类是**一条没有任何决策能"解决"的挂起** —— 该行不存在于 PLM，任何 confirm 动作都不会让它离开 `existing.missing` 桶。

> **一句话**：*带血缘字段的野行在确认队列里留下一条永远关不掉的挂起（按身份归组），不带的那类只进 plan 计数、账本里查无此事（`stock-preparation-conflict-planner.cjs:602-608`、`:1305-1310`；`stock-preparation-confirmation-decisions.cjs:744-764`）。*

### 4.4 快照批次：野行**不进**

`plugins/plugin-integration-core/lib/stock-preparation-expansion-snapshot-mapper.cjs:1-22` 明写它是纯函数，只把 **expansion 输出行**（源侧读出来的）重塑成快照线形状，无任何 IO、不读主表。`stock-preparation-project-reads.cjs` 的 `snapshotBatchCount` / `heldLineCount` / `readyLineCount` 读的是 MVP 快照表（`:226-229`）。所以野行**不会**进入快照批次或快照线计数。

### 4.5 附带效应：revision 会动（但这不是野行独有）

`table-actions.cjs:1055` `buildRevision` 把 `existingRows`（**整行内容**）哈希进 revision（`:1080`）。插一行野行会让 revision 变，已发出的 dry-run token 失配。**但人手改一个人工列单元格也一样会变** —— 这是既有性质，不能记到野行头上，此处点名以免被当成野行的罪状。

---

## 5. 今天哪些身份能往托管表插行

### 5.1 能力链

```
POST /api/multitable/records                   univer-meta.ts:18019
  -> resolveSheetCapabilities                  permission-service.ts:1749
       -> resolveSheetCapabilitiesForAccess    permission-service.ts:1760
  -> RecordService.createRecord                record-service.ts:534
       -> if (!capabilities.canCreateRecord)   record-service.ts:545
```

`canCreateRecord` 有**两条**来源，任一成立即为 true：

1. **全局 RBAC**：`packages/core-backend/src/multitable/access.ts:107` `canWrite = isAdminRole || hasPermission('multitable:write')` → `:129` `canCreateRecord: canWrite`。
2. **表级授权抬权**：`permission-service.ts:1515-1531` `applyContextSheetRecordWriteGrant` —— 只要 `scope.canRead && (scope.canWrite || scope.canWriteOwn)`，就把 `canCreateRecord` / `canEditRecord` / `canDeleteRecord` 一起**抬成 true**，即使该用户全局没有 `multitable:write`。

**推论（本文的核心事实）**：一线操作员要能编辑备料人工列（这正是产品承诺的能力），他在能力层上就**同时**持有 `canCreateRecord` —— 这两位在 `access.ts:129-131` 与 `permission-service.ts:1478-1480`、`:1526-1528` 里是**同一个 `canWrite` / `canWriteAnyRecord` 派生出来的**，今天没有任何地方把它们分开。#5638 的门（`permission-service.ts:1787-1800`）只降 `canManageFields`，对这两位一个字节都没动。

### 5.2 其它能在托管表上插行的入口（与能力层的关系）

| 入口 | 门 file:line | 走 `resolveSheetCapabilitiesForAccess` 吗 |
| --- | --- | --- |
| `POST /api/multitable/records`（导入循环、手工新增行） | `univer-meta.ts:18019` → `record-service.ts:545` | 是 |
| `POST /api/multitable/sheets/:sheetId/import-xlsx` | `univer-meta.ts:14721` | 是 |
| `POST /api/multitable/records/:recordId/duplicate` | `univer-meta.ts:18142` | 是 |
| 表单视图提交（**已登录**） | `univer-meta.ts:16255` | 是 |
| 表单视图提交（**匿名公开分享**） | `univer-meta.ts:16246` 用 `PUBLIC_FORM_CAPABILITIES` | **否** —— 那是 `permission-service.ts:210-224` 的硬编码常量，`canCreateRecord: true`（`:212`），不经能力层解析 |
| automation FWB 创建行 | `automation-service.ts:2335` | **否** —— 走第二个解析器 `sheet-capabilities.ts:243` `resolveSheetCapabilitiesForUser` |
| 插件自己的 apply 写手 | `plugin-scope.ts:491` → `records.ts:667` | **否** —— 完全不经能力层（与 #5633 钉的"插件写路径不受列级权限约束"同一事实的另一面） |

最后一行是好消息：任何做在能力层的门**不会**误伤插件自己的 ADD。前两行"否"是坏消息，见 §6.1(b)。

### 5.3 人工列 ADR 对"人工新增整行"有没有预期

读 `docs/development/takeover-beiliao-20260821/adr-first-load-writer-human-owned-columns.md`：

- **§2.2** 明确评估过 `POST /records`，判 **viable-with-caveats**。它的否决理由是"**不可重跑、不可对账、不可分辨**"（原文：「不是因为它不安全（它和任何人手编辑一样安全），而是因为它不可重跑、不可对账、不可分辨」），**不是**"不该有这个能力"。它同时点名了本文 §2 的机制根因：「`idempotencyKey` 在画布上只是一个普通 string 列，`meta_records` 是 jsonb 存储，**没有唯一约束**」。
- **§4.2** 否决它做**迁移主路径**。
- **§4.3** 把「**XLSX 导入 + 人工核对**」列为**合法且零代码**的单项目试点，附四条成立条件 —— 其中第 2 条正是「接受『重跑 = 先删光该项目在该表的全部行』」。

**判定**：ADR **预期**过"人经通用路径把整行写进主表"这件事，并为它留了一条有条件的口子；但 ADR 的全部语境是**首载迁移**（一次性把 16 个人列灌进一个零行项目）。它**没有讨论过**本文的场景 —— **日常运行期，在一个已经在被刷新的项目上手加一行**。对这个场景，ADR 没有表态，不能拿它当"预期能力"的背书，也不能拿它当"应当禁止"的依据。

另外一处需要分清：ADR §1.1 的那道墙（`assertNoHumanFields`，`conflict-planner.cjs:1057`、`apply-writer.cjs:239`）保证的是"**刷新的 payload 里不含人工列**"。这条承诺与野行**正交** —— 野行根本没被任何 payload 命中，墙对它一句话都没说。

---

## 6. 裁决：(a) / (b) / (c)

### 6.1 三个选项的判定

**(a) 野行是预期能力（人工补行），只需让刷新/导出对它有稳定语义 —— 现状下不成立。**

不成立的点不在"人该不该能加行"，而在：今天**没有任何一处**给它稳定语义，而要补齐得同时动四个地方 ——
刷新（`conflict-planner.cjs:1305-1310` 每轮一条无解挂起）、
停用扫描（`:1432-1447` 永不覆盖它）、
导出（`prep-line-export.cjs:374` 的 `active` 缺省把它当有效行）、
目录/看板扫描（`pull-target-scan.cjs:508`、`:520-531` 同一条缺省 + 凭空开组）。
这不是一个窗口的活，而且每一处的"正确语义"都需要 owner 裁定（野行该不该导出？该不该计入交付数？该不该出现在目录里？）。**(a) 可以是终局，不能是第一刀。**

**(b) 拦住（非 admin 对托管表 `canCreateRecord` 降 false，与 #5638 同形）—— 在当前形状下代价不可接受，且仍有洞。**

- **误伤面（数据面，与 #5638 的 schema 面完全不同量级）**：同一位 `canCreateRecord` 被 §5.2 表里前四行**共用**。降它 = 同时关掉手工新增行、XLSX 导入、行复制、已登录表单提交。
- **命中面无法只限备料**：判定用的是 `plugin_multitable_object_registry`（`sheet-delete-guard.ts:65`）。考勤、审批投影、e-learning 的托管表**一并中招**；而 `managed-sheet-schema-write-guard.ts:53` 的 fail-closed 语义（查不到注册表就当托管）意味着注册表不可读时 **非 admin 在所有表上都插不了行**。#5638 砍 `canManageFields` 时这个代价可接受（非 admin 本来也很少需要在托管表建列，且 admin 留了修复口子）；砍 `canCreateRecord` 是另一回事。
- **仍然漏两条**：匿名公开表单（`permission-service.ts:210-224` 的常量不经能力层）与第二个解析器（`sheet-capabilities.ts:243`，automation FWB create 用它）。要堵全得改三处。
- **对承诺的影响**：直接**推翻 ADR §4.3** 的零代码试点路径（非 admin 再也导不进去）。**不影响**「拉取从不覆盖人工列」—— 那条由 `assertNoHumanFields` 保证，与 create 无关；`canEditRecord` 不动，人工列编辑保留（这一点 (b) 做得到，但不足以让 (b) 划算）。

**(c) 允许但打标，并在刷新/导出/计数里被识别 —— 推荐，且第一刀在读侧。**

关键发现：**不需要新列，也不该加新列。**

- 想加的"server-owned 标记"如果落在 jsonb `data` 里（哪怕经 `repairStockPreparationCanonicalTarget` 的 `plm_system` 通道补上，`stock-preparation-target-provisioning.cjs:707-724` 允许 `plm_system`），它**同样可被那次导入伪造** —— 记录写守卫只认 hidden/readOnly/computed（`record-write-service.ts:548`/`:552`/`:562`）。想靠 `property.readonly` 让它"插件能写、人不能写"也不成立：插件路径 `records.ts:378` `isFieldAlwaysReadOnly` 会**同样**拒绝，两边一起被挡。（注意这与 #5633 钉的"插件写路径不受**列级权限**约束"不矛盾 —— 那说的是 `field_permissions`，不是 `property.readonly`，是两个层。）
- 而**已经存在**一个服务端铸造、客户端写不到的判别位：`meta_records.created_by`。
  - 插件写的行：`records.ts:712-717` 的 `INSERT INTO meta_records (id, sheet_id, data, version)` **不含 `created_by`** → NULL。
  - REST 写的行：`record-service.ts:740-743` 的 `INSERT ... (id, sheet_id, data, version, created_by, modified_by) VALUES (..., $4, $4)`，`$4 = actorId`。
  - 读侧已经透出来了：`query-service.ts:257` 把 `created_by` 映成 `createdBy`，`:368`/`:439` 的 SELECT 里有它，类型 `LoadedMultitableRecord.createdBy`（`query-service.ts:58`）。
  - 插件侧唯一丢掉它的地方是 `stock-preparation-table-actions.cjs:774-783` `unmapRecordFields` —— 它只取 `record.data`。

### 6.2 推荐

**(c)，并且第一刀只做读侧的"给它一个名字"，不改任何行为。**

理由排序：(b) 的误伤/漏网比它挡住的风险大，且 (b) 要 owner 先重裁 ADR §4.3；(a) 是终局但需要四处 owner 裁定；(c) 的第一刀把"野行"从一个没人看得见的现象变成一个**有计数、有证据**的事实，而这正是 (a)/(b) 任一终局都必须先有的输入。

### 6.3 第一刀（一个窗口、可验收、可回滚）

**做什么**：让 planner 知道 `existing.missing` 里的每一行是不是人手插的，并分成两类计数 —— **行为一个字节不变**。

1. `stock-preparation-table-actions.cjs:774` `unmapRecordFields` 把 `record.createdBy` 带出来，放进一个**保留键**（不落 `data`、不进模板、不进 `fieldIdMap`）。
2. `conflict-planner.cjs:1305-1310` 的 `existing.missing` 分支按该键分两类 conflictType：
   - `missing_existing_idempotency_key`（保留原 token，`createdBy` 为空）；
   - 一个新的、加进冻结词表的 token（`createdBy` 非空 = 人手插的）。
3. plan summary 各出一个计数。**挂起照挂、不写、不删、不阻断 apply** —— 变的只是这件事从此在证据里**有名字**。

**为什么这是第一刀而不是别的**：它不碰任何写口、不碰任何权限位、不碰导出/看板的 `active` 缺省，因此不需要 owner 裁定就能落；而它产出的计数正是回答"现网到底有多少野行、在哪些项目上"的唯一无侵入手段。

**验收**：一件测试，同一张托管主表上放两行 —— 一行 `created_by` 非空（模拟人手插）、一行 `created_by` 为 NULL 且无键（模拟历史/插件无键行），断言两个计数各为 1；**并且**断言 `buildRevision`（`table-actions.cjs:1055`）的输出与改动前**逐字节相同**（保留键必须被挡在 revision 哈希之外，否则每一个既有 revision 都会漂、所有在飞的 dry-run token 全部失配）。

**变异（每条都要"去掉它测试就红"）**：
- 摘掉 `unmapRecordFields` 的 `createdBy` 透传 → 新计数恒 0 → 红；
- 把保留键放进 `buildRevision` 的输入 → revision pin → 红；
- 把新 token 从冻结词表里去掉 → 词表全集断言 → 红。

**回滚**：单 commit revert，读侧无状态、无 schema、无数据迁移。

### 6.4 三个选项对现有承诺的影响（对照表）

| 承诺 | (a) 认可野行 | (b) 拦住野行 | (c) 打标识别 |
| --- | --- | --- | --- |
| ADR §1.1「拉取从不覆盖人工列」（`assertNoHumanFields`） | 不受影响（野行不在 payload 里） | 不受影响 | 不受影响 |
| ADR §4.3「XLSX 导入 + 人工核对」可作单项目试点 | 保留 | **推翻**（非 admin 再也导不进去） | 保留 |
| ADR §2.2 对 `POST /records` 的 viable-with-caveats 判定 | 一致 | 与之相悖，需 owner 重裁 | 一致 |
| 交付说明里的导出行数口径 | **需要重新定义**（野行算不算） | 自动收敛（不再有新野行，存量仍在） | 不变，但存量野行从此可计数 |
| #5638 的"托管表列集归插件所有" | 正交 | 同形延伸到行 | 正交 |

---

## 7. 报告说错的点名

1. **「刷新对既有行是 merge（`SET data = data || $1::jsonb`）所以不会误覆盖」— 这条 SQL 不是刷新走的那条。**
   `data || $1::jsonb` 出现在 **REST** 路径（`record-write-service.ts:1058`、`record-service.ts:1615`、`univer-meta.ts:16525`/`:17913`）。**插件刷新不走它**：`records.ts:558-562` 先 `getRecord` 读出整行，`:575-578` 在 JS 里 `{...existing.data, ...patch}`，然后 `:586-591` `UPDATE meta_records SET data = $1::jsonb` —— **整档替换**。
   语义上确实仍是"只改 patch 里出现的键"，所以**对人工列的结论仍然成立**；但它是**读-改-写**，而且：`getRecord` 不带 `FOR UPDATE`（`records.ts:558`，该函数下方 `:592-600` 的注释自己说明这个 UPDATE 是本函数第一个真正上锁的语句）、apply-writer 调用时**不传** `expectedVersion`（`apply-writer.cjs:565-569`、`:597-601`）、默认配置下 patch 路径不取表锁（`records.ts:538-543` 的 `fenceWriterEntry` 在写者栅栏开关关闭时是 no-op）。因此存在一个窄窗口：人在 SELECT 与 UPDATE 之间提交的人工列编辑会被整档写回丢掉。**我没有实测复现这个窗口，只读了代码**，这条按"待证"记。
2. **「merge 所以安全」只回答了既有行，对野行一个字都没说。** 野行从来不是 patch 的目标 —— `findExistingRecord`（`apply-writer.cjs:438`）按键查不到它，`groupByKey`（`conflict-planner.cjs:485`）也不把它放进 `keyed`。"不会误覆盖"是真的，但它与"野行的命运"是两个互不相交的问题。
3. **「#5638 把托管表的 schema 写拦住了」应加一个作用域限定。** 它拦住的是**经 `resolveSheetCapabilitiesForAccess`（`permission-service.ts:1760`）的那一半**。第二个能力解析器 `sheet-capabilities.ts:243` `resolveSheetCapabilitiesForUser`（服务 Yjs 协作房间、OAPI token 能力、automation、`routes/api-tokens.ts:16`）有 approval（`:263-287`）与 e-learning（`:288` 起）两道 restrict 的克隆，**没有**托管表那道。这条我只做了 grep 判定，**没有**跑出一个经该解析器在托管表上建列的具体请求 —— 可能它根本够不到 schema 路由；但"两个解析器只有一个装了门"这个不对称本身值得 #5638 的作者复核。
4. **「导入未匹配表头默认建列离写数据只有一步」（#5603/#5638 的措辞）在方向上要反过来读**：写数据那一步**从来不需要**建列。`bulk-import.ts:135` 的 `createRecord` 只要列名能映上任何既有列就能落行；`applyImportCreateFields`（`MultitableWorkbench.vue:3966`）失败会中止整个导入（`:4070-4073`），但**不建任何新列的导入照样能插满野行**。#5638 关掉建列**不减少**野行的产生面。

---

## 8. 未能判断的

1. **222 上一线操作员的 `canCreateRecord` 来自哪一条** —— 全局 `multitable:write`（`access.ts:107`）还是表级授权抬权（`permission-service.ts:1526-1528`）。两条都通向 true，但决定了 (b) 的误伤面有多大。本机无法查 RBAC 表。
2. **备料主表上是否存在公开表单分享** —— 若有，(b) 有一个能力层堵不住的洞（`permission-service.ts:210-224`）。
3. **现网到底有没有野行、有多少** —— 需要一条实读（形如 `meta_records` 上按 sheet 统计 `created_by IS NOT NULL` 的行数）。这正是 §6.3 第一刀要产出的计数。
4. **`created_by IS NULL ⇔ 插件写` 的反方向没有穷尽** —— 我核了 create（`record-service.ts:740`）与 restore（`:1234`，传原 `createdBy`）两条，**没有**遍历所有会写 `meta_records` 的入口。把 `createdBy` 当判别位之前，这一步必须补完（否则会把某条 actorId 为 null 的人手路径误判成插件写）。
5. **网格里"在末行直接敲字新增"走的是哪条 create** —— 我没有追完 collab / Yjs 的新行路径，不确定它是否也落在 `POST /records`。
6. **`active` 缺省那两处（`prep-line-export.cjs:374`、`pull-target-scan.cjs:508`）改成"必须显式 true"会不会误伤既有插件写的行** —— 模板把 `active` 标 required（`stock-preparation-templates.cjs:738`），`makeAddDecision` 的 record 由 `pickFields` 从 PLM 行取值（`conflict-planner.cjs:1124`），看上去每行都会带 `active`；但我**没有**在真库上验证过存量行，所以这一刀要先有实读证据，不能顺手做。
