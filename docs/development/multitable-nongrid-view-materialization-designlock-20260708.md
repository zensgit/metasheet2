# Multitable — 非网格视图物化（Non-Grid View Materialization） — DESIGN LOCK

状态：PROPOSED — 待 owner ratify

- 本文件为**纯文档**；未经 owner ratify 不得开工任何运行时切片。本锁不自我批准。
- **✅ 已经独立对抗门禁（MERGE_CLEAN，2026-07-08）**——载重声明全部代码坐实（五视图共绑同一页无分页/工具栏对每视图显示 pre-deny total/层级丢弃已加载行/甘特坐标系是截断的函数/画廊有翻页器故排除/INV-3 pre-deny 且不碰权限码），无 P1/P2。门禁 P3 已并入：INV-4 补「行否决残差第四态」+ §5.1-B/B 行补该态判据与 mount 断言。报告 `/tmp/nongrid-materialization-lock-gate-20260708.md`。
- **基线**：`origin/main` @ `3c7c97111`。下文每条"现状"断言均给出 `file:line`，均在该 commit 上逐条复核过。
- **姊妹锁**：`docs/development/multitable-crosspage-grouping-datamodel-designlock-20260708.md`（PROPOSED）。
  两锁的接缝在 §0 明确划定；凡涉及**分组真值**的问题，一律以姊妹锁为唯一真源，本锁不另立词汇。
- **变更面（ratify 后按梯子分切片）**：`apps/web/src/multitable/components/Meta{Kanban,Calendar,Gantt,Timeline,Hierarchy}View.vue`、
  `apps/web/src/multitable/views/MultitableWorkbench.vue`（**共享装配热文件**，见 §5.0）、
  一个**新建**的 `apps/web/src/multitable/composables/useNonGridMaterialization.ts`（刻意不进 `useMultitableGrid.ts`，见 §5.0）、
  以及后端 `packages/core-backend/src/routes/univer-meta.ts`（**跨锁后端热文件**，见 §5.0-C）的**新增**只读端点、
  `packages/core-backend/src/multitable/aggregation-helpers.ts` 与 `apps/web/src/multitable/api/client.ts`（同为跨锁共享，§5.0-C）。

---

## §0 与姊妹锁的接缝（先划边界，再谈问题）

姊妹锁（下称"分组锁"）解决的是：**一个分组的存在性、真计数、稳定序、组内游标**——
即"窗口里装的是哪一份分组真值"。它的产出是 `GET /api/multitable/sheets/:sheetId/view-groups`
契约（`mode: "indexed" | "materialized" | "unavailable"`、两级游标 `nextGroupCursor` / `rowsCursor`、
`count` / `order` / `path`），以及网格分组无限滚动（切片 C/D）与**画廊分组**（切片 E）。

本锁解决的是一个**正交**的问题：**非网格视图究竟拿到了整个筛选集，还是只拿到了第一页 50 行。**

| 问题 | 归属 | 备注 |
|---|---|---|
| 分组头 `(N)` 是页内计数还是全集真计数 | **分组锁** | 本锁不重复论证 |
| 分组稳定序、分组感知游标、`mode` 三分叉 | **分组锁** | 本锁**复用**其 `mode` 判别式，不新造 |
| 画廊**分组**（段头 + 组内窗口） | **分组锁** 切片 E | 见下条 |
| 画廊**物化** | **不属于任何一锁——因为它没有缺陷** | 画廊已有翻页器（§2.6），截断是**已披露且可导航**的 |
| 看板列内分页 / 列计数 | **本锁的看板切片，但其数据契约 = 分组锁的 `view-groups`** | 分组锁 §5.1 末行显式把"看板消费本契约"排除在其梯子外并要求"另立需求门"。**本锁即是那道需求门**，但它只做需求与装配，不重新定义分组契约 |
| 甘特/时间轴的**时间轴端点（extent）** | **本锁** | 分页游标在定义上给不出全集 min/max |
| 日历的**可见区间取数** | **本锁** | 是区间窗口查询，不是分页 |
| 层级的**祖先闭包** | **本锁** | 既不是分页也不是端点 |

**共享原语一律下沉到分组锁：** 若本锁的任一切片需要"某个分组在整个筛选集中的真计数"或"组内续取游标"，
它**必须**消费分组锁定义的 `view-groups.count` / `rowsCursor`，**不得**在本锁内另造 `columnTotal`、
`laneCursor` 之类的竞争词汇。若本锁的新端点需要区分"能否 SQL 化"，它**必须**沿用分组锁 §3.0 的
`mode: "indexed" | "materialized" | "unavailable"` 判别式与 `413 AGGREGATE_TOO_LARGE` 语义，
**不得**新造模式名。

---

## §1 原则 — 视图渲染的输入必须是筛选集，而不是"恰好加载了的那一页"

MetaSheet 的既有口径已经把"真值"和"页面切片"分开了：页脚聚合只来自服务端全集，从不由本地行计算。
分组锁把这条口径推广到了分组骨架。本锁把它推广到**视图几何**：

> **一个视图的坐标系、桶计数、树结构、以及"某条记录是否出现"，都是筛选集的属性，不是当前页的属性。**
> 网格是唯一一个"少画几行"就等于"少显示几行"的视图——因为网格的第 N 行不依赖第 N+1 行。
> 看板、日历、甘特、时间轴、层级**都不是**这样：它们的每一个渲染单元都由**整集**决定。
> 用一页 50 行去驱动它们，产出的不是"一个不完整的视图"，而是**一个自洽但错误的视图**——
> 它不会报错，不会留白，它会理直气壮地画出一张与数据不符的图。

这就是本锁与"网格分页"在性质上的区别，也是本锁必须独立于任何"再加个翻页器"式修补的原因。

---

## §2 现状枚举（逐条 file:line，已在 `3c7c97111` 复核）

### 2.0 唯一数据源：一次实例化、一页 50 行、只有网格能续取

