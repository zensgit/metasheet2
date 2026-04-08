# Multitable Cell Realtime Development Report

Date: 2026-04-05
Branch: `codex/multitable-cell-realtime-20260405`

## Scope

This slice deepens multitable realtime from record-level merge to cell-level local patching.

The goal is to let non-structural remote field updates update the current page and selected record locally from the websocket event payload, while preserving the existing record fetch fallback for structural or non-patchable changes.

## Runtime Changes

### Backend realtime payload enrichment

Updated `/packages/core-backend/src/routes/univer-meta.ts` so `spreadsheet.cell.updated` payloads now include `recordPatches`:

- `recordId`
- `version`
- `patch`

This now ships for:

- `record-created`
- `record-updated` from form submit
- `record-updated` from bulk patch
- `attachment-updated`

### Frontend grid patch support

Updated `/apps/web/src/multitable/composables/useMultitableGrid.ts` with `applyRemoteRecordPatch(recordId, { version, patch })`.

This merges remote cell values directly into the in-memory row without forcing a full record fetch.

### Frontend realtime routing

Updated `/apps/web/src/multitable/composables/useMultitableSheetRealtime.ts` to:

- parse `recordPatches` from `sheet:op`
- try `applyRemoteRecordPatch(...)` first for targeted local rows
- fall back to `mergeRemoteRecord(...)` only when local patching is unavailable or rejected

### Workbench integration

Updated `/apps/web/src/multitable/views/MultitableWorkbench.vue` to:

- classify which field types are safe for local cell patching
- apply local patches to current page rows via `grid.applyRemoteRecordPatch(...)`
- patch the deep-linked selected record state when present
- keep the existing `getRecord(...)` fallback for link, attachment, lookup, rollup, formula, and structural changes

## Test Updates

Updated:

- `/packages/core-backend/tests/integration/multitable-sheet-realtime.api.test.ts`
- `/packages/core-backend/tests/integration/multitable-attachments.api.test.ts`
- `/apps/web/tests/multitable-sheet-realtime.spec.ts`
- `/apps/web/tests/multitable-workbench-view.spec.ts`

These now verify:

- backend realtime events include `recordPatches`
- frontend prefers direct cell patching when safe
- frontend falls back to record merge when local patching is rejected
- workbench wires the new local patch handler into realtime
