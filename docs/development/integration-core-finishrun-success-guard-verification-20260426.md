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

After merging current `origin/main`, including stale-run cleanup, failed-run finalization, and replay bookkeeping guards, all 18 `plugin-integration-core` test files pass:

```
✓ adapter-contracts: registry + normalizer tests passed
✓ credential-store: 10 scenarios passed
✓ db.cjs: all CRUD + boundary + injection tests passed
✓ e2e-plm-k3wise-writeback: mock PLM -> K3 WISE -> feedback tests passed
✓ erp-feedback: normalize + writer tests passed
✓ external-systems: registry + credential boundary tests passed
✓ http-adapter: config-driven read/upsert tests passed
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
✓ migration-sql: 057/058/059 integration migration structure passed
✓ payload-redaction: sensitive key redaction tests passed
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed
✓ plm-yuantus-wrapper: source facade tests passed
✓ plugin-runtime-smoke: all assertions passed
runner-support: idempotency/watermark/dead-letter/run-log tests passed
✓ staging-installer: all 7 assertions passed
[pass] transform-validator: transform engine + validator tests passed
```

## Worktree

Branch: `codex/integration-finishrun-success-guard-20260426`  
Worktree: `/private/tmp/ms2-finishrun-success-guard`  
Base: current `origin/main` as of 2026-04-27