- `MultitableWorkbench.vue:780` — `const grid = useMultitableGrid({ sheetId, viewId, isPersonalMode })`：
  **整个工作台只有这一个数据源**，未传 `pageSize`。
- `useMultitableGrid.ts:474` — `const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE`；
  `:305` — `const DEFAULT_PAGE_SIZE = 50`。
- `useMultitableGrid.ts:622-625` — `loadViewData` 以 `client.loadView({ …, limit: pageSize, offset })` 取数。
- 六个视图**全部**绑定同一个 `grid.rows.value`：
  `MultitableWorkbench.vue:177`（看板）、`:191`（画廊）、`:205`（日历）、`:222`（时间轴）、`:237`（甘特）、`:248`（层级）。
- 续取能力**存在**但只接到网格上：
  - `useMultitableGrid.ts:672` — `canLoadMore = page.hasMore && !accumulationCapped`；`:693` — `async function loadMore()`。
  - `MultitableWorkbench.vue:1398` — `gridIsFlatPath = grid.groupFields.value.length === 0`；
    `:1402` — `gridCanLoadMore = gridIsFlatPath && grid.canLoadMore`；
    `:276` — 这两个 prop **只**喂给 `MetaGridTable`；`:292` — `@load-more="grid.loadMore"` **只**接在 `MetaGridTable` 上。
  - 全仓 `grep -c "load-more\|canLoadMore\|infiniteScrollEnabled\|totalPages\|go-to-page"` 对五个非网格视图组件
    （`MetaKanbanView` / `MetaCalendarView` / `MetaGanttView` / `MetaTimelineView` / `MetaHierarchyView`）
    的结果均为 **0**。

→ **五个非网格视图，永远只持有第 1 页的 50 行，没有任何续取通路。**

### 2.1 这 50 行是怎么来的：服务端 `LIMIT`（有时）+ 服务端内存切片（有时）

`GET /api/multitable/view` 的处理体是 `univer-meta.ts:12983`–`:13492`（`:13493` 空行，下一个 `router.*` 注册在 `:13494`）。

- `:12991` — `const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam!, 1), 5000) : undefined`
  → 服务端 clamp 上限 **5000**；**未传 `limit` 时 `limit === undefined`**，此时既不 `LIMIT` 也不返回 `page`。
  **50 是纯客户端选择**，服务端没有 50 这个数。
- 取数走**两条**路径：
  - **无筛选/排序/搜索**（`:13269` 的 `else` 分支）→ `:13271-13277` 真 SQL 分页：
    `SELECT … COUNT(*) OVER()::int AS total FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC LIMIT $2 OFFSET $3`。
  - **有筛选/排序/搜索**（`:13152` `hasInMemoryProcessing`）→ `:13154` **无 LIMIT 全表取行**
    （`SELECT id, version, data, created_at, … FROM meta_records WHERE sheet_id = $1 ORDER BY created_at ASC, id ASC`），
    内存筛选/排序后 `:13265` `const total = sorted.length`、`:13266` `const paged = limit ? sorted.slice(offset, offset + limit) : sorted`。
    → **服务端此时已经把整个筛选集握在手里，然后切掉了 98%。**

这条事实是本锁在成本上的关键杠杆（§3.0）：对筛选/排序路径而言，"全集真值"几乎是**免费**的。

### 2.2 "静默"必须收窄：**总数就在屏幕上，且与视图内容自相矛盾**

- `MultitableWorkbench.vue:127` — `<MetaToolbar …>` 是根 `div.mt-workbench`（`:2`）的直接子节点，
  与承载 `v-if` 视图链的 `div.mt-workbench__content`（`:146`，链自 `:148` 起）**平级**，其上**无任何条件包裹**。
  `MetaToolbar.vue` 的根节点 `<div class="meta-toolbar">`（`:2`）亦无 `v-if`，且该组件对视图类型**零引用**
  （全文件 `grep -c "viewType\|activeViewType"` = 0）。→ **工具栏对所有视图类型无条件渲染。**
- `:139` — `:total-rows="grid.page.value.total"`。
- `MetaToolbar.vue:185` — `<span v-if="totalRows !== undefined" class="meta-toolbar__row-count">{{ rowCount(totalRows, isZh) }}</span>`
  （`meta-core-labels.ts:289-292`：`${n} 行` / `${n} row(s)`）。

→ 一个 1234 行的表，打开看板：**工具栏写着"1234 行"，看板泳道计数之和恒为 50**。
用户看到的不是"少了点东西"，而是**同屏两个互相否证的数字**，且没有任何控件能弥合它们。

**因此审计口径"silent，无任何提示"应改为：**
**总数被披露，截断本身从未被披露，且不存在续取通路。** 这不比纯静默轻——它更重：
纯静默至少不主动断言一个用户无法达成的数字。（画廊是唯一的反例，见 §2.6。）

### 2.3 逐视图后果（**五者互不相同，必须分别定性**）

#### 2.3.1 层级 — **结构性损坏：已加载的行被丢弃，并伪造诊断信息**（本锁最强的单点证据）

`MetaHierarchyView.vue:189-191` — `treeResult = buildHierarchyTree(props.rows, parentFieldId, orphanMode)`。

- `:363` — `const byId = new Map(rows.map((row) => [row.id, row]))`
  → **父节点的解析宇宙 = 已加载的 50 行**。
- `:370` — `parentById.set(row.id, parentId && byId.has(parentId) ? parentId : null)`
  → 父在第 2 页 ⇒ 该行被判定为**无父**。
- `:371` — `if (parentId && !byId.has(parentId)) orphanCount += 1`
  → **孤儿计数是分页制造出来的**，与数据无关。
