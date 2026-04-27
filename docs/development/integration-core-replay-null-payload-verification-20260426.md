# Verification: Reject Null/Non-Object sourcePayload Before Replay

**PR**: #1202  
**Date**: 2026-04-26

---

## Test Scenarios Added (Section 5b)

All 5 variants inject a DB row directly into `db.tables.get('integration_dead_letters')` to bypass `createDeadLetter`'s own sourcePayload validation (which correctly rejects null on write — this tests the read/replay path).

### null → NULL_PAYLOAD

**DB row**: `source_payload: null`  
**Assertions**: error is `PipelineRunnerError`, `reason === 'NULL_PAYLOAD'`, `targetRows.size === 0`

### undefined → NULL_PAYLOAD

**DB row**: `source_payload: undefined`  
**Assertions**: error is `PipelineRunnerError`, `reason === 'NULL_PAYLOAD'`, `targetRows.size === 0`

### array → INVALID_PAYLOAD_TYPE

**DB row**: `source_payload: [{ code: 'x' }]`  
**Assertions**: error is `PipelineRunnerError`, `reason === 'INVALID_PAYLOAD_TYPE'`, `targetRows.size === 0`

### string → INVALID_PAYLOAD_TYPE

**DB row**: `source_payload: 'raw-value'`  
**Assertions**: error is `PipelineRunnerError`, `reason === 'INVALID_PAYLOAD_TYPE'`, `targetRows.size === 0`

### number → INVALID_PAYLOAD_TYPE

**DB row**: `source_payload: 42`  
**Assertions**: error is `PipelineRunnerError`, `reason === 'INVALID_PAYLOAD_TYPE'`, `targetRows.size === 0`

## Regression Guard

After merging current `origin/main` through the finishRun success-warning guard, all 18 `plugin-integration-core` test files pass:

```
✓ credential-store        ✓ adapter-contracts       ✓ http-adapter
✓ db.cjs                 ✓ plm-yuantus-wrapper     ✓ pipelines
✓ external-systems       ✓ transform-validator      ✓ runner-support
✓ payload-redaction      ✓ pipeline-runner          ✓ http-routes
✓ k3-wise-adapters       ✓ erp-feedback             ✓ e2e-plm-k3wise-writeback
✓ staging-installer      ✓ migration-sql
```

## Worktree

Branch: `codex/integration-replay-null-payload-20260426`  
Worktree: `/private/tmp/ms2-replay-null-payload`  
Base: `4ba8d3d50` (origin/main after PR #1200)
