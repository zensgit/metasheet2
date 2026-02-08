# Attendance: Anomalies + Payroll Cycle Batch Generation (Design)

Date: 2026-02-08

## Goal
Deliver the next-stage items (1+2+3) in a way that is:

- User-facing: anomalies are discoverable and can be closed via requests without hunting through records.
- Admin-facing: payroll cycles can be generated in bulk from a template (cross-month windows supported by template rules).
- Safe by default: permissions and "access other users" restrictions are preserved.

This design intentionally focuses on "close the loop" UX and operationally stable endpoints, not full payroll settlement.

## Scope
In scope:

- New backend API: `GET /api/attendance/anomalies`
- Overview UI: "Anomalies" card
- "Create request" prefill from anomaly (approval linkage)
- Admin Center UI: payroll cycles batch generation (uses existing backend endpoint)

Out of scope:

- End-to-end payroll settlement (wages, payslips, exporting to finance system)
- Deep anomaly rule tuning/weighting beyond existing attendance record `status`

## Backend

### API: `GET /api/attendance/anomalies`

Purpose:

- Provide a minimal, paginated list of "workday anomalies" for a given user/date range.
- Attach request linkage (pending/latest request for that date) so the UI can decide whether to allow creating a new request.
- Provide `suggestedRequestType` so the UI can prefill request type.

Permissions:

- Requires `attendance:read`.
- When `userId` is different from the requester, checks `canAccessOtherUsers(requesterId)` and denies with 403 if not allowed.

Query parameters:

- `from` (optional, `YYYY-MM-DD`) default: last 30 days
- `to` (optional, `YYYY-MM-DD`) default: today
- `userId` (optional) default: current user
- Pagination: `page`, `pageSize` (existing `parsePagination(req.query)`)

Anomaly definition (v1):

- Attendance record rows within `[from, to]` where:
  - `COALESCE(is_workday, true) = true`
  - `status` not in `['normal', 'off', 'adjusted']`

Request linkage (approval linkage):

- Loads `attendance_requests` in the same date window.
- For each `workDate`:
  - If any `pending` exists, anomaly `state = 'pending'` and UI must not allow creating another request.
  - Otherwise `state = 'open'`.
  - Exposes `request` as `pending ?? latest` (so the UI can show a chip).

Warnings:

- Extracted from record `meta` (normalized) by collecting:
  - `meta.warnings[]`
  - `meta.metrics.warnings[]`
  - `meta.policy.warnings[]`
  - `meta.engine.warnings[]`
- Deduplicated to a string array.

Suggested request type:

- `absent` -> `leave`
- `partial`:
  - missing `first_in_at` -> `missed_check_in`
  - missing `last_out_at` -> `missed_check_out`
  - otherwise -> `time_correction`
- `late` / `early_leave` / `late_early` -> `time_correction`
- else -> `null`

Response shape (v1):

```jsonc
{
  "ok": true,
  "data": {
    "items": [
      {
        "recordId": "...",
        "workDate": "2026-02-01",
        "status": "partial",
        "warnings": ["..."],
        "state": "open",
        "request": { "id": "...", "status": "pending", "requestType": "missed_check_out" },
        "suggestedRequestType": "missed_check_out",
        "workMinutes": 0,
        "lateMinutes": 0,
        "earlyLeaveMinutes": 0,
        "leaveMinutes": 0,
        "overtimeMinutes": 0
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 50,
    "from": "2026-01-09",
    "to": "2026-02-08"
  }
}
```

### Existing endpoint used: `POST /api/attendance/payroll-cycles/generate`

This endpoint already exists in the attendance plugin. The next-stage work adds UI + tests around it.

Behavior summary:

- Requires `attendance:admin`.
- Resolves template:
  - Uses `templateId` if provided, otherwise uses org default template.
- For each generated cycle:
  - Calculates `(startDate, endDate)` using template rules + `anchorDate`.
  - Inserts `attendance_payroll_cycles` with `ON CONFLICT (org_id, start_date, end_date) DO NOTHING`.
  - Returns arrays: `created[]` (full rows), `skipped[]` (date windows).

## Frontend (apps/web)

### Overview: "Anomalies" card

Location:

- `apps/web/src/views/AttendanceView.vue` (Overview tab)

UI behavior:

- Adds a card showing:
  - `Date`, `Status`, `Warnings`, `Request`, `Action`
- Action:
  - `Create request`:
    - Prefills the request form:
      - `workDate = anomaly.workDate`
      - `requestType = anomaly.suggestedRequestType ?? 'time_correction'`
    - Scrolls to request form.
  - Disabled when `state === 'pending'` (prevents duplicate pending request per day).

Data flow:

- `refreshAll()` now includes `loadAnomalies()` alongside summary/records/requests/report/holidays.
- `loadAnomalies()` calls `/api/attendance/anomalies` using same date range and optional userId/orgId filters.

### Admin Center: Payroll cycles batch generation

Location:

- `apps/web/src/views/AttendanceView.vue` (Admin Center -> Payroll Cycles section)

UI behavior:

- Adds `<details>` section: "Batch generate cycles"
- Inputs:
  - `Template` (optional, defaults to org default template)
  - `Anchor date` (required)
  - `Count` (1..36)
  - `Status` (`open|closed|archived`)
  - `Name prefix` (optional)
  - `Metadata (JSON)` (optional; must be valid JSON object)
- Action:
  - Calls `POST /api/attendance/payroll-cycles/generate`
  - Displays result: `Created X, skipped Y`
  - Reloads payroll cycles list

## Risks / Follow-ups

- Anomaly definition is currently record-status-based. If future policies introduce additional statuses, update excluded list or make it configurable.
- `orgId` query param is currently accepted by the UI but backend derives orgId from context; keep as-is for compatibility, but consider removing from schema in a later cleanup.

