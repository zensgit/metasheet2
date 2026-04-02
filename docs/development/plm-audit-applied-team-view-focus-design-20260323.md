# PLM Audit Applied Team View Focus Design

## Background

`PLM Audit` already treated team-view management handoffs as a distinct attention owner:

- source focus is cleared
- local saved-view followups are cleared
- the active management card can stay focused

That contract already covered rename, transfer-owner, archive, restore, delete, and other durable team-view actions.

## Problem

`Apply` still lagged behind that contract.

When a collaboration draft or older management focus was active on team view `A`, applying team view `B` only:

- cleared source focus
- cleared local saved-view attention
- cleared draft / share-entry / followup state

It did **not** replace `focusedAuditTeamViewId` with `B`.

That left a mixed state where route/query had pivoted to `B`, while the management panel could still highlight `A`.

## Decision

Treat `Apply` as a durable management takeover:

- clear source attention and local saved-view followups
- clear transient collaboration ownership
- then anchor `focusedAuditTeamViewId` to the newly applied team view

## Implementation

Files:

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

Key changes:

- add `buildPlmAuditAppliedTeamViewAttentionState(...)`
- reuse managed-team-view cleanup semantics for `Apply`
- explicitly replace the final management focus with the applied `teamViewId`
- call the helper after transient collaboration/share-entry/followup cleanup inside `applyAuditTeamViewEntry(...)`

## Expected Behavior

- `manage A -> apply B` ends with only `B` focused
- recommendation and saved-view source focus are cleared
- saved-view local followups are cleared
- collaboration followup cleanup no longer leaves the page without a durable management anchor
