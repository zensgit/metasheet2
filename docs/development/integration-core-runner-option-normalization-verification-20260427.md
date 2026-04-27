# Verification: Normalize Pipeline Runner Paging Options

**Date**: 2026-04-27  
**Branch**: `codex/integration-next-hardening-20260427`  
**Base**: `f372b9180` (`origin/main` after PR #1206)

---

## Test Scenarios Added

### `batchSize = 0`, `maxPages = 0`

Setup:

- Pipeline options are hand-edited to `{ batchSize: 0, maxPages: 0 }`.
- Source adapter returns one valid record.

Expected:

- Adapter receives `limit === 1000`.
- Runner reads one page instead of producing a silent no-op.
- `result.metrics.rowsRead === 1`.
- `result.run.details.pagesProcessed === 1`.
- Target receives the valid record.

### Huge `batchSize`

Setup:

- Pipeline options are hand-edited to `{ batchSize: 999999, maxPages: 1 }`.

Expected:

- Source adapter receives `limit === 10000`.
- Oversized batch requests are capped before they reach vendor adapters.

## Local Commands

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f"; done
```

## Expected Result

All 18 `plugin-integration-core` CJS test files pass on top of `origin/main`.
