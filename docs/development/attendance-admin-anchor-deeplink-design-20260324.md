# Attendance Admin Anchor Deeplink, Grouped Rail, Collapse Persistence, Compact Rail UX, Share Links, Recent Shortcuts, Recent-Clear Control, Active-Link Visibility, Last-Section Restore, Org-Scoped Rail State, Scope Badge, Scope-Change Feedback, And Group-Context Labels Design 2026-03-24

## Context

`AttendanceView.vue` already carries the attendance admin console as a single long page with 22 top-level sections. The first-stage root-admin stabilization added a sticky left anchor rail, active-section tracking, and section-level refs. The second stage added quick-find and hash deep links. The third stage grouped the rail by business domain. The fourth stage added collapse persistence and bulk expand/collapse actions. The fifth stage made the compact mobile rail deliberate instead of just functional. The sixth stage turned the existing deep-link model into a user-facing share action. The seventh stage added recent shortcuts. The eighth stage kept the active rail link visible while the operator scrolls through the long page. The ninth stage added startup fallback to the last meaningful section when there is no explicit hash. The tenth stage scoped all persisted rail state by org id so one org does not reopen with another org's navigation memory. The eleventh stage made that scoping visible with a lightweight badge in the rail header. The twelfth stage added a short-lived confirmation note when the org-scoped navigation memory actually changes. This follow-up adds explicit group-context labels for the current section summary and recent shortcuts.

## Goals

- Reduce scroll cost inside the attendance admin console.
- Reduce cognitive load in the left rail itself.
- Preserve the operator's preferred left-rail state across reloads.
- Reduce compact-mode height and keep the current domain prominent on narrow screens.
- Make the current admin section shareable without editing the URL manually.
- Make repeated jumps between a handful of admin sections faster than re-scanning all groups.
- Keep the left rail spatially in sync with the long-page active section.
- Reopen the admin console at the operator's last meaningful section when no deep link is present.
- Prevent persisted rail state from bleeding across organizations.
- Make the current org-scoped rail memory visible without adding a new panel or warning banner.
- Confirm the org-scoped rail memory switch at the moment it happens.
- Make the current section and recent shortcuts self-describing without forcing operators to re-scan the group headers.
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

### 5. Shareable current-section link

The rail actions now include `Copy current link`.

Design choices:

- the copied value is derived from the existing active section id, not from ad hoc DOM lookup
- the copied URL is the current page origin/path/search plus `#<active-section-id>`
- success and failure both reuse the existing attendance status surface instead of adding a separate toast system

This keeps the share action aligned with the already-tested hash deep-link model:

- click a section
- active section id updates
- hash stays in sync
- copy action exports the same target

### 6. Recent admin section shortcuts

The rail now keeps a short `Recent` strip above the grouped navigation.

Design choices:

- the source of truth is still `adminActiveSectionId`
- recent ids are persisted separately from group collapse state
- the list is deduplicated, bounded to five items, and sanitized against the current known section ids
- recent items reuse the same button styling and `scrollToAdminSection()` handler as grouped items
- quick-find filtering also filters the recent strip, so the rail stays internally consistent while searching

This avoids introducing a second navigation model. The recent strip is only a faster entry point into the same section ids that already drive:

- observer tracking
- hash deep links
- compact-mode promotion
- current-link copying

### 7. Active-link visibility inside the rail

The rail now actively keeps the current section button in view when `adminActiveSectionId` changes.

Design choices:

- this is implemented as a separate render-layer sync step, not folded into the content scroll logic
- grouped rail links remain the primary target; recent shortcuts are only a fallback if the grouped button is temporarily absent
- the sync uses `scrollIntoView({ block: 'nearest', inline: 'nearest' })` so it minimally adjusts the rail instead of snapping it to the top
- the existing deep-link and observer pipeline stays unchanged; this layer only mirrors their result inside the left rail

This is the missing last mile after active-section tracking. Without it, the correct item can be active in state but still be physically out of view inside the sticky rail once the operator has moved far enough down the page.

### 8. Last-section restore without a hash

The admin console now stores the last known active section id separately from the recent-shortcuts list.

Design choices:

