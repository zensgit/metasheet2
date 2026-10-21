# Q4c PR-2: stock-preparation 读面 openapi 契约补齐（design, short）

2026-09-21

## 范围

机械补齐，不改任何路由行为。给 stock-preparation MVP view 2（BOM 快照批次 & Diff）的三条既存
只读路由补 `packages/openapi` 契约：

| 方法+路径 | 处理器 | 来源 |
|---|---|---|
| GET /api/integration/stock-preparation/snapshot-batches | `stockPreparationSnapshotBatchList` | `plugins/plugin-integration-core/lib/http-routes.cjs:7469`（路由表 `:144`）→ `listSnapshotBatches`（`lib/stock-preparation-snapshot-reads.cjs:228`） |
| GET /api/integration/stock-preparation/snapshot-batches/{id}/diff | `stockPreparationSnapshotDiff` | `http-routes.cjs:7491`（路由表 `:145`）→ `getSnapshotDiff`（`lib/stock-preparation-snapshot-reads.cjs:404`） |
| GET /api/integration/stock-preparation/snapshot-batches/{id}/diff/rows | `stockPreparationSnapshotDiffRows` | `http-routes.cjs:7515`（路由表 `:148`）→ `listSnapshotDiffRows`（`lib/stock-preparation-snapshot-reads.cjs:558`） |

同族只读路由核查：亲读了 `http-routes.cjs` 里全部 `['GET', '/api/integration/stock-preparation/...`
路由表条目（26 条），`/snapshot-batches` 前缀下只有这三条；不存在
`/snapshot-batches/{id}`（单批次读）这类第四条。物料映射/单位换算的四条读路由
（`material-mappings/summary|candidates`、`unit-conversions/summary|candidates`）是另一个投影族
（W3 confirm reads），不在本任务范围，留作后续 PR。

Q4c PR-1（`/api/integration/*` 核心读面，同一 worktree 分支
`docs/openapi-integration-read-contracts`，#5949）已明确把本 PR 分出去；两支各自基于 `origin/main`
独立开出，不互相叠加。

## 做法

1. 亲读三个处理器 + 各自调用的读函数（`listSnapshotBatches`/`getSnapshotDiff`/
   `listSnapshotDiffRows`）+ 其内部共享的辅助函数（`batchSummary`/`isBatchIncomplete`/
   `changeCountsFromEvidence`/`resolveDiffBase`/`assertDiffBatchComplete`/`diffBatchAmbiguous`/
   `projectDiffRow`），逐条记 `path:line` 写进新 yml 的注释头。
2. 新增 6 个 schema（`base.yml`，紧接在既有 `IntegrationPipelineRun` 之后）：
   `StockPreparationSnapshotBatchSummary`/`StockPreparationSnapshotBatchListResult`/
   `StockPreparationSnapshotChangeCounts`/`StockPreparationSnapshotDiffResult`/
   `StockPreparationSnapshotDiffRow`/`StockPreparationSnapshotDiffRowsResult`，逐字段对应各自的
   投影函数；复用既有 `ErrorResponse`/`Unauthorized`/`Forbidden`。
3. 一个新 path 文件（`build.ts` 按文件名排序合并，无需登记别处）：
   `packages/openapi/src/paths/integration-stock-prep-read.yml`。
4. `changeCounts` 10 键枚举齐全，含 Q3c 补的两键：`changeCountsFromEvidence`
   （`stock-preparation-snapshot-reads.cjs:263`）逐一读源确认 10 个键：
   `added/removed/quantityChanged/unitChanged/versionChanged/pathChanged/missingChildBom/
   fingerprintChanged/componentCodeChanged/materialChanged`；后两个是 #5932（Q3c）新补的指纹分解
   键，`fingerprintChanged`（`source_fingerprint_changed`）与它们相互独立（一行可同时命中多个
   changeType，互不相减）。
