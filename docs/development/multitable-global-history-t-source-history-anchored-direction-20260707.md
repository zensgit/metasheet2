# Multitable Global History — Reset T-source 方向一页纸(history-anchored)(2026-07-07)

**性质:** 产品方向提案(PROPOSED)。本文**不是** design-lock,也不授权任何开工;forward-plan(#3633)中 T-source 的解锁词仍是「owner 对产品方向的明确点头」。本文的唯一目的:把这个点头压缩成一句话。

## 1. 现状(primary-source 已核)

- 用户选 T 的唯一控件 = 自由 `datetime-local` 输入(`apps/web/src/multitable/components/ResetToPointPicker.vue:19-25`)。`asOf` 派生处是作者预留的 **single swappable seam**(`:67-74`;头注 `:6-8` 明确写了 deferred 替代方案就是「把 HistoryCenterModal 最近批次时间戳做成可选项」)。
- 后端 reset-preview/execute 只收 `asOf` 时间戳(`packages/core-backend/src/routes/univer-meta.ts:9580-9586` / `:9620-9627`),per-record 解析到 `created_at <= T` 的最近 revision(`record-reconstructor.ts:34-68`,PIT-4 确定序)。
- HistoryCenter batch 行已具备全部锚点素材:`batchId`/`createdAt`/`actorName`/`source`/`action`/counts(`apps/web/src/multitable/types.ts:338-350`;`HistoryCenterModal.vue:44-50`)。

## 2. 为什么 history-anchored(而非自由时间)

1. **语义无损**:任意自由 T 的重建结果 ≡「最近一次 ≤T 的变更点」的重建结果——两个变更点之间的自由时间戳不产生任何新状态,只产生伪精度。
2. **误导性归零**:锚定后每个可选 T 都对应一个真实存在过的表状态,preview 摘要与用户预期天然一致。
3. **改动面最小**:只换 picker 的 T 来源(选中 batch 的 `createdAt` 直接作为 `asOf` 传下去)。后端零改动、契约零改动、flag 状态零改动(`PIT_RESET` 仍默认关,且其 STOP-SHIP 条件不受影响)。

## 3. V1 语义边界(建议随点头一并锁死)

- 锚点语义 = **「恢复到该批次完成后的状态」**(`asOf = batch.createdAt`,含该批次;与 `created_at <= T` 完全一致,零语义偏移)。
- 「恢复到该批次**之前**」不进 V1:需要排他界,且同一时间戳多批次(批量导入)存在边界并列。将来若要精确批次排除,现成 prior art = config-restore 的 `revisionId` 锚定(`univer-meta.ts:8085-8091`)与 record-restore 的 `targetVersion`(`client.ts:2158`)。
- retention 削薄后锚点只列幸存批次——与重建现实(只能基于幸存 revision)一致,反而消除自由时间戳在已清历史区间上的假象。

## 4. 两个可点头的选项

- **A1(推荐):anchored-only** — 移除自由 datetime 输入,picker = HistoryCenter 最近批次列表(复用既有游标 loadMore)。理由:自由时间戳语义冗余(§2.1),保留只增加误用面与双路测试面。
- **A2(保守):anchored 默认 + 自由 datetime 收进「高级」折叠** — 保底逃生口,代价是保留伪精度入口,且两条 T 路径都要长期养测试。

## 5. 点头后的执行承诺(不点头不动)

单车道单轮:Sonnet 5 建 + Fable 5 审;FE-only + 少量 wiring;golden 覆盖(锚点选择→`asOf` 传参→preview 摘要一致性;空历史 / retention 削薄 / 同时间戳并列边角);验证 MD 随轮交付。

**解锁词示例:「T-source 按 A1 做」或「按 A2 做」。**
