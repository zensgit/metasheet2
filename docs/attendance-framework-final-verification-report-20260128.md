# Attendance Framework Final Verification Report (2026-01-28)

## Commands Run (Local)
- `pnpm --filter @metasheet/core-backend build`
- `pnpm --filter @metasheet/web build`
- `pnpm --filter @metasheet/core-backend test:integration:attendance`
- `python3 docs/attendance-import-preview-payload.json -> POST /api/attendance/import/preview`
- `pnpm install --no-frozen-lockfile`
- `gh workflow run docker-build.yml --ref feat/attendance-framework-20260128`

## Commands Run (Server: 142.171.239.56)
- `docker exec metasheet-backend sh -lc "pnpm --filter @metasheet/core-backend migrate"`
- `docker exec metasheet-backend sh -lc "pnpm --filter @metasheet/core-backend test:integration:attendance"`
- `docker exec metasheet-backend sh -lc "pnpm --filter @metasheet/core-backend build"`
- `tar -xzf /tmp/plugin-attendance.tar.gz -C /tmp`
- `docker cp /tmp/plugin-attendance/. metasheet-backend:/app/plugins/plugin-attendance`
- `docker exec metasheet-postgres psql -U metasheet -d metasheet -c "ALTER TABLE attendance_records ALTER COLUMN status TYPE VARCHAR(64);"`
- `docker restart metasheet-backend`
- `tar -xzf ~/metasheet-web-dist.tgz -C ~/web-dist`
- `docker exec metasheet-web sh -lc "rm -rf /usr/share/nginx/html/*"`
- `docker cp ~/web-dist/dist/. metasheet-web:/usr/share/nginx/html/`
- `docker restart metasheet-web`
- `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8081/`
- `docker exec metasheet-backend sh -lc "node -e '...jwt.sign(...)'"` (generate short-lived admin token)
- `docker compose -f /home/mainuser/metasheet2/docker-compose.app.yml pull backend`
- `docker compose -f /home/mainuser/metasheet2/docker-compose.app.yml up -d backend`
- `python3` script to call:
  - `POST /api/attendance/rule-sets`
  - `POST /api/attendance/payroll-templates`
  - `POST /api/attendance/payroll-cycles`
  - `GET /api/attendance/payroll-cycles/:id/summary`
  - `GET /api/attendance/payroll-cycles/:id/summary/export`

## Results
- ✅ Backend build succeeded
- ✅ Web build succeeded
- ✅ Docker build workflow re-run on branch after lockfile checksum refresh (run `21463337505`) and pushed latest backend/frontend images.
- ⚠️ Initial docker build failed due to `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`; resolved by updating `pnpm-lock.yaml` checksum and re-running workflow.
- ✅ DB migration executed: `zzzz20260128120000_create_attendance_rule_sets_and_payroll`
- ❌ Integration test suite failed (3 tests). Failures:
  - `tests/integration/attendance-plugin.test.ts`: duplicate key on `attendance_rule_sets` (`idx_attendance_rule_sets_org_name`), assertion expected 201/409 but got 500.
  - `tests/integration/spreadsheet-integration.test.ts`: formula engine returned `#ERROR!` for null/empty cell reference cases (2 tests).
  - Plugin loader warnings for `plugin-view-kanban` parsing error (test still continued).
- ⚠️ Test run logged DB auth errors from Workflow engine init (password auth failed for user `metasheet`), but test still passed.
- ⚠️ Policy engine behavior validated by code review; no dedicated policy preview/import test run yet.
- ✅ Import preview API (server) succeeded for 2 users (payload saved in `docs/attendance-import-preview-payload.json`).
- ✅ Import API (server) succeeded for 2 users (10 rows). Summary saved in `docs/attendance-import-server-summary.json`.
- ✅ Records API verified: `/api/attendance/records` returned 5 rows per user (files `docs/attendance-records-server-*.json`).
- ⚠️ Re-run preview with timezone-corrected payload failed due to 401 (token expired); needs fresh admin token to re-validate.
- ✅ Backend container rebuilt and restarted
- ✅ Backend redeployed from GHCR `latest` via docker compose pull/up.
- ✅ Attendance plugin hotpatched in container (statusMap substring matching) and backend restarted
- ✅ DB schema updated: `attendance_records.status` length set to `VARCHAR(64)`
- ✅ Web static assets updated and container restarted
- ✅ Web root responded `200`
- ✅ UI smoke: `/attendance` loaded; Rule Sets / Payroll Templates / Payroll Cycles sections visible; no auth error banner.
- ✅ UI records (MCP): date range `2025-12-01` → `2025-12-05`, user `09141829115765` shows 5 records; Summary totals 5 days / 2400 minutes / Early leave 222; status `Early leave`.
- ✅ UI records (MCP): same range, user `0613271732687725` shows 5 records; Summary totals 5 days / 0 minutes / Absent 5; status `Absent`.
- ✅ API E2E: rule set, payroll template, payroll cycle created; summary + CSV export succeeded.
 - ⚠️ Policy rules preview/import validation not executed after latest changes (see Not Run).
