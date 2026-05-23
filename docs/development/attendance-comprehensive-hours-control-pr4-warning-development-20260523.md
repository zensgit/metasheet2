# Attendance comprehensive-hours PR4 weak warning development - 2026-05-23

## Summary

This slice implements the runtime part of PR4 from
`attendance-comprehensive-hours-control-pr4-warning-design-20260522.md`.

The change is intentionally weak-control only: shift-assignment and
rotation-assignment saves run a read-only comprehensive-hours advisory preview
before calling the existing save endpoint, but preview status never blocks the
original save.

## Files Changed

| File | Change |
| --- | --- |
| `apps/web/src/views/AttendanceView.vue` | Adds assignment-save advisory state, reuses `POST /api/attendance/comprehensive-hours/preview`, renders warning/error text near shift and rotation assignment save buttons, then always continues the original save path. |
| `apps/web/tests/attendance-admin-regressions.spec.ts` | Adds weak-control regression tests for violation and preview-error paths. |
| `docs/development/attendance-comprehensive-hours-preview-runtime-smoke-verification-20260523.md` | Records production runtime smoke for the #1777 read-only preview UI and route on `23.254.236.11`. |
| `docs/development/attendance-comprehensive-hours-control-pr4-warning-development-20260523.md` | This development note. |
| `docs/development/attendance-comprehensive-hours-control-pr4-warning-verification-20260523.md` | Runtime verification note for this slice. |

## Save-Time Advisory Contract

The assignment save flow now performs this sequence:

1. Validate the existing assignment form exactly as before.
2. Build a read-only comprehensive-hours preview body from the validated draft.
3. Call the existing backend preview route.
4. Render a local advisory if the preview returns `warning`, `violation`,
   degraded data, or an unavailable/error response.
5. Continue the original assignment save request.

The preview request body is deliberately narrow:

```json
{
  "policyDraft": {
    "capHours": 160,
    "enforcement": "warn"
  },
  "scope": {
    "userId": "<assignment-user-id>"
  },
  "period": {
    "type": "custom_range",
    "from": "<assignment-start-date>",
    "to": "<assignment-end-date-or-start-date>"
  },
  "metric": "planned"
}
```

Key details:

- `metric` is always `planned`.
- `enforcement` is always `warn` for save-time advisory previews.
- `scope` is always a single explicit `userId`.
- `allUsers` is never emitted.
- Open-ended assignments use the start date as the conservative one-day preview
  end date.

## Behavior Matrix

| Preview result | UI message | Save behavior |
| --- | --- | --- |
| `ok` | No advisory message. | Original save continues. |
| `warning` | Advisory copy says planned minutes are close to the draft cap. | Original save continues. |
| `violation` | Advisory copy says planned minutes exceed the draft cap. | Original save continues. |
| `degraded` | Advisory copy says preview returned degraded data. | Original save continues. |
| `400` / `503` / network error | Advisory copy says preview is unavailable. | Original save continues. |

All copy avoids PR5 language such as blocked, cannot save, policy enforced, or
violation prevented.

## Boundaries

| Boundary | Status |
| --- | --- |
| Backend route changes | None. Reuses `POST /api/attendance/comprehensive-hours/preview`. |
| `attendance_*` migrations | None. |
| `meta_*` writes | None. |
| Policy persistence | None. |
| Strong block-save guard | Deferred to PR5. |
| Actual-minute enforcement | Not used. Save-time warning uses planned minutes only. |
| All-users save preview | Not used. |

## Runtime Evidence Link

The production runtime smoke for the existing PR3 preview UI/route is recorded in
`attendance-comprehensive-hours-preview-runtime-smoke-verification-20260523.md`.
It confirms that the reused preview route is deployed and responds on
`23.254.236.11:8081` before this weak-warning slice adds a caller.