- `:383-391` 的挂载循环：`:386` `if (parentId && !cyclicIds.has(row.id))` 挂到父下；
  `:388` `} else if (orphanMode === 'root' || !firstParentId(...) || cyclicIds.has(row.id)) { roots.push(node) }`。
  → 当 `orphanMode === 'hidden'` 时，一个"父在第 2 页"的行：`parentId` 已被 `:370` 置 `null`（`:386` 挂不上父），
  三个 else-if 条件亦全假（不是 `'root'` 模式 / 原始 `data` 里**确有**父 id 故 `firstParentId` 返回真值、`:343` / 不成环）
  ⇒ **既不入 `roots` 也不入任何 `children`——这一行虽然已经加载，却完全不出现在渲染里。**
- `:402-403` — `diagnostics.push(\`${orphanCount} orphan record(s) shown at root. / hidden.\`)`
  → 界面上**明文告诉用户**"有 N 条孤儿记录"，而这 N 条在真实数据里根本不是孤儿。

**定性：** 层级视图不是"少画了几个节点"。它输出了一棵**拓扑错误**的树，
在 `orphanMode: 'hidden'` 下**静默丢弃已在内存中的行**，并把分页假象作为**诊断结论**呈现给用户。

#### 2.3.2 甘特 / 时间轴 — **坐标系是截断的函数**

- 甘特 `MetaGanttView.vue:272-285` — `timeRange = computed(...)`，`:275` `for (const row of props.rows)`
  求 min/max，`:281` 空集回退 `now … now+30d`，`:284` 返回 `{ min - pad, max + pad }`。
- 该 `timeRange` 是**唯一**的坐标系来源：
  - `:418` `barStyle` 取 `const { min, max } = timeRange.value`；`:421` `left = ((startMs - min) / range) * 100`。
  - `:431` `axisTicks` 取同一 `min/max`；`:435` `for (let ts = min; ts <= max; ts += step)` 生成刻度。
- 时间轴 `MetaTimelineView.vue:433-445` — 同构（`:436` 遍历 `props.rows`，`:444` `{ min - pad, max + pad }`），
  喂给 `:447-449` `scheduledRows` 的条形几何与 `:475-477` `axisTicks`。

**定性（不要过度声张）：** 对**已加载的那 50 行**，条形之间的相对位置是**自洽的**——
不能说"条形被画在错误的位置"。真正的缺陷是：**这张图的坐标系不是数据的属性，而是分页的属性**。
第 51 行一旦进入，整条时间轴的 min/max、全部刻度、以及**每一根条形的 left/width 百分比**都会重算。
两个用户在不同筛选下看同一批任务，会得到**不可比**的两张图；用户也无从知道图的两端不是数据的两端。

附带的、无歧义的错值：
- 甘特依赖箭头 `:344-365` — `dependencyLinksByRecordId` 的 `:345` `const byId = scheduledTaskById.value`
  （`:342`，其 `Map` 只由 `scheduledTasks` → `props.rows` 构成，**仅含已加载行**）里查 `dependencyId`，
  `:351` `if (!dependency || …) return null`，随后被 `.filter(...)` 剔除，`:365` 只对幸存者建边。
  → **依赖目标落在第 2 页 ⇒ 箭头静默消失**。图上看不到"这里本该有一条依赖"。

#### 2.3.3 看板 — **桶计数被当作真值渲染**

- `MetaKanbanView.vue:262` `bucketColumns(rows)`：`:270` / `:277` 用 `rows.filter(...)` 对**入参行**分桶。
- `:287` — 1D 泳道 `count: props.rows.length`；`:293` — 2D 泳道 `count: laneRows.length`。
- 模板 `:52` — `<span class="meta-kanban__count">{{ lane.count }}</span>`；
  `:62` — `<span class="meta-kanban__count">{{ col.rows.length }}</span>`。

**定性：** 列头的 `(N)` 是**页内计数**，被无条件渲染成该列的规模。
（分组锁 §2.6 已引用完全相同的 `:52` / `:62`，并明确把"看板消费 `view-groups` 契约"排除在其梯子外、要求另立需求门。）

#### 2.3.4 日历 — **月份静默漏事件，且"+N 更多"角标也是错的**

- `MetaCalendarView.vue:516-519` — `eventsByDate = computed(...)`，`for (const row of props.rows)` 按日期字段分桶。
  → **只有前 50 行的事件会出现在日历上**；一个月里其余事件不存在，无任何提示。
- `:579` `const all = eventsByDate.value[dateStr] ?? []`；`:586` `events: all.slice(0, MAX_EVENTS_PER_CELL)`；
  `:587` `overflow: Math.max(0, all.length - MAX_EVENTS_PER_CELL)`（`:393` `MAX_EVENTS_PER_CELL = 3`）。
  → 单元格里那个 **"+N 更多"** 角标（模板 `:140` / `:248`）本身就是"披露截断"的机制，
  但它披露的是**页内**的溢出量，不是真实溢出量。**唯一的截断提示，报的是错数。**
- 日历**确实**知道自己的可见区间：`:619` `visibleRange`、`:627-628` `watch(visibleRangeKey, () => emit('visible-range-change', …))`。
  但工作台对该事件的**唯一**消费是 `MultitableWorkbench.vue:4093-4095` — `onCalendarVisibleRangeChange(range) { void loadCalendarHolidays(range) }`
  → **只用来拉节假日角标，从不据此重新取行**。区间信号已经在线上，只是没接到取数上。

#### 2.3.5 五视图小结

| 视图 | 渲染集 | 是否有续取 | 是否披露截断 | 由截断集算出的**错误真值** | 严重度 |
|---|---|---|---|---|---|
| 层级 | 前 50 行 | 否 | 否 | 树拓扑错误；`orphanMode:'hidden'` 下**丢弃已加载行**（`:388`）；孤儿诊断为伪（`:402-403`） | **结构性损坏** |
| 甘特 | 前 50 行 | 否 | 否 | 时间轴 min/max 与全部条形几何随分页重算（`:272-285` → `:418/:431`）；依赖箭头静默消失（`:351`） | **坐标系 + 丢边** |
| 时间轴 | 前 50 行 | 否 | 否 | 同上（`:433-445` → `:449/:477`） | **坐标系** |
| 看板 | 前 50 行 | 否 | 否 | 泳道/列计数 = 页内计数（`:52` / `:62`） | **错值计数** |
| 日历 | 前 50 行 | 否 | 仅"+N 更多"，且该 N 亦错（`:587`） | 月内事件静默缺失；溢出角标错数 | **错值 + 漏事件** |

