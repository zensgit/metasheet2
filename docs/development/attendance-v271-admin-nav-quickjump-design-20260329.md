# Attendance Admin Quick Jump Design

Date: 2026-03-29

## Goal

After landing:

- simplified left rail
- sticky current-section bar
- previous/next pager
- focus-mode persistence
- keyboard previous/next shortcuts

the next small UX slice is a direct quick-jump control inside the same right-side current-section bar.

This is meant to solve the remaining "班次 / Shifts is still too far away" problem without reintroducing left-rail clutter.

## Scope

Frontend only.

Files:

- `apps/web/src/views/AttendanceView.vue`
- `apps/web/tests/attendance-admin-anchor-nav.spec.ts`

## Design

### Keep navigation surfaces consolidated

The quick jump is added to the existing sticky current-section bar, not to the left rail.

That keeps all fast navigation tools in one place:

- previous
- next
- focus/show-all
- direct jump

### Reuse canonical section order

The control is built from `orderedAdminSectionNavItems`, which already defines the stable canonical order used by the pager.

Items are rendered as grouped native `<select>` optgroups, preserving existing section grouping without creating a second navigation taxonomy.

### Reuse existing selection flow

The select change handler only calls `selectAdminSection()`.

That means it automatically inherits:

- focused-mode reset to current section
- hash sync
- scroll-to-section behavior
- recent-section tracking

## Why this slice

It is higher value than more left-rail work because it directly reduces the cost of reaching deep sections, especially when the operator already knows the target section name.

It is smaller and safer than introducing a command palette or new floating navigation UI.

## Claude Code Note

Claude Code was invoked again during this continuation. It did not return a timely consumable answer for this slice, so the implementation boundary here was chosen from the already-landed navigation architecture and local code review.
