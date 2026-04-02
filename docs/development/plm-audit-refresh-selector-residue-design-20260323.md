# PLM Audit Refresh Selector Residue Design

## Background

`bab0d3b53 fix(plm-audit): preserve canonical control ownership` moved `PLM Audit` controls onto canonical team-view ownership and started pruning transient ownership when refreshes remove team views.

One local state path still stayed outside that cleanup: the selector id itself.

## Problem

`trimAuditTeamViewSelection()` only trimmed:

- batch-selected ids
- focused management card ids
- focused recommendation ids

It did not clear `auditTeamViewKey` when a refresh removed the backing team view.

That leaves a stale local selector residue:

- canonical controls can stay locked against a nonexistent local drift target
- `readCurrentRouteState()` can still emit a removed `teamViewId`
- later local actions such as save/filter pivots can carry that dead team-view id forward

## Decision

Treat the local selector as part of the refresh-trim contract and clear it whenever its backing team view disappears from the refreshed catalog.

## Implementation

Add `trimPlmAuditExistingTeamViewUiState(...)` to `apps/web/src/views/plmAuditTeamViewOwnership.ts`.

The helper trims:

- `selectedTeamViewId`
- `selectedIds`
- `focusedTeamViewId`
- `focusedRecommendedTeamViewId`

`PlmAuditView.vue` now routes `trimAuditTeamViewSelection()` through that helper, so refresh-driven removals clear the stale selector id together with the rest of the transient UI state.

## Expected Behavior

- refreshes still keep valid local selectors intact
- if the selected local team view disappears, `auditTeamViewKey` is cleared
- canonical controls no longer stay locked behind a removed local selector
- subsequent local route/state saves no longer carry a deleted `teamViewId`
