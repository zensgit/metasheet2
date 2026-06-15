# 多维表条件格式 — 范围型样式(data bar / color scale / icon set)设计锁 — 2026-06-15

> Status: **DESIGN-LOCK(实现前)**。对应基准刷新阶梯 `multitable-benchmark-refresh-ladder-20260615.md` 的 **A5**(条件格式样式深度)。
> 范围:前端渲染 + 后端 service 镜像 + 规则 schema 扩展。**docs-only,本 PR 不含实现。**

## 1. 问题

当前条件格式只有**算子匹配 → 纯色**一种模型:`ConditionalFormattingStyle = { backgroundColor?, textColor?, applyToRow? }`,规则是 `算子(gt/eq/between/…) + 值 → 样式`,逐记录独立判定(`evaluateRulesForRecord`,`conditional-formatting.ts`)。

对标缺口:成熟多维表还提供**范围型(scale)**样式——data bar(单元格内按列 min/max 比例画条)、color scale(按值在 min/max 区间映射的渐变底色,2/3 色)、icon set(按阈值显示箭头/红绿灯图标)。这三者与算子模型**架构不同**:

- 不是"匹配才生效",而是**对该字段所有单元格生效**;
- 每个单元格的呈现取决于**该列的 min/max 区间**(跨记录的聚合上下文),现有逐记录判定没有这个上下文。

因此 A5 不是给 `ConditionalFormattingStyle` 加几个字段,而是引入一个**新的 scale 规则模式**。

## 2. 锁定的架构决策

### 2.1 新增 `ConditionalFormattingScaleRule`(与算子规则并列,不混用)

不把 scale 塞进 `ConditionalFormattingRule`(那会让 `operator/value` 字段失去意义)。新增并列类型:

```ts
type ScaleKind = 'dataBar' | 'colorScale' | 'iconSet'
interface ConditionalFormattingScaleRule {
  id: string
  order: number
  fieldId: string          // 仅数值类字段(number/currency/percent/rating);非数值 → 该规则忽略
  kind: ScaleKind
  enabled: boolean
  // 区间锚点:默认 'auto'(用当前作用域内该列的 min/max),也允许显式 min/max 数值
  range?: { mode: 'auto' | 'fixed'; min?: number; max?: number }
  // kind-specific config(见 §3)
  dataBar?: { color: string; negativeColor?: string; showValue?: boolean }
  colorScale?: { stops: Array<{ at: 'min' | 'mid' | 'max'; color: string }> } // 2 或 3 stop
  iconSet?: { set: 'arrows3' | 'traffic3' | 'signs3'; thresholds: [number, number] } // 百分位或绝对值
}
```

存储位置沿用 `view.config.conditionalFormattingScaleRules`(与现有 `conditionalFormattingRules` 同级,复用 `CONDITIONAL_FORMATTING_RULE_LIMIT` 上限)。

### 2.2 区间计算作用域 = 当前已加载行(client 端),与导出选择器(A2)同纪律

`range.mode='auto'` 的 min/max **在当前已加载/分页的行集上计算**(`grid.rows`),与 A2 导出选择器一致:client 端只持有已脱敏、已授权的数据,在其上算 min/max 不引入新鉴权面、不需服务端往返。**全列(超出已加载页)的 scale = 后续 slice**(与 A2 的"服务端全量导出"对称,经 #2591 类的服务端聚合通道,单独 gate)。`range.mode='fixed'` 用显式 min/max,无需聚合。

### 2.3 渲染管线扩展点

- `conditional-formatting.ts`(FE)+ `conditional-formatting-service.ts`(后端镜像,canonical):新增 `sanitizeScaleRule(s)` + `buildFieldScaleMap(rules, records, fields)` —— 对每个 scale 规则预计算该列的 `{min,max}` 与每记录的派生呈现(barPct / scaleColor / iconKey),放进与 `buildRecordFormattingMap` 并列的 map,渲染器按 `(recordId, fieldId)` 读取。
- `MetaGridTable.vue`:单元格在现有纯色样式之上叠加 scale 呈现(data bar = 单元格内绝对定位的 `<div>` 宽度 %;color scale = 背景渐变色;icon set = 值前缀图标)。**纯色规则与 scale 规则同字段共存时**:scale 决定底色/条,纯色规则的 `textColor` 仍可叠加(锁:scale 的 `backgroundColor` 优先于纯色 bg,避免双底色冲突)。
- `ConditionalFormattingDialog.vue`:新增 scale 规则编辑分区(kind 选择 + 颜色/阈值配置);非数值字段禁选。

### 2.4 安全/正确性锁

- min/max 只在 client 已持有的脱敏行上算 → 不泄露未授权行/列(继承 A2 的 client-side 安全论证)。
- `fieldId` 指向不可读/已掩码字段时,scale 规则**静默忽略**(不渲染),与现有 mask 纪律一致。
- 颜色值走现有 `sanitizeHex`;阈值/min/max 经 `Number.isFinite` 校验;`thresholds` 必须单调。
- 数值解析复用 `toComparableNumber`(字符串数值兼容)。

## 3. 三个子能力(按 slice 切)

- **A5-1 data bar**[M,首发]——最具辨识度;单元格内比例条,支持负值双向(`negativeColor`)。仅需 min/max + 每格 %。
- **A5-2 color scale**[M]——2/3 色渐变底色;复用 min/max + stop 插值。
- **A5-3 icon set**[M]——阈值 → 图标;阈值支持百分位(基于 min/max)或绝对值。

每个 slice 独立 opt-in;A5-1 落地后再决定 A5-2/3。

## 4. 不做(本弧外)

- 全列(超出已加载页)的 scale 聚合 = 服务端通道,单独 gate(对称于 A2 服务端全量导出)。
- 文本/日期字段的 scale(无需求)。
- 自定义图标上传(provider 依赖决策)。

## 5. 验证计划(实现 PR 时)

- 后端 `conditional-formatting-service` 单测:`sanitizeScaleRule` enum/单调阈值/非数值忽略;`buildFieldScaleMap` 的 min/max + 派生值(含全等值列 min==max 的退化、负值、空列)。
- FE 单测:`buildFieldScaleMap` 与后端镜像同形;`MetaGridTable` 渲染快照(bar 宽度 % / 渐变 / 图标);scale 与纯色共存的叠加优先级;非数值字段禁选。
- i18n 走 `meta-core-labels` 既有扩展点(strict-zero)。

## 6. 落地

本 PR = 设计锁。实现按 slice:A5-1(data bar)先行,contracts-first(先 schema/sanitizer + 后端镜像,再渲染,再 dialog),每 slice 独立 PR + 验证。
