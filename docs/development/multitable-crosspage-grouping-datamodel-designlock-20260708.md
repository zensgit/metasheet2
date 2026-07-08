# Multitable — 跨页 / 服务端分组数据模型 — DESIGN LOCK

- **状态：PROPOSED — 待 owner ratify。** 本文件为纯文档；未经 ratify 不得开工任何运行时切片。
- **基线**：`origin/main` @ `c29b5e2c2`。以下每条"现状"断言均给出 file:line，均在该 commit 上复核过。
- **本锁的位置**：`docs/development/multitable-grid-grouped-windowing-designlock-20260705.md` §6 / §8 把
  "server-side grouping / cross-page group coalescing（data-model slice, independent）"点名为一条**独立**的、
  被 gate 的后续线。本文件就是那条线，**不是** GW 锁的重复。
  - GW 锁的渲染切片**已落地**：`4c376b8e4 feat(multitable): window grouped grid rows (#3648)`；
    `groupedWindowEnabled` / `windowedGroupRenderItems` 已在 `MetaGridTable.vue:905-909, 971-975` 上线。
    本锁**不重开**窗口化问题；本锁解决的是"窗口里装的是哪一份分组真值"。
- **变更面（ratify 后按梯子分切片）**：`packages/core-backend/src/routes/univer-meta.ts`（新分组列表契约）、
  `apps/web/src/multitable/api/client.ts`（wire 类型）、`apps/web/src/multitable/composables/useMultitableGrid.ts` +
  `apps/web/src/multitable/components/MetaGridTable.vue`（**网格互斥文件**，见 §5.0）、
  `apps/web/src/multitable/components/MetaGalleryView.vue`。

---

## §1 原则 — 为什么分组必须是服务端数据模型

MetaSheet 的既有口径已经把"聚合真值"和"页面切片"分开了：页脚聚合与分组小计**只**来自服务端、
**从不**由本地行计算（`MetaGridTable.vue:1198` "value comes ONLY from the server response … never computed
from local rows"；`MultitableWorkbench.vue:2716` "SERVER-RESPONSE ONLY — never compute aggregates from
local rows"；`:2762` 明确"NO local fallback — keeps the 'filtered set, not page rows' contract"）。

**分组本身是同一类真值，却仍然停留在客户端页内计算。** 这产生三条本锁要消除的后果：

1. **分组是筛选集的属性，不是当前页的属性。** 一个分组的存在、它的成员数、它在列表中的位置，
   由整个筛选集决定；用一页 50 行去归纳它，得到的是一个随翻页而变形的假分组。
2. **同一份渲染里不能同时存在两套真值。** 今天分组头显示页内计数，而同一个分组块下面的小计行显示
   服务端全集计数——两者字面矛盾（§2.4，可复现）。真值必须唯一。
3. **游标必须理解分组，否则"分组 + 增量加载"在定义上无解。** 按 `created_at, id` 切页的偏移分页
   不保证同组行相邻；任何"加载下一页再合并分组"的客户端策略都只是把碎片搬到更晚的时刻。
   要让分组视图能无限滚动、让画廊能分组，**顺序与边界必须由服务端定义**。

因此本锁的原则是：**分组键、分组真计数/小计、分组稳定序、以及分组感知游标，全部是服务端契约的一部分；
客户端只在"服务端已定义的分组骨架"内做窗口化与增量取数。** 客户端永远不发明分组。

---

## §2 现状枚举（逐条 file:line，已复核）

### 2.1 分组在哪里算出来的：客户端，只对已加载的那一页

- `MetaGridTable.vue:588` — `const filteredRows = computed(() => props.rows)`：`rows` 就是**服务端返回的当页行**，
  组件不做二次筛选。
- `MetaGridTable.vue:832-856` — `buildGroupTree(rows, level, parentPath)`：对 `rows` 做 `Map` 分桶递归。
- `MetaGridTable.vue:858-861` — `groupedRows = buildGroupTree(filteredRows.value, 0, '')`。
  → **分组树的输入集合 = 当前页的行**。
- `MetaGridTable.vue:841` 注释自陈：`// Insertion order = first-seen on this page`。
  → **分组顺序 = 该页首次出现顺序**。
