# Attendance Admin Rail Navigation Extraction Design 2026-03-24

## Context

The attendance admin rail was already split in two earlier steps:

- render layer: `AttendanceAdminRail.vue`
- state/persistence layer: `useAttendanceAdminRail.ts`

After those extractions, `AttendanceView.vue` still owned the highest-risk navigation logic:

- section element ref binding
- URL hash restore and sync
- `IntersectionObserver` section tracking
- compact viewport sync
- active rail link visibility sync

That meant the page still carried the entire DOM/navigation state machine, even though the rail render/state layers had already been extracted.

## Goal

- remove the remaining admin-rail-specific DOM/hash/observer code from `AttendanceView.vue`
- preserve deep-link, compact-mode, and active-link behavior exactly
- keep the extraction reviewable without changing broader attendance page logic

## Chosen Extraction Boundary

New composable:

- `apps/web/src/views/attendance/useAttendanceAdminRailNavigation.ts`

Moved into the composable:

- section ref registration via `adminSectionBinding()`
- section element resolution
- hash read / hash write
- restore-from-hash retry loop
- `IntersectionObserver` setup and teardown
- active-link `scrollIntoView`
- compact viewport resize sync
- watchers that connect:
  - `showAdmin`
  - `adminForbidden`
  - `adminNavStorageScope`
  - `adminActiveSectionId`

Kept in `AttendanceView.vue`:

- actual page sections and their markup
- the call site for `scrollToAdminSection()`
- attendance business state and API orchestration
- plugin bootstrap and admin data loading

## Composable Contract

The new composable is intentionally fed by shared refs from `useAttendanceAdminRail()` and the page:

- `showAdmin`
- `adminForbidden`
- `adminNavStorageScope`
- `adminActiveSectionId`
- `adminSectionNavItems`
- `isKnownAdminSectionId`
- `readLastAdminSection`
- `isCompactAdminNav`
- `adminCompactNavOpen`

It returns only the surface the page actually needs:

- `adminSectionBinding(id)`
- `scrollToAdminSection(id)`

This keeps the page-to-composable seam narrow while still letting the composable own lifecycle and watchers internally.

## Why This Boundary

This is the last meaningful extraction step before the admin rail becomes a mostly self-contained subsystem.

The logic that remained in `AttendanceView.vue` was highly coupled to the rail, but not to the rest of the attendance feature set. It was a good candidate for extraction because it already depended on a narrow set of shared refs and helpers.

The key constraint was preserving three behaviors:

1. hash restore on cold load
2. observer-driven active section tracking
3. compact-mode close-on-select behavior

The extraction therefore keeps the exact sequencing model but moves it behind a dedicated navigation composable.

## Claude Code Input

Claude Code CLI was used to review the boundary before implementation.

Its guidance was:

- separate the remaining layer as a navigation/section-sync composable
- pass the existing shared refs in instead of recreating local state
- keep the composable focused on section sync, not business logic
- prioritize tests around:
  - hash restore
  - observer/hash/active-link three-way sync
  - compact viewport transitions

That guidance aligns with the implemented `useAttendanceAdminRailNavigation.ts` boundary.

## Test Strategy

Keep the existing page-level rail coverage:

- `attendance-admin-anchor-nav.spec.ts`
- `attendance-import-batch-timezone-status.spec.ts`

Keep the previously added extraction seam tests:

- `AttendanceAdminRail.spec.ts`
- `useAttendanceAdminRail.spec.ts`

Add a new navigation-layer test:

- `useAttendanceAdminRailNavigation.spec.ts`

The new navigation test focuses on the two behaviors that are easiest to regress during extraction:

- restoring the hashed section on mount
- closing compact nav after programmatic section selection

## Non-Goals

- no backend changes
- no route changes
- no new storage keys
- no redesign of admin rail UX
- no attempt to merge rail state and navigation into one oversized composable

## Outcome

With this extraction in place, `AttendanceView.vue` now mostly treats admin rail concerns as imported capabilities:

- render: `AttendanceAdminRail.vue`
- state: `useAttendanceAdminRail.ts`
- DOM/navigation sync: `useAttendanceAdminRailNavigation.ts`

That is the cleanest structure reached so far for this long admin page without changing user-visible behavior.
