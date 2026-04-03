# Attendance API Create Quickstart

This quickstart lists the minimum known-good request bodies for the attendance create routes that were most often mis-tested during on-prem validation.

## Create Attendance Request

Canonical leave request:

```json
{
  "workDate": "2026-04-03",
  "requestType": "leave",
  "leaveTypeCode": "annual_leave",
  "minutes": 480,
  "reason": "Personal leave"
}
```

Snake_case missed check-in request:

```json
{
  "work_date": "2026-04-03",
  "request_type": "missed_check_in",
  "requested_in_at": "2026-04-03T09:05:00+08:00",
  "reason": "Badge reader was offline"
}
```

Notes:
- `workDate`, `work_date`, and `date` are accepted aliases.
- `requestType`, `request_type`, and `type` are accepted aliases.
- `missed_check_in` requires `requestedInAt`/`requested_in_at`/`clockIn`.
- `missed_check_out` requires `requestedOutAt`/`requested_out_at`/`clockOut`.
- `leave` requires a valid `leaveTypeId`/`leave_type_id` or `leaveTypeCode`/`leave_type_code`.
- `overtime` requires a valid `overtimeRuleId`/`overtime_rule_id` or `overtimeRuleName`/`overtime_rule_name`.

Canonical overtime request:

```json
{
  "workDate": "2026-04-03",
  "requestType": "overtime",
  "overtimeRuleId": "22222222-2222-4222-8222-222222222222",
  "minutes": 90,
  "reason": "Release support"
}
```

## Create Approval Flow

```json
{
  "name": "Leave Approval",
  "requestType": "leave",
  "steps": [],
  "isActive": true
}
```

## Create Rotation Rule

```json
{
  "name": "Two Shift Rotation",
  "shiftSequence": ["Day Shift", "Night Shift"]
}
```

Compatibility aliases:
- `shift_sequence`
- `shiftIds`
- `shift_ids`

## Create Payroll Cycle

Explicit date range:

```json
{
  "name": "2026-04 Payroll",
  "startDate": "2026-04-01",
  "endDate": "2026-04-30"
}
```

## Generate Payroll Cycles

Requires a default payroll template for the org, or an explicit template id.

```json
{
  "payrollTemplateId": "11111111-1111-4111-8111-111111111111",
  "year": 2026,
  "month": 4,
  "count": 1,
  "status": "open"
}
```

## Attendance Import Template

Template download endpoints:
- `GET /api/attendance/import/template`
- `GET /api/attendance/import/template.csv`

Minimum CSV headers for the daily summary profile:

```csv
日期,上班1打卡时间,下班1打卡时间
2026-04-03,2026-04-03 09:00:00,2026-04-03 18:00:00
```

## Shift Delete Guard Manual Check

To verify that deleting a shift fails with `409` when it is still in use:

1. Create a shift with `POST /api/attendance/shifts`.
2. Create a rotation rule with that shift name using `POST /api/attendance/rotation-rules`.
3. Create a rotation assignment using `POST /api/attendance/rotation-assignments`.
4. Delete the shift with `DELETE /api/attendance/shifts/:id`.

Expected result:

```json
{
  "ok": false,
  "error": {
    "code": "CONFLICT",
    "message": "Shift is still referenced by active assignments or rotation schedules"
  }
}
```
