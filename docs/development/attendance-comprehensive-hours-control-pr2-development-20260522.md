# Attendance Comprehensive Working Hours Control PR2 Development

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-preview-20260522`

## Summary

This slice implements PR2 from `attendance-comprehensive-hours-control-rfc-20260522.md`: a read-only backend preview route for comprehensive working-hours control (`综合工时制`).

It wires the PR1 pure helpers to existing attendance producers:

- planned minutes from effective-calendar / schedule context resolution
- actual minutes from `loadAttendanceSummary()`
- cap comparison with stable user ordering
- explicit validation and schema-gap errors

The route does not persist policy, does not add UI, and does not touch any schedule save path.

## Public API

```text
POST /api/attendance/comprehensive-hours/preview
```

Permission: `attendance:admin`

Request shape:

```json
{
  "policyDraft": {
    "capMinutes": 960,
    "enforcement": "warn"
  },
  "scope": {
    "userIds": ["user-a", "user-b"]
  },
  "period": {
    "type": "custom_range",
    "from": "2026-05-01",
    "to": "2026-05-31"
  },
  "metric": "planned"
}
```

Supported period types match PR1:

- `month`
- `quarter`
- `year`
- `custom_range`
- `payroll_cycle`

For `payroll_cycle`, the route accepts `cycleId` and loads `attendance_payroll_cycles` to resolve the date range.

## Response Shape

```json
{
  "ok": true,
  "data": {
    "readOnly": true,
    "period": {
      "type": "custom_range",
      "key": "range:2026-05-01:2026-05-31",
      "from": "2026-05-01",
      "to": "2026-05-31",
      "label": "2026-05-01..2026-05-31"
    },
    "metric": "planned",
    "enforcement": "warn",
    "capMinutes": 960,
    "scope": {
      "userIds": ["user-a", "user-b"]
    },
    "rows": [],
    "aggregate": {
      "users": 0,
      "ok": 0,
      "warning": 0,
      "violation": 0,
      "totalMinutes": 0,
      "totalExcessMinutes": 0,
      "totalRemainingMinutes": 0,
      "status": "ok"
    },
    "degraded": false
  }
}
```

## Implementation Notes

| Area | Decision |
| --- | --- |
| Scope | v1 requires explicit `userId` / `userIds`; `allUsers` is rejected to avoid turning preview into a batch scan. |
| Cap input | Accepts `capMinutes` or `capHours` at top level or under `policyDraft`; value must be positive. |
| Planned metric | Uses `buildWorkContextPrefetch()` + `resolveWorkContextFromPrefetch()` over the resolved date range, then feeds PR1's planned-minutes helper. |
| Actual metric | Uses `loadAttendanceSummary()` and PR1's actual-minutes helper. |
| Payroll cycle | Loads `attendance_payroll_cycles` by `cycleId` and passes the mapped cycle into PR1 period resolution. |
| Schema gaps | Runs narrow read-only schema probes for the producer tables; missing table/column returns `503 DB_NOT_READY` instead of silent zeroes. |
| Sorting | User IDs are normalized, de-duplicated, and sorted; rows are also sorted by `userId`. |

## Boundary

| Boundary | Result |
| --- | --- |
| HTTP route | Adds only `POST /api/attendance/comprehensive-hours/preview`. |
| Frontend UI | Not added. |
| Policy persistence | Not added. |
| New migration | Not added. |
| `attendance_*` fact writes | Not added. |
| Direct `meta_*` writes | Not added. |
| Multitable writes | Not added. |
| Advanced scheduling write path | Not touched. |
| Save warning / save block | Not added. |
| Data Factory / Bridge Agent | Not touched. |

## Follow-Up

PR3 should add an admin read-only preview UI. It must still avoid save warnings, save blocking, policy persistence, and schedule write-path changes unless the user explicitly opens those later stages.