- `MetaToolbar.vue:358-359` — `GROUPABLE_TYPES = {select,string,boolean,number,date}`，`MAX_GROUP_LEVELS = 3`。

### 2.2 分组头上那个数字，实际反映的是"这一页里属于该组的行数"

- `MetaGridTable.vue:851` — `count: groupRows.length`（`groupRows` 来自当页分桶）。
- `MetaGridTable.vue:883` — 该 `count` 原样进入 `header` 渲染项。
- `MetaGridTable.vue:46` — `<span class="meta-grid__group-count">({{ item.count }})</span>`。
  → 用户看到的 `(N)` **是页内计数**，不是该分组的真实规模。

### 2.3 50 行/页 的交互：分组视图被钉死在单页，且每翻一页分组重建

- `useMultitableGrid.ts:305` — `const DEFAULT_PAGE_SIZE = 50`；`:625-626` `loadViewData` 以 `{ limit: pageSize, offset }` 取数。
- `MetaGridTable.vue:696-698` — `infiniteScrollEnabled = !printing && !groupedRows && expandedRowIds.size === 0`
  → **分组模式被显式排除在无限滚动之外**。
- `MultitableWorkbench.vue:1398` — `gridIsFlatPath = grid.groupFields.value.length === 0`；
  `:1402` — `gridCanLoadMore = gridIsFlatPath && grid.canLoadMore`；
  `:276` — `:can-load-more="gridCanLoadMore" :infinite-scroll="gridIsFlatPath"`。
  → 工作台**从不**给分组视图喂 `load-more`；分组视图走经典页脚翻页器。
- `univer-meta.ts:12983` `GET /view` 的行加载：`:13271-13276`
  `SELECT … FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`。
  `/view` 处理体的真实边界是 **12983–13493**（下一个 `router.*` 注册在 `:13494`）；该区间内
  **没有任何 `groupInfo` 引用**——全文件 `grep -n groupInfo` 的最高命中是 `:12807`，落在 `view-aggregate` 体内。
  → **服务端切页时完全不知道视图在分组**；同一分组的成员被 `created_at` 序切散在多页。
- 因此翻到第 2 页时 `props.rows` 被整页替换，`buildGroupTree` 在新一页上重新分桶：
  分组集合、分组顺序、分组计数**逐页变形**。这不是渲染缺陷，是数据模型缺陷。

### 2.4 头部计数 vs 服务端小计：**同屏字面矛盾**（本锁的核心证据）

服务端 `GET /sheets/:sheetId/view-aggregate`（`univer-meta.ts:12629`）**已经**在同一份响应里带上了
每个分组节点的**全集真计数**：

- `univer-meta.ts:12841-12847` — `serializeBuckets`：`{ key, count: bucket.rows.length, aggregates, children? }`，
  其中 `bucket.rows` 来自**整个筛选集**（`:12738` 全量取行 → `:12747-12749` 行级拒读过滤 → 搜索/筛选 → `:12848` 分桶）。
- 客户端 wire 类型**已经声明了这个字段**：
  - `api/client.ts:889-897` — `interface ViewAggregateGroup { key; count: number; aggregates; children? }`
  - `MetaGridTable.vue:417-422` — `interface ServerAggregateGroup { key; count: number; aggregates; children? }`
- **然后客户端把它丢掉了**：`MetaGridTable.vue:1207-1219` 的 `serverGroupAggByKey` 只做
  `m.set(path, node.aggregates)`（`:1213`）——`node.count` **从未被读取**（全仓 grep：`ServerAggregateGroup` 仅出现在
  `:417/:421/:483/:1209`，`count` 无任何消费点）。

矛盾的**可复现形式**：某分组在筛选集中有 200 行，页大小 50，用户对任一列配置聚合函数 `count`。

| 同一分组块内 | 渲染来源 | 显示 |
|---|---|---|
| 分组头 `(N)` | `MetaGridTable.vue:46` ← `:851` `groupRows.length`（**页内**） | `(50)` 或更少 |
| 小计行 Σ 单元格 | `MetaGridTable.vue:145` `groupAggValueDisplay(item.path, field.id)` ← 服务端 `aggregates[fieldId]`，而 `aggregateField(values,'count',…)` = `values.length`（`aggregation-helpers.ts:65-66`，**全集**） | `200` |

