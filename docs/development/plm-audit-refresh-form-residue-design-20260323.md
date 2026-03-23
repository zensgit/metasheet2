# PLM Audit Refresh Form Residue Design

## Background

`d50a7fdfa fix(plm-audit): clear refresh selector residue` already clears stale selector ids and focus when a refresh removes the currently selected audit team view.

One local draft path still sat outside that cleanup: the management form inputs.

## Problem

When refresh removes the selected team view, `PlmAuditView.vue` clears:

- `auditTeamViewKey`
- batch selection ids
- management focus ids

But it still keeps the removed view's form drafts:

- `auditTeamViewName`
- `auditTeamViewOwnerUserId`

That leaves stale form residue behind:

- `Save to team` can reuse the deleted view's name by accident
- transfer-owner input can keep a dead target owner from the removed selection

## Decision

Treat management form drafts as part of the refresh-trim contract, but only when a selected team view actually disappears.

If no team view is currently selected, create-form drafts stay intact.

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewOwnership.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

Key changes:

- extend `trimPlmAuditExistingTeamViewUiState(...)` to carry `draftTeamViewName` and `draftOwnerUserId`
- clear those drafts only when the currently selected team view no longer exists after refresh
- keep drafts untouched when the user is in "new team view" mode with no current selection

## Expected Behavior

- refreshing away the selected team view clears its stale name/owner drafts together with the selector
- normal create-mode drafts remain available when no selected team view was removed
- subsequent `Save to team` or transfer flows no longer inherit form data from a vanished team view
