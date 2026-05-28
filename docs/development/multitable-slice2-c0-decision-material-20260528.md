# 多维表 Slice 2 — C0 决策材料（分页器 vs 连续滚动）

> Date: 2026-05-28  
> Status: **DECISION MATERIAL — 非实现**  
> Grounded in local checkout `HEAD @ f5013324e`（基于当前 `origin/main` 代码实读；本文件只做决策支持，不改 tracker / 不开工）

## TL;DR

`C0` 不是“滚动容器怎么做”的小交互决定，而是 **grid 数据投递模型** 的决定。

- **当前实现天然是分页模型**：前端 grid、workbench orchestration、后端 `/view` 返回都围绕 `offset/limit/page.total/hasMore` 运转。
- **当前 grouped grid 是“当前页本地分组”**：header 的 `count` 就是当前页 `rows.length`，不是全集值。
- 因此：
  - 若选 **保留分页器**，就应接受“分组是页局部语义”，`Slice 2` 不宜再按原设想推进。
  - 若选 **连续滚动**，才有理由启动 `2b`，并且它不是 UI polish，而是一次前后端联动的数据投递改造。

**我的默认建议**：若没有明确产品信号要求“飞书式连续浏览 + 分组完整显示”，先拍 **保留分页器**，暂停 `Slice 2` 实现。原因不是做不了，而是这不是性能问题，而是产品交互模型切换，当前没有足够证据值得付这个改造成本。

---

## 1. 当前代码事实

### 1.1 前端 grid 当前就是“页局部分组”

- `MetaGridTable.vue` 在 grouped 模式下渲染 group header，header 直接显示 `group.count`。[MetaGridTable.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/components/MetaGridTable.vue:34)
- `groupedRows` 的来源是对 **当前 `filteredRows`** 做本地分组；`count` 直接取 `rows.length`。[MetaGridTable.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/components/MetaGridTable.vue:405)
- grid 底部明确有分页器 UI：`currentPage / totalPages` + prev/next。[MetaGridTable.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/components/MetaGridTable.vue:246)

这说明当前 grouped grid 的真实语义不是“全集分组浏览”，而是“**当前页 rows 的本地分组浏览**”。

### 1.2 前端装载模型当前就是 offset/limit

- `useMultitableGrid` 维护的分页 state 是 `MetaPage { offset, limit, total, hasMore }`。[types.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/types.ts:125)
- `loadViewData(offset)` 每次调用 `/api/multitable/view` 都明确带 `limit` 和 `offset`。[useMultitableGrid.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/composables/useMultitableGrid.ts:429)
- `goToPage()` 的核心也是 `offset = (page - 1) * pageSize`。[useMultitableGrid.ts](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/composables/useMultitableGrid.ts:524)

这说明当前 grid 不是“拿一段数据然后在前端自由浏览”，而是 **强依赖 server page contract**。

### 1.3 workbench 刷新节奏也围绕“当前页”

- 视图更新、字段权限更新等，最终都是 `grid.loadViewData(grid.page.value.offset)`。[MultitableWorkbench.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/views/MultitableWorkbench.vue:1765)
- `groupFieldId` 还被纳入 `structuralRealtimeFieldIds`，说明分组变化被视为结构性变化，而不是纯 UI 状态。[MultitableWorkbench.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/views/MultitableWorkbench.vue:885)

这意味着如果改成连续滚动，不只是“翻页按钮换成触底加载”，还会波及 **reload / realtime / 结构刷新** 的策略。

### 1.4 后端 `/view` 当前也是分页返回，不是分组投递

- `/view` 的 in-memory path 在 filter/sort 后，仍然执行 `sorted.slice(offset, offset + limit)`。[univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5943)
- 默认 DB path 也返回 `page = { offset, limit, total, hasMore }`。[univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5979)

所以当前服务端 contract 是“给我第 N 页 rows”，不是“给我完整 groups / next chunk of grouped rows”。

---

## 2. 为什么 `2a` 不是 quick win

这点在现有 tracker 已经勘误过，这里给出 C0 视角下的简化结论：

