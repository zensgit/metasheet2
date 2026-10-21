# 备料批次 diff「导出对账摘要」— 验证（Q3c）

2026-09-21。对应设计见同目录
`stock-prep-diff-summary-export-design-20260921.md`。commit 前在
`C:/Users/zhou/Downloads/dev/metasheet-wt-w8q` worktree 内实测，非猜测。

## 1. 后端：词表补齐的单测

```
node __tests__/stock-preparation-snapshot-reads.test.cjs
  → stock-preparation-snapshot-reads.test.cjs: 23 passed, 0 failed

node __tests__/scenario-b-v2-snapshot-diff.test.cjs
  → testTwoImmutableBatchesLand OK
    testEngineClassifiesFourChangeKinds OK
    testDiffReadRoutesServeTheSameFourKinds OK
    testSameBatchRerunConflictsAndDiffIsStable OK
    testMutationRestoringDeletedChildTurnsRemovedRed OK
    testMutationRowCountOnlyDiffTurnsChangedRed OK
    testMutationUndoingSubstitutionTurnsComponentCodeRed OK
    testFlagDefaultOffStaysReadOnly OK
    scenario-b-v2-snapshot-diff: all OK

node __tests__/scenario-b-staging-persist.test.cjs
  → 10/10 OK（未改动，跑一遍确认没被词表改动波及）
```

`testDiffReadRoutesServeTheSameFourKinds` 场景下的真实数字（跑出来的，不是编的）：
`componentCodeChanged: 1`、`materialChanged: 0`、`fingerprintChanged` 保持 `2` 不变 ——
证明两个新 key 与既有 `fingerprintChanged` 相互独立（一行可以同时携带
`COMPONENT_CODE_CHANGED` 与 `SOURCE_FINGERPRINT_CHANGED`），新增不改变任何既有计数。

## 2. 前端：类型检查

```
cd apps/web && npx vue-tsc -b
  → 无输出，退出码 0
```

## 3. 前端：spec 三件套（新增 + 两个既有回归）

```
cd apps/web && npx vitest run --watch=false \
  tests/StockPreparationDiffSummaryExport.spec.ts \
  tests/StockPreparationSnapshotDiffView.spec.ts \
  tests/StockPreparationScenarioBAcceptance.spec.ts

  ✓ tests/StockPreparationDiffSummaryExport.spec.ts (3 tests) 90-102ms
  ✓ tests/StockPreparationScenarioBAcceptance.spec.ts (6 tests) 228-237ms
  ✓ tests/StockPreparationSnapshotDiffView.spec.ts (31 tests) 296-330ms
  Test Files  3 passed (3)
  Tests  40 passed (40)
```

## 4. 变异自证（内存级，锚点单行，未落盘残留）

**变异**：在 `StockPreparationSnapshotDiffView.vue` 的 `changeCountEntries` 数组里删掉
`{ key: 'componentCodeChanged', value: counts.componentCodeChanged },` 这一行（`Edit` 工具单行
`old_string`/`new_string`，命中且仅命中 1 次），使汇总面板的 10 项词表退回 9 项（缺
`componentCodeChanged`，`materialChanged` 仍在）。

**跑测试**（同一条命令，只跑新 spec）：

```
npx vitest run --watch=false tests/StockPreparationDiffSummaryExport.spec.ts

FAIL  ... 变异后
  ✗ exports header + batch/summary/changeCount rows WITHOUT opening row detail, ...
    AssertionError: expected '\ufeffsection,key,value\n...' to contain
    'changeCount,componentCodeChanged,1'
  ✗ fails if componentCodeChanged/materialChanged are missing from the exported changeCount vocabulary
    AssertionError: expected [ 'added', ..., 'materialChanged' ] (9 项)
      to deeply equal [ 'added', ..., 'componentCodeChanged', 'materialChanged' ] (10 项)

Test Files  1 failed (1)
Tests  2 failed | 1 passed (3)
```

两条用例按预期变红，第三条（held/ready + rowId 那条，不断言 changeCount 全集顺序）保持绿——
证明红的原因确实是词表缺口，不是无关断言碰巧命中。

**复原**：把那一行加回（同一处 `Edit`），重跑：

```
npx vitest run --watch=false tests/StockPreparationDiffSummaryExport.spec.ts \
  tests/StockPreparationSnapshotDiffView.spec.ts tests/StockPreparationScenarioBAcceptance.spec.ts

Test Files  3 passed (3)
Tests  40 passed (40)
```

## 5. values-free 反向断言

`StockPreparationDiffSummaryExport.spec.ts` 在两个 diff-rows 里种下
`PLANTED_DRAWING_NO` / `PLANTED_MATERIAL_CODE` / `PLANTED_QUANTITY` 三个业务值作为
mock 行对象上的额外字段（视图不认识的 key），两条主用例都在导出的 CSV 全文里断言
`not.toContain` 这三个值——通过。这证明导出路径读的是固定白名单字段
（`snapshotBatchId` / `diffId` / `changeTypes` 枚举 token / 计数），不是把整行序列化。

## 6. diff 干净性

```
git diff origin/main | grep -P '\x08'
  → 空（无反斜杠退格字节）
```

## 残余 / 已知限制

- `held`/`ready` 计数与逐行 id 列表只在操作者已经点开「看逐行明细」之后才出现在导出里；
  未点开时这两段留空——这是设计里明确的取舍（导出按钮本身不应该触发新的 GET），不是 bug。
  PR 正文会说明这一点。
- 后端 `changeCountsFromEvidence` 的两个新 key 目前只有 `stock-preparation-snapshot-reads.test.cjs`
  和 `scenario-b-v2-snapshot-diff.test.cjs` 覆盖真实的引擎产出路径；没有为它们单独新写一份
  `__tests__/*.test.cjs`（沿用既有测试改断言，未新增文件，因此 `test-chain.txt` 无需登记新行）。
