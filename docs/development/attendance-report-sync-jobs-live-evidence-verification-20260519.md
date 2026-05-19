# 考勤报表同步任务化 Live Evidence 验证记录

Date: 2026-05-19

## Scope

验证已合并 report sync job runner 的真实 staging `JOB_MODE=1` 路径：

- daily `attendance_report_records`
- period `attendance_report_period_summaries` date range
- period `attendance_report_period_summaries` payroll cycle

本轮使用文件型 staging admin JWT，不记录 token 值。

## Environment

| Item | Value |
| --- | --- |
| API base | `http://localhost:8082` |
| Auth source | `AUTH_TOKEN_FILE` |
| Staging image | `a3cb70de1c9b5bd3676f0db8126d1f8ac9617ac1` |
| Health | PASS |
| Job route after schema alignment | `200 {"ok":true,"data":{"items":[]}}` |
| Sample org | `default` |
| Sample date range | `2026-05-15` to `2026-05-17` |

## Daily Report Records Result

| Check | Result |
| --- | --- |
| Command | `pnpm run verify:attendance-report-fields:live` with `JOB_MODE=1` |
| Overall | PASS |
| Total checks | 59 |
| Failed checks | 0 |
| Daily job status | `completed` |
| Daily job pages | 1 |
| Users scanned | 1 |
| Rows synced | 3 |
| Failed rows/users | 0 |
| Terminal rerun | `409 JOB_TERMINAL` PASS |
| Replacement job create + cancel | PASS |

Field fingerprint consistency:

| Surface | Fingerprint |
| --- | --- |
| catalog | `684233f9c36205f9ea59248b29f9d050f88af0cd` |
| records | `684233f9c36205f9ea59248b29f9d050f88af0cd` |
| export | `684233f9c36205f9ea59248b29f9d050f88af0cd` |
| CSV label header | `684233f9c36205f9ea59248b29f9d050f88af0cd` |
| CSV code header | `684233f9c36205f9ea59248b29f9d050f88af0cd` |

Formula evidence:

| Item | Value |
| --- | --- |
| Formula field codes | `net_anomaly_minutes` |
| Formula invalid codes | empty |

## Period Summaries Result

| Check | Result |
| --- | --- |
| Command | `pnpm run verify:attendance-report-period-summaries:live` with `JOB_MODE=1` |
| Overall | PASS |
| Total checks | 56 |
| Failed checks | 0 |
| Date range job status | `completed` |
| Date range job pages | 1 |
| Date range users scanned | 1 |
| Date range rows synced | 1 |
| Payroll cycle job status | `completed` |
| Payroll cycle job pages | 1 |
| Payroll cycle users scanned | 1 |
| Payroll cycle rows synced | 1 |
| Terminal rerun | `409 JOB_TERMINAL` PASS for date range and payroll cycle |
| Replacement job create + cancel | PASS for date range and payroll cycle |

Period fingerprint:

| Surface | Fingerprint |
| --- | --- |
| date range | `ecefbf5d6311372c780830b1504b471afba022ec` |
| payroll cycle | `ecefbf5d6311372c780830b1504b471afba022ec` |

## Files Produced Locally

Generated evidence remains local and untracked:

- `output/attendance-report-fields-live-acceptance/2026-05-19-job-mode-daily-after-staging-update/report.json`
- `output/attendance-report-fields-live-acceptance/2026-05-19-job-mode-daily-after-staging-update/report.md`
- `output/attendance-report-period-summaries-live-acceptance/2026-05-19-job-mode-period-after-staging-update/report.json`
- `output/attendance-report-period-summaries-live-acceptance/2026-05-19-job-mode-period-after-staging-update/report.md`

These files are not committed because they are generated live evidence.

## Boundary Verification

- Staging writes were explicitly authorized for this evidence run.
- Job mode used only the existing job routes:
  - `POST /api/attendance/report-sync-jobs`
  - `POST /api/attendance/report-sync-jobs/:id/run-next-page`
  - `POST /api/attendance/report-sync-jobs/:id/cancel`
- Daily and period jobs both completed through manual-step execution.
- Completed jobs rejected rerun with `409 JOB_TERMINAL`.
- Replacement jobs could be created and then canceled, so terminal jobs do not block future runs.
- No secret or token literal appears in this document.

## Residual Notes

- Staging DB still reports many older pending migrations when using the generic migration lister. This evidence slice intentionally did not apply the full migration set.
- The narrow staging schema alignment should be superseded naturally when the full migration runner is later applied; the merged migration is idempotent for an already existing job table.
