# Verification: Cap Run errorSummary at MAX_ERROR_SUMMARY_LENGTH

**PR**: #1206  
**Date**: 2026-04-27

---

## Test Scenarios Added (`runner-support.test.cjs` — run-log section)

### Long error message via failRun → truncated

**Input**: `failRun(run, new Error('X'.repeat(10000)))`  
**Assertions**:
- `errorSummary.length === MAX_ERROR_SUMMARY_LENGTH` (2000)
- `errorSummary.endsWith('… [truncated]')`

### Long extra.errorSummary via finishRun → also truncated

**Input**: `finishRun(run, {}, 'failed', { errorSummary: 'X'.repeat(10000) })`  
**Assertion**: `errorSummary.length === MAX_ERROR_SUMMARY_LENGTH`

### Short message → unchanged

**Input**: `failRun(run, new Error('connection refused'))`  
**Assertion**: `errorSummary === 'connection refused'` (no suffix added)

### Absent errorSummary → undefined passes through

**Input**: `finishRun(run, {}, 'succeeded', {})` — no `errorSummary` field  
**Assertion**: `errorSummary === undefined` (DB layer handles NULL)

## Regression Guard

All 18 `plugin-integration-core` test files pass on top of latest `origin/main` (`d7fd6d6ea`):

```
✓ credential-store        ✓ adapter-contracts       ✓ http-adapter
✓ db.cjs                 ✓ plm-yuantus-wrapper     ✓ pipelines
✓ external-systems       ✓ transform-validator      ✓ runner-support
✓ payload-redaction      ✓ pipeline-runner          ✓ http-routes
✓ k3-wise-adapters       ✓ erp-feedback             ✓ e2e-plm-k3wise-writeback
✓ staging-installer      ✓ migration-sql
```

## Worktree

Branch: `codex/integration-error-summary-cap-20260427`  
Worktree: `/tmp/ms2-error-summary-cap`  
Base: `d7fd6d6ea` (origin/main after PR #1204)
