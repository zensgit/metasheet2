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
| Real staging sync | 8082 staging, `POST /api/attendance/report-records/sync?orgId=default`, sample user/date fixture | PASS, 3 created then 3 skipped on rerun |

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
- Real 8082 staging evidence was completed after merge:
  - health/auth OK after staging-only compatibility repair for missing `users.username` and `meta_records.modified_by`
  - seeded a 3-row staging-only attendance fixture for one sample admin user over `2026-05-15..2026-05-17`
  - first sync returned `synced=3`, `created=3`, `patched=0`, `skipped=0`, `failed=0`, `duplicateRowKeys=0`
  - field fingerprint: `78a97d437d9fb64ab8cff63c6c935d4ea9085f78`
  - multitable locator: `projectId=default:attendance`, `objectId=attendance_report_records`, `sheetId=sheet_90fd4bdebbaabe12b76556bf`, `viewId=view_f764653146213b44d955d2b1`
  - readback found 3 records, 3 distinct row keys, no duplicates, `field_fingerprint`/`source_fingerprint`/`synced_at` present on all rows
  - row values matched fixture: `480/12/0/late`, `450/0/30/early_leave`, `0/0/0/absent`
  - rerun returned `created=0`, `patched=0`, `skipped=3`, `failed=0`, `duplicateRowKeys=0`
  - evidence was also posted to PR #1609 as comment `4473388994`

## Boundaries Checked

- No `attendance_*` migration.
- No direct `meta_*` SQL write from the attendance plugin.
- Report-records remains a rebuildable multitable report layer, not a fact source.
- PR3 does not implement period sync, all-user sync, pagination, or formula editor.

## Pending Evidence

- None for daily report-records sync. Period sync remains out of scope by design.
