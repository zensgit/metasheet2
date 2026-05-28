# 多维表 — 剩余 open 项开发方案（clean, origin/main-grounded）

> Date: 2026-05-27 · Author: Claude · Status: **PLAN — 非开工**
> **Drafting base `origin/main@8fd73257d`，reconciled through #1958（2026-05-28）** —— 下方状态已对齐当前现实（Slice 1 #1950 + A2b #1958 已 shipped）；`8fd73257d` 仅是初稿基线、非当前 HEAD。（纪律：方案/benchmark 前先 `git fetch` 对照 `origin/main`。）
> K3 PoC Stage-1 锁：以下均为多维表内核打磨，允许；**每项仍是独立 opt-in**，不碰 integration-core/RBAC/auth。

## 0. 范围：只列 `origin/main` 上**确认仍未做**的项

> **状态 reconcile（2026-05-28，docs-only）**：Slice 1 已 shipped（#1950）+ A2b 已 merged（#1958），本文随之收口；唯一 still-open = **Slice 2（C0-gated）**。下方各节标 ✅ 并保留为 as-built 记录。

**已 shipped（不在本方案内，仅备查）**：agg-footer 后端#1841 + 分组小计#1852 + 前端 `<tfoot>`；formula recalc-on-patch#1883 + A1.1#1890 + A2-defense#1896 + F1#1897；formula dry-run #1865/#1873；frozen-col#1837；inline-create#1834；D2 perf#1815；D3 权限矩阵#1820/#1827/#1831；**charts → ECharts Slice 1 #1950（merge `b665b2b1c`）**；**A2b formula hardening #1958（squash `d9b5b031a`，defensive）**。

**本方案 = 1 项 still-open（Slice 2，C0-gated）**：

| Slice | 项 | 状态 | K3 |
|---|---|---|---|
| ~~1~~ | charts → ECharts | ✅ **SHIPPED** #1950 | — |
| **2** | grid 分组头 count + 滚动 UX | ⬜ still-open，**C0 gated**（2a 非 quick-win→折叠进 2b；2b/2c 架构级） | 允许 |
| ~~3~~ | A2b 宏展开转义加固 | ✅ **MERGED** #1958（defensive） | — |

---

## Slice 1 — charts → ECharts ✅ **SHIPPED (#1950, merge `b665b2b1c`)** — 下方为 as-built 设计记录

> 实际落地：bar/line/pie→ECharts canvas；title + pie legend 留 HTML chrome；number/table HTML；tooltip 为唯一 additive。33 specs + `vue-tsc -b` + build/tree-shaking 绿；**V-S1-7 视觉冒烟 NOT-RUN（无 stack，须有 stack 时人工核对）**。S1-9 async-import / S1-10 新图表类型仍为独立 follow-up。

### 现状（origin/main 实读，as-built 前）
- `ChartType` = `bar | line | pie | number | table`（`types.ts:863`，5 类）。
- `MetaChartRenderer.vue`（293 行）手搓：bar 用 `<rect>`（含 `orientation==='horizontal'` 横向分支）、line 用 `<polyline>`+`<circle>`、pie 用手算 `<path>` 弧段 + HTML 图例、number/table 用 HTML。8 色 `COLORS` 调色板 + `defaultColor(idx)`。
- props = `chartData: ChartData` + `displayConfig?: ChartDisplayConfig`；`ChartData.dataPoints: {label,value,color?}[]` + `total` + `chartType`；`ChartDisplayConfig` = `title/showLegend/showValues/prefix/suffix/orientation` + **`colorScheme?: string`**（后者 **dormant**：`types.ts:878`/`charts.ts:42` 仅类型声明、无渲染器/服务消费者 → 本 slice **显式不接、沿用现有 8 色 `COLORS`**，不静默收窄类型；wire `colorScheme`→ECharts palette 留 follow-up）。
- **唯一消费者** = `MetaDashboardView.vue:82`（`import @:121`）。后端 `ChartAggregationService` 产出 `dataPoints` —— **本 slice 后端零改动**。

### OSS 借鉴
**Apache ECharts（Apache-2.0，可作依赖）** —— 中国 BI 事实标准、Element Plus 共存好。轻量备选 Chart.js（MIT，≈70KB）仅当确定不扩类型。

