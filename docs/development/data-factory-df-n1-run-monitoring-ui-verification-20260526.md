# Data Factory — DF-N1 Run Monitoring UI Verification - 2026-05-26

Verification for `data-factory-df-n1-run-monitoring-ui-design-20260526.md` (DF-N1 = first, **read-only** slice of #1844 Stage 5 "运行监控"). Branch: `frontend/data-factory-df-n1-run-monitoring-20260526` (off `origin/main` @ 8d792a948). **Not merged — held for review.** Replay deliberately excluded (see design doc scope decision); replay impl preserved on `frontend/data-factory-df-n1_5-deadletter-replay-20260526`.

## What was implemented (front-end only, read-only)

| File | Change |
|---|---|
| `apps/web/src/services/integration/workbench.ts` | `IntegrationTargetWriteSummary` + forward-compatible `IntegrationPipelineRunDetails` types (narrows `run.details.targetWriteSummaries`). No write/replay client. |
| `apps/web/src/views/IntegrationWorkbenchView.vue` | Panel `运行观察 → 运行监控`; structured run rows (status badge, mode, triggeredBy, read/clean/**write**/**fail**, duration, timestamps, errorSummary); expandable per-run **row-level results** from `targetWriteSummaries`; read-only dead-letter rows (errorCode/message/status/retryCount/idempotencyKey); scoped CSS. No action buttons. |
| `apps/web/tests/integrationWorkbench.spec.ts` | Service run/dead-letter list coverage (unchanged from baseline). |
| `apps/web/tests/IntegrationWorkbenchView.spec.ts` | New mount test: rename, run metrics, collapsed→expandable row-level results, read-only dead-letter display, and **assert no replay button / no retryability badge** (locks the read-only scope). |
| `docs/development/data-factory-df-n1-run-monitoring-ui-{design,verification}-20260526.md` | This design + verification. |

## Commands run (all from the worktree)

```
pnpm --filter @metasheet/web exec vitest run tests/integrationWorkbench.spec.ts tests/IntegrationWorkbenchView.spec.ts
  → Test Files 2 passed (2) · Tests 29 passed (29)
pnpm --filter @metasheet/web type-check          → exit 0 (vue-tsc -b, no errors)
pnpm --filter @metasheet/web exec eslint <4 changed files>
  → 0 errors, warnings = pre-existing `router-link` test-stub pattern only
```

This satisfies #1839's verification-strategy item *"front-end test Data Factory run status and dead-letter links"* (extended to row-level results), within a read-only scope.

## Regression check — full web suite (no DF-N1 regressions)

`pnpm --filter @metasheet/web exec vitest run` → 16 test failures, all proven **pre-existing on clean `origin/main`**, not caused by this slice:
- The 9 failing files (`approval-center`, `attendance-*` ×2, `featureFlags`, `multitable-*` ×4, `useAttendanceAdminRail`) are unrelated domains; **none import** `integration/workbench` or `IntegrationWorkbenchView`.
- Baseline run with this slice **stashed** reproduced the **identical** `9 files / 16 tests` failures.
- The two integration-workbench specs pass before and after stash-pop.

(This baseline was established on the replay-inclusive revision; removing replay only shrinks the changed surface, so the conclusion holds.)

## Lock-profile confirmation (matches design)

- **Pure front-end, read-only.** Diff touches only `apps/web/**` (view + service + specs) and these two docs. **No** change to `plugins/plugin-integration-core/**`, `packages/core-backend/**`, migrations, OpenAPI, RBAC, or any connector. **No write action** of any kind — the view only calls the existing read routes (`/runs`, `/dead-letters`). (The `node_modules/.bin` churn from `pnpm install` in the fresh worktree is **not** staged.)
- **Read-only scope verified** — the component test asserts that neither a replay button (`replay-dead-letter-*`) nor a retryability badge (`dead-letter-retryable-*`) is rendered.

## Not done (remain separate gated opt-ins)

Dead-letter **replay** (single manual; impl preserved on the df-n1_5 branch) · DF-N2 provenance events · DF-N3 bounded retry / stop rules / back-pressure · DF-N4 connector catalog · cross-pipeline monitoring · K3 Submit/Audit/BOM/multi-record/read-unlock.
