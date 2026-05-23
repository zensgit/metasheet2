# Attendance Comprehensive Working Hours Control PR3 Development

Date: 2026-05-22
Branch: `codex/attendance-comprehensive-hours-preview-ui-20260522`

## Summary

This slice implements PR3 from `attendance-comprehensive-hours-control-rfc-20260522.md`: an admin read-only preview panel for comprehensive working-hours control (`综合工时制`).

It consumes the already-merged PR2 backend route:

```text
POST /api/attendance/comprehensive-hours/preview
```

The panel helps admins compare an explicit user or explicit user list against a draft cap for month, quarter, year, custom range, or payroll-cycle periods. It does not persist policy, does not enforce schedule saves, and does not add any backend route.

## Files

| File | Change |
| --- | --- |
| `apps/web/src/views/AttendanceView.vue` | Adds the read-only comprehensive-hours preview section, request builder, preview status, aggregate cards, and row table. |
| `apps/web/src/views/attendance/useAttendanceAdminRail.ts` | Adds `Comprehensive hours` to the Scheduling admin rail. |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | Locks preview body shape, result rendering, and absence of write buttons. |
| `apps/web/tests/attendance-admin-anchor-nav.spec.ts` | Updates admin anchor counts and adds a quick-jump regression for the new section. |

## Boundary

- Frontend-only runtime change.
- No `plugins/plugin-attendance/index.cjs` edits.
- No `attendance_*` migration.
- No `meta_*` writes.
- No all-users batch preview.
- No policy persistence, schedule-save warning, or schedule-save blocking.
- No client-side validator beyond disabling preview when required form inputs are empty.

## UI Contract

The panel is mounted under the Scheduling admin group, next to the Advanced scheduling workbench.

Inputs:

- Scope: single `userId` or comma/space/newline-separated `userIds`
- Metric: `planned` or `actual`
- Cap: draft hours, converted by the backend to minutes
- Policy mode: `warn` or strict preview (`block` in the backend contract)
- Period: month, quarter, year, custom date range, or payroll cycle ID

Output:

- Read-only status chip
- Period label
- Aggregate cards for users, OK, warning, violation, total minutes, and excess minutes
- Per-user comparison table with metric minutes, cap, remaining, excess, status, and source
- Local error/degraded status without clearing the admin page

## Request Shape

```json
{
  "policyDraft": {
    "capHours": 160,
    "enforcement": "warn"
  },
  "scope": {
    "userId": "user-1"
  },
  "period": {
    "type": "month",
    "year": 2026,
    "month": 5
  },
  "metric": "planned"
}
```

The backend remains authoritative for validation, cap normalization, period resolution, schema readiness, and planned-vs-actual producer separation.