### 改造范围（小）：1 个组件 + 1 个消费者；number/table 保留 HTML

**checklist**：
- ⬜ **1.1 [包体闸门]** tree-shakeable 引入：`import * as echarts from 'echarts/core'` + `echarts/charts` 的 `BarChart/LineChart/PieChart` + `echarts/components` 的 `GridComponent/TooltipComponent` + `echarts/renderers` 的 `CanvasRenderer`，再 `echarts.use([...])`。**不引 `LegendComponent`/`TitleComponent`**（legend/title 走 HTML chrome）。**禁止 runtime `from 'echarts'`**（type-only `import type` 例外）。实测 tree-shaking 剔除 **~537KB raw / ~174KB gzip**（vs 全量 echarts）。
- ⬜ **1.2** `MetaChartRenderer.vue` 的 bar/line/pie 三个 `<template>` 分支替换为单一 `<div ref="chartEl">` + ECharts canvas；**number/table 两分支原样保留 HTML**（ECharts 无对应、保留即可保住其现有测试）。
- ⬜ **1.3** option 映射（纯函数 `buildOption(chartData, displayConfig)`，便于单测）：
  - bar 竖：`xAxis{type:'category',data:labels}` + `yAxis{type:'value'}` + `series[{type:'bar',data:values,label:{show:showValues!==false}}]`；`orientation==='horizontal'` → 交换 x/y 轴。
  - line：`xAxis category` + `series[{type:'line',data:values}]`。
  - pie：`series[{type:'pie',data:dataPoints.map(p=>({name:p.label,value:p.value,itemStyle:{color:p.color}}))}]` + `tooltip{trigger:'item'}`。
  - 颜色：option 级 `color: COLORS`（复用现有 8 色数组），per-point `p.color` 走 `itemStyle.color`。
  - `displayConfig`：**`title`/`showLegend` 不进 option（= HTML chrome：标题恒 HTML，legend 仅 pie 的 HTML legend 块）**；`showValues`→**仅 bar** 系列 `label.show`（**pie/line label-less**）；`orientation`→仅 bar 轴交换；`prefix/suffix` 仅 number（HTML）；`colorScheme` dormant 不接。**最终 option 不含 `legend`/`title`。**
- ⬜ **1.4 [生命周期]** `onMounted` init（仅 bar/line/pie）；`watch([()=>props.chartData, ()=>props.displayConfig], ()=>inst.setOption(buildOption(...), true), {deep:true})`；`ResizeObserver` → `inst.resize()`；`onUnmounted` → `inst.dispose()`（防泄漏）。
- ⬜ **1.5 [测试迁移 — 风险，两层]** ① **renderer spec**：现有断言 SVG DOM 选择器（`data-chart="bar"`/`data-bar-index`/`data-legend`）—— ECharts 渲染到 **canvas**，会失效，且 **jsdom 无 canvas → 必须 `vi.mock('echarts/core')`**；改为断言纯函数 `buildOption` 输出（labels/values/series.type 映射、空数据降级）。number/table 的 HTML 测试原样保留；保留 wrapper `data-chart-type`（模板 L2）做类型断言。② **dashboard consumer spec（owner review 补）**：`MetaDashboardView.vue:121` 静态 import `MetaChartRenderer`，且有独立挂载测试 `apps/web/tests/multitable-dashboard-view.spec.ts`（mock client 返回 chart data）—— 该 spec 也要补 `vi.mock('echarts/core')`，否则 dashboard 挂载即因 canvas 缺失报错。**reviewer 不要以为只改 renderer-spec 就够。**
- ⬜ **1.6 [包体优化 — 建议拆为独立 follow-up]** `defineAsyncComponent` 让 ECharts 落异步 chunk 收益真实（≈150KB 离主包），但会把 dashboard spec 从同步挂载变成需 `flushPromises`/await 异步解析。**建议 Slice 1 先用静态 import（只 mock echarts，dashboard spec 改动最小），把 async-import 作为单独 follow-up** —— 降低本刀的测试面与风险。
- 🔒 **1.7** 新增图表类型（scatter/area/funnel/gauge/堆叠/组合）= **后续独立 opt-in**；扩 area/堆叠/组合时后端 `ChartAggregationService` 当前是**单 series**，需补多 series 维度。

