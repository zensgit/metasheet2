# Integration-Core Stale-Run Autowire · Verification

> Date: 2026-04-26
> Companion: `integration-core-stale-run-autowire-design-20260426.md`
> PR: #1188

## Commands run

```bash
node plugins/plugin-integration-core/__tests__/pipeline-runner.test.cjs
# Full regression:
for f in plugins/plugin-integration-core/__tests__/*.test.cjs; do node "$f" 2>&1 | tail -1; done
```

## Result — pipeline-runner.test.cjs

```
✓ pipeline-runner: cleanse/idempotency/incremental E2E tests passed
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
✓ pipelines: registry + endpoint + field-mapping + run-ledger tests passed
✓ plm-yuantus-wrapper: source facade tests passed
✓ plugin-runtime-smoke: all assertions passed
runner-support: idempotency/watermark/dead-letter/run-log tests passed
✓ staging-installer: all 7 assertions passed
[pass] transform-validator: transform engine + validator tests passed
```

18/18 test files pass. 0 regressions.

## New test coverage breakdown (2 added in pipeline-runner.test.cjs)

| # | Scenario | What it pins |
|---|---|---|
| 17a | `abandonStaleRuns` called once per `runPipeline` invocation, scoped to correct tenant + pipeline ID | Verifies the autowire fires and the scope is correct |
| 17b | `runPipeline` succeeds when registry has no `abandonStaleRuns` method | Backward-compatibility: `typeof` guard prevents TypeError on pre-#1187 registries |

## Manual code review checklist

- [x] Call placed after `loadPipelineContext` — pipeline is validated before we attempt sweep
- [x] Call placed before `runLogger.startRun` — no run record exists when the sweep fires;
  if `abandonStaleRuns` throws, the error propagates cleanly with no orphaned run
- [x] `typeof` guard — won't throw on registries that lack the method
- [x] Scope is `{ tenantId, workspaceId, pipelineId }` — sweep is confined to the pipeline
  being triggered, not a global sweep of all tenants or pipelines
- [x] `abandonStaleRuns` return value is unused — the runner doesn't need to log or act on
  the list of abandoned runs; callers that want that info should call it directly
- [x] No new `requireDependency` constraint added — soft optional call only
- [x] `createRunnerHarness` now returns `pipelineRegistry` — test can inspect call counts
  without exposing internal implementation details to other scenarios

## Interaction with #1187

This PR is forward-compatible: it is safe to merge before or after #1187.

- **Before #1187**: `abandonStaleRuns` doesn't exist on the registry; `typeof` guard
  skips the call; behavior is unchanged from main.
- **After #1187**: `abandonStaleRuns` exists; the recovery path activates automatically.

The concurrent-run guard in #1187's `createPipelineRun` fires immediately after this sweep.
The intended flow is: sweep removes any crashed ghost → guard finds nothing → new run is
created. If the sweep itself finds nothing (normal case), no runs are abandoned and the
guard check is a no-op.