### 2.6 画廊：**不在本锁的缺陷清单内**（审计前提在此处**不成立**）

- `MultitableWorkbench.vue:195` — `:current-page="grid.currentPage.value" :total-pages="grid.totalPages.value"`；
  `:198` — `@go-to-page="grid.goToPage"`。
- `MetaGalleryView.vue:119` — `<div v-if="totalPages > 1" class="meta-gallery__pagination">`；
  `:121` — `<span class="meta-gallery__page-info">{{ currentPage }} / {{ totalPages }}</span>`。

→ 画廊的截断是**已披露、可导航**的：用户看得见 `1 / 25`，也点得到下一页。
画廊平铺卡片（`:52` `v-for="(row, idx) in rows"`），**不计算任何跨行真值**——没有计数、没有端点、没有树。
**因此画廊没有本锁所论的缺陷。** 画廊唯一缺的是**分组**，那属于分组锁切片 E。
本锁**不得**把画廊列为受害者，也不得改动 `MetaGalleryView.vue`。

### 2.7 审计前提裁定

| 审计断言 | 裁定 |
|---|---|
| "看板/日历/甘特/时间轴/层级只渲染第一页" | ✅ **成立**（§2.0，五视图共享同一 `grid.rows`，无一有续取通路） |
| "约 50 行" | ✅ **成立且需精确**：50 = 客户端 `DEFAULT_PAGE_SIZE`（`useMultitableGrid.ts:305`）；服务端无此默认（`univer-meta.ts:12991`，缺省 `undefined` ⇒ 不分页），clamp 上限 5000 |
| "没有任何提示" | ⚠️ **需收窄，但更重**：总行数在工具栏对所有视图可见（`MultitableWorkbench.vue:127/:139` → `MetaToolbar.vue:185`），
造成**同屏矛盾**；截断本身与续取通路仍完全不存在。日历的 `+N 更多`（`MetaCalendarView.vue:587`）是唯一的"截断提示"，且**报错数** |
| "没有办法加载更多" | ✅ **成立**（`loadMore` 仅接在网格上：`MultitableWorkbench.vue:292`） |
| （审计未提）"五视图行为一致" | ❌ **不成立**：五者的错误**性质各不相同**（§2.3.5），修法互不兼容（§3.1） |
| （审计未提）画廊 | ❌ **画廊不受影响**（§2.6）：截断已披露且可导航 |
| （审计未提）**严重度升级** | ✅ **成立**：四个视图从截断集算出**被当作真值渲染的错误量**；层级更进一步——它**丢弃已加载的行**并伪造诊断（§2.3.1） |

**结论：前提成立，且比审计所述更严重；同时在"静默"与"画廊"两处必须被修正。**

---

## §3 目标形状 — 契约

### 3.0 一条必须被点名、不能被"统一契约"抹平的四路分叉

审计隐含地假设"给五个视图都加个 load-more 就完了"。**这是错的。** 五个视图要的数据形状互不相同：

| 视图 | 它真正需要的东西 | 为什么分页游标给不了 |
|---|---|---|
| **看板** | 每列（=一个分组）的**真计数** + **组内**续取游标 | 这正是分组锁的 `view-groups`：`count` + `rowsCursor`（两级游标）。看板列 = 一级分组，泳道×列 = 二级嵌套分组（≤ `MAX_GROUP_LEVELS` = 3） |
| **甘特 / 时间轴** | 两个日期列在**整个筛选集**上的 `min` / `max` | 端点是**全集归约**，不是行的前缀。任何"再加载一页"都只能让端点单调外扩，永远不知道自己到没到 |
| **日历** | 日期列 ∈ 可见区间 的**全部**行 | 这是**区间窗口查询**，与 `created_at` 序的偏移分页正交。第 50 行之后可能全是本月事件 |
| **层级** | 已加载节点的**祖先闭包**（或服务端整树骨架） | 子节点的正确位置由**祖先**决定，而祖先在 `created_at` 序里可能任意靠后。没有闭包就没有正确的树 |

**这四者不可能塞进同一个契约。** 强行统一（例如"所有视图都用分组游标"）会把甘特的端点问题
伪装成一个分组问题，把日历的区间问题伪装成一个分页问题。**本锁拒绝这样做。**

**分叉的裁定权交给闸门后的切片**，本锁只锁定三条：

1. **看板不新造契约。** 看板切片**必须**消费分组锁的 `view-groups`（`count` / `order` / `rowsCursor` / `mode`）。
   若分组锁未 ratify 或其切片 A+B+C 未落地，看板切片**不解锁**。
2. **新端点必须复用分组锁的 `mode` 判别式。** 甘特/时间轴的端点契约与日历的区间契约，
   其"可否 SQL 化"的分叉与降级语义**一律沿用** `mode: "indexed" | "materialized" | "unavailable"`
   及 `413 AGGREGATE_TOO_LARGE` 语义（`univer-meta.ts:12675-12679`），**不得新造模式名**。
   - `materialized` 分支在本仓几乎免费：筛选/排序路径**已经**在服务端全量取行（`:13154`）后才切片（`:13266`）。
   - `indexed` 分支对端点而言是一条 `SELECT MIN(...), MAX(...)`；对日历而言是一条带日期谓词的 `WHERE`。
3. **降级必须在 wire 上自陈。** 与分组锁同理：`mode: "unavailable"` 时客户端**原样退回**今天的渲染
   （不白屏、不把端点显示为 `now … now+30d`、不把计数显示为 0），并**必须**显示 §3.2 的截断披露。

### 3.1 层级：唯一一个"必须先止血"的视图

