# Attendance request write-path honesty (#5983, #5985)

> Design lock for this PR. Draft; do not merge.
> Baseline: `main` @ `261835ad2`.
> Issues: #5983 (leave `requiresAttachment` is frontend-only), #5985 (overtime min/max silently rewritten).

## Contract

Both bugs are the same class: an admin switch is stored, then the create path does not enforce it. This PR fail-closes the create and pending-update path inside `resolveAttendanceRequestDraft`. That function runs in `prepareGenericRequestCreate` / pending-edit prepare, before `executeGenericRequestCreate` inserts a `pending` row.

### #5983 Leave attachment

When `requestType === 'leave'` and the loaded leave type has `requiresAttachment === true`, a missing `attachmentUrl` (null, empty, or whitespace after `normalizeOptionalText`) is `422 LEAVE_ATTACHMENT_REQUIRED` on field `attachmentUrl`.

- Create with no attachment does not insert a request.
- Pending update that omits `attachmentUrl` keeps the stored URL.
- Pending update that clears it, or that switches to a type that requires an attachment while none is stored, is the same 422.
- `requiresAttachment !== true` stays optional.
- Makeup `MAKEUP_PUNCH_ATTACHMENT_REQUIRED` is unchanged.
- The web form check stays as early feedback. The generic leave attachment placeholder says the URL is required when the selected type demands it.

### #5985 Overtime min / daily max

Submitted overtime minutes are not raised to `minMinutes` and not cut down to `maxMinutesPerDay`.

Order, on the integer minutes the draft already resolved (explicit `minutes`, else the in/out span):

1. If `maxMinutesPerDay > 0` and `minMinutes > maxMinutesPerDay`, `422 OVERTIME_RULE_BOUNDS_INVALID`. The rule cannot be satisfied. `maxMinutesPerDay === 0` still means no daily cap.
2. If `minMinutes > 0` and submitted minutes are below it, `422 OVERTIME_MINUTES_BELOW_MIN`.
3. If `maxMinutesPerDay > 0` and submitted minutes are above it, `422 OVERTIME_MINUTES_ABOVE_MAX`.
4. Rounding stays: same ceil-to-`roundingMinutes` step as today (`roundingMinutes <= 1` does not change the value).
5. If that rounded value is above `maxMinutesPerDay` (`max > 0`), `422 OVERTIME_MINUTES_ABOVE_MAX`. Do not clamp.

In-range values are still stored as the rounded total, including the segmentation snapshot. For those values the rounded total matches what `applyOvertimeRule` would have produced, because the raise and the clamp would have been no-ops.

### `applyOvertimeRule` after this change

`applyOvertimeRule` is unchanged and still raises below the minimum, rounds, then clamps to the daily max. It remains the normalizer for:

- `buildOvertimeSegmentationSnapshot`
- `buildCrossMidnightOvertimeSegmentationSnapshot`

The HTTP write path does not call it. Segmentation therefore still clamps if a caller passes an out-of-range total directly. Accepted requests never do that: the write path rejects first, then the snapshot re-applies `applyOvertimeRule` to the original minutes and lands on the same rounded total.

## Out of scope

- Overtime-rule CRUD still allows saving `minMinutes > maxMinutesPerDay`. The request path rejects that rule; the admin form does not yet 422 on save.
- Rows already stored with a silently rewritten duration are not rewritten.
- #5967 approval-off settlement, overtime bank formulas, and day-type segmentation are unchanged.
- OpenAPI `422` enums on these routes still list only the org-resolution codes. They were already non-exhaustive (`OVERTIME_INVALID_TIME_WINDOW` is absent). This PR does not regenerate `packages/openapi/dist`.
