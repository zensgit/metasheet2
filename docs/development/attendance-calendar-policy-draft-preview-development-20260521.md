# Attendance Calendar Policy Draft Preview Development

Date: 2026-05-21
Branch: `codex/attendance-calendar-draft-preview-20260521`
Base: `origin/main@46800a8ef`

## Summary

This slice lets attendance admins preview effective-calendar policy rows while
they are still editing them. Before this change the preview panel always called
the saved `GET /api/attendance/effective-calendar` resolver, so a user had to
save settings before verifying a draft override. The new path is read-only:
it simulates the current editor payload through the same backend resolver and
does not persist anything.

## Scope

Delivered:

- `POST /api/attendance/effective-calendar/preview` for admin-only draft
  simulation.
- Existing `resolveEffectiveCalendar()` can accept caller-provided
  `calendarPolicyOverrides`; if absent, it keeps loading saved settings.
- `settingsSchema` and the draft preview route share one
  `calendarPolicyOverrideSchema`, so save and preview accept the same wire
  shape.
- The preview panel now shows an opt-in checkbox for "Include unsaved editor
  rules" when the parent provides draft overrides.
- `AttendanceView.vue` passes the current editor rows through
  `calendarPolicyOverridesFromForm()`, reusing the same normalization that
  save uses.

Not delivered:

- No save-blocking validator.
- No unsaved shift/rotation assignment simulation.
- No new `attendance_*` migration or fact-source write.
- No direct `meta_*` write.

## Design Notes

The frontend still does not implement a calendar-policy resolver. It only
serializes the editor state with the existing save codec and asks the backend
to resolve the preview. This avoids a second source of truth for source
priority, day-index filters, role filters, and same-priority tie order.

The preview endpoint uses `attendance:admin` because it can simulate arbitrary
calendar-policy settings for org/group/user modes. The saved GET endpoint is
unchanged and remains the shared read path for user-facing calendar widgets.

The draft preview intentionally normalizes the provided overrides via
`normalizeCalendarPolicyOverrides()` before resolution. Incomplete rows are
dropped in the same way they would be dropped on save; the existing diagnostics
surface incomplete scoped rows before the admin runs preview.

## Files Changed

- `plugins/plugin-attendance/index.cjs`
  - Added shared zod schema for calendar-policy override payloads.
  - Added the draft preview route.
  - Exported `resolveEffectiveCalendar()` and
    `normalizeCalendarPolicyOverrides()` for focused tests.
- `apps/web/src/services/attendance/effectiveCalendar.ts`
  - Added `draftOverrides` option and POST preview transport.
- `apps/web/src/views/attendance/AttendanceCalendarPolicyPreviewPanel.vue`
  - Added draft checkbox and copy.
- `apps/web/src/views/AttendanceView.vue`
  - Wires current editor overrides into the preview panel.
- Tests:
  - `packages/core-backend/tests/unit/attendance-effective-calendar-role-context.test.ts`
  - `apps/web/tests/effectiveCalendar.spec.ts`
  - `apps/web/tests/AttendanceCalendarPolicyPreviewPanel.spec.ts`

## Follow-Up Candidate

The next higher-risk slice is backend save-time conflict validation for fixed
shift assignments and rotation assignments. That would change persistence
semantics and should be scoped separately from this read-only draft-preview
slice.
