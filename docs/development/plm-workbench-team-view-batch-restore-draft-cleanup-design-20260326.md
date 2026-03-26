# PLM Workbench Team View Batch Restore Draft Cleanup Design

## Problem

`teamViewName` and `teamViewOwnerUserId` are cleared when the active team view changes, but batch restore can
reapply the same explicit route owner id. In that case the selection survives logically while the editable
rename/transfer-owner drafts remained stale.

This left batch-restored team views with:

- a stale rename input
- a stale transfer-owner input

even though restore had already completed.

## Decision

When batch restore reapplies the restored explicit team view identity, clear the editable drafts explicitly:

- `teamViewName`
- `teamViewOwnerUserId`

This keeps restore behavior aligned with other single-target takeovers.

## Expected Behavior

- restoring an archived selected team view keeps that view selected
- stale rename/owner drafts are cleared immediately after restore
- batch selection cleanup behavior remains unchanged