**验收**：dashboard 4 类面板（bar/line/pie/number）视觉冒烟一致；横向 bar 生效；resize 不变形；切换 base/卸载无 canvas 泄漏；`buildOption` 单测覆盖 5 类型 + 空数据。

---

## Slice 2 — grid 分组头 count + 滚动 UX（拆 3 个 opt-in）

### 现状（origin/main 实读）
- grid 仍**翻页器**（50/页）；`groupedRows`（`MetaGridTable.vue:450`）对**当前页** `filteredRows` 分组，header 显示 `group.count = rows.length`（:462/:40）= **页局部计数**。
- 但 #1852 已让 **server 分组数据**经 `props.aggregateGroups`（`:376`，含 `count` + per-field `aggregates`）流入，已建 `serverGroupAggByKey`（:601）只用于脚注小计，**未用于 header count**。

#### 2a — 分组头 count 用 server 全集值 ⚠️ **不是 quick-win（owner review 勘误）—— 建议折叠进 2b**
- **比文档初稿大**：前端 `loadAggregates()`（`MultitableWorkbench.vue:1770`）在 `view.config.aggregations` 为空时**直接清空 `aggregateGroups` 并 return**（`:1774-1779`），且 watch（`:1793`）只听 aggregationConfig、**不听 groupField**。所以"仅分组、未开 footer aggregation"的视图**根本拿不到 server count** —— 只改 header 映射是 no-op。
- **后端其实已 ready**：`/view-aggregate`（`univer-meta.ts:6004-6009`）按 `view.groupInfo.fieldId` 返回 `groups[{key,count,aggregates}]`，**aggConfig 为空也返回 count**（`computeAggregates({})={}`）。所以要让它生效，需扩前端触发：`groupField` 存在即调端点（不止 aggregations 非空）。
- ⚠️ **但即便修了 count 仍是半修 + 有 UX 风险**：grid 只渲染当前页、页局部分组 → header 显示"(250)"而下面只有 ~30 行，且**整组行都在第 2 页的组在第 1 页根本不出现**。count≠可见行 + 缺组，比现状（页局部 count 与可见行一致）**更易误导**。
- ✅ **建议（我的推荐）**：**不单独做 2a**。把"分组 count 正确性"**折叠进 2b 的服务端分组行投递**（server 对全集分组、返回 groups+count、前端以 server groups 为渲染源），count 与行一起对。若一定要现在有个 interim，则"扩触发到 groupField + 渲染 server count + 加'当前页'提示"，但价值有限。

#### 2b — 翻页器 → 连续滚动 / 服务端分组行投递 🔒（需 C0 决策先行）
- 🔒 **C0 决策**：保留确定性"第 N/M 页"（部分企业用户偏好）vs 飞书式连续滚动。**D2 已证 DOM 非瓶颈** → 纯 UX 取舍，非性能驱动。**未决策不启动。**
- 🔒 决策=连续滚动后：`useMultitableGrid` 加 `appendViewData`（push 不替换）+ 触底 IntersectionObserver；或走服务端分组行投递（组不被分页切断）。

#### 2c — 真窗口化 🔒（仅当 2b 实测暴露 DOM 问题；spike-first）
- 🔒 **前置 spike（1 天）**：现 frozen 列是 `position:sticky;left:<px>`，窗口化常用 absolute+`translateY` 行 → **sticky 在 transform 父级内是已知浏览器坑**。1k 行窗口化 + 横向滚动验证 frozen 仍钉住。
- 🔒 通过 → TanStack Virtual（MIT，固定行高按 `RowDensity` 28/36/52px）；失败 → 手搓固定行高 + 手算 sticky 偏移（不同 effort）。

---

## Slice 3 — A2b 宏展开转义加固 ✅ **MERGED (#1958, squash `d9b5b031a`, 2026-05-28)** — defensive hardening

### 落地 contract（owner 拍板：object → `#VALUE!`）
`formula-engine.ts evaluateField` 的 `String(value)` 兜底分支收口（仅此一处，不碰 frozen `formula/engine.ts`）：