- explicit `#section-id` deep links remain highest priority
- if there is no valid hash, startup falls back to the stored last section id
- if the stored id is stale or unknown, the console still falls through to the current default first section
- restoring the last section reuses the same bounded restore loop as hash-based restore, so the mount-time scroll behavior stays in one place
- once the stored section becomes the active section, it flows through the existing active-section synchronization and can materialize the matching hash in the address bar

This keeps the persistence model layered and predictable:

- `hash` controls shareable deep links
- `last section` controls return-to-work continuity
- `recents` controls fast in-session and cross-session jumps between a few common sections

### 9. Org-scoped rail state

The admin rail now scopes all persisted client-side navigation state by org id:

- collapsed group ids
- recent shortcuts
- last active section

Design choices:

- `normalizedOrgId()` is reused as the scope input, with `default` as the fallback bucket
- storage keys stay human-readable by suffixing the existing keys with `:<scope>`
- switching orgs reloads the three rail state buckets before re-synchronizing the observer and restore flow
- the hash still stays global and wins over org-local persistence when present

This keeps the persistence semantics predictable:

- deep links are shareable and explicit
- rail memory is local to the working org
- changing orgs swaps rail state without needing a full remount

### 10. Visible org scope badge

The rail header now shows a compact org-scope badge when the admin console is using a non-default org bucket.

Design choices:

- the default bucket stays visually silent, so the common single-org case does not get extra chrome
- the badge lives in the existing header row instead of adding a separate hint block or banner
- the badge displays the effective `adminNavStorageScope`, which already drives the storage key resolution
- long org ids truncate with ellipsis so the sticky rail width stays stable

This keeps the signal lightweight:

- no new interactions
- no extra persistence
- no mismatch between what is shown and what the storage helpers actually use

### 11. Scope-change feedback

The rail now shows a short-lived note when the effective org scope changes.

Design choices:

- the feedback is rendered inside the rail panel instead of reusing the global admin status block
- it only appears when the scope actually changes; first load stays quiet
- it reuses the same effective scope that drives storage key resolution, so the message cannot drift from the real bucket
- the note auto-clears after a short timeout and is cleaned up on unmount

This keeps the signal precise:

- badge answers “which scope am I in”
- note answers “the scope just changed”

### 12. Group-context labels for current section and recents

The rail now surfaces the active admin section as a small `Current` summary, and recent shortcuts render as `Group · Section`.

Design choices:

- grouped nav buttons keep their existing short labels because the group header already provides context
- the new context string is derived from the existing grouped rail model instead of introducing a second labeling registry
- compact-mode toggle reuses the same current-section summary so narrow screens see the full context too
- quick-find filtering on recent shortcuts now matches against the context string, so searching by group name can still surface recent entries

This keeps the change presentation-only while lowering scan cost:

- the current section is obvious even when the active group is collapsed or scrolled away
- recent shortcuts no longer rely on the operator remembering which domain a section belongs to
- the grouped rail structure remains unchanged

### 13. Explicit recent-shortcut reset

The `Recent` block now exposes a lightweight `Clear` action in its own header.

Design choices:

- the action only resets the attendance-admin recent bucket for the current org scope
- it reuses the existing recent persistence model instead of adding a second “pinned” or “favorite” concept
- clearing recents leaves collapse state, current-section summary, and last-section restore untouched
- confirmation reuses the existing attendance status surface instead of adding a dedicated toast just for rail state

This keeps the shortcut strip user-controlled:

- operators can flush stale recents after task switching
- org-scoped rail memory stays predictable instead of accreting old shortcuts forever
- the action remains local to attendance and does not require backend preferences

### 14. Hash-based deep links

The admin rail now treats each known section id as a valid deep-link target.

- Clicking a rail item scrolls to the section and synchronizes `window.location.hash`.
- First load reads the hash, restores the matching section, and marks the correct rail item active.
- Active-section changes continue to keep the hash in sync after the initial restore.

The restore path uses a bounded next-tick retry loop plus a non-reentrant guard. This makes the first-load hash restore resilient to mount timing without introducing duplicate scrolls, scroll polling, or route-level state. The same rule also guarantees that a hashed target remains visible when its group would otherwise be collapsed by persisted state, including in compact mode.

### 15. Branch hygiene for timezone helpers

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
- No server-side preference store or cross-user sharing model for recent shortcuts.
- No attempt to make rail state multi-tab transactional; last write still wins inside the same org scope.
