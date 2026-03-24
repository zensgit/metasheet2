# Attendance Admin Anchor Deeplink, Grouped Rail, Collapse Persistence, And Compact Rail UX Design 2026-03-24

## Context

`AttendanceView.vue` already carries the attendance admin console as a single long page with 22 top-level sections. The first-stage root-admin stabilization added a sticky left anchor rail, active-section tracking, and section-level refs. The second stage added quick-find and hash deep links. The third stage grouped the rail by business domain. The fourth stage added collapse persistence and bulk expand/collapse actions. This follow-up makes the compact mobile rail feel deliberate instead of just functional.

## Goals

- Reduce scroll cost inside the attendance admin console.
- Reduce cognitive load in the left rail itself.
- Preserve the operator's preferred left-rail state across reloads.
- Reduce compact-mode height and keep the current domain prominent on narrow screens.
- Allow users to share or restore a concrete admin section via URL hash.
- Keep the implementation local to attendance until a second real long-form admin page appears.

## Scope

### 1. Grouped rail instead of a 22-item flat list

The rail now groups the 22 top-level sections into five stable business domains:

- `Workspace`
  - `Settings`
  - `User Access`
  - `Batch Provisioning`
  - `Audit Logs`
- `Policies`
  - `Holiday Sync`
  - `Default Rule`
  - `Rule Sets`
  - `Rule Template Library`
  - `Leave Types`
  - `Overtime Rules`
  - `Approval Flows`
- `Organization`
  - `Attendance groups`
  - `Group members`
- `Data & Payroll`
  - `Import`
  - `Import batches`
  - `Payroll Templates`
  - `Payroll Cycles`
- `Scheduling`
  - `Rotation Rules`
  - `Rotation Assignments`
  - `Shifts`
  - `Assignments`
  - `Holidays`

Each group renders as a collapsible block with its own count badge. The implementation keeps a flat item list in code for hash lookup and observer bookkeeping, then derives grouped render data on top.

This keeps the behavioral core unchanged:

- section ids remain attendance-owned
- observer logic still reads the flat section list
- hash restore still targets the same ids

### 2. Quick-find on the admin anchor rail

The left rail now exposes a lightweight text filter above the anchor list. It filters only the existing top-level admin anchors, keeps the same order, updates the visible count, and shows an explicit empty state when no section matches.

This is intentionally string-match only. The admin section list is small and stable, so there is no need to introduce fuzzy search state, token indexing, or a shared search store.

When filtering is active:

- only groups with matches stay visible
- matching groups auto-expand
- the top summary count remains `visible items / total items`

### 3. Collapse persistence and bulk controls

The grouped rail now persists `adminCollapsedGroupIds` in `localStorage`.

Design choices:

- store only group ids, not expanded state snapshots of every item
- sanitize persisted ids against the current known group list
- keep filtering higher priority than persisted collapse state
- keep the active group's items visible even if its group id is stored as collapsed

The rail also adds `Expand all` and `Collapse all` controls:

- both operate on the grouped state only
- both are disabled while quick-find filtering is active
- `Collapse all` still leaves the active group's items visible through the existing active-group expansion rule

### 4. Compact rail UX

The rail already had a compact-mode toggle, but once opened it still rendered as a wrapped card flow. That made narrow screens feel closer to a block of filter cards than a navigation control.

The compact rail now adds three presentation rules:

- when compact navigation is opened, the rail renders as a single-column accordion instead of a wrapped multi-card flow
- the active group is promoted to the first visible group in compact mode
- compact rail action buttons opt out of the global mobile `width: 100%` rule so they do not dominate the panel height

These are deliberately render-layer changes only:

- no new route state
- no new persistence model
- no rewrite of hash or observer logic

### 5. Hash-based deep links

The admin rail now treats each known section id as a valid deep-link target.

- Clicking a rail item scrolls to the section and synchronizes `window.location.hash`.
- First load reads the hash, restores the matching section, and marks the correct rail item active.
- Active-section changes continue to keep the hash in sync after the initial restore.

The restore path uses a bounded next-tick retry loop plus a non-reentrant guard. This makes the first-load hash restore resilient to mount timing without introducing duplicate scrolls, scroll polling, or route-level state. The same rule also guarantees that a hashed target remains visible when its group would otherwise be collapsed by persisted state, including in compact mode.

### 6. Branch hygiene for timezone helpers

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
