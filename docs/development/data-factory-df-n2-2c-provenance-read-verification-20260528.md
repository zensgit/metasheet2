# DF-N2-2c — provenance read route (verification, 2026-05-28)

Read surface of the DF-N2-2 design (#1979), on top of DF-N2-2a storage (#1981 — the
`integration_provenance_by_row` view) and DF-N2-2b runtime write (#1988 — what populates it).
**Read-only — separate gated opt-in. No write / replay / K3 / frontend.**

## What it does (the small slice)
`GET /api/integration/provenance?rowId=…[&pipelineId=&from=&to=&limit=&offset=]` returns a row's
**cross-run** provenance timeline. The handler `requireAccess('read')` → `pipelineRegistry.
listProvenanceByRow` → `sendOk`. The registry method SELECTs the migration-060 view, scopes by
tenant/workspace + `row_id` (+ optional `pipeline_id`), then in-app applies the optional run-time
window and sorts by `(run_created_at, event_index)` (db `where` is equality-only and `orderBy`
single-column; the per-`rowId` result set is small, so window + secondary sort run in JS).

## Spec compliance (the locked requirements)
- **Reads `integration_provenance_by_row`** (migration 060) — `PROVENANCE_VIEW`; no write.
- **Input** = `rowId` (required → 400 if absent) + `pipelineId` + run-time window `from`/`to` + paging.
- **Output** = cross-run timeline, **sorted by run_created_at then event_index**.
- **RBAC** = `requireAccess('read')` (integration:read / :write / admin); 401 unauth, 403 insufficient.
- **OpenAPI: schema + parity** — `ProvenanceTimelineEntry` in `base.yml` (`additionalProperties: false`,
  `eventType.$ref → ProvenanceEventType`); `assertOpenApiParity()` asserts its `required` set **equals
  the `pipelines.cjs` projection field list** (`PROVENANCE_TIMELINE_ENTRY_FIELDS`) — triple-locked
  (field list ↔ `rowToProvenanceEntry` keys ↔ OpenAPI required). `dist/` regenerated.
- **Test = wire-vs-fixture** — `df-n2-2c-provenance-read.test.cjs` runs DF-N2-2b **twice on the same
  row** (fail, then succeed) via the real pipeline-runner, captures 2b's **actual** persisted arrays,
  translates them to view rows in **one helper** (the only place migration-060's column shape is
  mirrored; the SQL unnest itself is locked by `migration-sql.test.cjs`), and reads them back through
  the **real** registry → asserts the cross-run timeline, the sort, the window, and that the entry has
  **exactly** the OpenAPI-locked field set (no drop, no extra view column).

## Scope boundary
- **No write / replay / K3 / connector / frontend.** GET only; the route never mutates.
- **Window bounds whole RUNS by `run_created_at`** (the #1979 "read-time bounded window" retention
  story) — *not* per-event `event_at`. Stated in the OpenAPI `runCreatedAt` description.
- **No read-path re-redaction** — `attrs` were redacted at write (2b scrub gate); the persistence
  boundary is the security boundary, so the read returns the already-scrubbed value (the round-trip
  test confirms a planted secret stays masked end-to-end).
- **`listProvenanceByRow` is NOT in `requireService`** — optional-method **501** (like `deadLettersReplay`),
  so a host whose registry predates this method degrades gracefully instead of failing to register.
- **OpenAPI is schema-only** (no path entry) — matches the #1882 precedent; `base.yml` carries no
  integration paths and the multitable-openapi parity gate is for multitable, not integration.

## Files
- `lib/pipelines.cjs` — `PROVENANCE_VIEW` + `PROVENANCE_TIMELINE_ENTRY_FIELDS` + `rowToProvenanceEntry`
  + window/sort helpers + `listProvenanceByRow` (+ registry return + `__internals` exports).
- `lib/http-routes.cjs` — `GET /api/integration/provenance` route + `provenanceByRow` handler.
- `packages/openapi/src/base.yml` (+ regenerated `dist/`) — `ProvenanceTimelineEntry` schema.
- `__tests__/provenance-contracts.test.cjs` — `assertOpenApiParity` extended (load-bearing).
- `__tests__/df-n2-2c-provenance-read.test.cjs` (new) — the 2b→2c round-trip.
- `__tests__/http-routes.test.cjs` — `provenanceByRow` route (RBAC / 400 / 501 / serialization).
- `package.json` — new test wired into the suite.

## Test result
All **27** `plugin-integration-core` `*.test.cjs` green (with deps; the OpenAPI parity needs `js-yaml`).
Two negative controls run: (a) drop a field from `rowToProvenanceEntry` → the round-trip's exact-keys
assertion fails; (b) change `ProvenanceTimelineEntry.required` in `base.yml` → `assertOpenApiParity`
fails. Both restored; suite green.

## Gated next (separate opt-in, do NOT auto-start)
**DF-N2-3** — frontend per-row lineage timeline (read-only, reuse the DF-N1 expand pattern + stable
`data-testid`). K3 Submit/Audit/BOM/multi-record/production stay gated.
