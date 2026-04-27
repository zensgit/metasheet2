# Verification: Record maxPagesReached + pagesProcessed in Run Details

**PR**: #1204  
**Date**: 2026-04-27

---

## Test Scenarios Added (Section 19)

### 19a: Cap hit with more data → maxPagesReached=true

**Setup**:
- Pipeline `options.maxPages = 2`
- Source returns 3 pages (each with `nextCursor` until the 3rd page)

**Assertions**:
- `result.run.details.maxPagesReached === true`
- `result.run.details.pagesProcessed === 2`
- Source `read()` called exactly 2 times (cap was respected)

### 19b: Source done before cap → maxPagesReached=false

**Setup**:
- Pipeline `options.maxPages = 5`
- Source returns 1 page with `done: true`, `nextCursor: null`

**Assertions**:
- `result.run.details.maxPagesReached === false`
- `result.run.details.pagesProcessed === 1`

## Regression Guard

All 18 `plugin-integration-core` test files pass:

```
✓ credential-store        ✓ adapter-contracts       ✓ http-adapter
✓ db.cjs                 ✓ plm-yuantus-wrapper     ✓ pipelines
✓ external-systems       ✓ transform-validator      ✓ runner-support
✓ payload-redaction      ✓ pipeline-runner          ✓ http-routes
✓ k3-wise-adapters       ✓ erp-feedback             ✓ e2e-plm-k3wise-writeback
✓ staging-installer      ✓ migration-sql
```

## Worktree

Branch: `codex/integration-maxpages-reached-signal-20260427`  
Worktree: `/tmp/ms2-maxpages-signal`  
Base: `202c10eff` (PR #1186, remote main)
