# 考勤 UI-P1 余量：768px 紧凑自助面 design-lock — 2026-07-07

> **Status: RATIFIED（UI uplift 计划 P1「768px 紧凑打卡」;owner 2026-07-07「请继续 UI-P1 余量」;
> E2 移动 landing 依赖此项——嵌入方向锁 E2 行）。** display-only CSS-only,零逻辑/接口/模板结构改动。

## 1. 现状与缺口

`AttendanceView.vue` 已有 768px 块覆盖大头（container padding / header 堆叠 / actions·btn 全宽 /
focus·callout 堆叠 / hero-punch 堆叠 #3788）。移动/容器 landing 剩余触屏缺口:
- **filters**（日期区间/组织/用户/刷新）:`flex-wrap` 会换行但字段**不全宽** → 手机上日期输入拥挤。
- **stat 卡**（`--stat`,#3788 大数字四卡）:继承 `.attendance__summary` 的 `auto-fit minmax(120px)` →
  ~700px 宽挤成一排窄卡,大数字可读性差 → 应 **2×2**。
- hero 时间线（#3788）窄屏可换行。

## 2. 修法（仅扩现有 768px 块,纯 CSS）

- `.attendance__filters .attendance__field { width: 100% }`（字段全宽,触屏友好）。
- `.attendance__summary--stat { grid-template-columns: repeat(2, 1fr) }`（大数字卡 2×2）。
- `.attendance__hero-timeline { flex-wrap: wrap }`（窄屏节点换行不溢出）。
- 全部落在既有 `@media (max-width: 768px)` 块内,值用 UF `--ms-*`（宽度/百分比除外）。

## 3. 保全

零模板/testid/copy/逻辑改动;既有测试（selfservice/hero）不受影响（CSS media 不改 DOM/断言）。
非 overview 面（admin/reports）本媒体块已有规则,本刀只加 overview 自助相关三选择器,不动其余。

## 4. 测试契约

CSS-only 媒体查询无法在 jsdom 断言计算样式（既有惯例:CSS 改动靠 data-testid/类保全 + 人工/真机）。
本刀加**存在性守卫**:selfservice 挂载测试断言 stat 卡容器带 `attendance__summary--stat` 类、
filters 字段存在（确保选择器目标未被误删）——媒体规则本身随 E4 真机 smoke 目视验收。
不新增可 mutation 的运行时守卫（纯 CSS）;验证 MD 记明"响应式目视验收留 E4"。

## 5. 完成口径

实现 → opus 对抗审阅 0 P1/P2（display/CSS-only）→ 三红线 → 验证 MD。FE 串行车道。
