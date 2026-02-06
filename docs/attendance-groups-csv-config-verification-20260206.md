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

## Remote Acceptance (2026-02-06)

Target:

- Web: `http://142.171.239.56:8081/attendance`
- API: `http://142.171.239.56:8081/api`

Artifacts:

- API result: `output/playwright/attendance-remote-api-acceptance-20260206.json`
- UI screenshot: `output/playwright/attendance-ui/attendance-import-ui-20260206.png`

### Remote API Summary

- Total checks: 13
- Passed: 12
- Failed: 1
- Failed item: `csv_import_without_timezone` (HTTP 500)

Failure payload:

```json
{
  "ok": false,
  "error": {
    "code": "INTERNAL_ERROR",
    "message": "Failed to import attendance"
  }
}
```

Retry with explicit timezone succeeded:

- `groupSync.timezone = "Asia/Shanghai"` -> pass (`ok: true`)
- `meta.groupCreated = 1`, `meta.groupMembersAdded = 1`

Interpretation:

- Remote runtime still behaves like pre-fix code path for `ensureAttendanceGroups()` timezone fallback.
- Local branch fix is valid (covered by integration tests), but remote service has not fully picked up that fix yet.

### Remote UI Summary

Validation script:

```bash
WEB_URL=http://142.171.239.56:8081/attendance \
AUTH_TOKEN=<admin-token> \
FROM_DATE=2026-02-01 \
TO_DATE=2026-02-06 \
USER_IDS=26979f88-e7cc-4b40-a975-a0353d19aec0 \
UI_SCREENSHOT_PATH=output/playwright/attendance-ui/attendance-import-ui-20260206.png \
node scripts/verify-attendance-import-ui.mjs
```

Result:

- Records query and refresh for admin user: pass
- Screenshot captured: pass

### Release Gate Status

- Code/CI: pass (PR checks green)
- Local integration: pass
- Remote acceptance: partial pass (blocked by timezone fallback behavior in deployed runtime)
