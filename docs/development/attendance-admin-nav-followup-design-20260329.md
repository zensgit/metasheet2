# Attendance Admin Nav Follow-up Design

## Goal

Make the attendance admin console easier to traverse after the earlier rail simplification already removed the noisy controls.

The remaining friction was:

- desktop operators still had to visually scan a long left rail after jumping to a deep section such as `Shifts`
- selecting a deep section did move the right pane back to the current block, but the left rail still left unrelated groups expanded

## Scope

Smallest safe UX slice:

1. Keep the current grouped rail, recent shortcuts, and sticky current-section bar.
2. Move the active group to the top on desktop while focused mode is on.
3. Collapse non-active groups when a section is explicitly selected.
4. Preserve compact/mobile behavior and existing right-pane scroll reset.

## Design

### 1. Active group becomes the primary desktop rail context

The rail already reordered the active group to the top in compact mode. This slice extends the same behavior to desktop when focused mode is active.

That keeps the group containing the current block closest to the operator's cursor after every jump.

### 2. Explicit section selection collapses unrelated groups

When operators click a left-rail item or use the quick-jump selector:

- focused mode remains enabled
- the selected section becomes active
- the selected section's group stays expanded
- all other groups collapse

This shortens the left rail immediately after every explicit jump without changing the content model on the right.

### 3. No new controls

This slice deliberately does not reintroduce:

- search
- expand all / collapse all
- current-link copy
- count badges

The earlier simplification already removed those from the live rail, and this follow-up keeps that direction.

## Non-goals

- No backend changes
- No new route/tab
- No redesign of the sticky current-section bar
- No change to recents placement at the top of the content pane
