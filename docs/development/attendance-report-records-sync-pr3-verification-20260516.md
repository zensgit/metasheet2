# 考勤 report-records 同步层 PR3 验证记录

## Verification Matrix

| Layer | Command | Result |
| --- | --- | --- |
| Plugin syntax | `node --check plugins/plugin-attendance/index.cjs` | PASS |
| Backend unit | `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/attendance-report-field-catalog.test.ts tests/unit/attendance-report-field-formula-engine.test.ts --reporter=dot` | PASS, 31 tests |
| Frontend unit | `NODE_OPTIONS=--no-experimental-webstorage pnpm --filter @metasheet/web exec vitest run tests/AttendanceReportFieldsSection.spec.ts tests/attendance-admin-regressions.spec.ts --watch=false` | PASS, 19 tests |
| Web type-check | `pnpm --filter @metasheet/web type-check` | PASS |
| Core backend build | `pnpm --filter @metasheet/core-backend build` | PASS |
| Diff hygiene | `git diff --check -- <slice files>` | PASS |

## Evidence

- Report-records view descriptor is deterministic:
  - view id: `records_by_date`
  - sort: `work_date desc`, `user_id asc`, `synced_at desc`
  - purpose: `attendance-report-records`
- Sync response includes the multitable locator:
  - `projectId`
  - `objectId = attendance_report_records`
  - `baseId`
  - `sheetId`
  - `viewId`
- Frontend sync panel posts exactly:
  - `POST /api/attendance/report-records/sync?orgId=<orgId>`
  - body `{ from, to, userId }`
- Frontend displays:
  - `synced/created/patched/skipped/failed/duplicateRowKeys`
  - `fieldFingerprint`
  - `syncedAt`
  - report-records multitable open link when `sheetId + viewId` are present
- Degraded sync returns warning UI and does not break report-field rendering.
- Stale-null full path is locked: if `late_duration` is disabled but an existing report-record row has old `fld_late_duration`, sync patches it to `null`.

## Boundaries Checked

- No `attendance_*` migration.
- No direct `meta_*` SQL write from the attendance plugin.
- Report-records remains a rebuildable multitable report layer, not a fact source.
- PR3 does not implement period sync, all-user sync, pagination, or formula editor.

## Pending Evidence

- Real staging sync evidence is not run in this slice. It needs a short-lived admin JWT plus a sample tenant with attendance records; without credentials this remains a follow-up and is not marked as passed.
