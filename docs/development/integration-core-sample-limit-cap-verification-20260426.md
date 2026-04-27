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

After merging current `origin/main`, including list limit, list offset, public run-mode, and finishRun success warning guards, all 18 `plugin-integration-core` test files pass:

```
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
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

Branch: `codex/integration-sample-limit-cap-20260426`  
Worktree: `/private/tmp/ms2-sample-limit-cap`  
Base: current `origin/main` as of 2026-04-27
