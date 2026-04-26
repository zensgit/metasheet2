# Verification: Cap List Endpoint Offset at MAX_LIST_OFFSET

**PR**: #1199  
**Date**: 2026-04-26

---

## Test Scenarios Added (`testListOffsetCap`)

### All 4 list endpoints: huge offset → clamped to MAX_LIST_OFFSET

**Input**: `offset: String(MAX_LIST_OFFSET + 999999)` on each of:
- `GET /api/integration/external-systems`
- `GET /api/integration/pipelines`
- `GET /api/integration/runs`
- `GET /api/integration/dead-letters`

**Assertions**:
- `listExternalSystems` receives `offset === MAX_LIST_OFFSET`
- `listPipelines` receives `offset === MAX_LIST_OFFSET`
- `listPipelineRuns` receives `offset === MAX_LIST_OFFSET`
- `listDeadLetters` receives `offset === MAX_LIST_OFFSET`

### offset=0 → treated as undefined (no offset)

**Input**: `offset: '0'`

**Assertion**: `listPipelines` receives `offset === undefined`

### Small valid offset → passes through unchanged

**Input**: `offset: '50'`

**Assertion**: `listPipelines` receives `offset === 50`

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

Branch: `codex/integration-list-offset-cap-20260426`  
Worktree: `/tmp/ms2-list-offset-cap`  
Base: `202c10eff` (PR #1186, remote main)
