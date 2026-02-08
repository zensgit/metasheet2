# Attendance: Anomalies + Payroll Cycle Batch Generation (Verification)

Date: 2026-02-08

## What Changed

1. New anomalies API:
   - `GET /api/attendance/anomalies`
2. Overview UI:
   - New "Anomalies" card with request linkage + "Create request" prefill.
3. Admin Center UI:
   - Payroll cycles "Batch generate cycles" UI (uses `POST /api/attendance/payroll-cycles/generate`).

## Local Verification (Repo)

From repo root:

```bash
pnpm --filter @metasheet/core-backend test:integration:attendance
pnpm --filter @metasheet/core-backend build
pnpm --filter @metasheet/web build
```

Expected:

- Attendance integration test passes.
- Backend `tsc` passes.
- Frontend `vue-tsc + vite build` passes.

## API Verification (Example)

Assume:

- `API_BASE=http://<host>:<port>/api`
- `TOKEN=<ADMIN_JWT>`

### 1) Create a partial record (check-in only) via import

Pick a weekday date (so `is_workday=true`), e.g. `2026-02-10`.

```bash
curl -sS -X POST "$API_BASE/attendance/import" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "demo-user",
    "mode": "override",
    "rows": [
      {
        "workDate": "2026-02-10",
        "fields": {
          "firstInAt": "2026-02-10T09:00:00Z"
        }
      }
    ]
  }' | jq .
```

Expected:

- HTTP 200 with `{ ok: true }`.

### 2) Query anomalies

```bash
curl -sS "$API_BASE/attendance/anomalies?userId=demo-user&from=2026-02-10&to=2026-02-10&page=1&pageSize=50" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected:

- HTTP 200 with `data.items[]` containing:
  - `workDate == "2026-02-10"`
  - `status == "partial"`
  - `state == "open"` (before any request is created)

### 3) Create an attendance request (close the anomaly)

```bash
curl -sS -X POST "$API_BASE/attendance/requests" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "workDate": "2026-02-10",
    "requestType": "missed_check_out",
    "requestedOutAt": "2026-02-10T18:00:00Z",
    "reason": "Auto-filled from anomalies"
  }' | jq .
```

Expected:

- HTTP 201.

### 4) Query anomalies again

```bash
curl -sS "$API_BASE/attendance/anomalies?userId=demo-user&from=2026-02-10&to=2026-02-10" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

Expected:

- The anomaly item now includes:
  - `request` object (pending/latest)
  - `state == "pending"` (if the request is still pending)

## UI Verification

Prerequisites:

- A working deployment of web + api with the updated attendance plugin.
- A user token with `attendance:read` and `attendance:write` for request creation.

### Overview: anomalies card

1. Open `/attendance`.
2. Set date range to include the anomaly date.
3. Confirm the "Anomalies" card appears.
4. Click `Create request` on an anomaly row.
5. Confirm the request form is prefilled:
   - Work date set to that row's date
   - Request type set to `suggestedRequestType` (or fallback `time_correction`)
6. Submit request and confirm:
   - The anomaly row shows a request chip
   - The button becomes disabled if state is pending

### Admin Center: payroll cycles batch generation

1. Switch to `Admin Center`.
2. Go to `Payroll Cycles`.
3. Expand `Batch generate cycles`.
4. Choose:
   - Anchor date (required)
   - Count (e.g. 2)
   - Optional name prefix + metadata json
5. Click `Generate cycles`.
6. Confirm:
   - Status message indicates success
   - The UI shows `Created X, skipped Y`
   - Cycles list is updated

## Notes

- Do not paste real tokens or passwords into repo docs/commits.
- The full integration test suite (`pnpm --filter @metasheet/core-backend test:integration`) can fail locally due to unrelated partitioned `audit_logs` setup; this does not block attendance verification for this change set.

