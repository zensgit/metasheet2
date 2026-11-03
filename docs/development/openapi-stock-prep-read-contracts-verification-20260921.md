# Q4c PR-2 verification（短版）

2026-09-21

## 契约来源表（每条路径在 `src/paths/integration-stock-prep-read.yml` 里的注释头也各自重复了这一行）

| 路径 | 处理器 path:line | 读函数 path:line | 关键辅助函数 path:line |
|---|---|---|---|
| GET /api/integration/stock-preparation/snapshot-batches | `plugins/plugin-integration-core/lib/http-routes.cjs:7469` | `plugins/plugin-integration-core/lib/stock-preparation-snapshot-reads.cjs:228`（`listSnapshotBatches`） | `batchSummary`（同文件 `:201`）、`isBatchIncomplete`（`:197`）、`orderBatches`（`:215`） |
| GET /api/integration/stock-preparation/snapshot-batches/{id}/diff | `lib/http-routes.cjs:7491` | `lib/stock-preparation-snapshot-reads.cjs:404`（`getSnapshotDiff`） | `changeCountsFromEvidence`（`:263`）、`resolveDiffBase`（`:317`）、`assertDiffBatchComplete`（`:374`）、`diffBatchAmbiguous`（`:363`） |
| GET /api/integration/stock-preparation/snapshot-batches/{id}/diff/rows | `lib/http-routes.cjs:7515` | `lib/stock-preparation-snapshot-reads.cjs:558`（`listSnapshotDiffRows`） | 同上 + `projectDiffRow`（`:543`）、`DIFF_ROW_KEYS`（`:526`）、`MAX_DIFF_ROWS=2000`（`:539`） |

查询允许列表逐一读源确认：`VALID_STOCK_PREPARATION_SNAPSHOT_READ_QUERY_KEYS`
（`http-routes.cjs:1708`，`tenantId/workspaceId/projectId`）、
`VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_QUERY_KEYS`（`:1715`，+`baseSnapshotBatchId`）、
`VALID_STOCK_PREPARATION_SNAPSHOT_DIFF_ROWS_QUERY_KEYS`（`:1721`，+`reviewStatus`/`diffType`）。
输入解析函数：`stockPreparationSnapshotBatchListInput`（`:2614`）、
`stockPreparationSnapshotDiffInput`（`:2632`）、`stockPreparationSnapshotDiffRowsInput`（`:2651`）。
错误码/枚举来源同样亲读确认：`requireAccess`（`:934`，401 UNAUTHENTICATED / 403 FORBIDDEN）、
`resolveTenantId`（`:1037`，400 TENANT_REQUIRED / 403 TENANT_CONTEXT_REQUIRED / 403
TENANT_MISMATCH）、`DIFF_TYPES`/`CHANGE_TYPES`/`REVIEW_STATUSES`/`BLOCKING_CHANGE_TYPES`
（`stock-preparation-snapshot-diff.cjs:5`/`:13`/`:34`/`:39`）。

## 命令与结果

同一 worktree `C:/Users/zhou/Downloads/dev/metasheet-wt-w8s`（PR-1 已在此装过
`@metasheet/openapi`/`@metasheet/sdk` 依赖，本次直接复用，未重新 `pnpm install`）：

```
$ export PATH="$PATH:/c/Users/zhou/AppData/Roaming/npm"
$ cd packages/openapi

$ pnpm run build
Built OpenAPI to dist with parts: [ ..., 'integration-runs.yml', 'integration-stock-prep-read.yml', ... ]

$ pnpm run validate
OpenAPI security validation passed

$ pnpm run generate:sdk
✨ openapi-typescript 7.13.0
🚀 dist/openapi.yaml → dist-sdk/index.d.ts [665.4ms]
SDK packaged to dist-sdk

$ pnpm run guard:codegen
[openapi-guard] OK: source needles present in generated dist (content, not mtime)
... (既有 FormField/record-link 等既有断言，未受影响)
[openapi-guard] all checks passed
```

## Diff 摘要

```
$ git status --short
M  packages/openapi/dist-sdk/index.d.ts
M  packages/openapi/dist/combined.openapi.yml
M  packages/openapi/dist/openapi.json
M  packages/openapi/dist/openapi.yaml
M  packages/openapi/src/base.yml
A  packages/openapi/src/paths/integration-stock-prep-read.yml
```

`dist-sdk/client.js`/`client.d.ts`/`index.js` 被 `generate:sdk` 重新写出但内容无实质变化（与
PR-1 观察一致），未出现在 `git status` 里。

## 反斜杠 / 退格字节扫描

```
$ git diff origin/main | grep -P '\x08'
(空)
```

## 未跑 / 不适用

- 本 PR 不改后端路由或前端代码，因此不适用 `stock-prep-web-ci-coverage-enumeration.test.ts` 的
  枚举核验、`run-required-web-tests.sh`/`integration-guard-run-web-specs.sh` 的 token 登记（无新
  web spec）、`vue-tsc -b`（无前端代码改动）。
- 未跑 `computePackageProvenancePinSet`：本 PR 未改动
  `plugins/plugin-integration-core/index.cjs`、`lib/http-routes.cjs`、`lib/sealed-export/*` 或
  `.github/workflows/plugin-tests.yml`，只改了 `packages/openapi/**` 与两份 `docs/**`，pin 集合
  不受影响。
- 未跑后端/前端单测（本 PR 不改 `plugins/plugin-integration-core/lib/*.cjs` 或 `apps/web/**`
  代码，只读了它们）。
