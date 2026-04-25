# Multitable MF1 — Excel `.xlsx` import / export development

Date: 2026-04-26
Branch: `codex/multitable-feishu-mf1-xlsx-20260426`
Base: `origin/main@25202478c`
Wave: `Wave M-Feishu-1` (Lane MF1, ~4.5 person-days target)

## Scope

Lane MF1 closes the P0 gap from `docs/development/multitable-feishu-gap-analysis-20260426.md` §2.8: B2B customers expect Excel-first onboarding, but the existing import path only accepts CSV/TSV pasted text. Goal: extend the existing multitable import/export surface so users can drop a `.xlsx` file into the import modal and click "Export XLSX" from the toolbar.

The wave-1 row in the gap analysis (line 255) explicitly recommends a **frontend-only** delivery — "后端无改动（CSV 路径已通）" — which mirrors how CSV import works today (modal parses in-browser, posts each record via the existing `/api/multitable/records` route).

## Design

The existing CSV/TSV import is 100% client-side:
- `MetaImportModal.vue` parses pasted text → fills `parsedHeaders` / `parsedRows`
- `buildImportedRecords` (`apps/web/src/multitable/import/delimited.ts`) maps columns to fields and coerces basic types
- `bulkImportRecords` (`apps/web/src/multitable/import/bulk-import.ts`) iterates `parsedRows` and POSTs each one as a record

For xlsx import we mirror this architecture exactly: parse the workbook in-browser (xlsx is already a declared dep in `apps/web/package.json`), fold the result into the same `parsedHeaders`/`parsedRows` shape, and let the existing flow (mapping editor, preview, draft recovery, retry logic, link picker, error display) handle everything downstream.

For xlsx export we mirror `onExportCsv` on the workbench: read the visible fields + grid rows, emit a workbook via `XLSX.write(...)`, then trigger a blob+anchor download.

A pure helper module `apps/web/src/multitable/import/xlsx-mapping.ts` wraps the `xlsx` package surface so it can be unit-tested and so the consumers depend only on three named functions plus two safety constants.

## Files

New:
- `apps/web/src/multitable/import/xlsx-mapping.ts` (~165 LoC, pure helpers)
- `apps/web/tests/multitable/xlsx-mapping.test.ts` (14 tests)

Edited:
- `apps/web/src/multitable/components/MetaImportModal.vue` — broadened the file `accept` attribute, added `isXlsxFile()` sniff, added `readAndSetXlsx()` branch that jumps straight to the preview step, imported the new helper.
- `apps/web/src/multitable/components/MetaToolbar.vue` — added an "Export XLSX" button next to "Export CSV" and an `export-xlsx` event.
- `apps/web/src/multitable/views/MultitableWorkbench.vue` — wired the `@export-xlsx` listener to a new `onExportXlsx()` function that mirrors `onExportCsv()` (same visible fields, same blob+anchor download pattern), imported `buildXlsxBuffer`.

LoC delta (rough): +260 / -3 across 5 frontend files.

## Helper API

`apps/web/src/multitable/import/xlsx-mapping.ts` exports:

- `parseXlsxBuffer(xlsx, buffer, { sheetName? }) → { headers, rows, sheetName, truncated }` — first-sheet (or named-sheet) read, `header: 1, raw: false, defval: ''`. Drops trailing empty header columns and fully blank data rows. Caps row count at `XLSX_MAX_ROWS` and reports `truncated: true` when surplus rows are dropped.
- `buildXlsxBuffer(xlsx, { headers, rows, sheetName? }) → Uint8Array` — writes headers + string-/number-/boolean-coerced rows. Sheet name truncated to the 31-char Excel limit. Output is `bookType: 'xlsx'`.
- `mapXlsxColumnsToFields(headers, fields, { excludeReadOnly? }) → { mapping, unmappedHeaders, unmappedFields }` — best-effort case-insensitive header-to-field match. Skips formula/lookup/rollup fields and (by default) `readOnly`/`readonly` properties. Won't double-map duplicate headers to the same field. Pure (no DB, no module imports beyond types).

