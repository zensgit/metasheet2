# Attendance v2.7.1 Admin Nav UX Design

## Goal

Reduce friction in the attendance admin console when operators jump between deep sections such as `Shifts`.

The current pain points were:

1. The left rail carried too much chrome before the actual section links.
2. `Shifts` and other scheduling sections sat too low in the rail.
3. After selecting a left-rail section, operators could still feel stranded in the old scroll position.

## Scope

This slice stays entirely in the attendance admin shell:

1. Simplify the left rail into a plain grouped directory.
2. Move recent shortcuts out of the rail and into the top of the admin content area.
3. Bring the scheduling group higher in the rail ordering.
4. Make section selection bring the right content back to the top region immediately.
5. Keep the current section and focus toggle visible inside the right pane itself.

## UX Changes

### Left Rail

Removed from the left rail:

- section count
- current section summary
- quick-find input
- expand all
- collapse all
- copy current link
- embedded recents block

The rail now acts as a cleaner jump list with grouped headings only.

### Recent Access

Recent shortcuts still use the existing persisted recents model, but now render at the top of the admin content area as compact jump chips. This keeps high-value revisits visible without pushing the primary directory downward.

### Current Section Bar

The right pane now renders a sticky current-section bar above the content body.

It shows:

- the active section context label
- a short usage hint
- the focused/show-all toggle in the same place operators are already looking

This shortens the interaction loop: operators no longer need to scroll back to the top header just to change the visibility mode.

### Group Ordering

The group order is now:

1. Workspace
2. Scheduling
3. Organization
4. Policies
5. Data & Payroll

This moves `Shifts` and related scheduling actions significantly closer to the top.

### Scroll Behavior

When a section is selected:

1. the active rail link is centered into view in the left rail
2. the right content container is scrolled back into the top region in focused mode
3. the target section is only scrolled into place when operators reveal all sections

This avoids a double-scroll fight in focused mode while keeping section-level navigation intact in expanded mode.

## Non-goals

- No backend/API changes
- No change to focused-mode semantics
- No removal of the underlying recents/collapse persistence model
