# 考勤 Period Summaries live acceptance 脚本验证记录

Date: 2026-05-19

## Commands

```bash
node --check scripts/ops/attendance-report-period-summaries-live-acceptance.mjs
node --test scripts/ops/attendance-report-period-summaries-live-acceptance.test.mjs
pnpm run verify:attendance-report-period-summaries:live:test
AUTH_SOURCE=AUTH_TOKEN_FILE AUTH_TOKEN_FILE=/tmp/<staging-admin-jwt-file>.jwt API_BASE=http://localhost:8082 ORG_ID=default USER_ID=<sample-user-id> FROM_DATE=2026-05-15 TO_DATE=2026-05-17 CYCLE_ID=<sample-cycle-id> EXPECT_USERS_SCANNED=1 CONFIRM_SYNC=1 OUTPUT_DIR=output/attendance-report-period-summaries-live-acceptance/2026-05-19-script-smoke pnpm run verify:attendance-report-period-summaries:live
git diff --check
```

## Results

| Check | Result |
| --- | --- |
| Script syntax | PASS |
| Node mock test | PASS, 6 tests |
| Package live:test script | PASS, 6 tests |
| Staging API health | PASS via `http://localhost:8082` |
| Token file auth | PASS, `AUTH_TOKEN_FILE`, mode `0600` |
| Date range sync first run | PASS, `skipped=1`, `failed=0`, `duplicateRowKeys=0` |
| Date range sync rerun | PASS, `skipped=1`, `failed=0`, `duplicateRowKeys=0` |
| Payroll cycle sync first run | PASS, `skipped=1`, `failed=0`, `duplicateRowKeys=0` |
| Payroll cycle sync rerun | PASS, `skipped=1`, `failed=0`, `duplicateRowKeys=0` |
| Field fingerprint | PASS, `ecefbf5d6311372c780830b1504b471afba022ec` |
| Multitable object | PASS, `attendance_report_period_summaries` |
| Total live checks | PASS, 34 checks, 0 failing |

## Live Evidence

The staging rows had already been created by the previous manual live closeout, so this script smoke intentionally observed idempotent `skipped=1` on both the first call and the rerun.

```text
dateRangeFieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec
dateRangeObjectId=attendance_report_period_summaries
dateRangeSheetId=sheet_f88393b5901293621cab1262
dateRangeViewId=view_56cb1aa1126315cc5a35d19a
cycleFieldFingerprint=ecefbf5d6311372c780830b1504b471afba022ec
checks=34
failing=0
```

The generated live output stayed under `output/attendance-report-period-summaries-live-acceptance/2026-05-19-script-smoke/` and is not committed.

## Boundaries

- No production write was performed.
- No DB / Redis restart was performed.
- No token value was printed or committed.
- Staging writes went only through `POST /api/attendance/report-period-summaries/sync`.
- This slice did not alter period rollup business logic.
