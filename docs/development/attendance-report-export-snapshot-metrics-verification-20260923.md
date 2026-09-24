# 考勤报表导出截断披露与快照区间口径 — 验证 — 2026-09-23

Design: `docs/development/attendance-report-export-snapshot-metrics-design-20260923.md`.
Branch: `cursor/attendance-report-export-snapshot-fa47`. Draft PR #6013. Not merged.

## What was checked

- Export cap and status token: omitted limit is 5000, values above 5000 clamp, `all` is no filter, `late;drop` is rejected.
- CSV bodies have no `# META` footer. Truncation is only on `X-Attendance-Export-*` headers (and the JSON fields). The reports UI already reads those headers.
- Route harness: scheduler export still succeeds, now with disclosure headers and default limit 5000; unsafe status does not read `attendance_current_records`; `status=late&limit=2` binds `ar.status = $5` and reports truncation; `status=ALL&limit=9000` drops the status predicate and clamps the limit to 5000. The capped CSV has no `# META` line. The same bytes, parsed by the import reader and by SheetJS the way `csvTextToXlsxArrayBuffer` does, keep the header width and the data-row count (no extra worksheet row). That is the backup/restore path: the pre-overwrite backup downloads this CSV.
- Reports UI: snapshot records/flagged/work minutes read 17 / 8 / 5820 from the summary fixture while the table still shows 3 page rows. The adjusted pill narrows the table to 1 row and leaves the snapshot numbers unchanged. CSV export sends `limit=3` (the loaded total) and, after the late pill, `status=late`. Response headers drive the persistent disclosure line and the error status when truncated.
- Existing report Excel, CSV header-mode, and import-override backup queries still pass. The backup button still omits `limit` and `status`.

## Commands

```text
pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-report-range-contract.spec.ts \
  tests/attendance-reports-analytics.spec.ts
# 2 files, 12 tests passed

pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-export-disclosure.test.ts \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  -t "attendance export|export records|unsafe attendance export|capped status-filtered"
# 7 tests passed, 99 skipped in the UUID file

pnpm --filter @metasheet/web exec vitest run --watch=false \
  tests/attendance-admin-regressions.spec.ts \
  tests/attendance-import-override-guard.spec.ts \
  -t "passes the selected CSV header mode|export backup: calls the existing"
# 2 tests passed, 165 skipped
```

No live database, so `attendance-plugin.test.ts` export cases were not re-run. No browser session against a running API. The reports spec mounts `AttendanceView` and clicks the pill and export buttons.

### 2026-09-24 follow-up (CSV body has no META footer)

The `# META attendance_export` footer was removed. Truncation stays on `X-Attendance-Export-*` headers, which `noteReportExportDisclosure` already reads. Excel (`csvTextToXlsxArrayBuffer` → SheetJS `XLSX.read`) and the import-override backup both consume that CSV, so the footer would have been an extra worksheet row and a backup row.

```bash
node --check plugins/plugin-attendance/index.cjs
node --check plugins/plugin-attendance/lib/attendance-export-disclosure.cjs
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-export-disclosure.test.ts \
  tests/unit/attendance-uuid-validation-routes.test.ts \
  -t "attendance export|export records|unsafe attendance export|capped status-filtered"
pnpm --filter @metasheet/core-backend exec vitest run --watch=false \
  tests/unit/attendance-w7-w6r5-preservation-guard.test.ts
```

Result: disclosure + route filter 2 files, 7 passed, 112 skipped in the UUID file. The capped CSV case asserts no `# META` line, import `iterateImportRowsFromCsv` row count 2, and SheetJS `sheet_to_json` length `1 + rowCount` with unchanged header width. W7 guard 13 passed. The new disclosure module is listed in `ATTENDANCE_W7_NOT_CALCULATION_PATH_FILES_V1`.

Prior CI `test (18.x)` / `test (20.x)` failed for a real reason: `plugins/plugin-attendance/lib/attendance-export-disclosure.cjs` was an unclaimed file under a pinned W7 root. That was not a flake. The reports Vue specs were not re-run here; the header contract they already assert did not change.

## Open questions

- Ranges above 5000 stay truncated on purpose. Completing them would mean paging into memory past the safety cap.
- Snapshot flagged days are the summary buckets (late, early leave, late+early, partial, absent, adjusted). `off_days` is the summary non-counted-day bucket, not a raw `status = 'off'` recount.
- The record-status pill filters the records table and the export. It does not change the snapshot trio, so those numbers stay aligned with Management Metrics for the loaded range.
- `packages/openapi` was not regenerated.