`orphanMode: 'hidden'` 下**丢弃已加载的行**（`MetaHierarchyView.vue:388`）是一个**纯客户端**的判定错误：
即使不改任何取数，也不该发生"这一行我手里有、但我不画它"。

因此层级切片被拆成两级：

- **止血（不改取数）**：一个父 id 指向**未加载**记录的行，**不得**被 `orphanMode: 'hidden'` 吞掉，
  也**不得**被计入 `orphanCount`。"父不在已加载集合内"与"父不存在"是两种状态，必须区分。
  未确知的行以**显式的未决态**呈现（例如挂在根下并标注"祖先未加载"），而不是伪装成孤儿。
  → 这一切片**不需要**任何后端改动，是本梯子里唯一可以先落地的止血。
- **根治（祖先闭包）**：由服务端返回已加载行的祖先闭包（或整棵骨架）。契约形状由该切片在其闸门内裁定；
  唯一硬约束是 §4 的权限对等——**祖先若被行级拒读，闭包中不得出现该祖先，其子孙的父指针必须表现为"父不存在"，
  与"这些行不存在"的世界完全一致。**

### 3.2 截断披露：**在任何取数改动之前，先让谎言停止**

本锁定义一个**最小、可独立落地、零后端改动**的披露口径：

> 当一个非网格视图渲染的行数 `< grid.page.value.total` 时，该视图**必须**在其自身表面
> （不是工具栏）显示一个截断提示，并提供**一个**动作：继续加载 / 或明确告知需要收窄筛选。
> 视图内一切由行集算出的计数（看板 `lane.count` / `col.rows.length`、日历 `overflow`、
> 层级 `orphanCount`）在截断态下**不得**被渲染成无标注的裸数字。

**这条口径不引入任何新的服务端总数。** 它复用**已经在渲染的** `grid.page.value.total`
（`MultitableWorkbench.vue:139` → `MetaToolbar.vue:185`），因此**不扩大任何出口面**（§4 INV-2）。

### 3.3 复用既有取数原语，不新造客户端分页器

- 续取一律走 `useMultitableGrid.ts:693` 的 `loadMore()` 与 `:672` 的 `canLoadMore`（含 `:314`
  `MAX_ACCUMULATED_ROWS = 5000` 的累积上限与其 `console.warn` 自陈）。
- 服务端 clamp 上限已是 5000（`univer-meta.ts:12991`），与客户端累积上限对齐；本锁**不得**上调任一侧。
- 达到 5000 上限即 `accumulationCapped`（`useMultitableGrid.ts:672` 令 `canLoadMore` 转假）——
  此时 §3.2 的披露**必须**从"继续加载"切换为"请收窄筛选"。**上限不得被静默吞掉。**

---

## §4 硬约束 / 不变式

- **INV-1 权限对等（不新造闸门）。** 一切新增/加宽的读路径**必须**逐层复用 `/view` 既有闸门，**不得**另起炉灶：
  - 字段掩码唯一 chokepoint：`maskStoredRecordFieldIds`（`univer-meta.ts:13044`），
    其结果经 `filterRecordDataByFieldIds(row.data, allowedFieldIds)`（`:13345`）落到行数据上。
  - 行级拒读：`univer-meta.ts:13354-13373`（`hasRecordPermissionAssignments` `:13355` →
    `loadRowLevelReadDenyEnabled` `:13366` → `rows.filter(deriveRecordPermissions(...).canRead)` `:13367-13370`）。
  - **不触碰中心 `rbac` / `auth`**（既有 K3 锁）；本线只在 multitable 路由内消费既有闸门。
- **INV-2 加载更多行 = 出口面扩大，必须逐条论证。** 今天非网格视图只见 50 行**不是**一道安全边界
  （网格对同一视图已可滚到 5000 行，走同一个 `/view` + 同一套闸门），因此"续取"本身不新增出口。
  但下列三处**确实**是新出口面，各自需要 golden：
  1. **日历区间查询**引入一个**新的服务端谓词**（日期列 ∈ 区间）。该谓词**必须**在字段掩码之后求值：
     一个被 `field_permissions` 拒读或被 §2a.3 taint 掩码的日期字段，**不得**作为区间谓词字段
     （否则可通过"改区间、看命中数"逐位探测被掩码列的值）。口径与 `/view` 的
     `searchableFields = visiblePropertyFields.filter((f) => allowedFieldIds.has(f.id) && …)` 一致。
  2. **甘特/时间轴端点**（`min`/`max`）是**列分布的两个端点**，本身即是信息泄露面。
     必须继承 `view-aggregate` 既有的**数值型泄露闸**纪律：`computeScaleStats`（`univer-meta.ts:12780`）
     在 `:12785` 以 `if (!fieldType || !isNumericFieldType(fieldType)) continue`
     显式排除"hidden / denied / tainted / 非数值"字段。
     **注意：`isNumericFieldType`（`aggregation-helpers.ts:17`）与 `fnApplies`（`:53`）今天把 `min`/`max`
     限制在数值类型上，因此日期列的端点在仓内【尚不存在】。** 端点切片是一项**新能力**，
     必须原样复刻该泄露闸：被隐藏 / 被拒读 / 被 taint 的日期字段 **不返回任何端点**（不是返回 `null`，是不出现该键），
     且端点必须在**行级拒读之后**计算。
  3. **层级祖先闭包**会把"某个我读不到的祖先存在"这一事实变成可观测量。见 §3.1 的硬约束。