即：**头写 50，头正下方的 Σ 写 200，二者出自同一个分组节点。** 服务端真值已经在客户端内存里，
只是渲染分组头时没有被使用。这是本锁最短的证据链，也说明"客户端页内分组"已经不是一个自洽状态。

补充两条使该矛盾无法靠"客户端读一下 `count`"了结的现实约束：

- **服务端分组树只在配置了页脚聚合时才会被拉取。** `MultitableWorkbench.vue:2744-2766` 的 `loadAggregates()`
  在 `:2748` 处 `Object.keys(activeAggregationConfig.value).length === 0` 即早退并清空 `aggregateGroups`。
  一个"只分组、不配聚合"的视图**根本拿不到**服务端分组树。
  `MetaGridTable.vue:1221` `hasGroupSubtotals` 亦要求 `hasAnyAggregation`。
  → 分组元数据今天是**页脚聚合配置的副产品**，而不是分组视图的一等契约。
- **该端点在 10k 行硬失败。** `univer-meta.ts:12675-12679`：`MULTITABLE_AGGREGATE_MAX_ROWS`（默认 `10000`）
  超限直接 `413 AGGREGATE_TOO_LARGE`，`MultitableWorkbench.vue:2764` 置 `aggregateTooLarge`，
  `MetaGridTable.vue:1221` 随即关闭全部小计。→ 超过 1 万行的表，服务端分组真值**不存在**。

### 2.5 分组顺序：服务端有稳定序，客户端不用它

- `aggregation-helpers.ts:117-124` — `sortBucketsByKey`：空值组恒最后，其余按 `localeCompare(..., { numeric: true })`。
- 客户端 `MetaGridTable.vue:841` 用"本页首次出现序"。
- 两者**按 path 查小计仍能对上**（`levelKey` 与 `groupKeyOf` 的空值口径一致，`:810-816` 有注释担保），
  所以这不是错值缺陷；但**服务端定义的稳定序在 UI 上完全不可见**，翻页即重排。

### 2.6 画廊为什么不能分组：它连分组概念都没有

- `MetaGalleryView.vue:52` — `v-for="(row, idx) in rows"`，扁平铺卡。
- 全文件 447 行，`grep -ci group` = **0**。
  → 画廊分组不是"没做 UI"，是**没有可消费的分组骨架**。它要的正是本锁定义的契约（分组键 + 真计数 + 稳定序 + 组内游标）。
- 看板确有分列，但同样是页内计数：`MetaKanbanView.vue:52` `{{ lane.count }}`、`:62` `{{ col.rows.length }}`。
  （看板消费本契约是**契约之外**的后续，本锁不安排该切片。）

### 2.7 现状小结（审计前提是否成立）

审计前提**成立**，且本锁把它**收紧**了：

- ✅ 成立：分组在客户端、只覆盖已加载页（§2.1–2.3）。
- ✅ 成立：分组视图不能正确无限滚动（§2.3，被显式 gate 掉）。
- ✅ 成立：画廊不能分组（§2.6）。
- ✅ 成立且更强：头部计数 vs 服务端小计的矛盾是**真的、同屏的、可复现的**——并且**服务端真计数早已在 wire 上**，
  客户端在 `MetaGridTable.vue:1213` 主动丢弃（§2.4）。
- ⚠️ 需要收窄的说法：分组**小计值**并没有错。它们本来就是服务端全集算的（`:12844-12846`），
  按 composite path 查表命中。错的是**分组骨架**（存在性 / 计数 / 顺序 / 边界），不是小计数值。
  本锁不得宣称"小计是错的"。

---

## §3 目标形状 — 契约

### 3.0 一个必须被点名、而不是被 SQL 抹平的架构张力

`view-aggregate` 今天**故意**"全量取行 → 内存筛选/分桶"（`univer-meta.ts:12738` 后整段），
因为 MetaSheet 的筛选/分组语义有一部分**没有 SQL 形式**：

- 计算字段（`lookup/rollup/formula`）与 `link` 条件无法在该路径求值 → `422 AGGREGATE_COMPUTED_FILTER_UNSUPPORTED`（`:12709`）、
  `422 AGGREGATE_COMPUTED_GROUP_UNSUPPORTED`（`:12821`）。
- 行级拒读需要先解析出被拒 id 集合再过滤（`:12747-12749`）。