Constants `XLSX_MAX_BYTES` (100 MB) and `XLSX_MAX_ROWS` (50 000) are exported for caller-side guards.

## Safety caps

- File size: enforced in `MetaImportModal.readAndSetXlsx` (rejects with parse error before reading the buffer). Caller side only — server-side enforcement waits on the deferred backend route (see "Out of scope" below).
- Row count: enforced in `parseXlsxBuffer`. Surplus rows are dropped silently and the modal surfaces a banner via `parseError`.

## Frontend integration touch points

- File picker now advertises `.xlsx,.xls` plus the matching MIME types.
- xlsx files skip the textarea preview step and land directly on the preview/mapping page (CSV/TSV unchanged).
- Default mapping leverages `mapXlsxColumnsToFields` so the experience matches CSV (header equality is case-insensitive).
- All downstream behavior — manual remap, link/person picker, retry, draft recovery — is reused unchanged.

## Out of scope (deferred — dep policy blocker)

The original task spec also requested a backend service (`packages/core-backend/src/multitable/xlsx-service.ts`) and two routes:
- `POST /api/multitable/sheets/:sheetId/import-xlsx`
- `GET  /api/multitable/sheets/:sheetId/export-xlsx`

`xlsx` (SheetJS) is **not** a declared dep of `@metasheet/core-backend` (only of `@metasheet/web`). Adding it requires editing `packages/core-backend/package.json`, which falls under the dep-policy boundary the task explicitly fences ("If `xlsx` npm package is not available and adding it is forbidden by dep policy, STOP and document the blocker rather than working around it").

The frontend-only delivery is consistent with the gap-analysis Wave-1 recommendation (line 255 explicitly says "后端无改动（CSV 路径已通）"), so Lane MF1 is functionally complete at this scope. Backend deliverables can resume in a follow-up lane once `xlsx` is added to backend deps via an authorized dep change. The deferred surface is purely additive (new file + new routes) and would not change any of the files in this PR.

## Behavior preservation

- CSV / TSV paste-text import: unchanged.
- CSV file drop: unchanged.
- Existing field-mapping defaults: unchanged for CSV; xlsx now uses the same case-insensitive matching helper (`mapXlsxColumnsToFields`) as CSV's inline default mapping but exposed as a reusable function.
- Toolbar button order: existing buttons preserved; XLSX export sits between CSV export and "+ New Record".
- No backend code touched; no migrations.

## File-disjointness with sibling lanes

- `apps/web/src/multitable/components/MetaCellEditor.vue` — not touched (MF2).
- `apps/web/src/multitable/components/MetaCellRenderer.vue` — not touched (MF2).
- `apps/web/src/multitable/components/MetaFieldManager.vue` — not touched (MF2).
- `apps/web/src/multitable/components/MetaGridTable.vue` — not touched (MF3).
- `apps/web/src/multitable/components/MetaViewManager.vue` — not touched (MF3).
- `packages/core-backend/src/multitable/permission-service.ts` — not touched.
- `plugins/plugin-integration-core/*` — not touched.
- `tools/`, plugin `node_modules/` — not touched.

## Tests

- `apps/web/tests/multitable/xlsx-mapping.test.ts` — 14 unit tests covering `parseXlsxBuffer` (header parsing, named sheet, blank-row skip, row cap + truncation flag, sheet-not-found fallback, finite caps), `buildXlsxBuffer` (round trip, nullish coercion, sheet name truncation), and `mapXlsxColumnsToFields` (case-insensitive match, exclude formula/readonly fields, leftover field reporting, duplicate header collision, empty-header skip).

No integration test was added — the path runs fully in the browser; the existing `bulkImportRecords` integration is unchanged.

## Commands

See `multitable-mf1-xlsx-verification-20260426.md`.
