# Attendance v2.7.1 Round 2 Import/Export Compatibility Verification

Date: 2026-03-29

## Scope Verified

- upload-channel CSV row counting matches parsed non-empty rows
- API-style CSV imports with slash dates no longer fail the default admin path
- payroll-cycle export compatibility alias returns the same CSV as the canonical summary/export route
- OpenAPI source/dist include the new export alias

## Commands

```bash
git diff --check
pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/attendance-plugin.test.ts -t "rejects uploaded CSV files that only contain a header row after parser normalization|accepts uploaded API-column CSV imports with slash dates through required-field aliases|supports approval flow, rule set, and payroll cycle item lookup while keeping missing item semantics stable" --reporter=dot
pnpm --filter @metasheet/core-backend exec tsc --noEmit
pnpm exec tsx packages/openapi/tools/build.ts
```

## Results

- `git diff --check`: passed
- focused integration suite: `3 passed`
- backend TypeScript compile: passed
- OpenAPI rebuild: passed

## Focused Assertions

### Header-only uploads

Valid-looking headers followed only by empty row content are rejected during upload with `400 VALIDATION_ERROR` instead of surviving until commit and failing later.

### API-column CSV compatibility

The following import shape now succeeds without requiring an explicit profile override:

```csv
workDate,userId,1_on_duty_user_check_time,1_off_duty_user_check_time,attend_result
2026/3/26,user-001,2026-03-26T09:00:00+08:00,2026-03-26T18:00:00+08:00,Normal
```

The preview result normalizes `workDate` to `2026-03-26`, and commit imports the row instead of skipping it as “missing required”.

### Payroll cycle export alias

`GET /api/attendance/payroll-cycles/:id/export` now returns `200` and the raw CSV matches `GET /api/attendance/payroll-cycles/:id/summary/export` byte-for-byte.

## Residual Notes

- The earlier “edit buttons 0x0” report still looks like a focused-mode locator mismatch unless reproduced in a real browser against the active section.
- `/metrics/prom` was not changed in this slice; the product route remains `/metrics/prom`.