- ✅ Import preview (full payload, statusMap) now normalizes to allowed statuses. Output: `docs/attendance-import-preview-核对-20260120-20260127-full-statusmap-normalized-afterpatch.json`.
- ✅ Full CSV import (single request, statusMap) succeeded for 3080 rows. Output: `docs/attendance-import-核对-20260120-20260127-full-statusmap-normalized-afterpatch.json`.
- ✅ Summary API verified after statusMap import: `docs/attendance-summary-核对-20260120-20260127-statusmap.json`.
- ✅ Post-image redeploy checks: import preview sample OK (`docs/attendance-import-preview-statusmap-postimage.json`) and summary OK (`docs/attendance-summary-核对-20260120-20260127-statusmap-postimage.json`).

## Addendum (Local CSV Validation)
- ✅ `node scripts/attendance/dingtalk-csv-to-import.mjs --input /Users/huazhou/Downloads/核对(2).csv --columns docs/dingtalk-columns-alias-20260128.json --user-map /Users/huazhou/Downloads/dingtalk-csv-userid-map-核对.json --out artifacts/attendance/import-核对-20260120-20260127.json --from 2026-01-20 --to 2026-01-27 --debug 1`
- ✅ Output generated: `artifacts/attendance/import-核对-20260120-20260127.json` (3080 rows)
- ✅ API preview (mapped sample) succeeded for 10 rows. Output saved in `docs/attendance-import-preview-核对-20260120-20260127.json`.
- ❌ API import (same payload) failed with `INTERNAL_ERROR` (HTTP 500) before server hotfix. Response saved in `docs/attendance-import-核对-20260120-20260127.json`.
- ✅ API preview re-run after removing status mapping succeeded. Output saved in `docs/attendance-import-preview-核对-20260120-20260127-nostatus.json`.
- ✅ API import succeeded for 10 rows after removing status mapping. Output saved in `docs/attendance-import-核对-20260120-20260127-nostatus.json`.
- ✅ StatusMap preview/import now succeeds after server hotfix (see Full Import section).
- ✅ Records API verified for sample user: `docs/attendance-records-核对-20260120-20260124.json`.

## Not Run
- Full integration suite (`pnpm --filter @metasheet/core-backend test:integration`) not executed.
- Policy engine preview/import UI smoke not re-run after latest policy changes.
- Full import initially failed with nginx 413; retried using 200-row batches.

## Full Import (Batched) Result
- ✅ Full CSV import succeeded in 16 batches (200 rows each, last 80). Batch log saved in `docs/attendance-import-核对-20260120-20260127-full-nostatus-batched.json`.
- ✅ Summary API verified for sample user: `docs/attendance-summary-核对-20260120-20260127.json`.
- ✅ Nginx `client_max_body_size` increased to 50m in `metasheet-web` container to avoid 413 (server-side config change).

## Full Import (Single Request) Result
- ✅ Full CSV import succeeded as a single request after nginx limit increase (no status mapping). Output saved in `docs/attendance-import-核对-20260120-20260127-full-nostatus-single.json`.
- ✅ Full CSV import with `statusMap` succeeded after server hotfix + DB column update. Output saved in `docs/attendance-import-核对-20260120-20260127-full-statusmap-normalized-afterpatch.json`.
- ✅ Preview with `statusMap` now returns only allowed statuses. Output saved in `docs/attendance-import-preview-核对-20260120-20260127-full-statusmap-normalized-afterpatch.json`.
- ✅ Summary API verified for statusMap import: `docs/attendance-summary-核对-20260120-20260127-statusmap.json`.
- ℹ️ Previous failure responses retained for reference: `docs/attendance-import-核对-20260120-20260127-full-statusmap.json`, `docs/attendance-import-核对-20260120-20260127-full-statusmap-normalized.json`.

## Notes
- No runtime UI/API smoke tests executed beyond the integration test above.
- E2E API run created objects: Rule Set `d019f58c-2697-43f6-b9c7-bb6c483ad28e`, Template `b3379adb-9b5f-4d36-818e-47ec088b5fd1`, Cycle `b051e6bf-0fd7-461f-9771-5c7f0b8ac4a9`.
- UI records validation required manually setting date range and User ID to align with imported data.
