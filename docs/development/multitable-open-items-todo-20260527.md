# 多维表剩余 open 项 — TODO 追踪清单

> Date: 2026-05-27 · Status: **TRACKER（非开工）** · 配套：开发计划 `multitable-open-items-development-plan-20260527.md` + 验证 `multitable-open-items-verification-20260527.md`
> Grounded in `origin/main @ 8fd73257d`。K3 锁：均为内核打磨，允许；**每个 slice 仍是独立 opt-in，不自动开下一刀**。
> 标记：✅ done · ⬜ todo（opt-in 后可动手）· 🔒 gated（被决策/前置阻塞）· ☑️ 需 owner 拍板的决策点

---

## Slice 1 — charts → ECharts（推荐下一刀，静态 import 先行）

**前置**：`pnpm --filter @metasheet/web add echarts`（Apache-2.0）。范围：`MetaChartRenderer.vue`（1 组件）+ `MetaDashboardView.vue`（1 消费者）；后端零改动。

- ⬜ **S1-1** tree-shakeable 引入：`import * as echarts from 'echarts/core'` + `echarts/charts`(`BarChart/LineChart/PieChart`) + `echarts/components`(`GridComponent/TooltipComponent`) + `echarts/renderers`(`CanvasRenderer`) + `echarts.use([...])`。**不引 LegendComponent/TitleComponent**（legend/title = HTML chrome）。**禁 runtime `from 'echarts'`**（type-only 例外）。
- ⬜ **S1-2** 纯函数 `buildOption(chartData, displayConfig): EChartsOption`（独立文件，便于单测）：bar 竖/横（`orientation`）、line、pie 三类映射；复用现有 8 色 `COLORS`（`displayConfig.colorScheme` 当前 dormant、本 slice 不接、wire→palette 留 follow-up）；仅 `showValues`→**bar** 系列 label + `orientation`→bar 轴 映射进 option；**`title`/`showLegend` = HTML chrome 不进 option**；**pie/line label-less**；最终 option 无 `legend`/`title`。
- ⬜ **S1-3** `MetaChartRenderer.vue`：bar/line/pie 三个 `<template>` 分支 → 单一 `<div ref="chartEl">`；**number/table 两分支原样保留 HTML**；保留 wrapper `data-chart-type`（模板 L2）。
- ⬜ **S1-4** 生命周期：`onMounted` init（仅 bar/line/pie）；`watch([()=>chartData,()=>displayConfig], ()=>inst.setOption(buildOption(...), true), {deep:true})`；`ResizeObserver`→`inst.resize()`；`onUnmounted`→`inst.dispose()`。
- ⬜ **S1-5** **静态 import**（不用 `defineAsyncComponent`——见 S1-9 follow-up）。
- ⬜ **S1-6** renderer spec 迁移：`vi.mock('echarts/core')`（jsdom 无 canvas）；断言 `buildOption` 输出（5 类型 + 空数据 + 横向 bar + per-point color + displayConfig 映射）；number/table HTML 断言保留。
- ⬜ **S1-7** dashboard spec 补 `vi.mock('echarts/core')`（`multitable-dashboard-view.spec.ts` 挂载即用 renderer，否则 canvas 崩）。
- ⬜ **S1-8** i18n 走既有 `meta-view-render-labels`，**不新建 label 模块**。
- ⬜ **S1-9** 🔒 follow-up：`defineAsyncComponent` 让 echarts 落异步 chunk（+ dashboard spec 改 `flushPromises`）。**单独 PR**，不进 S1 本刀。
- ⬜ **S1-10** 🔒 follow-up：新图表类型（scatter/area/funnel/gauge/堆叠/组合）——需后端 `ChartAggregationService` 补多 series 维度。**单独 opt-in**。

---

## Slice 2 — grid 分组 count + 滚动 UX（gated）

> 2a（仅改 header count）已勘误为**非 quick-win**，折叠进 2b（理由见开发计划 §Slice 2）。

- 🔒 ☑️ **C0 决策（owner 拍板）**：翻页器（确定性 N/M 页）vs 飞书式连续滚动。D2 已证 DOM 非瓶颈 → 纯 UX 取舍。**未决策不启动 2b/2c。**
- 🔒 **2b-1**（决策后）服务端分组行投递：扩 `/view` 或新端点按 `view.groupInfo.fieldId` 对**全集**分组返回 groups+count（后端 `groupRowsByField` 已具备）；前端以 server groups 为渲染源，`group.count` 用 server 全集值（替代 `MetaGridTable.vue:462` 页局部）。
- 🔒 **2b-2** 分组分页模型（组内/跨组分页，组不被分页切断）。
- 🔒 **2b-3** 字段权限 parity：group field 不可见 → 422（端点 `:5994` 已有；前端要处理该错误态）。
- 🔒 **2c-0 [spike 先行，1 天]** 现 frozen 列 `position:sticky;left:<px>` 与窗口化 `translateY` 行的兼容性（1k 行 + 横向滚动验证 frozen 仍钉住）。
- 🔒 **2c-1** spike 通过 → TanStack Virtual（MIT，行高按 `RowDensity` 28/36/52px）；失败 → 手搓固定行高 + 手算 sticky 偏移。

---

## Slice 3 — A2b 宏展开转义加固（contract-first）

> 勘误：lookup/rollup 合法进公式（`MetaFieldManager.vue:669` 不排除、后端 `univer-meta.ts:1015` 允许），复杂值真实走 `formula-engine.ts:111` `String(value)`。**改其字面化 = 行为变更，故先锁 contract。**

- ⬜ ☑️ **A2b-1（owner 拍板）** 锁 per-type contract 表（开发计划 §Slice 3 有草表）：标量不变；array→加引号 literal（值不变、修注入）；date→ISO 引号 literal；**object → `#VALUE!` 还是引号 literal？需拍板**。
- ⬜ **A2b-2** 实现：`String(value)` 分支按 contract 安全编码（兼容保留为主）。
- ⬜ **A2b-3** 回归测试 pin 现行标量行为 + 对抗性单测（`"`/`{fld_x}`/`1+1`/array/object/date/超长串）。
- ⬜ **A2b-4** lookup-进-公式真 DB 集成测试（wire-vs-fixture：lookup 值经真 patch 流入 formula）。
- 🔒 **A2b-5** Track B（Teable `packages/formula` MIT 真解析器取代宏展开）——**单独 RFC**，若上马则 A2b 可作废，故 A2b 保持最小。

---

## 决策点汇总（☑️ 待 owner）

1. **C0**：翻页器 vs 连续滚动（解锁 2b/2c）。
2. **A2b-1**：object 值进公式 → `#VALUE!` 还是引号 literal。
3. **起点确认**：是否从 Slice 1（ECharts，静态 import）开工。

## 落地提示

**这些 docs（及后续实现）若要 land，先 `git fetch` 后从 `origin/main` 切新分支提交**，不要从可能落后的本地分支提交（规划/实现前先 `git rev-list --count HEAD..origin/main` 确认基线）。
