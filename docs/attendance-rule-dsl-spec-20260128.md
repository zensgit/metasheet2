# Attendance Policy DSL Spec (2026-01-28)

This document defines the JSON policy DSL used by the attendance rule-set `policies` block. The goal is to let orgs encode special cases (security/driver, attendance groups, cross-month payroll quirks) without hard-coding logic.

## 1) Structure
```json
{
  "policies": {
    "userGroups": [ ... ],
    "rules": [ ... ]
  }
}
```

### User Groups
User groups provide reusable labels (e.g. `security`, `driver`, `single_rest_workshop`). Groups are resolved per row using **facts** (userId, shiftName, isHoliday, isWorkingDay) and **fieldValues** (imported fields).

```json
{
  "name": "security",
  "userIds": ["168903..."],
  "shiftNames": ["保安班次"],
  "isHoliday": false,
  "fieldEquals": { "attendance_group": "保安" },
  "fieldIn": { "attendance_group": ["保安", "保安组"] },
  "fieldContains": { "department": "安保" },
  "fieldNumberGte": { "work_minutes": 0 }
}
```

### Rules
Rules are evaluated **in order**. If `when` matches, `then` actions apply. Multiple rules can apply to the same row.

```json
{
  "name": "Security holiday overtime",
  "when": {
    "userGroup": "security",
    "isHoliday": true,
    "fieldExists": ["1_on_duty_user_check_time"]
  },
  "then": {
    "addOvertimeMinutes": 480,
    "addWarning": "Security holiday treated as overtime"
  }
}
```

## 2) Condition Keys (`when`)
### Identity & Calendar
- `userIds: string[]`
- `userGroup: string`
- `shiftNames: string[]`
- `isHoliday: boolean`
- `isWorkingDay: boolean`
- `statusIn: string[]`

### Field Conditions (import fields / mapped fields)
- `fieldEquals: { [field: string]: any }`
- `fieldIn: { [field: string]: any[] }`
- `fieldContains: { [field: string]: string }`
- `fieldExists: string[]`
- `fieldNumberGte: { [field: string]: number }`
- `fieldNumberLte: { [field: string]: number }`

### Metric Conditions (computed metrics)
Metrics include: `workMinutes`, `lateMinutes`, `earlyLeaveMinutes`, `leaveMinutes`, `overtimeMinutes`, `status`.
- `metricGte: { [metric: string]: number }`
- `metricLte: { [metric: string]: number }`

## 3) Actions (`then`)
### Set (override)
- `setWorkMinutes`
- `setLateMinutes`
- `setEarlyLeaveMinutes`
- `setLeaveMinutes`
- `setOvertimeMinutes`
- `setStatus`

### Add (increment)
- `addWorkMinutes`
- `addLateMinutes`
- `addEarlyLeaveMinutes`
- `addLeaveMinutes`
- `addOvertimeMinutes`

### Warnings
- `addWarning`
- `addWarnings`

## 4) Examples
### Driver Rest-Day Overtime
```json
{
  "name": "Driver rest day counts as overtime",
  "when": {
    "userGroup": "driver",
    "fieldEquals": { "shift": "休息" },
    "fieldExists": ["1_on_duty_user_check_time"]
  },
  "then": {
    "setOvertimeMinutes": 480,
    "addWarning": "Driver rest day check-in => 8h overtime"
  }
}
```

### Single-Rest Workshop Business Trip
```json
{
  "name": "Single-rest workshop on business trip",
  "when": {
    "fieldEquals": { "attendance_group": "单休车间" },
    "shiftNames": ["休息"],
    "fieldContains": { "related_approval": "出差" }
  },
  "then": {
    "setOvertimeMinutes": 480,
    "addWarning": "Single-rest workshop rest day business trip => 8h overtime"
  }
}
```

### Late Penalty When Late Minutes > 15
```json
{
  "name": "Late penalty",
  "when": { "metricGte": { "lateMinutes": 15 } },
  "then": { "addLeaveMinutes": 30 }
}
```

## 5) Implementation Notes
- Rules apply sequentially; later rules can override earlier ones.
- `fieldNumberGte/Lte` and `metricGte/Lte` use numeric parsing; non-numeric values fail the condition.
- `attendance_group` is now mapped from CSV/JSON imports and is safe for policy use.
- Store user roles (security/driver) either as `userGroup` with `userIds` or via CSV field mapping (department/role).