因此**"真计数 + 无 N+1 + 分组感知游标"不可能一律等于一条 `GROUP BY` + keyset**。
仓内已经有解法形状：**导出路径的分叉**（`univer-meta.ts:12467-12495`）——
无筛选/排序时用 `queryRecordsWithCursor` 流式 keyset 分页；否则退化为"全量载入 → 内存处理 → 上限截断"。

**本锁据此规定：分组后端沿用同一分叉，并把分叉结果写进 wire。**

| 分支 | 条件 | 计数/小计 | 游标 |
|---|---|---|---|
| `mode: "indexed"` | 分组字段与全部筛选条件均可 SQL 化（无 computed/link） | SQL `GROUP BY` 单次扫描 | 分组感知 keyset 游标 |
| `mode: "materialized"` | 存在 computed/link 条件或行级拒读，且筛选集 ≤ `MULTITABLE_AGGREGATE_MAX_ROWS` | 内存分桶（沿用 `groupRowsByFields`） | 组内 offset 退化游标（仍为不透明 token） |
| `mode: "unavailable"` | 超上限 | 无（沿用 `413 AGGREGATE_TOO_LARGE` 语义） | 无；客户端回退到今天的经典翻页器 |

分叉的具体实现选择**留给后端切片**（§5 B 号栏）在其 gate 内决定；本锁只锁定
**游标必须可降级、且降级必须在 wire 上自陈**（`mode` 字段），而不是静默变形。

### 3.1 新端点：`GET /api/multitable/sheets/:sheetId/view-groups`

与 `view-aggregate` **并列**、**不替换**。分组视图无条件调用它（不依赖是否配置了页脚聚合）。

**请求**

| 参数 | 类型 | 说明 |
|---|---|---|
| `viewId` | string? | 与 `/view` / `view-aggregate` 同义；分组字段读自 `view.groupInfo.fieldIds`（`univer-meta.ts:12803-12813` 的既有双读口径，含 legacy `fieldId`） |
| `search` | string? | 必须走 `normalizeSearchTerm`，与 `/view`、`view-aggregate` 同一归一化（否则筛选集分叉） |
| `cursor` | string? | 不透明 token；缺省=首屏 |
| `limit` | int? | 本次返回的**数据行**上限，clamp 与 `/view` 一致（≤ 5000，`univer-meta.ts:12991`） |

**响应**（`ok: true, data:`）

```jsonc
{
  "mode": "indexed",               // "indexed" | "materialized" | "unavailable"
  "groupFieldIds": ["fld_a", "fld_b"],   // 有序，≤ MAX_GROUP_LEVELS(3)
  "total": 12034,                  // 筛选集（已行级拒读、已 field-mask）的总行数
  "groups": [                      // 稳定序；层级树
    {
      "key": "华东",               // 与 aggregation-helpers.ts:108-115 `groupKeyOf` 同口径：空值 → null
      "path": ["华东"],            // 祖先键 + 自身键；客户端 GROUP_KEY_SEP 拼接的显式数组形式
      "count": 4210,               // ★ 该分组在【整个筛选集】中的真实行数（不是本页）
      "order": 0,                  // ★ 服务端稳定序内的序号（见 §3.3）
      "aggregates": { "fld_amt": { "fn": "sum", "value": 91234 } },  // 仅在配置了聚合时出现；口径 == view-aggregate
      "children": [ /* 同构 */ ],
      "rows": [ /* 见 §3.2：仅首屏/被请求的组内窗口 */ ],
      "rowsCursor": "eyJn…",       // ★ 组内续取游标；null = 该组已取尽
      "hasMoreRows": true
    }
  ],
  "nextGroupCursor": "eyJn…"       // ★ 组维度续取游标；null = 分组骨架已取尽
}
```

**两级游标是本契约的关键。** 分组列表本身可能很长（高基数分组字段），组内行也可能很长。
`nextGroupCursor` 沿 §3.3 的稳定序推进；`rowsCursor` 在**一个已知分组内**推进。二者都不透明。

### 3.2 首屏配额（避免 N+1 与"为一个折叠组拉全表"）

- 首屏对每个**展开的**叶子分组返回至多 `PREFETCH_ROWS_PER_GROUP`（建议 `20`，与 `OVERSCAN_ROWS = 8`
  的窗口口径相容）行；折叠分组 `rows: []`、`hasMoreRows: true`、`rowsCursor != null`。
