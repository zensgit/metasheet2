# PLM Workbench Stale Owner Pending Selector Design

## Background

`usePlmTeamViews(...)` and `usePlmTeamFilterPresets(...)` both support this split state:

- canonical route owner: the currently applied collaborative target
- local selector target: a pending target the user has picked but has not applied yet

Before this change, refresh logic cleared an invalid canonical route owner, but left a different local selector target intact. That accidentally promoted the pending selector target into the active management target even though the page state had never been reapplied to that target.

## Failure Mode

Typical sequence:

1. route owner `A` is currently applied
2. user changes the selector to pending target `B`
3. refresh returns with `A` still present but no longer applyable
4. refresh clears `requestedViewId` / `requestedPresetId`
5. selector `B` remains selected, so management actions start targeting `B`

That is wrong because the visible page state still reflects `A`, not `B`.

## Decision

When a stale route owner is cleared during refresh:

- if the current local selector points at a different target, clear that selector too
- clear attached management drafts at the same time
- keep the page in ownerless state until the user explicitly reselects or reapplies a target

This keeps route ownership and management targeting aligned again for both:

- team views
- team filter presets

## Expected Outcome

- a stale canonical owner can no longer silently promote a pending selector target
- rename / transfer-owner drafts do not leak across that forced reset
- users must explicitly re-apply a target before management actions become available again
