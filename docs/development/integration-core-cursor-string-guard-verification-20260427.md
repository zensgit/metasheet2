# Verification: Reject Non-String Cursor at REST API Boundary

**PR**: #1203  
**Date**: 2026-04-27

---

## Test Scenarios Added (`testCursorStringGuard`)

### Object cursor → 400 INVALID_CURSOR

**Input**: `body.cursor = { malicious: true }` on `/run`  
**Assertions**:
- `statusCode === 400`
- `error.code === 'INVALID_CURSOR'`
- `error.details.received === 'object'`

### Array cursor → 400 INVALID_CURSOR (received='array')

**Input**: `body.cursor = ['c', 'd']` on `/dry-run`  
**Assertions**:
- `statusCode === 400`
- `error.code === 'INVALID_CURSOR'`
- `error.details.received === 'array'` (distinguished from `object`)

### Numeric cursor → 400 INVALID_CURSOR

**Input**: `body.cursor = 42` on `/run`  
**Assertions**:
- `statusCode === 400`
- `error.code === 'INVALID_CURSOR'`

### String cursor → passes through

**Input**: `body.cursor = 'page-token-abc'` on `/run`  
**Assertions**:
- `statusCode === 202`
- `runPipeline` receives `cursor === 'page-token-abc'`

### Absent cursor → not in input

**Input**: no `cursor` field in body  
**Assertion**: `'cursor' in runPipelineCall` is `false`

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

Branch: `codex/integration-cursor-string-guard-20260427`  
Worktree: `/tmp/ms2-cursor-guard`  
Base: `202c10eff` (PR #1186, remote main)
