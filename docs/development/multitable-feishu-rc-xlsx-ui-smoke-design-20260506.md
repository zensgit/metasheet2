# Multitable Feishu RC XLSX UI Smoke Design - 2026-05-06

## Scope

This slice turns the remaining Phase 1 XLSX frontend smoke item into executable evidence inside the existing multitable pilot Playwright runner.

Target TODO item:

- `Smoke test xlsx frontend import/export with a real file.`

The change is runner-only. It does not change production frontend or backend behavior.

## Design

The existing `scripts/verify-multitable-live-smoke.mjs` already exercises CSV import, mapping reconciliation, retry, attachment upload, comments, view replay, and cleanup. This slice extends that runner with a real XLSX round trip:

1. Generate a real `pilot-import.xlsx` fixture under the run output directory.
2. Open the existing grid view and click `Import records`.
3. Select the `.xlsx` file through the real file input.
4. Wait for the XLSX-specific behavior: the UI parses the file and moves directly to the mapping preview step.
5. Explicitly map the first column to the pilot title field.
6. Import one record.
7. Verify API/search hydration for the imported row.
8. Click the real `Export Excel` toolbar button.
9. Capture the Playwright download.
10. Parse the downloaded `.xlsx` and assert that it contains both the `Title` header and the imported row title.

## Implementation Notes

The runner resolves `xlsx` from workspace package paths using `createRequire(...).resolve(...)` because `xlsx` is a workspace package dependency rather than a root package dependency in all execution contexts.

The runner records two new checks:

- `ui.xlsx.import-file`
- `ui.xlsx.export-download`

It also records `xlsxImportRecordId` in report metadata and adds the imported record to the existing best-effort cleanup map before later smoke steps continue.

## Rejected Approach

The first implementation tried to click the `Preview` button after selecting the XLSX file, mirroring the CSV/TSV flow. That was wrong for current UI semantics: XLSX selection is parsed asynchronously and moves directly into the preview/mapping step. The final runner waits for `1 record(s) detected. Map columns to fields:` instead.

## Non-Goals

This slice does not close the remaining Phase 1 manual items:

- broad field type UI smoke
- conditional formatting reload
- formula editor
- filter builder
- Gantt view
- Hierarchy view
- public form submit
- automation `send_email`

Those should remain separate slices to keep failure signals isolated.
