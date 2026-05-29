# DF-T3b-2b — live mapping-sheet bulk-read → preview-route resolve (read-only, API-reachable) — development verification (2026-05-29)

> Third slice of DF-T3b. Makes the preview **route** resolve `from_reference_table` from **real** mapping
> sheet rows **when the request supplies `referenceMappingSources`**: bulk-read via the staging
> source-adapter → build `referenceMappingIndexes` → feed the DF-T3b-2a (#2063) seam. **READ-ONLY** — no
> pipeline-runner / `upsert` / K3 Save. The real-Save compose-before-`upsert` wire is **DF-T3b-2c** (a
> separate opt-in).
>
> **Reachability (precise, no overclaim):** this is **API-reachable, not operator-UI-reachable**. The
> route resolves live when a caller sends `referenceMappingSources`, but **no shipped client sends them
> yet** — `IntegrationWorkbenchView.previewPayload` does not (UI was out of scope). So an operator
> clicking Preview still gets no mapping-sheet resolution until a **separate, not-yet-scoped UI wire**
> slice sends the sources. 2b ships the backend capability + the API surface; it is not operator-facing
> on its own.

## Locked scope (owner-set)

In:
- **Reuse** `createMetaSheetStagingSourceAdapter` — no new sheet reader (#2036: read "the same way the
  staging source-adapter already reads cleansing sheets … by `sheetId`").
- Bulk-read mapping rows → build `referenceMappingIndexes`.
- Wire the **server-side options seam** of `POST /api/integration/templates/preview`.
- wire-vs-fixture test (real adapter + mocked `recordsApi.queryRecords`) + a bypass negative control.
- Three-state fail-closed still verified **at the preview layer** (unresolved / ambiguous / incomplete
  → `valid:false`).

Out:
- ❌ pipeline-runner / `upsert` / K3 Save / dead-letter / provenance (that's T3b-2c).
- ❌ UI / import-export; ❌ no Submit/Audit/BOM/multi-record; ❌ no K3 write scope change.

## What shipped

- `lib/reference-mapping-source.cjs` (new):
  - `bulkReadRows(adapter, object, {maxPages, pageLimit})` — loops the staging adapter's paginated
    `read()` until `done`; **bounded by `maxPages` (default 100) and THROWS on exceed — never silently
    truncates** (a truncated dictionary would resolve real codes to "unresolved", a silent wrong answer).
  - `buildReferenceMappingIndexes(adapter, bindings)` — per `{domain, object, template}`, bulk-read then
    `buildReferenceMappingIndex` (T3b-1). Per-run; no cross-run cache.
- `lib/http-routes.cjs`:
  - `normalizeReferenceMappingSources` — `referenceMappingSources: [{domain, systemId, object}]`.
  - `templatesPreview` — when sources are named, **tenant-scoped** load each system →
    `adapterRegistry.createAdapter` → live bulk-read → `referenceMappingIndexes` → pass to
    `buildTemplatePreview` options. No sources → behavior unchanged. Unknown domain → 400.
- Tests: `reference-mapping-source.test.cjs` (wire-vs-fixture) + `http-routes.test.cjs`
  (`testTemplatePreviewLiveBulkRead`); wired into the `test` chain.

## The binding — grounded against #2036, not invented

#2036 (lines 81–86) specifies the mapping sheet is read "the same way the staging source-adapter already
reads cleansing sheets — its rows via the multitable records API by `sheetId`" and **defers the exact
read-call shape to T3b scoping**. So a domain binds to a configured **staging object** (→ `sheetId`),
read via that adapter — the contract's own mechanism. `referenceMappingSources` is that binding; the
client names `{domain, systemId, object}`, the **server** does the tenant-scoped load + bulk-read (the
index is never client-supplied).

## wire-vs-fixture (the keystone)

`reference-mapping-source.test.cjs` drives the **real** `createMetaSheetStagingSourceAdapter` with a
mocked `recordsApi.queryRecords` and asserts: `queryRecords` ran **per page** (pagination, `pageLimit:1`
across 3 rows), the **offset advances** `[0,1,2]`, it stops on `done`, targets the configured `sheetId`,
and the resulting index **resolves** a sourceCode. Negative control (Edit-revert): bypassing the
bulk-read → `queryRecords` count `0` fails the test (it cannot pass on a hand-passed index). Plus the
`maxPages` cap throws on a never-`done` source. `http-routes.test.cjs` proves the **route** runs the
live bulk-read (real adapter via the registry) and resolves, with the three non-resolved statuses
fail-closed (`valid:false` + correct `errorType`) and an unknown domain → 400.

## Review fixes (owner P1/P2 — folded in pre-merge)

- **P1 — the bulk-read entry point is fail-closed to `metasheet:staging` only.** Without this, the
  preview route would be an **arbitrary-adapter `read()` entry point**: a caller passing a K3 / other
  external `systemId` (any adapter with `read()`) would trigger an **external read**, not a read-only
  workspace mapping-sheet read — breaking the slice's boundary. The route now throws
  `INVALID_TEMPLATE_PREVIEW` **before** `createAdapter` when `system.kind !== 'metasheet:staging'`. Test
  asserts a non-staging system is rejected **and** `createAdapter` / `queryRecords` are **never called**.
- **P2 — duplicate `referenceMappingSources` domains fail closed (400).** One sheet per domain (#2036);
  `Object.assign` into the index would otherwise let the last binding **silently win**. The normalizer
  now rejects a repeated domain before any adapter/read. Test asserts the 400 + no adapter created.

Both guards negative-controlled (Edit-revert: disabling each makes its test fail), plus a happy-path
control that a valid staging source still creates the adapter and reads.

## Carry into DF-T3b-2c (review checklist — on record now)

When 2c wires the **real Save** compose-before-`upsert`, the three-state fail-closed becomes a per-row
**write failure at K3-call time** (sentinel → `buildSaveBody` throws). 2c MUST:
- land it as a **clean per-row error** in the runner → **dead-letter / provenance**, NOT a batch-abort
  and NOT an unhandled throw;
- ensure it is **NOT auto-retry-hammered** (an unresolved/ambiguous reference is a data-fix, not a
  transient — auto-retry must not loop on it);
- **build its indexes from the SAME bindings the preview uses** — the decision fn + extraction are
  shared (P1/P2 closed), but if preview and pipeline derive `referenceMappingSources` from different
  places, preview≠Save divergence creeps back in at the **config layer**, below where the parity test
  looks. (Note: 2b's three-state fail-closed covers the three **data** conditions; an adapter `read`
  **I/O** failure — sheet missing / records API down — is a different category that surfaces as a route
  error, acceptable for a read-only preview but to be handled explicitly when 2c hits the Save path.)

## Next (gated, separate opt-in)

- **UI wire** (separate, not-yet-scoped) — `IntegrationWorkbenchView.previewPayload` does not send
  `referenceMappingSources`, so this slice is **API-reachable only**. A small UI slice to author/send the
  sources is what makes mapping-sheet resolution operator-facing in the live app. Owner's call whether
  2b is "done" as a backend capability or a UI wire should precede operator value.
- **DF-T3b-2c** — pipeline compose-before-`upsert` so the **real K3 Save body** resolves end-to-end
  (changes the bytes sent to K3 — its own focused review per the checklist above).
