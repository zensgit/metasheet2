# DF-N2-2b — provenance runtime write (verification, 2026-05-28)

Implements the **runtime write** slice of the merged DF-N2-2 design
(`data-factory-df-n2-2-provenance-runtime-design-20260528.md`, #1979), building on the DF-N2-2a
storage migration (#1981, `integration_runs.provenance_events` + `integration_provenance_by_row`) and
the DF-N2-1 contract (#1882, `provenance-contracts.cjs`). **Runtime write only — separate gated opt-in.**

## What it does (the tight slice)
`pipeline-runner.cjs` collects **per-row write-outcome** provenance during a live run and hands it to
`run-log.finishRun`, which **normalizes + redacts** each event and persists the array to the
`integration_runs.provenance_events` JSONB column via `pipelines.cjs`. The `rowId` is the record's
**idempotency key** — the stable cross-run identity the DF-N2-2a by-row view groups on.

- Emits `target_write_succeeded` / `target_write_failed`, keyed by idempotency key.
- Events are appended **raw in-memory** during the run; the **normalize + shared-redaction gate runs
  once at `finishRun`, before persist** — the *persistence boundary is the security boundary* (this is
  also where the failed-run path writes, so pre-throw rows keep their lineage).
- `attrs` carry only a small summary (`{}` for success; `{errorCode, errorMessage}` for failure).

## Scope boundary (what this PR does NOT do — confirmed against #1979)
- **Write-outcome events only.** Pre-write failures (`transform_failed` / `validation_failed`) lack an
  idempotency key (computed only after validation) and are already captured in dead-letters → **deferred**.
- **No `dry_run_previewed` emission** — dry runs perform no real write, so they record no provenance.
- **No read surface.** `pipelines.cjs rowToPipelineRun` is **not** changed to map the column back — reading
  provenance is **DF-N2-2c** (a separate opt-in by-`rowId` GET route + RBAC + wire test).
- **No route / OpenAPI / RBAC / frontend / K3 / connector behavior change.** All edits are inside
  `plugin-integration-core/lib` (`pipelines.cjs` is plugin-local, not core-backend); the write/upsert
  path and its return shape (`{run, metrics, preview}`) are unchanged.
- **Success-emission rule (the unitemized-failure trap):** `target_write_succeeded` is emitted **only when
  per-row attribution is unambiguous** (`unitemizedFailures === 0 && writeResult.inconsistent !== true`).
  When the adapter reports failures it cannot itemize, success events are **skipped** for that batch and
  the gap is recorded as `details.provenanceAttributionSkipped` — never infer "succeeded" from "absent
  from the error list", which would silently mislabel unattributed failures as writes.

## Acceptance points (each test-locked, in `pipeline-runner.test.cjs` §14–20 + `pipelines.test.cjs` §8b)
1. **Normalize before persist** — §14 asserts the canonical contract shape only (`runId/rowId/eventType/
   at/attrs`), ISO `at`, `eventType` from the enum; proves `normalizeProvenanceEvent` ran at `finishRun`.
2. **Shared redaction before persist (KEYSTONE)** — §15 plants a secret-shaped **value** in a failed-write
   `errorMessage` (`postgres://erp:S3cretPass@…`) and asserts the persisted `attrs.errorMessage` has the
   password **masked** (`postgres://erp:[redacted]@10.0.0.5`) with context kept. This exercises the
   #1882-F1 value-scrubber (`SECRET_VALUE_PATTERNS`) and **fails if normalize/scrub is bypassed** (proven
   by negative control — see below); it is **not** a key-name redaction that would pass without the scrub.
3. **Per-run / per-row cap** — §16: 502 rows → exactly 500 events, `details.provenanceDropped === 2`,
   `details.provenanceCap === 500`, and one event per row (no duplicate `rowId`). Overflow is a **counter
   in `details`**, never a sentinel event (keeps the 2a by-row view uniform).
4. **Replay must NOT duplicate lineage** — §17: a failed row → dead-letter → replay creates a **new run**;
   the replay run holds one `target_write_succeeded`, and the **original run's lineage is unchanged** (one
   `target_write_failed`). Same `rowId` across two runs is correct cross-run lineage, not duplication.
5. **No route/frontend/K3 behavior + best-effort** — diff scope (lib-only) + §20: a malformed event makes
   `run-log` **drop provenance and surface `details.provenanceWarning`** rather than throw — a bad event
   never loses the run record. §18 (failed-run path): rows written before a mid-run throw keep their
   lineage on the `failed` run (events passed to **both** `finishRun` sites).
- §8b (`pipelines.test.cjs`): the array is serialized to the `provenance_events` column when present, and
  **omitted from the SET when absent** so migration 060's `'[]'` default is preserved (no overwrite).

## Retention (unchanged direction, per #1979 §Retention — recorded so 2b does not drift)
Retention stays **run-level aging** (drop whole old runs by `integration_runs.created_at`/`finished_at`) +
**read-time bounded window** (owned by the 2c route). The per-run cap here bounds a single row; it is **not**
a per-row/per-event JSONB pruning pass — #1979 explicitly avoids rewriting old run rows per `rowId`.

## Files
- `lib/pipeline-runner.cjs` — collect + cap + emit (write-stage) + pass to both `finishRun` sites.
- `lib/run-log.cjs` — normalize+redact gate (best-effort) → `updatePipelineRun({provenanceEvents})`.
- `lib/pipelines.cjs` — serialize `provenanceEvents` → `provenance_events` column (dumb persister).
- `__tests__/pipeline-runner.test.cjs` (§14–20), `__tests__/pipelines.test.cjs` (§8b).

## Test result
All **26** `plugin-integration-core` `*.test.cjs` pass (with deps available; `provenance-contracts.test.cjs`
needs `js-yaml` from `node_modules`). Negative controls run: (a) bypassing `normalizeProvenanceEvents` in
`run-log` → §15 fails (raw `S3cretPass` persists); (b) dropping `provenanceEvents` from the failed-path
`finishRun` → §18 fails. Both restored; suite green.

## Gated next (separate opt-ins, do NOT auto-start)
**DF-N2-2c** (by-`rowId` read route + RBAC + wire test) → **DF-N2-3** (frontend timeline). K3
Submit/Audit/BOM/multi-record/production stay gated.