- 如果只把 group header count 改成 server 全集值，但 **下面渲染的仍只是当前页 rows**，
- 那就会出现：header 显示 `(250)`，当前页面下却只有几十行，甚至某些组在这一页完全不出现。

这比现在“页局部 count 与可见行一致”的模型更容易误导用户。

所以 `2a` 不是单独可落的 polish；它只有在 **同一刀里把‘组的行投递模型’也改掉** 时才成立。这也是为什么它应折叠进 `2b`，而不能独立作为 quick win。

同时，有一条需要补充的现实约束：

- `origin/main` 上已经有 `/sheets/:sheetId/view-aggregate` 路由，可返回 group aggregate 结果，并且计数/聚合这一侧已有现成权限门：computed group → `422 AGGREGATE_COMPUTED_GROUP_UNSUPPORTED`，hidden/denied group field → `422 AGGREGATE_GROUP_FIELD_DENIED`。[univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5892) [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5990)
- 但这条原料只说明 **“计数/聚合那一侧大半现成”**，**不等于** “A2 的权限问题已经解决”。若将来要补“按 `groupKey` 拉组内行”的路径，那条 `/view + groupKey` 契约仍要单独审视权限与侧信道问题。
- 这条 aggregate 路由还有 **10000 行硬上限**，超限直接 `413 AGGREGATE_TOO_LARGE`。[univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5919) [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5923)
- 这个 cap 不是“随手调大环境变量”就该解决的旋钮。当前实现本质上是把行 load 进内存后再做 JS 侧 filter/sort/group，因此 cap 在保护一次 O(n) 的内存分组过程。[univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5908) [univer-meta.ts](/Users/chouhua/Downloads/Github/metasheet2/packages/core-backend/src/routes/univer-meta.ts:5958)

所以这批现成原料的正确结论是：

> **它下修的是“计数这一侧”的成本，不是把 grouped delivery 问题直接变成现成能力。**

---

## 3. C0 的两个选项

### 选项 A — 保留分页器（推荐默认）

#### 这代表什么

- 继续承认 grid 的主语义是“第 N/M 页浏览”。
- grouped grid 继续是“**当前页局部分组**”，而不是“全集分组展开”。
- `Slice 2` 原设想（完整组浏览 / server count / 连续滚动）不启动。

#### 优点

- 与当前前后端 contract 完全一致，几乎没有架构改造成本。
- 保留企业用户常见的确定性导航语义：第 N 页、总页数、回到原页。
- 不需要改 `loadViewData(offset)`、reloadCurrentPage、realtime、当前页回退逻辑。

#### 缺点

- grouped grid 保持页局部语义，不是飞书式连续浏览。
- 大组会被分页切断；用户不会在一个连续视图里看到“整组”。
- `group.count` 只能诚实地继续代表“当前页可见组内行数”，不能升格成全集值。

#### 若选 A，后续建议

- **暂停 `Slice 2` 实现线**，不要为了“看起来还剩一项”硬做半套。
- 如果产品上仍觉得 grouped grid 容易误解，后续应走 **文案/交互澄清**，而不是直接开数据投递改造。
- 但要补一条 caveat：若 owner 明确不能接受“页局部分组”，又不愿直接跳到 continuous model，未来仍可评估一个 **A2 风格的 post-C0 branch**，见下文。

### 选项 B — 转连续滚动（飞书式）

#### 这代表什么

- grouped grid 的目标语义改成“**全集连续浏览**”。
- group header count 应该变成全集值。
- 组不能再被简单的页边界切断，至少前端渲染源不能再只是“当前页 rows 本地分组”。

#### 优点

- 用户心智更统一：看到的是一条连续的数据流，不是页局部切片。
- 组头 `count`、组内行、组展开/收起可以都按全集语义成立。
- 与 tracker 里原本的 `2b` 方向一致。

#### 成本 / 风险

- 不是小前端改动，而是 **前后端联合改造**：
  - server 需要提供适合连续浏览的组/行投递模型；
  - grid 需要 append 模式，而不是 replace 当前页；
  - workbench reload / realtime / selection / focus / row numbering 都要重审。
