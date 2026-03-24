# Attendance Admin Rail State Extraction Design 2026-03-24

## Context

The first extraction step already moved the attendance admin rail render layer into:

- `apps/web/src/views/attendance/AttendanceAdminRail.vue`

That reduced template bulk inside `AttendanceView.vue`, but the parent page still owned all rail-local state:

- grouped section metadata
- quick-find filtering
- recents / collapsed-group persistence
- org-scoped storage buckets
- current-section link generation
- scope-switch feedback

At that point the rail still had no reusable state seam. The next lowest-risk step is to extract only the rail state and persistence layer into a composable, while leaving all DOM- and URL-bound behavior in the page.

## Goal

- reduce `AttendanceView.vue` state bulk without changing navigation behavior
- create a clean separation between rail state and section DOM synchronization
- keep hash restore, scrolling, observer updates, and active-link visibility inside the page
- make the rail easier to cherry-pick into a smaller follow-up PR later

## Chosen Extraction Boundary

New composable:

- `apps/web/src/views/attendance/useAttendanceAdminRail.ts`

Moved into the composable:

- section id constants
- rail item/group definitions
- localStorage key handling and org-scoped bucket helpers
- filter state
- collapsed-group state
- recent-shortcut state
- current active section state
- visible group / recent computed models
- context-label formatting
- current-link copy action
- recent-clear action
- org bucket switch feedback
- persistence watchers for recents, collapsed groups, and last section

Kept in `AttendanceView.vue`:

- section element refs
- `IntersectionObserver`
- hash read / hash write
- initial restore sequencing
- DOM scrolling
- active-link `scrollIntoView`
- compact viewport resize sync

## Why This Boundary

The admin rail has two different concerns:

1. state and persistence
2. DOM synchronization with a very large long-form admin page

Only the first concern is safe to extract in isolation. The second one still depends on:

- real section elements
- render timing
- page scroll position
- hash restore ordering

Moving both at once would make the refactor much harder to verify. Extracting only the state layer keeps the existing observer and hash behavior untouched.

## Composable Contract

`useAttendanceAdminRail()` now accepts:

- `tr`
- `resolveStorageScope`
- `showAdmin`
- `notify`

It returns:

- `adminActiveSectionId`
- `adminCompactNavOpen`
- `adminNavDefaultStorageScope`
- `adminNavScopeFeedback`
- `adminNavStorageScope`
- `adminSectionFilter`
- `adminSectionFilterActive`
- `adminSectionNavCountLabel`
- `adminSectionNavItems`
- `allAdminSectionGroupsCollapsed`
- `allAdminSectionGroupsExpanded`
- `activeAdminSectionContextLabel`
- `clearRecentAdminSections()`
- `copyCurrentAdminSectionLink()`
- `expandAllAdminSectionGroups()`
- `collapseAllAdminSectionGroups()`
- `toggleAdminSectionGroup()`
- `visibleAdminSectionNavGroups`
- `visibleRecentAdminSectionNavItems`
- `isKnownAdminSectionId()`
- `readLastAdminSection()`

The `notify` callback is the deliberate seam for actions that still need page-owned status messaging.

## Claude Code Input

Claude Code was used as a boundary check, not as the execution engine.

The prompt asked for the minimal safe extraction line between:

- rail state/persistence/computed/actions
- page-owned hash/observer/DOM logic

Its output matched the chosen approach:

- move storage helpers, grouped metadata, rail refs/computed/actions, and persistence watchers
- keep section refs, hash restore, observer, scroll, and URL sync in `AttendanceView.vue`
- avoid leaking page-level `setStatus()` directly into the composable by using a callback seam

That recommendation was followed directly.

## Test Strategy

Keep the page-level tests:

- `attendance-admin-anchor-nav.spec.ts`
- `attendance-import-batch-timezone-status.spec.ts`

Keep the component contract test:

- `AttendanceAdminRail.spec.ts`

Add a dedicated composable test:

- `useAttendanceAdminRail.spec.ts`

The new composable test locks the two behaviors most likely to regress during further extraction:

- org-scoped bucket reload
- action-level notifications for `copy current link` and `clear recents`

## Non-Goals

- no backend changes
- no route changes
- no new storage keys
- no changes to existing hash semantics
- no attempt to move the observer / hash restore state machine

## Next Step

Once the state layer is stable, the remaining extraction target is the DOM integration layer inside `AttendanceView.vue`.

If a later clean PR is needed, the likely next seam is:

- keep `useAttendanceAdminRail.ts`
- keep `AttendanceAdminRail.vue`
- reduce `AttendanceView.vue` down to page-specific section binding and observer sync only
