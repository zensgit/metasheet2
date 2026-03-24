# Attendance Admin Rail Clean PR Design 2026-03-24

## Goal

Create a reviewable PR onto `origin/main` that contains only the attendance admin rail work, instead of the larger mixed attendance branch it was originally developed on.

## Scope

This clean PR contains only frontend files required for the admin rail subsystem and one small dependency pair that `AttendanceView.vue` now imports.

Included feature files:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/src/views/attendance/AttendanceAdminRail.vue`
- `apps/web/src/views/attendance/useAttendanceAdminRail.ts`
- `apps/web/src/views/attendance/useAttendanceAdminRailNavigation.ts`

Included tests:

- `apps/web/tests/AttendanceAdminRail.spec.ts`
- `apps/web/tests/useAttendanceAdminRail.spec.ts`
- `apps/web/tests/useAttendanceAdminRailNavigation.spec.ts`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`
- `apps/web/tests/attendance-import-batch-timezone-status.spec.ts`

Included support utilities:

- `apps/web/src/utils/error.ts`
- `apps/web/src/utils/timezones.ts`
- `apps/web/tests/utils/error.spec.ts`

## Why The Utility Files Are Included

`origin/main` does not yet contain:

- `apps/web/src/utils/error.ts`
- `apps/web/src/utils/timezones.ts`

But the extracted attendance admin rail work in `AttendanceView.vue` imports:

- `readErrorMessage`
- `buildTimezoneOptions`
- `formatTimezoneLabel`

Without those two utilities, the clean branch does not build on top of `main`.

Including them is the smallest dependency closure that keeps the PR independently compilable.

## Behavior Delivered

This clean PR keeps the admin page changes focused on rail usability:

- left-side grouped admin rail for the long attendance management page
- quick-find filtering
- active section summary
- deep-link copy
- recent shortcuts
- org-scoped persistence for recents / collapse state / last section
- last-section restore when no hash is present
- compact rail behavior on narrow screens
- hash restore and active-section sync
- rail decomposition into three layers:
  - render component
  - state/persistence composable
  - DOM/hash/observer navigation composable

## Extraction Shape

The final shape is intentionally layered:

1. `AttendanceAdminRail.vue`
   - render only
2. `useAttendanceAdminRail.ts`
   - state, persistence, grouped metadata, rail actions
3. `useAttendanceAdminRailNavigation.ts`
   - section binding, hash restore, observer sync, compact viewport behavior

This makes the rail reviewable without forcing reviewers to parse the entire `AttendanceView.vue` monolith.

## Claude Code Use

Claude Code CLI was used as a boundary-check tool during this cleanup work.

Its useful guidance that was applied here:

- keep render/state/navigation extraction layers separate
- keep shared refs passed into the navigation composable instead of duplicating state
- preserve hash restore and compact-mode behavior as first-class regression targets

The implementation and verification still happened locally in this repository.

## What Was Explicitly Left Out

This clean PR intentionally omits:

- attendance backend auth / RBAC fixes
- plugin attendance import / dedupe fixes
- IAM and auth-management slices
- workflow and branch-policy automation changes
- old branch strategy docs tied to the larger mixed branch

Those changes belong to other review tracks and would make this PR noisy again.
