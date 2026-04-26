# Multitable MF1 — Excel `.xlsx` import / export verification

Date: 2026-04-26
Branch: `codex/multitable-feishu-mf1-xlsx-20260426`
Base: `origin/main@25202478c`
Scope: see `multitable-mf1-xlsx-development-20260426.md`.

## Automated checks

### Frontend unit test

```
cd apps/web
npx vitest run tests/multitable/xlsx-mapping.test.ts --reporter=default
```

Result (2026-04-26):

```
 RUN  v1.6.1 /private/tmp/ms2-mf1-xlsx/apps/web

 ✓ tests/multitable/xlsx-mapping.test.ts  (14 tests) 192ms

 Test Files  1 passed (1)
      Tests  14 passed (14)
   Duration  749ms
```

### Frontend typecheck

```
cd apps/web
npx vue-tsc -b
```

Result: exit 0, no diagnostics.

### Backend typecheck

Skipped — no backend files were modified in this lane (see "deferred backend"
section in the development doc). Re-run during the follow-up lane that lands
the backend service / routes.

## Manual verification

These are not part of CI but should be performed before promoting to staging
when the backend follow-up lands:

1. **Import path — happy path**
   - Open a multitable sheet → "Import" → drop a `.xlsx` file with header row
     `Name | Age | Email` and 3 data rows.
   - Expect: modal jumps to preview step, columns auto-mapped (case-insensitive),
     first 5 rows shown in preview table.
   - Click "Import N record(s)" → records appear in the grid.

2. **Import path — header mismatch**
   - Drop a `.xlsx` with `name | age` against a sheet whose fields are `Name`
     and `Age`.
   - Expect: both columns auto-mapped (case-insensitive match).

3. **Import path — formula / read-only field**
   - Add a formula field `Total` to a sheet, drop a `.xlsx` with column header
     `Total`.
   - Expect: `Total` shown in the unmapped headers list (mapping select stays
     on `(skip)`); the importable fields dropdown does not offer it.

4. **Import path — row cap**
   - Drop a `.xlsx` with > 50 000 data rows.
   - Expect: parse banner reads "Imported the first 50000 rows; remaining rows
     were skipped (limit 50000)." Mapping/preview proceeds with the first
     50 000 rows.

5. **Import path — file too large**
   - Drop a `.xlsx` larger than 100 MB.
   - Expect: parse error "File too large (max 100 MB)"; the modal stays on the
     paste step.

6. **Import path — CSV regression**
   - Drop a `.csv` and a `.tsv` file separately.
   - Expect: behavior unchanged from before this lane. Pasted tab-separated
     text still parses via the textarea path.

7. **Export path — visible fields only**
   - Hide a field via the toolbar field picker, then click "Export XLSX".
   - Expect: the downloaded `.xlsx` opens in Excel/WPS without warnings,
     contains only the visible columns in the same order, and the rows match
     the current grid view (filter/sort applied).

8. **Export path — file metadata**
   - Open the downloaded file in Excel.
   - Expect: filename `<sheet-id>.xlsx`, single sheet whose name matches the
     active sheet id (truncated to 31 chars).

## Risks / known limitations

- xlsx parse uses `raw: false, defval: ''`, so cell formats render as their
  display strings (numbers as decimal text, dates as the workbook's locale
  string). Downstream type coercion for number/date fields still flows
  through `buildImportedRecords`, which is the same path CSV imports use.
- No client-side parsing happens for password-protected `.xlsx` files;
  `XLSX.read` will throw and the modal surfaces the message verbatim. This
  matches the SheetJS default behavior and is consistent with CSV which
  cannot represent locked workbooks at all.
- Cell values that are arrays/objects in the grid are JSON-stringified on
  export. Multi-select values become `; `-joined strings. This mirrors the
  existing CSV export behavior to keep the two paths interchangeable.

## Resume path for the deferred backend

When the backend deps boundary is unblocked:

1. Add `"xlsx": "^0.18.5"` to `packages/core-backend/package.json`.
2. Add `loadXlsx()` next to `loadMulter()` in `packages/core-backend/src/types/`
   (mirror the existing optional-dep pattern).
3. Create `packages/core-backend/src/multitable/xlsx-service.ts` exposing
   `parseXlsxBuffer` / `buildXlsxBuffer` / `mapXlsxColumnsToFields` over the
   server xlsx module (the helper signatures already work — they accept the
   xlsx module as an argument).
4. Add `POST /api/multitable/sheets/:sheetId/import-xlsx` (multer-backed,
   reuse `multitableUpload`, capability check via `resolveSheetCapabilities`,
   per-row write through `RecordService`).
5. Add `GET /api/multitable/sheets/:sheetId/export-xlsx?viewId=` using
   `queryRecordsWithCursor` + `loadFieldsForSheet`.
6. Add `packages/core-backend/tests/unit/multitable-xlsx-service.test.ts`.
7. Re-enable `npx tsc --noEmit` (in `packages/core-backend`) in the verify
   command list.

The frontend in this lane is forward-compatible — the helper API will be
shared verbatim; only the wrapper that supplies the xlsx module changes.
