# 多维表剩余 open 项 — TODO 追踪清单

> Date: 2026-05-27 · Refreshed: 2026-05-28 · Status: **TRACKER（post-#1950 + #1958 + C0 #1982）** · 配套：开发计划 `multitable-open-items-development-plan-20260527.md` + 验证 `multitable-open-items-verification-20260527.md`
> **Reconcile 2026-05-28**：Slice 1 ✅ SHIPPED #1950 · A2b ✅ MERGED #1958（defensive）· **C0 ✅ resolved by #1982（keep pager）** · 本 tracker 现无 still-open implementation slice。
> Drafting base `origin/main@8fd73257d`，reconciled through #1982（2026-05-28，状态已对齐现实）。K3 锁：均为内核打磨，允许；**每个 slice 仍是独立 opt-in，不自动开下一刀**。
> 标记：✅ done · ⬜ todo（opt-in 后可动手）· 🔒 gated（被决策/前置阻塞）· ☑️ 需 owner 拍板的决策点

---

## Slice 1 — charts → ECharts ✅ **SHIPPED (#1950, merge `b665b2b1c`)**

> as-built：bar/line/pie→ECharts canvas；title + pie legend 留 HTML chrome；number/table HTML；tooltip 唯一 additive。33 specs + `vue-tsc -b` + build/tree-shaking 绿；**V-S1-7 视觉冒烟已于 2026-05-28 RAN + PASS**。下方 S1-1..8 = as-built 记录（均已落）；**S1-9 async-import / S1-10 新图表类型** 仍为独立 follow-up。

**前置（as-built）**：`pnpm --filter @metasheet/web add echarts`（Apache-2.0）。范围：`MetaChartRenderer.vue`（1 组件）+ `MetaDashboardView.vue`（1 消费者）；后端零改动。

- ✅ **S1-1..S1-8 done（as-built，#1950）**：tree-shakeable `echarts/core` + `charts`/`components`/`renderers`（不引 Legend/Title）· 纯函数 `buildOption`（scalar / scalar-array / pie 映射；title+legend 留 HTML chrome；pie/line label-less；option 无 legend/title）· renderer bar/line/pie→canvas + number/table HTML（保留 `data-chart-type`）· 生命周期 init/`setOption`/`watch{flush:'post'}`/`ResizeObserver`/`dispose` · 静态 import · renderer+dashboard specs `vi.mock('echarts/core')` · i18n 走既有 `meta-view-render-labels`。
- ⬜ **S1-9** 🔒 follow-up：`defineAsyncComponent` 让 echarts 落异步 chunk（+ dashboard spec 改 `flushPromises`）。**单独 PR**，不进 S1 本刀。
- ⬜ **S1-10** 🔒 follow-up：新图表类型（scatter/area/funnel/gauge/堆叠/组合）——需后端 `ChartAggregationService` 补多 series 维度。**单独 opt-in**。

---

## Slice 2 — grid 分组 count + 滚动 UX ⏸ **DEFERRED by C0**

> `#1982` 已采纳 **C0 = 保留 pager**。因此本 track **不启动 2a / 2b / 2c 实现**；下列条目保留为 archive note，供未来若产品改拍连续 grouped browsing 时重开。

- ✅ **C0 已拍板**：保留翻页器（确定性 N/M 页），不做飞书式连续滚动。
- ✅ **结果**：grouped grid 继续保持“当前页局部分组 + 当前页局部 count”的现有语义；`2a` 维持“非 quick-win、不单独发”的结论。
- ⏸ **archive note**：若未来产品改拍连续 grouped browsing，从 `#1982` 重新起 `2b` 设计；A2 仅作 post-C0 branch 参考，`2c` 仍是独立 spike gate。

---

## Slice 3 — A2b 宏展开转义加固 ✅ **MERGED (#1958, squash `d9b5b031a`)** — defensive hardening

> 落地 contract（owner 拍板 **object → `#VALUE!`**）：`formula-engine.ts evaluateField` 的 `String(value)` 兜底收口 —— 标量不变；**scalar array** → 引号 joined literal（值保留、修注入）；**array-with-object + 裸 object → `#VALUE!`**（无 `[object Object]` 假 join、无注入）。不碰 frozen `formula/engine.ts`。

- ✅ **A2b-1** 拍板：object（含 array-with-object）→ `#VALUE!`；scalar array → 引号 join；date 在此层是 ISO 字符串走 string 分支。
- ✅ **A2b-2** 实现已落（仅 `String(value)` 分支）。
- ✅ **A2b-3** 13 unit：标量回归 + array/object contract（含 lookup-of-object 形状）+ 对抗性无注入（`"`/`{fld_x}`/`1+1`/object-array/超长串）；既有 formula/dry-run/write-path 套件无回归。
- ⛔ **A2b-4 → NOT-APPLICABLE**（原 V-A2b-3 real-DB lookup→formula）：hydrated lookup 数据当前不流入 formula recalc（`recalculateRecord` 走 DB reload；lookup computed-on-read 不 materialize）→ A2b 是 **defensive**，该 e2e 断言与架构不符。
- 🔒 **A2b-5** Track B（Teable `packages/formula` MIT 真解析器取代宏展开）——**单独 RFC**，若上马则 A2b 可作废，故 A2b 保持最小。
- 🆕 **Backlog（独立、out-of-scope，本 reconcile 不写 note 本身）**：formula 引用 lookup → recalc 缺席 lookup 值 → `undefined→'0'`（`formula-engine.ts:109`，"按 0 算"）；characterization/design note only，单独决策。

---

## 决策点汇总

1. ✅ **C0**：翻页器 vs 连续滚动 —— 已决：**保留 pager**（#1982）。
2. ✅ ~~A2b-1：object → `#VALUE!`~~（已拍板，#1958 落地）。
3. ✅ ~~起点确认：Slice 1 ECharts~~（已 shipped #1950）。

**当前无未决 owner gate。**

## 落地提示

**这些 docs（及后续实现）若要 land，先 `git fetch` 后从 `origin/main` 切新分支提交**，不要从可能落后的本地分支提交（规划/实现前先 `git rev-list --count HEAD..origin/main` 确认基线）。
