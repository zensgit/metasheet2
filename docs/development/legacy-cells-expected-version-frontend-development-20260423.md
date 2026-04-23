# Legacy Cells Expected Version Frontend Development - 2026-04-23

## Context

Backend PR #1042 added optimistic locking to the legacy spreadsheet cells PUT route:

- Existing cells accept `expectedVersion`.
- Mismatches return `409 VERSION_CONFLICT` with `serverVersion` and `expectedVersion`.
- Missing `expectedVersion` preserves last-write-wins compatibility for old clients.

This follow-up wires the frontend opt-in path so legacy spreadsheet UIs use the new backend seam when the server has already returned a cell version.

## Scope

Included:

- `GridView.vue` sends `expectedVersion` for changed cells with known server versions.
- `SpreadsheetDetailView.vue` loads sheet cell versions and sends `expectedVersion` for the manual update form.
- Shared helper module for cell version maps, conflict formatting, and payload enrichment.
- Focused frontend unit coverage for the helper behavior.

Not included:

- Full collaborative editing for legacy spreadsheets.
- Automatic conflict reconciliation.
- Frontend GridView/SpreadsheetDetailView end-to-end browser automation.

## Implementation

### Shared Helper

Added `apps/web/src/utils/spreadsheetCellVersions.ts`:

- `buildCellVersionMap(cells)` indexes backend rows by `row:col`.
- `mergeCellVersionMap(current, cells)` updates cached versions from successful PUT responses.
- `withExpectedCellVersions(cells, versions)` adds `expectedVersion` only when the version is known.
- `formatCellVersionConflict(error, locale)` turns the backend `VERSION_CONFLICT` payload into user-facing copy.

The helper intentionally omits `expectedVersion` for unknown/new cells so old and first-write flows keep the backend's LWW compatibility.

### GridView

`apps/web/src/views/GridView.vue` now keeps a `cellVersions` cache:

- Server load populates the cache from GET `/cells`.
- Empty/fallback/local loads clear the cache.
- Save payloads are built from changed cells, then enriched with `expectedVersion` when available.
- Successful PUT responses merge returned cell versions before snapshotting the synced state.
- `409 VERSION_CONFLICT` is handled explicitly and does not snapshot local edits.

### SpreadsheetDetailView

`apps/web/src/views/SpreadsheetDetailView.vue` now:

- Loads selected sheet cells after spreadsheet load and sheet switching.
- Clears the selected-sheet version cache before async cell loading so a fast edit cannot reuse another sheet's stale version.
- Ignores stale cell-load responses if the selected sheet changes while the request is in flight.
- Tracks `row_index`/`column_index` versions for the selected sheet.
- Sends `expectedVersion` for the update form when available.
- Merges successful PUT response versions.
- Surfaces `409 VERSION_CONFLICT` with refresh/retry guidance.

## Design Notes

- Version cache is client-side state only; it is rebuilt from backend GET responses.
- Unknown versions are treated as old-client compatibility, not as version `0`.
- Conflict handling is deliberately conservative: the frontend preserves the user's local edit and asks for refresh rather than overwriting with server data.
- The new helper is pure TypeScript so it can be tested without mounting the legacy views.

## Changed Files

- `apps/web/src/utils/spreadsheetCellVersions.ts`
- `apps/web/src/views/GridView.vue`
- `apps/web/src/views/SpreadsheetDetailView.vue`
- `apps/web/tests/spreadsheet-cell-versioning.spec.ts`
- `docs/development/legacy-cells-expected-version-frontend-development-20260423.md`
- `docs/development/legacy-cells-expected-version-frontend-verification-20260423.md`
