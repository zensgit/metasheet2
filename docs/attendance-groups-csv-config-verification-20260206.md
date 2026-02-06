# Attendance Groups + CSV + Config Verification (2026-02-06)

## Environment

- Repo: `metasheet2`
- Branch: `codex/attendance-groups-csv-config`
- Test database: `postgres://metasheet:metasheet@127.0.0.1:5435/metasheet`

## Validation Commands

```bash
ATTENDANCE_TEST_DATABASE_URL=postgres://metasheet:metasheet@127.0.0.1:5435/metasheet \
pnpm --filter @metasheet/core-backend test:integration:attendance
```

## Results

- Status: ✅ PASS
- File: `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- Assertions include:
  - leave/overtime/approval baseline flow
  - attendance groups create/member APIs
  - CSV import with `groupSync` auto-create + auto-assign
  - created group presence and member linkage
  - template library versioning + restore

## Defect Discovered and Fixed

- Symptom: CSV import returned `500` when `groupSync.autoCreate=true` without timezone.
- Root cause: `ensureAttendanceGroups()` inserted `NULL` timezone.
- Fix: fallback to `DEFAULT_RULE.timezone` when timezone not provided.
- File: `plugins/plugin-attendance/index.cjs`

## Conclusion

The agreed 1/2/3 capability chain is now covered by integration tests and the import-time group auto-create path is fixed for production-safe default behavior.

