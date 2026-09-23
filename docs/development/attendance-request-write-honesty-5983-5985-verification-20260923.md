# Verification: attendance request write-path honesty (#5983, #5985)

Design: `docs/development/attendance-request-write-honesty-5983-5985-design-20260923.md`.
Branch: `cursor/attendance-write-honesty-5983-5985-b2c9`. Draft PR; not merged.

## What was checked

| Case | Result |
|---|---|
| Leave type `requiresAttachment === true` and missing / blank URL | `rejectLeaveAttachmentIfRequired` returns `422 LEAVE_ATTACHMENT_REQUIRED` |
| Trimmed URL, or flag not exactly `true` | no rejection |
| Overtime 10 vs min 30 | `OVERTIME_MINUTES_BELOW_MIN`; `applyOvertimeRule` still returns 30 |
| Overtime 700 vs max 600 | `OVERTIME_MINUTES_ABOVE_MAX`; `applyOvertimeRule` still returns 600 |
| 106 with rounding 15 and max 110 | `OVERTIME_MINUTES_ABOVE_MAX` with rounded 120; `applyOvertimeRule` still clamps to 110 |
| 47 with rounding 15 inside max 120 | both paths return 60 |
| 90 / 30 / 600 on an aligned rule | stored as submitted |
| min 600 and max 30 | `OVERTIME_RULE_BOUNDS_INVALID` |
| `resolveAttendanceRequestDraft` source | calls both reject helpers and does not call `applyOvertimeRule` |
| Employee overtime card | hint text includes `30–600` and says the value is rejected |

`resolveAttendanceRequestDraft` throws those `HttpError`s before `executeGenericRequestCreate` inserts `attendance_requests`. A rejected create therefore does not leave a `pending` row.

## Commands

```text
pnpm --filter @metasheet/core-backend exec vitest run \
  tests/unit/attendance-request-write-honesty.test.ts \
  tests/unit/attendance-overtime-segmentation.test.ts --reporter=verbose

pnpm --filter @metasheet/web exec vitest run \
  tests/overtimeWriteBounds.spec.ts \
  tests/attendanceEmployeeOvertimeRequestCard.bounds.spec.ts --reporter=verbose
```

Both runs passed (backend 34 tests, frontend 5 tests) on 2026-09-23. Segmentation tests still expect `applyOvertimeRule` to cap an out-of-range snapshot; that helper was not changed.

## Not run

- No Postgres in this environment, so `POST /api/attendance/requests` was not executed against a live API. The insert-skip guarantee is the prepare/execute split, not a database assertion.
- The full Attendance view was not opened in a browser. The dedicated overtime card was mounted in jsdom; the shared form uses the same pure check.

## Open questions

1. Overtime-rule create/update still accepts `minMinutes > maxMinutesPerDay`. Only the request write path rejects that rule (`OVERTIME_RULE_BOUNDS_INVALID`).
2. Requests already stored with a raised or clamped duration are left as-is.
3. OpenAPI `422` enums on `POST/PUT /api/attendance/requests` were not extended. They already omit older codes such as `OVERTIME_INVALID_TIME_WINDOW`, and updating them requires `pnpm --filter @metasheet/openapi generate:sdk`.
