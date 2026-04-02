# PLM Audit Transfer Owner Target Gating Design

## Background

`6f5d662ee fix(plm-audit): lock transfer-owner drafts` tightened the transfer-owner input so it no longer stayed editable while the canonical management target was locked.

That patch reused `canTransfer`, which is the submit-state signal for the action button.

## Problem

`canTransfer` depends on the input value itself:

- target exists and is transferable
- draft owner id is non-empty
- draft owner id differs from the current owner

Using that signal to disable the input creates a self-lock:

- the draft starts empty
- `canTransfer` is `false`
- the input becomes disabled before the user can type

So transfer-owner becomes impossible even when the canonical target is valid.

## Decision

Split transfer-owner into two separate contracts:

- `canTransferTarget`: whether the current canonical team-view target is transferable at all
- `canTransfer`: whether the current draft is ready to submit

The input should be disabled only when:

- the canonical management target is locked
- the canonical target itself is not transferable
- the page is loading

The submit button keeps using `canTransfer`.

## Implementation

Files:

- `apps/web/src/views/plm/usePlmCollaborativePermissions.ts`
- `apps/web/src/views/plmAuditTeamViewControlTarget.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/usePlmCollaborativePermissions.spec.ts`
- `apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

Key changes:

- expose `canTransferTarget` from `usePlmCollaborativePermissions(...)`
- keep `canTransfer` as the draft-submit signal
- update transfer-owner input gating to consume `canTransferTarget`
- lock helper/tests to the new target-vs-submit split

## Expected Behavior

- a valid canonical management target keeps the transfer-owner input editable while the draft is blank
- the transfer button still stays disabled until the user types a different owner id
- locked or non-transferable canonical targets still disable the input
