# Attendance Scheduling Conflict Save Guard Development (2026-05-21)

## Summary

This slice hardens attendance scheduling writes so advisory conflict diagnostics are enforced at the backend save boundary.

Before this change, the admin UI could warn about overlapping fixed-shift and rotation assignments, but API clients could still persist those overlaps. The runtime resolver would then pick one winner (`rotation` before `shift`, latest assignment within the same kind), leaving ambiguity in saved scheduling state.

This slice keeps the existing frontend warning UX and adds an API-level conflict guard for assignment create/update.

## Scope

- Fixed shift assignments:
  - `POST /api/attendance/assignments`
  - `PUT /api/attendance/assignments/:id`
- Rotation assignments:
  - `POST /api/attendance/rotation-assignments`
  - `PUT /api/attendance/rotation-assignments/:id`
- No `attendance_*` migration.
- No direct `meta_*` write.
- No frontend validator rewrite.
- No change to runtime resolver precedence.

## Conflict Contract

Only active drafts are checked. `isActive: false` assignments remain saveable and do not block.

Date overlap is inclusive and matches the existing frontend diagnostic helper:

```text
left.startDate <= rightEnd && right.startDate <= leftEnd
```

Open-ended `endDate` is treated as `9999-12-31`.

| Draft kind | Existing kind | Result |
| --- | --- | --- |
| shift | shift | `409 ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT`, `shift_assignment_overlap` |
| rotation | rotation | `409 ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT`, `rotation_assignment_overlap` |
| shift | rotation | `409 ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT`, `rotation_overrides_shift` |
| rotation | shift | `409 ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT`, `rotation_overrides_shift` |
| inactive draft | any | allowed |
| different user | any | allowed |

## Implementation Notes

- Added `findAttendanceScheduleAssignmentConflict(db, draft)` in `plugins/plugin-attendance/index.cjs`.
- The helper checks same-kind conflicts first, then cross-kind conflicts.
- Update paths pass `excludeId` so an assignment does not conflict with itself.
- Create/update paths now run the conflict check and write inside one `db.transaction()`.
- Each transactional write takes a per-org/user `pg_advisory_xact_lock` before conflict detection, narrowing concurrent save races for the same user's schedule.
- Explicit update payloads with `endDate: null` now clear the stored end date instead of falling back to the existing date.
- The API response uses:

```json
{
  "ok": false,
  "error": {
    "code": "ATTENDANCE_SCHEDULE_ASSIGNMENT_CONFLICT",
    "message": "...",
    "details": {
      "conflictType": "rotation_overrides_shift",
      "draftKind": "shift",
      "existingKind": "rotation"
    }
  }
}
```

- Rotation assignment create/update now also rejects `endDate < startDate`, matching fixed assignment behavior.
- Existing broad integration tests that intentionally created a fixed assignment and a rotation assignment for the same user/date were adjusted to use non-overlapping dates or a distinct user. Those tests no longer rely on ambiguous saved state.

## Review Patch

After the initial PR opened, automated review flagged two high-priority save-boundary concerns:

- the check/write sequence was not serialized for concurrent requests;
- `PUT` with `endDate: null` could not clear a previously bounded assignment.

The follow-up patch addressed both without adding migrations or changing runtime resolution:

- `acquireAttendanceScheduleAssignmentLock(trx, orgId, userId)` serializes schedule saves for the same org/user inside the transaction;
- `resolveAttendanceScheduleAssignmentUpdateEndDate(payload, existingEndDate)` distinguishes omitted `endDate` from explicit `null`/empty string.

## Frontend Boundary

No frontend code changed.

`useAttendanceAdminScheduling.ts` already reads backend `error.message` for save failures, so the new 409 message is surfaced by the existing path. The existing conflict preview remains advisory before save; the backend is now the final enforcement point.

## Files

- `plugins/plugin-attendance/index.cjs`
- `packages/core-backend/tests/unit/attendance-scheduling-assignment-conflict.test.ts`
- `packages/core-backend/tests/integration/attendance-plugin.test.ts`
- `docs/development/attendance-scheduling-conflict-save-development-20260521.md`
- `docs/development/attendance-scheduling-conflict-save-verification-20260521.md`
