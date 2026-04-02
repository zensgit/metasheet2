# PLM Audit Transfer Owner Input Lock Design

## Background

`PLM Audit` already locks generic team-view management buttons to the canonical management target.

That lock did not extend to the `transfer owner` text input.

## Problem

When the local selector drifts away from the canonical management owner:

- `Transfer owner` button is disabled
- but `auditTeamViewOwnerUserId` stays editable

That creates a stale-draft path:

- user types an owner id while the canonical target is locked
- no transfer can run yet
- later the selector realigns or the canonical target changes
- the old owner draft is still there and can be applied to a different valid target

## Decision

Treat the transfer-owner input like the transfer-owner action itself.

If the canonical management target is locked, unavailable, or loading, disable the input.

The team-view name input remains editable because it is also used for `Save to team`, which stays valid outside rename flows.

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewControlTarget.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

Key changes:

- add `shouldDisablePlmAuditTeamViewTransferOwnerInput(...)`
- drive the transfer-owner input `:disabled` state from the same canonical-target contract as the action
- lock on any of:
  - canonical management target drift
  - missing transfer permission
  - loading state

## Expected Behavior

- transfer-owner drafts cannot be typed while management controls are locked to a different canonical target
- no stale owner id can be carried from a locked state into a later valid target
- `Save to team` name drafting remains unaffected
