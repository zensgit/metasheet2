# Verification: Cap Dry-Run sampleLimit at MAX_SAMPLE_LIMIT

**PR**: #1201  
**Date**: 2026-04-26

---

## Test Scenarios Added (`testSampleLimitCap`)

### /run: huge sampleLimit clamped to MAX_SAMPLE_LIMIT

**Input**: `sampleLimit: String(MAX_SAMPLE_LIMIT + 999999)` on `POST /api/integration/pipelines/:id/run`

**Assertion**: `runPipeline` receives `sampleLimit === MAX_SAMPLE_LIMIT`

### /dry-run: huge sampleLimit clamped to MAX_SAMPLE_LIMIT

**Input**: `sampleLimit: String(MAX_SAMPLE_LIMIT + 999999)` on `POST /api/integration/pipelines/:id/dry-run`

**Assertion**: `runPipeline` receives `sampleLimit === MAX_SAMPLE_LIMIT`

### sampleLimit=0 is stripped (undefined)

**Input**: `sampleLimit: 0`

**Assertion**: `'sampleLimit' in runPipelineCall` is `false` (key deleted by `publicRunInput`'s falsy-strip loop)

### Small valid sampleLimit passes through unchanged

**Input**: `sampleLimit: 5`

**Assertion**: `runPipeline` receives `sampleLimit === 5`

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

Branch: `codex/integration-sample-limit-cap-20260426`  
Worktree: `/tmp/ms2-sample-limit-cap`  
Base: `202c10eff` (PR #1186, remote main)
