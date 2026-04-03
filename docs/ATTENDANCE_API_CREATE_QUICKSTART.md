# Attendance API Create Quickstart

This note captures the minimal request bodies that are easiest to use during manual testing of the attendance admin APIs.

## Requests

### Missed check-in

```json
{
  "workDate": "2026-04-03",
  "requestType": "missed_check_in",
  "requestedInAt": "2026-04-03T09:05:00+08:00",
  "reason": "Forgot to check in"
}
```

### Leave

Use either `leaveTypeId` from `/api/attendance/leave-types` or `leaveTypeCode`.

```json
{
  "workDate": "2026-04-03",
  "requestType": "leave",
  "leaveTypeId": "11111111-1111-4111-8111-111111111111",
  "minutes": 480,
  "reason": "Family event"
}
```

### Overtime

Use either `overtimeRuleId` from `/api/attendance/overtime-rules` or `overtimeRuleName`.

```json
{
  "workDate": "2026-04-03",
  "requestType": "overtime",
  "overtimeRuleId": "22222222-2222-4222-8222-222222222222",
  "minutes": 90,
  "reason": "Release support"
}
```

## Approval Flows

Canonical payload:

```json
{
  "name": "补卡审批",
  "requestType": "missed_check_in",
  "steps": [
    {
      "name": "直属主管",
      "approverUserIds": ["manager-user-001"]
    }
  ],
  "isActive": true
}
```

Compatible payload also accepted:

```json
{
  "name": "请假审批",
  "type": "leave",
  "steps": "[{\"name\":\"直属主管\",\"approver_user_ids\":[\"manager-user-001\"]}]",
  "is_active": true
}
```

## Rotation Rules

Canonical payload:

```json
{
  "name": "四班两倒",
  "timezone": "Asia/Shanghai",
  "shiftSequence": [
    "33333333-3333-4333-8333-333333333333"
  ],
  "isActive": true
}
```

Compatible aliases also accepted:

```json
{
  "name": "四班两倒",
  "timezone": "Asia/Shanghai",
  "shift_ids": [
    "33333333-3333-4333-8333-333333333333"
  ],
  "is_active": true
}
```

## Payroll Cycles

### Create

Explicit date range:

```json
{
  "name": "2026-04 Payroll",
  "startDate": "2026-04-01",
  "endDate": "2026-04-30",
  "status": "open"
}
```

Template-based create using compatibility alias:

```json
{
  "payrollTemplateId": "44444444-4444-4444-8444-444444444444",
  "anchor_date": "2026-04-01",
  "name": "2026-04 Payroll",
  "status": "open"
}
```

### Generate

```json
{
  "payrollTemplateId": "44444444-4444-4444-8444-444444444444",
  "year": 2026,
  "month": 4,
  "count": 1,
  "name_prefix": "April Payroll"
}
```

## Shift Delete Guard Manual Check

To verify that deleting a shift fails with `409` when it is still in use:

1. Create a shift with `POST /api/attendance/shifts`.
2. Create a rotation rule with that shift id using `POST /api/attendance/rotation-rules`.
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
