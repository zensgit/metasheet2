# Attendance Advanced Scheduling Workbench Truncation Development

Date: 2026-05-22
Branch: `codex/attendance-advanced-scheduling-truncation-20260522`

## Summary

This slice hardens the read-only advanced scheduling workbench shipped in
`#1755`. The workbench assignment queries previously used `LIMIT 500`; large
tenants could therefore see lower-than-actual assignment coverage counts without
an explicit UI signal. This change keeps the route read-only and adds honest
truncation metadata plus a frontend warning.

## Changed Files

| File | Change |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | Adds `ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT`, queries assignment rows with `limit + 1`, slices visible rows back to the limit, and returns `metadata.truncation`. |
| `apps/web/src/views/AttendanceView.vue` | Adds `metadata.truncation` typing, computes a read-only truncation warning, and renders it in the workbench panel. |
| `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts` | Locks truncation metadata and verifies the route keeps limit+1 read behavior with visible-row slicing. |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | Verifies the frontend warning renders while the panel remains read-only. |
| `docs/development/attendance-advanced-scheduling-workbench-truncation-development-20260522.md` | This note. |
| `docs/development/attendance-advanced-scheduling-workbench-truncation-verification-20260522.md` | Verification evidence. |

## Backend Contract

The route remains:

```text
GET /api/attendance/advanced-scheduling/workbench
```

It still writes nothing and still requires `attendance:admin`.

Assignment query behavior:

- Query up to `ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT + 1`
  rows for shift assignments.
- Query up to the same `limit + 1` rows for rotation assignments.
- If either query returns more than the configured limit, set the matching
  truncation flag.
- Slice rows back to the configured limit before building the visible snapshot.

Returned metadata:

```json
{
  "metadata": {
    "readOnly": true,
    "source": "attendance_advanced_scheduling_workbench",
    "truncation": {
      "assignmentLimit": 500,
      "shiftAssignments": false,
      "rotationAssignments": false,
      "truncated": false
    }
  }
}
```

## Frontend Contract

When `metadata.truncation.truncated` is true, the workbench renders a warning
banner that names the truncated assignment type and the row cap. The warning is
purely informational; it does not add edit, export, sync, or retry behavior.

## Boundary

| Boundary | Decision |
| --- | --- |
| Write path | Not added. |
| Grid edit / import / copy-paste | Not added. |
| Migration | Not added. |
| `attendance_*` writes | Not added. |
| Direct `meta_*` writes | Not added. |
| Multitable | Not touched. |
| Data Factory / Bridge Agent | Not touched. |

## Follow-Up

If real tenants hit truncation often, a future read-only slice can replace the
row fetch with aggregate SQL or paginated diagnostics. That remains separate
from any advanced scheduling write-path work, which is still locked until
explicit customer opt-in or K3 PoC stage-1 GATE PASS.