- **INV-3 不显示未经拒读过滤的总数。** 本锁记录一条**继承而来的**现状约束（**不在本锁修复范围内**）：
  `/view` 的 `page.total` 在**行级拒读之前**算出——
  无筛选路径取 `COUNT(*) OVER()`（`univer-meta.ts:13272`），筛选路径取 `sorted.length`（`:13265`），
  而拒读过滤在 `:13354-13373` 才执行。该 `total` 今天已经通过 `MetaToolbar.vue:185` 显示。
  （行级拒读为**每表 opt-in、默认关**，故在未开启的表上二者一致。）
  - **本锁禁止任何切片"顺手修一下"这个总数**——它落在中心权限面的红线内，由 owner 处置。
  - **本锁禁止任何切片在视图内新增一个 "N of M" 形式的 M**，除非该 M 来自**拒读之后**的计数
    （分组锁 §3.1 的 `view-groups.total` 已按此规定）。§3.2 的披露口径因此**只**做"是否被截断"的
    布尔判断与"继续加载"的动作，**不**新渲染 M。
- **INV-4 唯一真值。** 切片完成后，"工具栏写 1234 行 / 看板泳道计数之和为 50"（§2.2）在任何页大小、
  任何筛选下都不可复现——要么两者一致，要么视图显式声明自己被截断。
  - **⚠ 例外·行否决残差态（门禁 P3，必须在切片 B 补齐）**：当某表**启用行级拒读**时，`grid.page.value.total` 是**拒读前**总数（INV-3 已锁明，本锁禁止碰它）。于是用户即便加载完**全部可读行**，`rows.length < total` 仍恒为真、而 `canLoadMore` 已转假、`accumulationCapped` 仍为假——这是 §5.1-B 三态模型**未枚举**的第四态 `(rows<total, !canLoadMore, !capped)`。此态下**禁止**显示"继续加载"（已无可载）或"收窄筛选"（差额是权限、非筛选，收窄无用）。切片 B 必须把它渲染为**中性终态**（如"已加载全部可见记录"，仍不渲染任何 M），并把该态纳入 §5.1-B 的判据与 mount 断言。此为 INV-3「拒读前总数不可碰」的直接下游，故 default-off 且与今日网格行为一致（无回归），列为 P3 而非 ratify 阻塞。
- **INV-5 不发明分组词汇。** 看板列的真计数与组内续取一律取自分组锁的 `view-groups`（§0）。
  本锁的任何文件里都不得出现自造的 `columnTotal` / `laneCursor` / `bucketCount` 之类字段名。
- **INV-6 甘特/时间轴的端点稳定性。** 端点切片完成后，**同一筛选集下的时间轴 min/max 必须与 `pageSize` 无关**。
  这是该切片唯一的验收断言形式（§5.1 F/G 行）。
- **INV-7 层级不得丢弃已加载的行。** 任何 `props.rows` 中的行，在任何 `orphanMode` 下都必须出现在渲染里
  （作为节点、或作为显式未决态），**不得**因为"父不在已加载集合内"而消失。

---

## §5 门禁 TODO-checklist（按序；🔒=未解锁 ⬜=已解锁待做 ✅=完成）

### §5.0 调度约束

**A. 网格互斥（grid mutex）— 由分组锁 §5.0 定义，本锁遵守并规避。**
`MetaGridTable.vue`（1516 行）与 `useMultitableGrid.ts`（1418 行）是单占用热文件，
分组锁切片 **C / D** 独占它们。

→ **本锁的所有切片一律不得修改这两个文件。** 续取只通过**调用** `useMultitableGrid.ts:693` 的
`loadMore()` 公共出口达成；任何新的取数（端点、区间、闭包）落在**新建**的
`apps/web/src/multitable/composables/useNonGridMaterialization.ts` 中。
这是一个**刻意的接缝选择**：它让本锁的梯子与分组锁的 C/D 可以并行推进。

**B. 装配互斥（workbench mutex，标记 `[MUTEX:WB]`）— 本锁与分组锁共有。**
`apps/web/src/multitable/views/MultitableWorkbench.vue`（4419 行）是**单占用共享装配热文件**。

| 触及它的切片 | 归属 |
|---|---|
| 分组锁 **C**（网格骨架装配）、**D**（分组无限滚动）、**E**（画廊分组装配） | 分组锁 |
| 本锁 **B / C / E / F / G** | 本锁 |

→ **带 `[MUTEX:WB]` 的切片不得与分组锁的 C / D / E 并行开工，也不得彼此并行。**
开工前确认无其他在飞的 `MultitableWorkbench.vue` PR；落地后再放行下一个。
本锁切片 **A**（层级止血）与 **D**（后端端点契约）**不触碰** `MultitableWorkbench.vue`。

**C. 后端互斥（backend mutex，标记 `[MUTEX:BE]`）— 本锁与分组锁共有，且此前未被两锁任一方点名。**
`packages/core-backend/src/routes/univer-meta.ts` 是全仓最热的路由文件（`/view` 处理体一条就占 `:12983-13492`）。
它与另外两个文件被两锁的后端切片**同时**触及：

| 文件 | 分组锁 | 本锁 |
|---|---|---|
| `packages/core-backend/src/routes/univer-meta.ts` | 切片 **A**（`view-groups` 路由骨架 + 400/422 闸门）、**B**（三分支实现） | 切片 **D**（`view-extents` 新路由）、**G**（日历区间谓词） |
| `apps/web/src/multitable/api/client.ts` | 切片 **A**（`view-groups` wire 类型） | 切片 **D**（`view-extents` wire 类型） |
| `packages/core-backend/src/multitable/aggregation-helpers.ts` | 切片 **B**（分桶复用） | 切片 **D**（日期 `min`/`max`，须扩 `fnApplies` `:53` / `isNumericFieldType` `:17` 的适用面） |

这三处都是**追加式**编辑（新路由 / 新导出类型 / 新分支），冲突面远小于组件重写，因此**不设独占闸**，
但**必须 baseline-first**：

→ **同一时刻 `univer-meta.ts` 上不得有两个在飞的路由 PR**（本锁 D/G 与分组锁 A/B 之间，任选其一先落）。
→ 后落的一方**开工前**必须 rebase 到先落方的 head，并在其 head 上**重跑 §6 纪律 1 的 file:line 复核**——
`univer-meta.ts` 的行号必然漂移，本锁全部 `:12xxx` / `:13xxx` 引用需重新取址。
→ `aggregation-helpers.ts` 的 `fnApplies` / `isNumericFieldType` 是**共享判定函数**：
本锁切片 D 扩展其日期适用面时，**必须**回归分组锁与 `view-aggregate` 的既有数值口径
（`univer-meta.ts:12785` 的泄露闸依赖 `isNumericFieldType` 的现有语义），不得放宽为"任意可比类型"。

