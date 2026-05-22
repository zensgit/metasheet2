# Attendance Advanced Scheduling Workbench Aggregate Accuracy Development

Date: 2026-05-22
Branch: `codex/attendance-advanced-scheduling-aggregate-20260522`

## Summary

This slice extends the read-only workbench truncation hardening from `#1762`.
The previous behavior correctly warned when assignment detail rows were capped,
but the top-level assignment metrics still came from the capped row sample. This
slice keeps the 500-row detail sample for UI detail and diagnostics, then adds
read-only aggregate SQL so top metrics and schedule-group coverage counts are
complete.

## Changed Files

| File | Change |
| --- | --- |
| `plugins/plugin-attendance/index.cjs` | Adds read-only aggregate queries for assignment totals, assigned users, mixed-assignment users, users without schedule groups, and per-schedule-group assignment coverage. |
| `apps/web/src/views/AttendanceView.vue` | Adds `metadata.sampling` typing and updates the warning copy to state that detail rows are capped while top metrics use full aggregate counts. |
| `packages/core-backend/tests/unit/attendance-advanced-scheduling-workbench.test.ts` | Locks aggregate summary overrides, aggregate group coverage, and source-level aggregate query hooks. |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | Verifies the warning copy and that the assignment metric renders aggregate totals rather than sample row counts. |
| `docs/development/attendance-advanced-scheduling-workbench-aggregate-accuracy-development-20260522.md` | This note. |
| `docs/development/attendance-advanced-scheduling-workbench-aggregate-accuracy-verification-20260522.md` | Verification evidence. |

## Backend Contract

The route remains unchanged:

```text
GET /api/attendance/advanced-scheduling/workbench
```

It remains `attendance:admin`, GET-only, and read-only.

The route now returns two distinct surfaces:

1. Full aggregate metrics:
   - `summary.shiftAssignments`
   - `summary.rotationAssignments`
   - `summary.assignedUsers`
   - `summary.assignmentUsersWithoutScheduleGroup`
   - `summary.usersWithBothAssignmentKinds`
   - per-group `assignedUserCount`, `shiftAssignmentCount`, and
     `rotationAssignmentCount`
2. Detail samples:
   - `assignments.shiftItems`
   - `assignments.rotationItems`
   - diagnostic sample `userIds`

The sample remains capped by
`ATTENDANCE_ADVANCED_SCHEDULING_WORKBENCH_ASSIGNMENT_LIMIT`.

New response metadata:

```json
{
  "metadata": {
    "readOnly": true,
    "source": "attendance_advanced_scheduling_workbench",
    "truncation": {
      "assignmentLimit": 500,
      "shiftAssignments": true,
      "rotationAssignments": false,
      "truncated": true
    },
    "sampling": {
      "assignmentLimit": 500,
      "sampled": true,
      "shiftAssignments": {
        "visible": 500,
        "total": 650,
        "truncated": true
      },
      "rotationAssignments": {
        "visible": 0,
        "total": 3,
        "truncated": false
      }
    }
  }
}
```

`metadata.truncation` is retained for backward compatibility with `#1762`;
`metadata.sampling` is the clearer operator-facing contract.

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

If the detail samples themselves become insufficient, the next allowed
read-only hardening slice is pagination or aggregate-only drilldown. That is
still separate from advanced scheduling write paths, which remain locked until
explicit customer opt-in or K3 PoC stage-1 GATE PASS.
