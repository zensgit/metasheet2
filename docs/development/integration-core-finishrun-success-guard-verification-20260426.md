# Verification: Wrap Success-Path finishRun in Try-Catch

**PR**: #1200  
**Date**: 2026-04-26

---

## Test Scenarios Added (Section 18)

All scenarios use a fresh `buildRunner18` helper that creates a complete runner with one source record producing a successful ERP write (`targetRows18.size === 1`).

### 18a: finishRun throws → result returned with warning, not error

**Setup**: `updatePipelineRun` always throws `'DB connection lost after ERP write'`

**Assertions**:
- `warnResult.run` is truthy (original startRun object)
- `warnResult.metrics.rowsWritten === 1` (ERP write completed)
- `warnResult.warning.code === 'FINISH_RUN_FAILED'`
- `typeof warnResult.warning.message === 'string'`
- `targetRows18.size === 1` (target record was written despite finishRun failure)

### 18b: Normal finishRun — no warning field

**Setup**: Standard `createPipelineRegistry` — `updatePipelineRun` succeeds

**Assertions**:
- `normalResult.run` is truthy
- `normalResult.run.status === 'succeeded'`
- `normalResult.warning === undefined`

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

Branch: `codex/integration-finishrun-success-guard-20260426`  
Worktree: `/tmp/ms2-finishrun-success-guard`  
Base: `202c10eff` (PR #1186, remote main)