5. 每条契约记录了非默认行为，均来自亲读，而非猜测：
   - 三条路由都是 **`requireAccess(req, 'admin')`** 门（`http-routes.cjs:7470`/`:7492`/`:7516`），
     比同模块内 `stockPreparationProjectList`（`requireAccess(req, 'read')`，见该路由处理器自身
     `:7449` 及其上方注释 "read-gated (broader than the rest of this module)"）更窄——契约里显式
     写明这一点，避免调用方以为整个 `/stock-preparation/*` 前缀都是同一门槛。
   - **`workspaceId` 是死参数**：三条路由的 `*Input` 解析函数都把 `workspaceId` 塞进返回对象
     （`stockPreparationSnapshotBatchListInput`/`...DiffInput`/`...DiffRowsInput`，
     `http-routes.cjs:2614`/`:2632`/`:2651`），但三个 handler 调用
     `listSnapshotBatches`/`getSnapshotDiff`/`listSnapshotDiffRows` 时都没有把 `workspaceId`
     传进去（`:7478-7484`/`:7500-7508`/`:7524-7533` 逐行核对，均无 `workspaceId` 键）——查询允许
     它出现，但完全不影响结果。写进了三条路由各自的参数说明，不留给调用方猜。
   - DIFF / DIFF-ROWS 的 `projectId` 只是**兜底**：正常路径从被 diff 的 CURRENT 批次行本身读
     `projectId`（FE 的 diff 调用从不传它），只有当那一行读不到时才退回查询里的 `projectId`
     （`getSnapshotDiff`/`listSnapshotDiffRows` 内 `let projectId = optionalString(businessProjectId)`
     后紧跟 `if (currentBatchRow) { projectId = ... || projectId }`，`stock-preparation-snapshot-
     reads.cjs:432-441`/`:585-596`）——不是过滤被 diff 批次本身（批次 id 已经在路径里）。
   - DIFF-ROWS 的 `reviewStatus`/`diffType` 枚举校验有两层，但第二层（读函数内部
     `SNAPSHOT_READS_CONFIG_INVALID` belt-and-braces 重复检查，`:567-573`）在 HTTP 层不可达——路由
     自己的 `VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_QUERY_KEYS` 校验先跑并已经用自己的
     `STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_REQUEST_INVALID` 400 拒绝了非法值（该模块自己的注释
     `:565` 也这么写："the route allowlist rejects these first with its own 400 code"）。契约只
     记录了实际可达的那个 400。
   - `previousPathKeyFingerprint`/`currentPathKeyFingerprint` 在无对应行或该行无 `pathKey` 时是
     **整键省略**，不是 `null`：`makeDiff` 直接把值设为字面量 `undefined`
     （`stock-preparation-snapshot-diff.cjs:267-268`），而 `projectDiffRow` 的投影循环显式
     `if (value !== undefined) out[key] = ...`（`stock-preparation-snapshot-reads.cjs:546-549`）——
     两个字段因此没有列进 schema 的 `required`。`previousSnapshotLineId`/`currentSnapshotLineId`
     走的是 `optionalString`，undefined 输入会归一化成 `null`（不省略），所以这两个字段仍在
     `required` 里、只是 `nullable: true`。
   - `reason` 字段是当前封闭的 9 个字符串诊断 token（`previous_missing_path_key` /
     `current_missing_path_key` / `previous_duplicate_path_key` / `current_duplicate_path_key` /
     `matched_path_changed` / `matched_path_unchanged` /
     `matched_identity_path_or_parent_changed` / `missing_from_current_snapshot` /
     `new_in_current_snapshot`，逐一读 `addMissingKeyDiffs`/`addDuplicateKeyDiffs`/
     `addMatchedByPathDiffs`/`addMovedIdentityDiffs`/`addAddedRemovedDiffs`
     确认），但引擎没有把它们收进一个像 `CHANGE_TYPES` 那样的具名常量集合，schema 里因此没有把
     它按枚举写死，只列了当前的取值集合并注明"非承诺稳定"。

## 未做 / 边界

- 不改任何处理器/读函数代码，纯文档。
- write 面（无——这三条读路由本身没有对应的 write 端点；`material-mappings`/`unit-conversions`
  的 confirm/retire 写路由，以及 `source-runs` 的 PLM/ERP 摄入 POST）不在本 PR。
- `material-mappings`/`unit-conversions` 的四条读路由（另一投影族）不在本 PR，留给后续 PR。
- 三个"应当不可达"的 500 级内部不变量守卫（`SNAPSHOT_READS_TEMPLATE_MISSING`/
  `SNAPSHOT_READS_OBJECT_ID_NOT_MVP`/`SNAPSHOT_READS_RECORDS_API_INVALID`）比照 PR-1 的先例
  （PR-1 同样只文档化了可达的 501，没有文档化任何 500）未写进契约——它们是"目标表被换成非 MVP
  对象/queryRecords 违反自身接口约定"级别的编程错误保证，不是正常操作下调用方会撞见的响应。
- PR-1（`/api/integration/*` 核心读面）不在此 PR，各自独立分支、独立基于 `origin/main`。

## 验证

见同名 `-verification-20260921.md`（短版）：build/validate/generate:sdk/guard:codegen 全绿 +
diff 摘要 + 反斜杠扫描。
