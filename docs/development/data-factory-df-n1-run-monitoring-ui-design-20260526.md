# Data Factory — DF-N1 Run Monitoring UI Design - 2026-05-26

## Status / purpose

**Front-end-only implementation of DF-N1 (the first slice of Data Factory Stage 5 "运行监控").** Surfaces the run / row-level / dead-letter state that the integration-core runtime **already records**, in the existing IntegrationWorkbench view. **Read-only**: read-existing-state only; **zero backend, zero migration, zero new connector behavior, no write action.** Implementation PR — held for review, not auto-merged.

**Replay is intentionally NOT in this slice** — see the scope decision below.

## Relationship to the 阶段二 design seed set (references, does NOT re-derive)

- `data-factory-hub-direction-20260525.md` / **#1838** — direction & gating (umbrella). Confirms: *"success/fail today = pipeline run status + targetWriteSummaries (row-level, #1813) + dead-letters (replayable)."* This slice surfaces the run-status + targetWriteSummaries + dead-letter **state** (it does not act on the "replayable" part).
- `data-factory-nifi-inspired-run-provenance-design-20260526.md` / **#1839** — run/provenance + core object data model, and the **DF-N0..N4 phasing**. This slice is **DF-N1**: *"Run result UI on existing surfaces … Prefer existing `integration_run_log` and `integration_exceptions` … Expected lock profile: front-end / read-existing-state first. Any API or persistence change must be split into its own gated PR."* `targetWriteSummaries` is the concrete present-day form of #1839's design-model **RowResult**.
- `data-factory-user-flow-ia-design-20260526.md` / **#1844** — UX/IA. **Stage 5 "运行监控"** = *"Run history + row-level results + provenance/lineage + dead-letters + retry of selected failed rows"*, and explicitly: *"stage 5 monitoring surfaces existing run/exception data first (#1839 DF-N1)"* and *"each screen/feature is its own gated PR."* This PR is that gated opt-in for Stage 5's first, read-only slice; the "retry of selected failed rows" part of Stage 5 is deferred.

K3 WISE stays a **preset**, not the product center.

## What this slice adds (concrete)

All changes are in `apps/web` (Vue frontend) + its tests + these docs.

1. **Panel rename `运行观察 → 运行监控`** to match #1844's Stage-5 term. (No test asserts on the old literal — verified by grep; existing `data-testid`s preserved.)
2. **Run list — structured columns.** Per run: `status` (state badge), `mode`, `triggeredBy`, read/clean/**write**/**fail** counts (write & fail emphasized per the user goal), `durationMs`, `startedAt`/`finishedAt`, and `errorSummary` when present.
3. **Row-level results (`targetWriteSummaries`).** Each run can expand to show `run.details.targetWriteSummaries` — the per-record target-write business responses the runner already records (sanitized, capped at 50 server-side). Rendered read-only as compact JSON. This is #1839's RowResult at today's grain.
4. **Open dead-letter / exception entry — read-only.** Per dead-letter: `errorCode`, `errorMessage`, `status` (open/replayed/discarded — which itself conveys retryability), `retryCount`, `idempotencyKey`, `createdAt`. **No action buttons.**

## Scope decision (NAMED): DF-N1 is read-only; replay deferred to its own PR

Replay sits in the genuine gap between DF-N1 and DF-N3, so it is called out explicitly rather than buried — and, per review, **kept out of this slice**.

- **DF-N1 strict text** emphasizes *links* and *read-existing-state first*. A slice literally named "运行监控" should be **read-only**.
- The existing `POST /api/integration/dead-letters/:id/replay` route **re-runs the pipeline** — a real target/ERP write. Even gated (two-step confirm, open-only, backend write-perm), surfacing a write here muddies the monitoring boundary and deserves a focused review of its own (idempotency / duplicate-write semantics as the subject, not a footnote).
- **Decision:** ship pure read-only monitoring now; replay returns as a **separate gated PR** ("DF-N1.5 single manual replay" or a DF-N3 precursor). The replay implementation is preserved on branch `frontend/data-factory-df-n1_5-deadletter-replay-20260526` for that PR.

| Concern | This slice (DF-N1, read-only) | Deferred |
|---|---|---|
| Run / row-level / dead-letter **display** | ✅ | — |
| Single manual replay (existing route, confirm-gated) | ❌ | **DF-N1.5 / own PR** |
| Bulk "retry selected failed rows" + stop rules + run policy + back-pressure | ❌ | **DF-N3** (frozen) |

## Lock profile / boundaries

- **Pure front-end, read-only.** Touches only `apps/web/src/views/IntegrationWorkbenchView.vue`, `apps/web/src/services/integration/workbench.ts` (read-only types over existing read routes), their specs, and these docs.
- **No** backend / plugin / migration / connector / API-contract / RBAC change, and **no write action** of any kind. (Stage-1 K3 lock respected.)
- **No** K3 Submit/Audit, no BOM, no multi-record push, no read/list unlock, no server-side reference auto-composition.
- **DF-N2 (provenance event), DF-N3 (retry/back-pressure), DF-N4 (connector catalog), and dead-letter replay remain separate gated opt-ins.**
- Scope stays single-pipeline (tied to the view's existing `savedPipelineId`); cross-pipeline monitoring is not required by #1844 for DF-N1.

## Existing data sources reused (no new endpoints)

| Surface | Existing route | Existing client |
|---|---|---|
| Runs | `GET /api/integration/runs` | `listIntegrationPipelineRuns()` |
| Row-level results | `run.details.targetWriteSummaries` (runner-recorded) | (read off the run object; typed via `IntegrationPipelineRunDetails`) |
| Open dead-letters | `GET /api/integration/dead-letters?status=open` | `listIntegrationDeadLetters()` |

## Test plan

- **Service spec** (`integrationWorkbench.spec.ts`): existing run/dead-letter list coverage; `IntegrationPipelineRunDetails` typing of `targetWriteSummaries`.
- **Component spec** (`IntegrationWorkbenchView.spec.ts`): run row renders status/write/fail; `targetWriteSummaries` collapsed→expandable; dead-letter renders read-only (code/message/status); and **no replay button / no retryability badge** is rendered (locks the read-only scope). Stable `data-testid`s: `pipeline-run-<id>`, `toggle-run-summaries-<id>`, `run-row-summaries-<id>`, `dead-letter-<id>`.

## See also

- #1838 (direction/gating) · #1839 (run/provenance + DF-N phasing) · #1844 (IA Stage 5) · #1813 (targetWriteSummaries / row-level) · #1828 (completeness preview) · #1709/#1835 (read decision/track) · #1792 (GATE).
- Verification: `data-factory-df-n1-run-monitoring-ui-verification-20260526.md`.
- Deferred replay work: branch `frontend/data-factory-df-n1_5-deadletter-replay-20260526`.
