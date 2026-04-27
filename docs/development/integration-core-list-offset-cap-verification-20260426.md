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

After merging current `origin/main`, including PR #1192 list-limit cap and PR #1196 public run-mode validation, all 18 `plugin-integration-core` test files pass:

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

Branch: `codex/integration-list-offset-cap-20260426`  
Worktree: `/private/tmp/ms2-list-offset-cap`  
Base: current `origin/main` as of 2026-04-27
