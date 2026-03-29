# Attendance v2.7.1 Admin Nav Pager Design

## Goal

Reduce the number of times operators must return to the left rail when moving through nearby attendance admin sections.

The previous slice already:

1. simplified the left rail,
2. moved recent shortcuts to the top of the right pane,
3. added a sticky current-section bar.

This follow-up adds lightweight adjacent navigation inside that current-section bar.

## Scope

This slice stays in the attendance admin shell only:

1. expose a stable previous/next section relationship,
2. render previous/next controls inside the sticky current-section bar,
3. keep the existing focused/show-all toggle in the same bar.

## UX Changes

### Current Section Pager

The sticky current-section bar now includes:

- a previous section button,
- the existing focused/show-all toggle,
- a next section button.

The buttons use adjacent section labels so operators can step through the admin console without returning to the left rail after every change.

### Stable Navigation Order

The pager uses a stable section order derived from the canonical admin section definitions rather than from the visible left-rail order.

That avoids coupling the pager to compact-mode behavior, where the active group is intentionally floated toward the top of the left rail.

### Interaction Model

Pager clicks reuse the existing `selectAdminSection()` flow. That means they preserve:

- focused-mode semantics,
- hash sync,
- recent-section tracking,
- right-pane top reset behavior.

## Non-goals

- No backend or API changes
- No change to left-rail structure
- No arrow-key shortcuts or carousel behavior
- No cross-group search UI
