# Multitable Global History — Reset T-source 方向一页纸(history-anchored)(2026-07-07)

**性质:** 产品方向提案(PROPOSED)。本文**不是** design-lock,也不授权任何开工;forward-plan(#3633)中 T-source 的解锁词仍是「owner 对产品方向的明确点头」。本文的唯一目的:把这个点头压缩成一句话。

> **⚠️ 更正(2026-07-07 同日 post-hoc 对抗审阅发现,P1):** 本文初版的「现状」基于过时快照(park-neutral @ `cdd716049`,落后 origin/main 155 commits)调研,漏看了当日 06:02 已合入的 **#3749**(codex/global-history-final-code-dev)——**A2 形态当时已经上线**。初版 §1「唯一控件 = 自由 datetime-local」为伪;真实决策点不是「A1 vs A2 点头开工」,而是下方 §4 的「**保持 A2(已上线)vs 简化为 A1**」。§2 rationale 与 §3 语义边界不受影响。(教训归档:gap-analysis 必须对 fresh origin/main,勿信「park-neutral≈origin/main」的口头前提。)

## 1. 现状(更正后;以 `origin/main@4bb668fa5` 为准)

- **history-anchored 主路径已上线(#3749)**:`apps/web/src/multitable/components/ResetToPointPicker.vue:19-25` 是「History point」批次 `<select>`(`selectedBatchId`,由最近 Global History 批次填充);自由 `datetime-local` 已降级为「Advanced manual time」`<details>` 兜底(`:51-64`);`mode` 默认 `'history'`(`:120`)。
- 后端 reset-preview/execute 只收 `asOf` 时间戳(`packages/core-backend/src/routes/univer-meta.ts:9723-9749` / `:9764-9786`),per-record 解析到 `created_at <= T` 的最近 revision(`record-reconstructor.ts:34-68`,PIT-4 确定序)——锚定路径与手动路径共用同一 `asOf` 契约,后端零分叉。
- HistoryCenter batch 行字段即锚点素材:`batchId`/`createdAt`/`actorName`/`source`/`action`/counts(`apps/web/src/multitable/types.ts:338-350`)。

## 2. 为什么 history-anchored(而非自由时间)

1. **语义无损**:任意自由 T 的重建结果 ≡「最近一次 ≤T 的变更点」的重建结果——两个变更点之间的自由时间戳不产生任何新状态,只产生伪精度。
2. **误导性归零**:锚定后每个可选 T 都对应一个真实存在过的表状态,preview 摘要与用户预期天然一致。
3. **改动面最小**:只换 picker 的 T 来源(选中 batch 的 `createdAt` 直接作为 `asOf` 传下去)。后端零改动、契约零改动、flag 状态零改动(`PIT_RESET` 仍默认关,且其 STOP-SHIP 条件不受影响)。

## 3. V1 语义边界(建议随点头一并锁死)

- 锚点语义 = **「恢复到该批次完成后的状态」**(`asOf = batch.createdAt`,含该批次;与 `created_at <= T` 完全一致,零语义偏移)。注:同一毫秒存在**兄弟批次**时,锚定其一会把并列批次一并含入(两者都 `<= T`)——该措辞在此情形下是近似,精确到批次的排除属 V2。
- 「恢复到该批次**之前**」不进 V1:需要排他界,且同一时间戳多批次(批量导入)存在边界并列。将来若要精确批次排除,现成 prior art = config-restore 的 `revisionId` 锚定(`univer-meta.ts:8219-8225`)与 record-restore 的 `targetVersion`(`client.ts:2158`)。
- retention 削薄后锚点只列幸存批次——与重建现实(只能基于幸存 revision)一致,反而消除自由时间戳在已清历史区间上的假象。

## 4. 决策点(更正后)

- **B1(维持现状):保持 A2** — 锚定默认 + Advanced 手动兜底(#3749 已上线形态,含 29 个 FE 测试)。兜底留给「历史被 retention 清薄后想指定更早时点」等边角;代价是双 T 路径测试面长期存在。
- **B2:简化为 A1(anchored-only)** — 移除 Advanced 兜底(§2.1 语义冗余论仍成立);减一条 T 路径与其测试面;代价是失去逃生口。

## 5. 点头后的执行承诺(不点头不动)

若择 **B1**:零工作,本文即闭。若择 **B2**:单车道小 slice(Sonnet 5 建 + Fable 5 审;FE-only 移除 + 测试收敛;验证 MD 随轮交付)。

**解锁词示例:「保持 A2」或「简化为 A1」。**
