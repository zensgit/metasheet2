# Integration-Core Concurrent Run Guard · Verification

> Date: 2026-04-26
> Companion: `integration-core-concurrent-run-guard-design-20260426.md`
> PR: #1187

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/pipelines.test.cjs
node plugins/plugin-integration-core/__tests__/http-routes.test.cjs
# Full regression sweep:
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f" 2>&1 | tail -1; done
```

## Result — pipelines.test.cjs

```
✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed
```

## Result — http-routes.test.cjs

```
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
```

## Result — full suite regression (18 files)

```
✓ adapter-contracts: registry + normalizer tests passed
✓ credential-store: 10 scenarios passed
✓ db.cjs: all CRUD + boundary + injection tests passed
✓ e2e-plm-k3wise-writeback: mock PLM → K3 WISE → feedback tests passed
✓ erp-feedback: normalize + writer tests passed
✓ external-systems: registry + credential boundary tests passed
✓ http-adapter: config-driven read/upsert tests passed
http-routes: REST auth/list/upsert/run/dry-run/replay tests passed
✓ k3-wise-adapters: WebAPI, SQL Server channel, and auto-flag coercion tests passed
✓ migration-sql: 057 integration migration structure passed
✓ payload-redaction: sensitive key redaction tests passed
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
✓ pipelines: registry + endpoint + field-mapping + run-ledger + concurrent-guard + stale-run-cleanup tests passed
✓ plm-yuantus-wrapper: source facade tests passed
✓ plugin-runtime-smoke: all assertions passed
runner-support: idempotency/watermark/dead-letter/run-log tests passed
✓ staging-installer: all 7 assertions passed
[pass] transform-validator: transform engine + validator tests passed
```

18/18 test files pass. 0 regressions.

## New test coverage breakdown (6 added)

### pipelines.test.cjs (+6)

| # | Scenario | What it pins |
|---|---|---|
| 1 | concurrent run rejected with `PipelineConflictError` | Guard fires when a `running` run exists for same pipeline; error class is correct |
| 2 | error details include `runningRunId` | Operator can identify the blocking run without a DB query |
| 3 | terminated run does not block | `succeeded` run allows new run — guard checks `status='running'` only |
| 4 | running run on different pipeline does not block | Guard scopes to `pipeline_id`; unrelated pipelines are independent |
| 5 | two concurrent `createPipelineRun` calls serialize through the in-process keyed lock | Only one call inserts a `running` row; the other receives `PipelineConflictError` even when both would otherwise snapshot no running rows |
| 6 | `abandonStaleRuns` default threshold (4h) | Stale run (5h old) abandoned; fresh run (30min) untouched; other-tenant run untouched |
| 7 | `abandonStaleRuns` custom `olderThanMs` | 15min threshold correctly abandons the 30min-old run |

### http-routes.test.cjs (+1, inside `testErrorResponseShape`)

| # | Scenario | What it pins |
|---|---|---|
| 8 | `PipelineConflictError` → HTTP 409 | `inferHttpStatus` maps `Conflict` name to 409; error body includes `code` and `details` |

## Manual code review checklist

- [x] `PipelineConflictError` exported alongside `PipelineValidationError` / `PipelineNotFoundError`
- [x] Guard placed after `disabled` check — ordering: pipeline exists → not disabled → not already running → insert
- [x] In-process keyed lock wraps check+insert — closes the single-node async race
- [x] Guard scopes correctly: `tenant_id`, `workspace_id`, `pipeline_id` all in WHERE clause
- [x] `abandonStaleRuns` never abandons fresh runs (JS timestamp filter, not DB filter)
- [x] `abandonStaleRuns` is tenant-scoped — other-tenant stale runs unaffected
- [x] Abandoned run `error_summary` is human-readable and operator-actionable
- [x] `returnType` of `abandonStaleRuns`: returns `PipelineRun[]` via `rowToPipelineRun()` for consistency with other registry return types
- [x] `inferHttpStatus` regex order: `Conflict` before `Validation` — prevents accidental 400 if a future error name contained both
- [x] No new shared module — local changes only to `pipelines.cjs` and `http-routes.cjs`
- [x] No behavior change for the happy path — only new code paths for error conditions

## Known limitations (documented in design)

- **TOCTOU window still exists** for distributed multi-node deployments. The
  in-process keyed lock covers the single-node PoC race. Production hardening
  would use `SELECT ... FOR UPDATE SKIP LOCKED`, advisory locks, or a partial
  unique index.
- **`abandonStaleRuns` not auto-wired**: exported but the caller (plugin activation or
  run-trigger route) must decide when to invoke it. This PR only provides the tool.
