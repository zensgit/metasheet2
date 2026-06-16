# 多维表条件格式 A5-2/A5-3 网格渲染 — 开发 & 校验 — 2026-06-15

> Status: **DONE + CI-BROWSER-VERIFIED**(jsdom 逻辑 + 真实 Chromium 截图确认)。补齐 A5 范围型条件格式弧的最后渲染半:色阶(A5-2) 单元格底色 + 图标集(A5-3) 字形。后端契约 + FE 镜像 + scale map 已于 #2664 落地;本 slice 仅补 `MetaGridTable` 的渲染消费。浏览器目检已由 CI lane(#2689)完成,截图确认色阶/图标渲染正确;首跑发现的数值低对比 bug 已修(#2694)并经 lane 复跑截图确认可读。

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
- ✅ **浏览器目检 = 已由 CI lane 完成**（#2689 真实 Chromium 截图）：色阶红→黄→绿插值、图标 ↓/→/↑ 分桶、data-bar 缩放均渲染正确。**首跑捕获真实视觉 bug**(数值正负号绿/红色在 scale 底色上低对比)→ #2694 修(亮度选 dark/white 文本)→ lane 复跑截图确认数值在蓝/黄/绿底色上均可读。frozen 滚动观感未单独验,非本弧阻塞。
- ⏸ **配置 UI 仍缺**：色阶/图标集规则需经条件格式配置对话框创建（browser-gated，未做）；本 slice 渲染**已配置**的规则。配置对话框 = 后续 browser-gated slice。

## 4. 落地

A5-2/3 渲染（MetaGridTable + 测）+ 本记录，单 PR。CI `test (18.x/20.x)` 验单测 + `vue-tsc -b`。A5 弧渲染半闭合；剩条件格式配置对话框 = browser-gated 后续。
