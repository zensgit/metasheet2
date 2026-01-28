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
- ⚠️ Re-run preview with timezone-corrected payload failed due to 401 (token expired); needs fresh admin token to re-validate.
- ✅ Backend container rebuilt and restarted
- ✅ Web static assets updated and container restarted
- ✅ Web root responded `200`
- ✅ UI smoke: `/attendance` loaded; Rule Sets / Payroll Templates / Payroll Cycles sections visible; no auth error banner.
- ✅ API E2E: rule set, payroll template, payroll cycle created; summary + CSV export succeeded.
 - ⚠️ Policy rules preview/import validation not executed after latest changes (see Not Run).

## Not Run
- Full integration suite (`pnpm --filter @metasheet/core-backend test:integration`) not executed.
- Policy engine preview/import UI smoke not re-run after latest policy changes.

## Notes
- No runtime UI/API smoke tests executed beyond the integration test above.
- E2E API run created objects: Rule Set `d019f58c-2697-43f6-b9c7-bb6c483ad28e`, Template `b3379adb-9b5f-4d36-818e-47ec088b5fd1`, Cycle `b051e6bf-0fd7-461f-9771-5c7f0b8ac4a9`.
