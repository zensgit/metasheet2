# 多维表条件格式 A5-2/A5-3 网格渲染 — 开发 & 校验 — 2026-06-15

> Status: **DONE（jsdom 逻辑验证）+ 浏览器目检为残余**。补齐 A5 范围型条件格式弧的最后渲染半：色阶(A5-2) 单元格底色 + 图标集(A5-3) 字形。后端契约 + FE 镜像 + scale map 已于 #2664 落地；本 slice 仅补 `MetaGridTable` 的渲染消费（A5-1c data-bar 渲染的同款 jsdom-可验证先例）。

## 1. 开发（做了什么）

仅 `apps/web/src/multitable/components/MetaGridTable.vue`（渲染消费）：

- **A5-2 色阶**：`cellStyle` 增 `colorScaleFill = scaleEntry.scaleColor` 分支 → 单元格 `backgroundColor`（实底色，非 data-bar 的渐变）。与 data-bar 一样吃单元格底色 → 抑制算子规则的 `backgroundColor`（保留 textColor）。冻结列 base 改 `colorScaleFill ?? format.bg ?? #fff`（否则 sticky 的 `#fff` 会盖掉色阶）。`barPct` 守卫保留 → 色阶不进渐变路径（无 `undefined%`）。
- **A5-3 图标集**：新 `cellScaleIcon(rid,fid)` 解析 `iconKey`(`${set}:${index}`) → `{glyph,color}`；`SCALE_ICON_GLYPHS` 映射 3 套（arrows3 ↓→↑ / traffic3 ●●● / signs3 ✕!✓，各配红/琥珀/绿）；越界或未知 set → 无图标（fail-safe）。两条渲染路径（分组 + 平铺）各在 `<MetaCellEditor>` 前插一独立 `v-if` 的 `<span class="meta-grid__cell-scale-icon">`（不破坏 editor/renderer 的 v-if/v-else 配对；逻辑全在共享 helper，避免双定义漂移）。+ scoped 样式。

数据已就位：workbench 的 `buildFieldScaleMap`(#2664) 已产 `scaleColor`/`iconKey`，经 `:conditional-formatting-scale` 传入网格；本 slice 仅补“画出来”。

## 2. 校验

| 校验项 | 结果 |
|---|---|
| 网格渲染 jsdom `multitable-grid-databar.spec.ts` | **9 passed**（原 6 + A5-2/3 渲染 3）|
| 含既有 **Trap-E** 守卫 | 仍绿（色阶用 `backgroundColor` 非 `backgroundImage`、图标用 span，皆不产渐变 → 无 `undefined%`）|
| 回归：grid-databar + cf-scale + conditional-formatting + frozen-columns | **58 passed**（冻结列 colorScale base 改动无回归）|
| FE 类型门 `vue-tsc -b` | **CI `test (18.x/20.x)` 为权威门**（本机 Node 25 跑不了 vue-tsc）|

新增渲染断言：色阶 amount 0/50/100 → 单元格 bg `rgb(0,0,0)`/`rgb(128,128,128)`/`rgb(255,255,255)` 且无渐变；图标集桶 0/2/2 → 字形 `↓`/`↑`/`↑`；无规则字段无图标。

## 3. Goal 边界（诚实残余）

- ✅ **A5-2/3 网格渲染逻辑 jsdom 验证到位**（cellStyle 输出 + 图标 DOM）。
- ⏸ **浏览器目检 = 残余**（同 A5-1c / B6-b）：jsdom 证 style/DOM，证不了真实色阶对比度可读性、图标字形跨平台渲染、frozen 滚动观感。有浏览器/app 访问后做一次目检（本地 app + Playwright 或 owner staging）。
- ⏸ **配置 UI 仍缺**：色阶/图标集规则需经条件格式配置对话框创建（browser-gated，未做）；本 slice 渲染**已配置**的规则。配置对话框 = 后续 browser-gated slice。

## 4. 落地

A5-2/3 渲染（MetaGridTable + 测）+ 本记录，单 PR。CI `test (18.x/20.x)` 验单测 + `vue-tsc -b`。A5 弧渲染半闭合；剩条件格式配置对话框 = browser-gated 后续。
