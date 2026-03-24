# Attendance Admin Rail Extraction Design 2026-03-24

## Context

`AttendanceView.vue` contains a fully working attendance admin rail, but the rail template and its scoped styles are embedded directly inside a very large page component. That makes branch extraction harder and keeps the rail tightly coupled to unrelated admin content markup.

The lowest-risk first extraction step is not a full state/composable rewrite. It is a render-layer split:

- move the rail `<aside>` markup into its own component
- move only the rail-scoped styles with it
- keep all rail state, persistence, hash restore, observer sync, and section scrolling logic inside `AttendanceView.vue`

## Goal

- reduce `AttendanceView.vue` template bulk immediately
- create a reviewable seam for future extraction work
- preserve all rail behavior exactly as-is
- avoid rewiring the observer / hash / restore state machine in the same change

## Chosen Extraction Boundary

The new component is:

- `apps/web/src/views/attendance/AttendanceAdminRail.vue`

This component owns:

- rail header rendering
- scope badge / scope-change note rendering
- current-section summary rendering
- compact toggle rendering
- quick-find input rendering
- rail action buttons
- recent shortcut strip rendering
- grouped navigation rendering
- rail-local scoped CSS

`AttendanceView.vue` still owns:

- the source-of-truth section ids
- grouped rail computed data
- active section tracking
- recent / collapse / last-section persistence
- org-scoped bucket switching
- hash restore and synchronization
- `scrollToAdminSection()`
- `copyCurrentAdminSectionLink()`
- `clearRecentAdminSections()`

## Component Contract

The extraction intentionally uses a prop/emit contract instead of moving state management into the child.

Primary props:

- `tr`
- `adminSectionNavCountLabel`
- `adminNavStorageScope`
- `adminNavDefaultStorageScope`
- `adminNavScopeFeedback`
- `activeAdminSectionContextLabel`
- `isCompactAdminNav`
- `adminCompactNavOpen`
- `adminSectionFilter`
- `adminSectionFilterActive`
- `allAdminSectionGroupsExpanded`
- `allAdminSectionGroupsCollapsed`
- `visibleRecentAdminSectionNavItems`
- `visibleAdminSectionNavGroups`
- `adminActiveSectionId`

Primary emits:

- `update:compactNavOpen`
- `update:sectionFilter`
- `expandAll`
- `collapseAll`
- `copyCurrentLink`
- `clearRecents`
- `toggleGroup`
- `selectSection`

This keeps the child dumb and view-oriented. The parent can still evolve persistence and observer logic without having to reverse that state back out of the component later.

## Why This First Step

This is the smallest extraction that still buys real structural value.

A direct “extract composable first” approach is riskier because the current rail logic is entangled with:

- `IntersectionObserver`
- `window.location.hash`
- scroll restoration loops
- localStorage bucket switching by org

Those behaviors are already working and already covered by the page-level tests. Moving them now would increase risk without making the rail easier to review immediately.

## Test Strategy

Keep the existing page-level tests:

- `attendance-admin-anchor-nav.spec.ts`
- `attendance-import-batch-timezone-status.spec.ts`

Add a new component-level contract test:

- `AttendanceAdminRail.spec.ts`

The component test only verifies:

- rendering of the extracted rail surface
- prop-driven current/recent labels
- emitted events for rail interactions

This gives the extraction its own seam without duplicating all page-level hash/observer assertions.

## Non-Goals

- No backend changes
- No route changes
- No change to storage keys
- No change to hash semantics
- No extraction of the observer / restore logic into a composable in this step

## Next Step After This Extraction

Once the rail lives behind a stable component contract, the next likely extraction step is a dedicated admin-rail state/composable layer for:

- group visibility
- recents
- last-section persistence
- org bucket switching

That should only happen after the render extraction is proven stable.