- **禁止 N+1**：`indexed` 模式下首屏必须在 **≤ 2 次 SQL 往返**内完成
  （一次 `GROUP BY` 拿骨架 + 一次带 `ROW_NUMBER() OVER (PARTITION BY …)` 或 `LATERAL` 的行取），
  **绝不允许"每组一次查询"**。展开某个折叠组 = 该组一次 `rowsCursor` 续取，不重取骨架。

### 3.3 稳定序（服务端定义，客户端不得重排）

沿用**已有**的 `sortBucketsByKey`（`aggregation-helpers.ts:117-124`）：空值组恒最后，其余
`localeCompare(String(key), …, { numeric: true })`。`order` 字段把该序显式写在 wire 上，
客户端按 `order` 渲染，**不得**再用"本页首次出现序"（`MetaGridTable.vue:841` 的行为在分组切片中删除）。

组内行序 = 视图 `sortInfo` 的既有排序规则；平局回落 `created_at ASC, id ASC`（`/view` 现行口径 `:13275`）。

### 3.4 游标编码

复用 `query-service.ts:68-82` 的 `encodeRecordCursor` / `decodeRecordCursor` 形状
（`base64url(JSON({ id, sv }))`），扩展为分组感知：

- `rowsCursor` = `base64url(JSON({ g: <group path>, id, sv }))` — keyset 谓词沿用 `:357-367` 的
  `(sortExpr, id) > ($n-1, $n)`，外加 `PARTITION` 键等值约束。
- `nextGroupCursor` = `base64url(JSON({ ok: <last group key>, o: <order> }))`。
- 解码失败 → `MultitableRecordValidationError`（沿用 `:72-82`），**不静默回退到 offset 0**。

### 3.5 客户端形状（不改渲染架构）

- `useMultitableGrid` 新增分组骨架状态：`groupSkeleton: GroupNode[]`、`groupTotal`、`loadGroupRows(path)`。
- `MetaGridTable` 的 `groupedRows` **不再**由 `buildGroupTree(filteredRows)` 产生，而是由
  `props.groupSkeleton` 直接映射；`item.count` 取 `node.count`（服务端真值）。
  `groupRenderItems` / `groupedItemOffsets` / `windowedGroupRenderItems`（`:876-975`，#3648 已落地）
  **原样保留**——窗口化的输入换成了正确的骨架，模型不变。
- 未加载的组内行以**占位项**（`kind: 'placeholder'`，高度 = `rowHeightPx × 未加载行数`）参与偏移表，
  使滚动条几何在整个筛选集尺度上成立；占位项进入视口 → 触发 `loadGroupRows`。

---

## §4 硬约束 / 不变式

- **INV-1 权限对等（计数不得泄露被拒行的存在）。** 分组骨架路径必须**复用既有闸门**，不得另起炉灶：
  - 行级拒读在**分桶之前**过滤（`univer-meta.ts:12747-12749` 的位置语义）：`count` 与 `aggregates` 均不含被拒行。
  - 字段掩码走**唯一 chokepoint** `maskStoredRecordFieldIds`（`:12725-12731`）；未通过者从输出集删除。
  - 分组字段本身若被隐藏/拒读 → `422 AGGREGATE_GROUP_FIELD_DENIED`（`:12826`）；
    计算字段分组 → `422 AGGREGATE_COMPUTED_GROUP_UNSUPPORTED`（`:12821`）。二者在新端点上**逐层**复用。
  - **推论（必须有 golden 覆盖）**：两个用户对同一视图取 `view-groups`，若 A 被拒读若干行，
    则 A 看到的 `total`、任一 `count`、任一 `aggregates.value`，以及**分组的存在性本身**
    （一个全部成员都被拒读的分组**不得出现**），都必须与"这些行不存在"的世界完全一致。
- **INV-2 无 N+1。** 见 §3.2。`indexed` 首屏 ≤ 2 次 SQL；展开一个组 = 1 次续取。
  审阅时以查询计数断言（mutation：把批量取行改成 per-group 循环 → 测试必须变红）。
