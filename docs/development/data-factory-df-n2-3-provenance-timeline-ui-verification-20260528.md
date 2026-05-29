# DF-N2-3 — read-only per-row provenance timeline (verification, 2026-05-28)

Closes the DF-N2 provenance arc on the operator side: **storage (2a) + runtime write
(2b) + read route (2c) + now the read-only UI surface (2-3)**. Frontend-only; no
backend / route / OpenAPI / RBAC / migration / connector change.

## Scope (owner-locked)

- In the run-monitoring panel, **expand a dead-letter** to see that row's **cross-run**
  provenance timeline.
- Calls the DF-N2-2c by-rowId route `GET /api/integration/provenance`, using the
  dead-letter's **`idempotencyKey` as `rowId`** and passing **`pipelineId`** to avoid
  cross-pipeline idempotency-key collisions merging unrelated timelines.
- Renders run time (`runCreatedAt`), `eventType`, `runStatus`, `runId`/`pipelineId`/`runMode`,
  and a compact **redacted `attrs` summary** — never raw payload.
- **Read-only**: separate from the existing replay button; no write / replay / retry /
  K3 action.
- When a dead-letter has **no `idempotencyKey`** (no rowId): the toggle is **disabled**
  with an explicit hint; clicking fires no GET.

## Key decisions

1. **Anchor = dead-letter expand**, not the run "行级结果" (`targetWriteSummaries`).
   The summaries are opaque sanitized target *business responses*
   (`{[key:string]:unknown}`, built from `writeResult.metadata.businessResponses`) and
   carry **no reliable rowId**. The dead-letter's `idempotencyKey` is the only typed
   value in the panel and is exactly the row identity the provenance view groups on
   (`_integration_idempotency_key`). It also matches the locked test wording
   ("展开某行后真实发出 provenance GET") — a per-row expand, not a search box.
2. **v1 = open dead-letters only (Option A).** The panel lists only `open` dead-letters,
   so a row that **failed → succeeded on replay** (status `replayed`) drops off the list;
   its completed fail→succeed arc is **not reachable** by this anchor. v1 still delivers
   real cross-run value — a *still-failing* row's failure history across runs, before the
   replay decision. The completed arc is a **follow-up history view**, explicitly out of v1.
3. **No manual rowId input.** A free-text rowId cannot scope by `pipelineId`
   (cross-pipeline key collisions) and was not the locked primitive; dropped.
4. **No read-path re-redaction.** `attrs` were redacted at write (DF-N2-2b scrub gate);
   the read path does not re-redact (persistence boundary = security boundary). The UI
   shows only a compact summary of those already-safe attrs.
5. **Lazy fetch, cached once.** The GET fires on first expand; collapse/re-expand reuses
   the cached timeline (no refetch). Optional-method **501** on older hosts is surfaced as
   a per-row error, never a crash.

## Tests

Frontend specs (vitest/jsdom), all green (view 14/14, service 37/37):

- **Keystone (real wire) — `IntegrationWorkbenchView.spec.ts`**: expanding a dead-letter
  **fires** `GET /api/integration/provenance` and the query carries **`rowId` + `pipelineId`**
  (asserted on the `apiFetch` mock); the cross-run timeline (two `runId`s) then renders.
  This is the wire-vs-fixture lesson from #1968 — it asserts the request goes out, not a
  pre-mocked response render.
  - **Negative control (verified)**: suppressing the GET on expand makes the keystone fail
    (`expected [] to have a length of 1`) — proving the assertion is load-bearing.
- **Disabled-no-key — view spec**: a dead-letter without `idempotencyKey` renders a
  **disabled** toggle + unavailable hint; clicking fires no GET and opens no panel.
- **Service — `integrationWorkbench.spec.ts`**: `listIntegrationProvenanceByRow` builds a
  GET with `rowId` + `pipelineId` + tenant scope, coerces a non-array body to `[]`, and
  omits empty optional params.
- **Read-only**: the timeline introduces no replay/confirm affordance; the provenance call
  is a GET, never a POST.

Type-check: `vue-tsc --noEmit` clean for the changed files. (A local `vue-tsc -b` reports
pre-existing `echarts` module-resolution errors in `MetaChartRenderer.vue` /
`buildChartOption.ts` — unrelated; `echarts` is absent from the local node_modules snapshot,
present in CI.)

## Files

- `apps/web/src/services/integration/workbench.ts` — `IntegrationProvenanceTimelineEntry` +
  `IntegrationProvenanceQuery` types, `listIntegrationProvenanceByRow()` (mirrors the
  dead-letter/run list helpers).
- `apps/web/src/views/IntegrationWorkbenchView.vue` — per-dead-letter expand + timeline
  render + lazy-fetch state/methods + minimal styles.
- `apps/web/tests/IntegrationWorkbenchView.spec.ts` — keystone + disabled-no-key.
- `apps/web/tests/integrationWorkbench.spec.ts` — service URL/param + array-coercion tests.

## Still gated (separate opt-ins, not started)

- DF-N2-3 follow-up: a rowId entry point for non-open rows (the completed fail→succeed arc).
- DF-N3 (bounded/**manual** retry + stop-rules — auto-retry stays hard-gated), DF-N4
  (connector catalog + 2nd ERP), FaaS. K3 Submit/Audit/BOM/multi-record/production remain
  gated.