### §5.1 梯子

每一格都是一次**独立的 owner opt-in**。ratify 本锁 ≠ 解锁 A；A 落地 ≠ 解锁 B。

| # | 切片 | 状态 | unblockedBy | 变更面 | 模型档位 | 验收要求（含**必须变红的 mutation**） |
|---|---|---|---|---|---|---|
| — | **本设计锁** | ⬜ 待 owner ratify | — | 仅文档 | opus 起草 | — |
| **A** | **层级止血**：区分"父不存在"与"父未加载"；后者不得计入 `orphanCount`（`:371`）、不得被 `orphanMode:'hidden'` 吞掉（`:388`）；诊断文案（`:402-403`）不得把未加载祖先报成孤儿。**零后端改动、不碰 Workbench** | 🔒 | 本锁 ratify | `MetaHierarchyView.vue` | **sonnet 实现 / opus 审阅** | **mount test**（扩 `apps/web/tests/multitable-hierarchy-view.spec.ts`）：构造 3 行、其中 1 行父 id 指向**不在 `rows` 里**的记录 ⇒ ①`orphanMode:'hidden'` 下该行**仍被渲染**（INV-7）；②`orphanCount` 诊断**不出现**。**mutation-red**：把 `:370` 的 `byId.has(parentId) ? parentId : null` 改回无条件 `null` 并恢复 `:371` 的计数 ⇒ 上述两条断言必须**同时变红** |
| **B** | **截断披露 [MUTEX:WB]**：五视图各自表面显示"已截断 / 继续加载 / 已达 5000 上限请收窄筛选"三态**+ 行否决残差第四态**（INV-4 例外：`rows<total && !canLoadMore && !capped` ⇒ 中性终态"已加载全部可见记录"，不渲染 M、不提示收窄）；由 `grid.page.value.total`、`grid.rows.length`、`grid.canLoadMore`（`useMultitableGrid.ts:672`）、`accumulationCapped` 推导。**不新渲染任何 M**（INV-3） | 🔒 依赖 A | 五个 `Meta*View.vue` + `MultitableWorkbench.vue` 装配 | **sonnet 实现 / opus 审阅** | **mount test**（五个既有 spec 各加一条）：`rows.length=50, total=1234` ⇒ 五视图**各自**渲染截断提示；`canLoadMore=false && accumulationCapped=true` ⇒ 提示文案切换为"收窄筛选"；**`rows.length=50, total=1234, canLoadMore=false, accumulationCapped=false`（行否决残差）⇒ 渲染中性终态、既不显"继续加载"也不显"收窄筛选"**；grep 断言**渲染出的文本里不含 `1234`**（INV-3）。**mutation-red**：把三态判据改成 `rows.length < total ? '继续加载' : ''`（吞掉 capped 态与残差态）⇒ 第二、三条断言必须红；把提示改为渲染 `${rows.length} / ${total}` ⇒ 不含-`1234` 断言必须红 |
| **C** | **续取接线 [MUTEX:WB]**：把 `loadMore` / `canLoadMore` 接到 B 的"继续加载"上（日历、时间轴、甘特、层级；**看板除外**，见 E）。**只调用 `useMultitableGrid` 的公共出口，不修改该文件** | 🔒 依赖 B | 四个 `Meta*View.vue` + `MultitableWorkbench.vue` | **sonnet 实现 / opus 审阅** | **mount test**：点击"继续加载"⇒ 恰好触发一次 `loadMore`；`loadingMore` 期间重复点击**不**重复触发；`git diff --stat` 断言 `useMultitableGrid.ts` 与 `MetaGridTable.vue` **零改动**（§5.0-A）。**mutation-red**：去掉重复点击去抖 ⇒ "单次触发"断言必须红 |
| **D** | **端点契约（后端，纯契约）[MUTEX:BE]**：`GET /api/multitable/sheets/:sheetId/view-extents?fieldIds=…`；沿用分组锁 `mode` 三分叉与 `413 AGGREGATE_TOO_LARGE` 语义；日期列 `min`/`max`；泄露闸复刻 `univer-meta.ts:12785`。**不改 UI、不碰 Workbench** | 🔒 依赖 本锁 ratify **且** 分组锁切片 A 落地（`mode` 判别式已存在） | `univer-meta.ts`（新端点）、`aggregation-helpers.ts`（日期 min/max）、`api/client.ts`（wire 类型） | **sonnet 实现 / opus 审阅** | **real-DB golden（新库单跑，fixture id 按文件命名空间化，`afterAll` 清子表）**：①被 `field_permissions` 拒读的日期列 ⇒ 响应中**不出现该键**（不是 `null`）；②行级拒读开启时，端点在**拒读后**计算（双用户对拍：A 被拒读掉持有 max 的那一行 ⇒ A 看到的 `max` 必须是次大值）；③`mode:"unavailable"` 复用 413。**真 wire 往返**集成测试覆盖每个字段（禁止只有 fixture 测试）。**mutation-red**：注释掉泄露闸（`:12785` 的 `continue`）⇒ 断言①必须红；把端点计算移到行级拒读**之前** ⇒ 断言②必须红 |
| **E** | **看板消费分组契约 [MUTEX:WB]**：列头计数取 `view-groups.count`；列内续取取 `rowsCursor`。**本切片不定义契约，只消费**（INV-5 / §0） | 🔒 依赖 B **且** 分组锁切片 **A+B+C 全部落地** | `MetaKanbanView.vue` + `MultitableWorkbench.vue` 装配 + 新 composable | **sonnet 实现 / opus 审阅** | **mount test**：某列全集 200 行 / 已加载 12 张卡 ⇒ 列头显示 `200`；折叠列**不**请求组内行；`mode:"unavailable"` ⇒ 退回 B 的截断披露且不白屏。**全仓 grep 断言**：新增代码中不出现 `columnTotal` / `laneCursor` / `bucketCount`（INV-5）。**mutation-red**：列头改读 `col.rows.length`（即回到 `MetaKanbanView.vue:62` 现状）⇒ "列头显示 200" 断言必须红 |
| **F** | **甘特/时间轴端点 [MUTEX:WB]**：`timeRange` 改由 D 的服务端端点驱动；`mode:"unavailable"` 时退回本地 min/max **并**由 B 披露 | 🔒 依赖 C **且** D | `MetaGanttView.vue`、`MetaTimelineView.vue`、`MultitableWorkbench.vue`、新 composable | **sonnet 实现 / opus 审阅** | **mount test**：同一筛选集、`pageSize` 取 10 / 50 / 200 三次挂载 ⇒ 轴刻度序列与任一条形的 `left/width` **逐字节相同**（INV-6）。依赖箭头：目标记录未加载 ⇒ 渲染**占位/未决**样式，**不得**静默消失（`MetaGanttView.vue:351` 的 `return null` 路径需可观测）。**mutation-red**：把 `timeRange` 换回 `props.rows` 的本地 min/max（现状 `MetaGanttView.vue:272-285`）⇒ INV-6 的三次挂载断言必须红 |
| **G** | **日历区间物化 [MUTEX:WB] [MUTEX:BE]**：`visible-range-change`（`MetaCalendarView.vue:627-628`）除拉节假日外，additionally 驱动一次区间取数；`cell.overflow`（`:587`）在区间已完整物化时才作为真值渲染 | 🔒 依赖 C **且** D（复用其 `mode` 与泄露闸口径） | `univer-meta.ts`（区间谓词）、`MetaCalendarView.vue`、`MultitableWorkbench.vue:4093-4095`、新 composable | **sonnet 实现 / opus 审阅** | **real-DB golden**：区间谓词字段被 `field_permissions` 拒读 / 被 §2a.3 taint ⇒ **400/422，不得降级为全量返回**（INV-2.1）；行级拒读的行不进区间结果。**mount test**：某月有 3 条事件而其中 2 条排在第 3 页 ⇒ 切到该月后三条**全部**出现，`overflow` 角标为真值。**mutation-red**：把区间谓词字段的 `allowedFieldIds.has(fieldId)` 检查删掉 ⇒ real-DB golden 必须红；把 `overflow` 改回在未完整物化时也渲染 ⇒ mount 断言必须红 |

