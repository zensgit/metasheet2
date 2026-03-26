# PLM Workbench Stale Route Owner Refresh Design

## Problem

`requestedViewId` is the canonical route owner for an applied collaborative team view. During refresh, the
composable previously cleared that owner only when the id disappeared entirely.

That left a stale route owner alive when the same id still existed but had become non-applyable, for example:

- archived after refresh
- permissions dropped to `canApply = false`

When the user had already switched the local selector to another applyable view, the stale requested owner kept
the composable in pending-apply mode and wrongly hid or blocked management actions for the current selector.

## Decision

Align `usePlmTeamViews` with the existing preset refresh contract:

1. During refresh, inspect the requested route owner by id.
2. Clear `requestedViewId` whenever the matching entry is missing or no longer passes
   `canApplyPlmCollaborativeEntry(...)`.
3. Keep the local selector unchanged so the user can still apply the pending target explicitly.

## Expected Behavior

- refresh clears stale canonical route owners that lost applyability
- pending state disappears once the canonical owner is no longer valid
- the local selector stays on the user’s chosen target
- management actions become available again for the surviving selector target