- **INV-3 并发写下的顺序稳定。** 游标是 keyset 不是 offset；一次分组会话内，
  新插入的行**不得**导致已渲染行重复或跳过。分组的 `count` 是**取骨架那一刻**的快照，
  允许与随后到达的行数短暂不一致；`count` 与已渲染行数的关系是"≥"，不是"=="，
  UI 不得据此断言"加载完成"（以 `hasMoreRows`/`rowsCursor === null` 为准）。
- **INV-4 与现客户端向后兼容（扩展，不替换）。**
  - `view-aggregate` 的响应形状**逐字节不变**（`:12851` 的 `{ total, aggregates, groupFieldId, groupFieldIds, groups, stats? }`）；
    现有按 composite path 查小计的读者（`MetaGridTable.vue:1207-1219`）继续工作。
  - `view-groups` 是**新增**端点。未启用分组数据模型的调用方（嵌入面、OAPI 读者）行为不变。
  - `mode: "unavailable"` 时客户端必须能**原样退回**今天的经典翻页器路径（`MultitableWorkbench.vue:1398-1402`），
    不得白屏、不得把 `count` 显示为 0。
- **INV-5 唯一真值。** 分组头计数与小计行 `count` 聚合**必须同源**。切片完成后，
  §2.4 表格里"头 50 / Σ 200"的组合在任何页大小、任何滚动位置下都不可复现。
- **INV-6 键口径同构。** 服务端 `groupKeyOf`（`aggregation-helpers.ts:108-115`）与客户端 `levelKey`
  （`MetaGridTable.vue:814-816`）的空值/原始值口径必须继续按构造一致；`path` 改为**显式数组**上 wire，
  `GROUP_KEY_SEP`（``，`:807`）退化为纯客户端的 Map 键实现细节，不再是跨进程契约。
- **INV-7 不动中心权限。** 不触碰 `rbac`/`auth` 中心模块（既有 K3 锁）；本线只在 multitable 路由内消费既有闸门。

---

## §5 门禁 TODO-checklist（按序；🔒=未解锁 ⬜=已解锁待做 ✅=完成）

### §5.0 调度约束：**网格互斥（grid mutex）**

`apps/web/src/multitable/components/MetaGridTable.vue`（1516 行）与
`apps/web/src/multitable/composables/useMultitableGrid.ts`（1418 行）是**单占用热文件**。
任何触及它们的切片**不得**与其他网格切片并行开工（并行会在 rebase 时产生不可机械消解的冲突，
并使"emit 字节等价"这类验收基准失效）。

→ 下表中标注 **[MUTEX]** 的切片必须**串行独占**：开工前确认无其他在飞的网格 PR，落地后再放行下一个。
→ 切片 A（契约）与切片 E（画廊）不触碰这两个文件，可与非网格线并行。

### §5.1 梯子

