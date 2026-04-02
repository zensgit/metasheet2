# PLM Audit Refresh-Removed Team View Ownership Design

## Background

`de5a39e7c fix(plm-audit): clear removed team-view ownership` already pruned collaboration draft, follow-up, and shared-entry owners when the removal happened through local lifecycle actions such as `Delete`.

One path still bypassed that cleanup: `Refresh team views`.

## Problem

`refreshAuditTeamViews()` replaced `auditTeamViews` with the fresh server payload, but it did not clear transient ownership when a team view disappeared outside the local page flow.

That left a stale hidden owner in one of these states:

- `auditTeamViewCollaborationDraft`
- `auditTeamViewCollaborationFollowup`
- `auditTeamViewShareEntry`

Even though the notice itself disappeared once the backing view vanished, the stale owner could still survive in memory and continue affecting canonical ownership calculations.

## Decision

Treat team-view refreshes the same way as local removals:

- diff the previous and refreshed team-view ids
- identify ids removed by the refresh
- prune collaboration/share-entry ownership for those ids before continuing with selection trimming

## Implementation

Add a new pure helper in `apps/web/src/views/plmAuditTeamViewOwnership.ts`:

- `resolvePlmAuditRemovedTeamViewIds(previousViews, nextViews)`
- `prunePlmAuditTransientOwnershipForRemovedViews(state, removedViewIds)`

Update `PlmAuditView.vue`:

- reuse the new helper inside `pruneRemovedAuditTeamViewTransientState(...)`
- extend `watch(auditTeamViews, ...)` to diff `previousViews` vs `views`
- when refresh removes ids, prune transient ownership before `trimAuditTeamViewSelection()`

## Expected Behavior

- local deletes keep their existing cleanup behavior
- external removals discovered through `Refresh team views` now clear stale draft/follow-up/shared-entry ownership too
- canonical team-view controls no longer stay locked behind an invisible removed owner after refresh
