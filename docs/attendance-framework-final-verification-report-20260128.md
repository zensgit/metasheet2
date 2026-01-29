# Attendance Framework Final Verification Report (2026-01-28)

## Commands Run (Local)
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend test:integration:attendance`
- `python3 docs/attendance-import-preview-payload.json -> POST /api/attendance/import/preview`

## Commands Run (Server: 142.171.239.56)
- `docker exec metasheet-backend sh -lc "pnpm --filter @metasheet/core-backend migrate"`
- `docker exec metasheet-backend sh -lc "pnpm --filter @metasheet/core-backend test:integration:attendance"`
- `docker exec metasheet-backend sh -lc "pnpm --filter @metasheet/core-backend build"`
- `docker restart metasheet-backend`
- `tar -xzf ~/metasheet-web-dist.tgz -C ~/web-dist`
- `docker exec metasheet-web sh -lc "rm -rf /usr/share/nginx/html/*"`
- `docker cp ~/web-dist/dist/. metasheet-web:/usr/share/nginx/html/`
- `docker restart metasheet-web`
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/`
- `docker exec metasheet-backend sh -lc "node -e '...jwt.sign(...)'"` (generate short-lived admin token)
- `python3` script to call:
  - `POST /api/attendance/rule-sets`
  - `POST /api/attendance/payroll-templates`
  - `POST /api/attendance/payroll-cycles`
  - `GET /api/attendance/payroll-cycles/:id/summary`
  - `GET /api/attendance/payroll-cycles/:id/summary/export`

## Results
- ✅ Backend build succeeded
- ✅ Web build succeeded
- ✅ DB migration executed: `zzzz20260128120000_create_attendance_rule_sets_and_payroll`
- ✅ Attendance integration test passed (1 test)
- ⚠️ Test run logged DB auth errors from Workflow engine init (password auth failed for user `metasheet`), but test still passed.
- ⚠️ Policy engine behavior validated by code review; no dedicated policy preview/import test run yet.
- ✅ Import preview API (server) succeeded for 2 users (payload saved in `docs/attendance-import-preview-payload.json`).
- ✅ Import API (server) succeeded for 2 users (10 rows). Summary saved in `docs/attendance-import-server-summary.json`.
- ✅ Records API verified: `/api/attendance/records` returned 5 rows per user (files `docs/attendance-records-server-*.json`).
- ⚠️ Re-run preview with timezone-corrected payload failed due to 401 (token expired); needs fresh admin token to re-validate.
- ✅ Backend container rebuilt and restarted
- ✅ Web static assets updated and container restarted
- ✅ Web root responded `200`
- ✅ UI smoke: `/attendance` loaded; Rule Sets / Payroll Templates / Payroll Cycles sections visible; no auth error banner.
- ✅ UI records (MCP): date range `2025-12-01` → `2025-12-05`, user `09141829115765` shows 5 records; Summary totals 5 days / 2400 minutes / Early leave 222; status `Early leave`.
- ✅ UI records (MCP): same range, user `0613271732687725` shows 5 records; Summary totals 5 days / 0 minutes / Absent 5; status `Absent`.
- ✅ API E2E: rule set, payroll template, payroll cycle created; summary + CSV export succeeded.
 - ⚠️ Policy rules preview/import validation not executed after latest changes (see Not Run).

## Addendum (Local CSV Validation)
- ✅ `node scripts/attendance/dingtalk-csv-to-import.mjs --input /Users/huazhou/Downloads/核对(2).csv --columns docs/dingtalk-columns-alias-20260128.json --user-map /Users/huazhou/Downloads/dingtalk-csv-userid-map-核对.json --out artifacts/attendance/import-核对-20260120-20260127.json --from 2026-01-20 --to 2026-01-27 --debug 1`
- ✅ Output generated: `artifacts/attendance/import-核对-20260120-20260127.json` (3080 rows)
- ✅ API preview (mapped sample) succeeded for 10 rows. Output saved in `docs/attendance-import-preview-核对-20260120-20260127.json`.
- ❌ API import (same payload) failed with `INTERNAL_ERROR` (HTTP 500). Response saved in `docs/attendance-import-核对-20260120-20260127.json`. Needs backend logs for root cause.
- ✅ API preview re-run after removing status mapping succeeded. Output saved in `docs/attendance-import-preview-核对-20260120-20260127-nostatus.json`.
- ✅ API import succeeded for 10 rows after removing status mapping. Output saved in `docs/attendance-import-核对-20260120-20260127-nostatus.json`.
- ✅ Records API verified for sample user: `docs/attendance-records-核对-20260120-20260124.json`.

## Not Run
- Full integration suite (`pnpm --filter @metasheet/core-backend test:integration`) not executed.
- Policy engine preview/import UI smoke not re-run after latest policy changes.
- Attendance API import for full 3080-row CSV output not executed (only 10-row sample attempted).
- Import preview/import with `statusMap` normalization not executed (we removed status mapping instead).
 - Full import initially failed with nginx 413; retried using 200-row batches.

## Full Import (Batched) Result
- ✅ Full CSV import succeeded in 16 batches (200 rows each, last 80). Batch log saved in `docs/attendance-import-核对-20260120-20260127-full-nostatus-batched.json`.
- ✅ Summary API verified for sample user: `docs/attendance-summary-核对-20260120-20260127.json`.
- ✅ Nginx `client_max_body_size` increased to 50m in `metasheet-web` container to avoid 413 (server-side config change).

## Full Import (Single Request) Result
- ✅ Full CSV import succeeded as a single request after nginx limit increase (no status mapping). Output saved in `docs/attendance-import-核对-20260120-20260127-full-nostatus-single.json`.
- ❌ Full CSV import with `statusMap` still failed (`value too long for type character varying(20)`), even after adding prefix matching in code. Response saved in `docs/attendance-import-核对-20260120-20260127-full-statusmap.json`.
- ❌ Full CSV import with pre-normalized `attend_result` and expanded `statusMap` still failed (same error). Response saved in `docs/attendance-import-核对-20260120-20260127-full-statusmap-normalized.json`.
- ⚠️ Recommendation: keep status mapping disabled (use computed status) for now, or instrument backend to log offending status values.

## Notes
- No runtime UI/API smoke tests executed beyond the integration test above.
- E2E API run created objects: Rule Set `d019f58c-2697-43f6-b9c7-bb6c483ad28e`, Template `b3379adb-9b5f-4d36-818e-47ec088b5fd1`, Cycle `b051e6bf-0fd7-461f-9771-5c7f0b8ac4a9`.
- UI records validation required manually setting date range and User ID to align with imported data.