| # | 切片 | 状态 | 变更面 | 模型档位 | 验收要求 |
|---|---|---|---|---|---|
| — | **本设计锁** | ⬜ 待 owner ratify | 仅文档 | opus 起草 | — |
| **A** | **契约切片**：`view-groups` wire 形状 + `mode` 分叉 + 两级游标编解码 + 类型（`api/client.ts`）+ 纯函数（游标 encode/decode、稳定序、path 数组化）。**不接数据库、不改 UI。** | 🔒 | `univer-meta.ts`（仅路由骨架 + 400/422 闸门）、`query-service.ts`（游标扩展）、`api/client.ts` | **sonnet 实现 / opus 审阅** | 单测覆盖游标往返 + 非法游标抛错（**不得**静默回退 offset 0）；`view-aggregate` 响应体**逐字节**回归断言；**mutation-red**：把 `decodeRecordCursor` 的失败分支改成 `return {id:'',sortValue:''}` → 测试必须红 |
| **B** | **后端切片**：`indexed` / `materialized` / `unavailable` 三分支实现；`GROUP BY` + `LATERAL`/`ROW_NUMBER` 单次取行；行级拒读 + `maskStoredRecordFieldIds` + 逐层 422 闸门复用 | 🔒 依赖 A | `univer-meta.ts`、`aggregation-helpers.ts` | **sonnet 实现 / opus 审阅** | **real-DB golden**（新库单跑）：INV-1 双用户对拍（被拒行不影响 `total`/`count`/`aggregates`，全员被拒的分组**不出现**）；INV-2 查询计数断言；INV-3 并发插入下游标不重不漏；**mutation-red**：注释掉 `:12747-12749` 位置的行级拒读过滤 → golden 必须红；把批量取行改为 per-group 循环 → N+1 断言必须红 |
| **C** | **网格切片 [MUTEX]**：`groupedRows` 改由服务端骨架驱动；`item.count` 读 `node.count`；按 `order` 渲染；`placeholder` 项进偏移表 | 🔒 依赖 B | `MetaGridTable.vue`、`useMultitableGrid.ts`、`MultitableWorkbench.vue` | **sonnet 实现 / opus 审阅** | **mount test**：INV-5——构造"某组全集 200 行 / 页 50 行 / 该列 fn=count"，断言分组头与 Σ 同值；GW 锁 §5 的 GW1–GW10 goldens **全部不回归**；`mode:"unavailable"` → 退回经典翻页器且不白屏；**mutation-red**：把 `node.count` 换回 `groupRows.length` → INV-5 断言必须红 |
| **D** | **分组无限滚动 [MUTEX]**：删除 `MetaGridTable.vue:696-698` / `MultitableWorkbench.vue:1398-1402` 对分组模式的 gate；占位项进视口 → `loadGroupRows(path)` | 🔒 依赖 C | 同 C | **sonnet 实现 / opus 审阅** | **mount test**：滚过 3 个分组边界后行不重不漏、`navIndex` 连续、`startIndex + navIndex + 1`（`:66`）行号仍为筛选集绝对序；折叠/展开在深滚动下 clamp（GW 锁 C4）；**mutation-red**：把 `rowsCursor` 换成 `offset += pageSize` → 并发插入 golden 必须红 |
| **E** | **画廊分组**：`MetaGalleryView.vue` 消费同一骨架（分组段头 + 组内卡片窗口 + 组内续取） | 🔒 依赖 C（非 D） | `MetaGalleryView.vue`、`MultitableWorkbench.vue` 装配 | **sonnet 实现 / opus 审阅** | **mount test**：段头计数 == 服务端 `count`；折叠段不请求组内行；**mutation-red**：段头改读 `section.rows.length` → 断言必须红 |

**每一格都是一次独立的 owner opt-in。** ratify 本锁 ≠ 解锁 A；A 落地 ≠ 解锁 B。
看板消费本契约（`MetaKanbanView.vue:52,62` 的页内计数）**不在**本梯子内，需另立需求门。

---

## §6 验证纪律 + 一句话总结

### 验证纪律

1. **对现行 head 复核，不信历史 MD。** 本锁的每条现状断言在 `c29b5e2c2` 上取过 file:line；
   实现切片开工前必须在**当时的** `origin/main` 上重跑一遍 grep，行号漂移属正常，**结论漂移则本锁作废重审**。
2. **real-DB golden 必须新库单跑。** 分组 golden 涉及全局主键与行级拒读表，fixture id 必须按文件命名空间化，
   `afterAll` 清子表（既有共享库夹具碰撞教训）。
3. **wire 形状变更 = 两侧 shape-lock 扫描。** `view-groups` 的每个字段必须有一条**真实 wire 往返**集成测试；
   任何"字段逐个拷贝 / whitelist / pick"的序列化点都不得只有 fixture 测试。
4. **mutation-red 是验收的一部分，不是加分项。** 上表每个切片都写明了必须变红的那一处改动；
   审阅者要**亲手改、亲眼看红**，再改回。绿测试本身不构成守卫存在的证据。
5. **禁止在同一时刻推进两个 [MUTEX] 切片。**（§5.0）
6. **本锁未经 owner ratify 不得开工任何运行时切片。** 本文件不自我批准。

### 一句话总结

> **分组是筛选集的属性而非当前页的属性；服务端已经算出了每个分组的真实计数并把它送到了客户端内存里
> （`univer-meta.ts:12844` → `MetaGridTable.vue:419`），而客户端在 `:1213` 把它丢掉、转而渲染页内计数
> （`:851` → `:46`）——本锁把"分组键 + 真计数 + 稳定序 + 分组感知游标"升格为一等服务端契约，
> 使分组头与小计行重新共享唯一真值，并以此解锁分组无限滚动与画廊分组。**