- `2c` 仍不应自动跟进；连续滚动不等于立刻窗口化。窗口化仍然要等真实 DOM 压力再开 spike。

#### 若选 B，后续建议

- 直接解锁 **`2b`**，且第一刀就按“服务端分组行投递 + 前端 append/continuous model”来设计。
- **不要再拆回 `2a`**；count、groups、rows 必须一起改。
- `2c` 继续保持 gated，等 `2b` 实测后再决定是否需要。

### A2 作为 post-C0 branch 的位置

若 owner 最终不接受“页局部分组”，但也不想直接切到 continuous model，那么仍存在一个 **A2 风格** 的后续分支可评估：

- 组头使用 aggregate 侧的全集 group/count 原料；
- grid 默认折叠；
- 展开时按 `groupKey` 懒加载组内行。

但这条分支不该在当前 `C0` 被写成“便宜 quick win”，因为它自己的成本也真实存在：

- 仍需新增一条 `groupKey` 行拉取契约；
- 仍要补 `/view + groupKey` 这条路径自己的权限/侧信道分析；
- 仍会受 aggregate 侧 `10000` 计数上限影响；
- 仍会碰到 reload / realtime / current-page refresh 的交互面，而这些当前都是按分页模型写死的。[MultitableWorkbench.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/views/MultitableWorkbench.vue:885) [MultitableWorkbench.vue](/Users/chouhua/Downloads/Github/metasheet2/apps/web/src/multitable/views/MultitableWorkbench.vue:1765)

所以我会把它记录成：

> **一个有界但有代价的中间档**，而不是当前默认推荐、也不是免费 quick win。

---

## 4. 我建议拍哪边

**建议：默认拍 A，保留分页器。**

### 原因

1. **当前没有性能压力证据。**  
   D2 已经给出过结论：这里不是 DOM 顶不住，而是 UX 选择题。

2. **当前没有产品信号证明必须要飞书式连续浏览。**  
   如果没有明确用户需求，“为了让 grouped grid 更像飞书”去改整个数据投递模型，收益不够确定。

3. **连续滚动在当前代码上是真改模型，不是做 polish。**  
   这不是“把 pagination 改成 intersection observer”就结束，而是要改：
   - `/view` 的消费方式；
   - `useMultitableGrid` 的 replace/append 行为；
   - 组头/组行的来源；
   - reload / realtime / selection 等边界。

### 什么情况下应改拍 B

若 owner 能明确回答下面任一条为“是”，就值得开 `2b`：

- grouped grid 的目标就是要接近飞书式连续浏览；
- 当前页局部分组在真实用户场景里已经造成明显困惑；
- 用户需要在一个连续会话里读完整组，而不是接受分页切片。

---

## 5. C0 拍板后的执行指引

### 若 C0 = 保留分页器

- 将 `Slice 2` 标记为 **deferred / cancelled by product choice**，不启动 `2b/2c`。
- grouped grid 保持“当前页局部分组”语义。
- 若要有后续动作，应该是单独的 UX wording / affordance 调整，而不是数据模型改造。

### 若 C0 = 连续滚动

下一份应产出的是 **`Slice 2b` 设计稿**，而不是直接写代码。设计稿至少要锁：

1. 服务端返回什么形状：groups-first 还是 rows-first。
2. 前端 append 与 replace 的切换点。
3. group collapse / selection / row number 在连续模型下的语义。
4. same-record / foreign changes 对连续列表的 refresh 策略。
5. `2c` 仍保持 gated，不默认捆绑。

---

## 6. 本材料的结论

`C0` 的本质不是“要不要把 grid 做得更丝滑”，而是：

> **我们是否愿意把 grouped grid 从“分页列表”升格成“连续浏览模型”？**

在当前代码和当前信号下，我的建议是：

> **先保留分页器，不启动 Slice 2 实现。**  
> 真要继续这条线，先由 owner 明确拍“必须做连续滚动”的产品决定，再开 `2b` 设计，而不是先写代码。