| 输入值类型 | A2b 落地 | 行为变更 |
|---|---|---|
| string（含 JSONB ISO 日期）/ number / boolean | 不动（string 已 `JSON.stringify` 引号、安全） | 否 |
| **scalar array**（多值 lookup of scalars） | 引号 joined literal（`["a","b"]→"a,b"`，值保留、修注入） | 仅修安全 |
| **array-with-object + 裸 object** | **`#VALUE!`**（Excel 式错误传播，无 `[object Object]` 假 join、无注入） | 破→诚实 |

> date 在此层是 JSONB ISO **字符串** → 走 string 分支（quoted）；裸 `Date` 对象无调用面 → `#VALUE!`（可接受）。

### 性质 = DEFENSIVE，不是 live bug fix（owner-confirmed）
**当前没有路径把 `applyLookupRollup` 的内存 object-array 喂进 `evaluateField`**：`recalculateRecord` 走 DB reload（`formula-engine.ts:249`）；lookup 是 computed-on-read / 不 materialize（`applyLookupRollup` 只写内存 `row.data`，`univer-meta.ts:1795`）。故 A2b 是"若复杂值真进 eval 则安全"的加固。13 unit 测试（标量回归 + array/object contract + 对抗性无注入）绿；既有 formula/dry-run/write-path 套件无回归。

### V-A2b-3 → **NOT-APPLICABLE as a gate**
原"real-DB lookup→formula→`#VALUE!`"end-to-end 断言与真实架构不符（该组合当前不发生，见上）→ 改为 architecture note，不作硬门。

### 🆕 Backlog（独立、既有架构 gap，out-of-scope，不在本 PR）
formula 引用 lookup 字段时，recalc 按 DB raw data 重算、lookup 值缺席 → `evaluateField` 把 `undefined→'0'`（`formula-engine.ts:109`）→ 实际"按 0 算"，不是用 lookup 值。**characterization/design-note only**（本 reconcile 不写该 note 本身）；需 materialize 或在 recalc 前喂 hydrated row 才能改 —— 单独决策。Track B（Teable `packages/formula` 真解析器）若上马会整体取代 A2b 宏展开转义。权威跟踪 `multitable-derived-field-borrow-plan-20260526.md`；**A2-full（链式 topo）仍 gated/future**。

---

## 横切

- **license**：ECharts(Apache)/TanStack Virtual(MIT)/Teable `packages/formula`(MIT) 可作依赖；引入仍是**独立 opt-in**。Chart.js(MIT) 为 ECharts 轻量备选。
- **grounding 纪律**（本轮教训）：任何 benchmark/方案先 `git fetch && git rev-list --count HEAD..origin/main`，落后则以 `git show origin/main:<file>` 为准 —— 落后 checkout 的 file:line 会误导。
- **staged opt-in**：Slice 1（#1950）+ A2b（#1958）均已落；**唯一 still-open = Slice 2，受 C0 gate**（2a 已折叠进 2b、非独立起跑项）；不自动开下一刀。
- **下一刀（无 C0 不开实现）**：仅剩 Slice 2 的 **C0 决策**（翻页器 vs 连续滚动）+ 上面的 formula-over-lookup backlog characterization/design note（非实现）。

> **Owner review v2（2026-05-27）已折入**：① 2a 比初稿大（前端 `loadAggregates` gated on `view.config.aggregations`、不听 groupField）→ 降级、建议折叠进 2b；② A2b 是行为变更不是纯 hardening（lookup/rollup 允许作公式输入，复杂值走 `String(value)`）→ 改 contract-first；③ Slice 1 测试漏了 dashboard consumer spec → 已补，且建议静态 import 先行。主排序不变（Slice 1 仍最干净）。

**一句话**：Slice 1 ECharts（#1950）+ A2b（#1958，defensive）均已 shipped；**剩余真正 open 的只有 grid 分组/滚动（Slice 2）**，2b/2c 受 **C0 决策**（翻页器 vs 连续滚动）gate（2a 非 quick-win、折叠进 2b）。另有 formula-over-lookup→`'0'` 的既有架构 gap = backlog（characterization/design note，非实现）。其余 BI-polish + formula 主线均已 shipped。