**梯子外（本锁明确不做）：**
层级祖先闭包的**根治**（§3.1 第二级）—— 它需要一个独立的树骨架契约与 INV-2.3 的泄露论证，
本锁只给出硬约束，不排切片。画廊（§2.6）。网格任何改动（§5.0-A）。工具栏 `page.total` 的拒读口径（INV-3）。

---

## §6 验证纪律 + 一句话总结

### 验证纪律

1. **对现行 head 复核，不信历史 MD。** 本锁每条断言在 `3c7c97111` 上取过 `file:line`；
   实现切片开工前必须在**当时的** `origin/main` 上重跑一遍 grep。行号漂移属正常，**结论漂移则本锁作废重审**。
2. **mutation-red 是验收的一部分，不是加分项。** 上表每个切片都写明了必须变红的那一处改动；
   审阅者要**亲手改、亲眼看红**，再改回。绿测试本身不构成守卫存在的证据。
   若某条守卫的 mutation 无法被命名，该守卫**不存在**，该切片不得通过。
3. **wire 形状变更 = 全仓两侧 shape-lock 扫描。** 切片 D / G 的每个新字段必须有一条**真实 wire 往返**
   集成测试；任何"字段逐个拷贝 / whitelist / pick"的序列化点都不得只有 fixture 测试。
4. **real-DB golden 必须新库单跑。** 切片 D / G 的权限 golden 涉及 `field_permissions` 与行级拒读表，
   fixture id 按文件命名空间化，`afterAll` 清子表（既有共享库夹具碰撞教训）。
5. **禁止在同一时刻推进两个 `[MUTEX:WB]` 切片**，也禁止与分组锁的 C / D / E 并行（§5.0-B）。
   **`[MUTEX:BE]` 切片（D / G）与分组锁 A / B 之间不得同时在飞**；后落者 rebase 到先落者 head 并按纪律 1 重新取址（§5.0-C）。
6. **禁止修改 `MetaGridTable.vue` / `useMultitableGrid.ts`**（§5.0-A）。切片 C 的验收含 `git diff --stat` 断言。
7. **禁止触碰中心 `rbac` / `auth`，禁止"顺手修" `page.total` 的拒读口径**（INV-3）。
8. **本锁未经 owner ratify 不得开工任何运行时切片。** 本文件不自我批准。

### 一句话总结

> **网格的第 N 行不依赖第 N+1 行，所以给它一个翻页器就够了；看板的列计数、甘特的时间轴、日历的月份、
> 层级的树，每一个渲染单元都由整个筛选集决定——用一页 50 行驱动它们，得到的不是残缺的视图，
> 而是一张自洽却错误的图：层级会把"父在第 2 页"的行判成孤儿并在 `orphanMode:'hidden'` 下
> 把它从渲染里删掉（`MetaHierarchyView.vue:370-371,388,402-403`），甘特的时间轴两端不是数据的两端
> （`MetaGanttView.vue:272-285`），而工具栏就在同一屏上写着 `1234 行`（`MetaToolbar.vue:185`）。
> 本锁把"视图的渲染输入必须是筛选集"升格为一等约束，并**拒绝**用一个统一契约去掩盖
> 看板（分组游标）/ 甘特（全集端点）/ 日历（区间窗口）/ 层级（祖先闭包）这四条互不兼容的修法。**
