# Attendance Admin Anchor Deeplink Design 2026-03-24

## Context

`AttendanceView.vue` already carries the attendance admin console as a single long page with 22 top-level sections. The first-stage root-admin stabilization added a sticky left anchor rail, active-section tracking, and section-level refs. This follow-up tightens that model so the admin console is navigable when the section list grows and so deep links survive reloads.

## Goals

- Reduce scroll cost inside the attendance admin console.
- Allow users to share or restore a concrete admin section via URL hash.
- Keep the implementation local to attendance until a second real long-form admin page appears.

## Scope

### 1. Quick-find on the admin anchor rail

The left rail now exposes a lightweight text filter above the anchor list. It filters only the existing top-level admin anchors, keeps the same order, updates the visible count, and shows an explicit empty state when no section matches.

This is intentionally string-match only. The admin section list is small and stable, so there is no need to introduce fuzzy search state, token indexing, or a shared search store.

### 2. Hash-based deep links

The admin rail now treats each known section id as a valid deep-link target.

- Clicking a rail item scrolls to the section and synchronizes `window.location.hash`.
- First load reads the hash, restores the matching section, and marks the correct rail item active.
- Active-section changes continue to keep the hash in sync after the initial restore.

The restore path uses a bounded next-tick retry loop. This makes the first-load hash restore resilient to mount timing without introducing scroll polling or route-level state.

### 3. Branch hygiene for timezone helpers

This clean branch already depended on `apps/web/src/utils/timezones.ts` through `AttendanceView.vue`, but the file was missing from the branch itself. The follow-up includes it so the branch can build and type-check independently instead of relying on unrelated local dirt from another worktree.

## Why This Stays Attendance-Local

The current codebase does not yet have a reusable “long-page admin shell” abstraction.

- `apps/web/src/App.vue` only provides the top navbar and a single `router-view`; it does not host any per-page section navigation contract.
- `apps/web/src/views/UserManagementView.vue` and `apps/web/src/views/RoleManagementView.vue` use side panels, but they are list-detail layouts, not long-form section-anchor pages.
- `apps/web/src/views/AttendanceView.vue` is currently the only page with a stable, domain-owned set of many stacked admin sections plus a strong need for anchor restore.

Because of that, the correct implementation boundary is still attendance-local:

- attendance owns the section ids
- attendance owns the localization of section labels
- attendance owns the “what counts as a top-level anchor” policy

If a second admin surface later needs the same behavior, the right extraction target is a generic view-layer utility or component set under `apps/web/src/components` or `apps/web/src/composables`, not `App.vue`.

## Non-Goals

- No global MetaSheet left-shell abstraction.
- No router-level nested admin navigation model.
- No backend changes in this follow-up.
- No change to how nested subsections are modeled; only top-level attendance admin blocks stay anchorable.
