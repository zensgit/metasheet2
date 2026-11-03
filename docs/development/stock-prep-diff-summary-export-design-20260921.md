# 备料批次 diff「导出对账摘要」（客户端版）— 设计（Q3c）

2026-09-21。范围：`StockPreparationSnapshotDiffView.vue`（批次详情 / view 2）新增一个「导出对账摘要」按钮，
外加它揭出的一个既有缺口：changeCounts 词表缺 `componentCodeChanged` / `materialChanged` 两类（引擎早已产出，
汇总只是没读）。

## 侦察事实

- `apps/web/src/components/integration/stockPreparation/StockPreparationSnapshotDiffView.vue` 已经读
  `snapshot-batches`、`/diff`、`/diff/rows` 三条只读 GET，渲染批次列表 + 汇总计数 + 逐行明细（懒加载）。
- `changeCounts` 词表在两处重复：
  - 后端 `plugins/plugin-integration-core/lib/stock-preparation-snapshot-reads.cjs:263`
    `changeCountsFromEvidence` —— 只读 `evidence.result.byChangeType` 里固定 8 个 key。
  - 前端 `StockPreparationSnapshotDiffView.vue` 的 `changeCountEntries` computed —— 同样固定 8 项。
- 引擎（`stock-preparation-snapshot-diff.cjs` `compareMatchedRows`）早就算出
  `COMPONENT_CODE_CHANGED` / `MATERIAL_CHANGED` 两个独立 changeType（指纹分解，见
  `docs/development/platform-overall-design/stock-prep-change-adjudication-20260901.md`），并把它们计入
  `evidence.result.byChangeType` —— 只是 `changeCountsFromEvidence` 从没把这两个 key 抄出来。两份既有测试
  （`scenario-b-v2-snapshot-diff.test.cjs`、`StockPreparationScenarioBAcceptance.spec.ts`）把这个缺口钉成了
  断言（"已知缺口" 注释 + `componentCodeChanged` 应为 `null`/不存在）——这次是把断言反过来钉紧，不是绕过。
- 已有 CSV 工具：`apps/web/src/services/integration/stockPreparation/stockPrepCsv.ts`
  （`downloadCsvFile` / `escapeCsvCell`，UTF-8 BOM，opt-in 的公式注入防护）。
  `StockPreparationProjectSyncPanel.vue` 的「导出 CSV」（缺件清单）是现成的调用范式，本次照抄。

## 做什么

1. **补齐词表（两处）**：
   - `stock-preparation-snapshot-reads.cjs` `changeCountsFromEvidence`：追加
     `componentCodeChanged: byChangeType[CHANGE_TYPES.COMPONENT_CODE_CHANGED] || 0` 和
     `materialChanged: byChangeType[CHANGE_TYPES.MATERIAL_CHANGED] || 0`。两者与既有的
     `fingerprintChanged`（`SOURCE_FINGERPRINT_CHANGED` 的计数）相互独立 —— 一行可以同时携带
     `COMPONENT_CODE_CHANGED` 和 `SOURCE_FINGERPRINT_CHANGED`（`compareMatchedRows` 两条判断都会 push），
     所以新增两个 key 不改变任何既有计数的数值，纯新增。
   - `apps/web/src/services/integration/stockPreparation/plainLanguage.ts`
     `STOCK_PREP_DIFF_KIND_PLAIN`：追加 `componentCodeChanged`（「原位换了零件号」）和
     `materialChanged`（「原位换了材质」）两条中英词条。
   - `StockPreparationSnapshotDiffView.vue` `changeCountEntries`：追加这两个 key，从 8 项变 10 项。
   - `apps/web/src/services/integration/stockPreparation/bomSnapshotDiff.ts`
     `StockPreparationSnapshotDiffSummary.changeCounts` 类型追加两个字段。
2. **导出对账摘要按钮**（DiffView.vue，纯客户端，零新增 GET）：
   - 位置：汇总计数 `<dl>` 下方，逐行明细折叠区之上。
   - `buildDiffSummaryCsv()` 用当前已在页面上的数据（`diff.value` / `result.value.batches` /
     可能已加载的 `diffRows.value`）拼出一张 `section,key,value` 三列 CSV：
     - `batch` 段：当前批次 id + version、base 批次 id + version（内部句柄 + 数字，不是业务值）。
     - `summary` 段：`blockingExceptionCount`，以及 `readyRowCount`/`heldRowCount` —— **只有** 逐行明细
       已经被展开加载过（`diffRows.value` 非空）才填数字，否则留空；导出按钮本身**绝不**触发
       `/diff/rows` 的新 GET（这是「客户端版」的核心约束——不能因为点了导出就多打一次后端）。
     - `changeCount` 段：`changeCountEntries` 当前渲染的全部 10 项，键名与屏幕上一致。
     - `rowId` 段：**只有**明细已加载才有——按 `(changeType, diffId)` 逐行展开（一行如果同时属于两个
       changeType，就出现两条），让人能从「N 行原位换了零件号」直接跳到具体是哪几行，而不必导出
       任何物料名/数量/图号。
   - values-free：每一格要么是计数、要么是固定枚举 token（`changeType` 用后端 snake_case 原始
     token，如 `component_code_changed`），要么是内部句柄（`snapshotBatchId` / `diffId`）——
     从不导出物料名、数量、图号、单位、路径键。PR 正文会点明「这是摘要不是明细」。
   - 复用 `downloadCsvFile`（`guardFormulas: true`，与缺件清单导出一致的防护姿态，虽然这里每格
     本就是受控格式，属于防御性统一而非必要）。文件名
     `stock-prep-diff-summary-<currentSnapshotBatchId>-<yyyymmdd>.csv`。

## 不做什么

- 不新增后端路由、不新增 GET——`held`/`ready` 计数与逐行 id 列表完全依赖前端已经拿到手的数据，
  没拿到就留空，绝不为了导出去多请求一次。
- 不导出任何业务值（物料名/数量/图号/单位/路径键）——见测试里的「planted 值」反向断言。
- 不改动 `plugins/.../lib/http-routes.cjs`，因此不涉及 `pins.json` 重算；不新增
  `__tests__/*.test.cjs` 文件，因此不改 `test-chain.txt`。

## 测试

- 新增 `apps/web/tests/StockPreparationDiffSummaryExport.spec.ts`：驱动真实
  `downloadCsvFile`（Blob 内容被捕获、`<a>.click()` 被 spy，不是把整个函数 mock 掉），断言：
  - 表头 `section,key,value`；未展开明细时 `changeCount` 段十项齐全、`rowId` 段完全缺席、
    held/ready 留空、且不触发 `listStockPreparationSnapshotDiffRows`；
  - 展开明细后 held/ready 有数字、`rowId` 按 `(changeType, diffId)` 逐条出现（一行两个 changeType
    出现两条，零 changeType 的行不出现）；
  - 两处都做 values-free 反向断言（种下图号/材质代码/数量，导出文本里必须查不到）；
  - 变异用例：把 `componentCodeChanged` 从 `changeCountEntries` 数组里删掉 → 手动验证两条用例都红
    （见「验证」文档），删除后再放回。
- 更新既有前端/后端测试的固定 8 键快照为 10 键（`StockPreparationSnapshotDiffView.spec.ts`、
  `StockPreparationScenarioBAcceptance.spec.ts`、`stock-preparation-snapshot-reads.test.cjs`、
  `scenario-b-v2-snapshot-diff.test.cjs`），把两处「已知缺口」注释/断言改写成「缺口已关」的实际值
  （`componentCodeChanged: 1` 用真实场景跑出来的数字，不是猜的——见验证文档）。
