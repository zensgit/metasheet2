# PLM Workbench Audit Saved-View Attention Runtime Design

## Background

`auditSavedViewShareFollowup` already had runtime normalization, but the sibling `focusedSavedViewId` state still only cleared on explicit local delete actions.

That left a runtime/state split:

- if a saved view disappeared from the current local catalog, the visible card focus vanished naturally because the card was gone
- but the saved-view attention state still kept the old `focusedSavedViewId` in memory

This was weaker than the other followup and ownership flows that already normalize transient state as catalogs change.

## Design

Normalize saved-view attention state against the current `savedViews` catalog:

1. Add a pure helper that clears stale `focusedSavedViewId` when its backing saved view no longer exists.
2. Combine that helper with the existing share-followup runtime normalization in `PlmAuditView.vue`.
3. Persist the normalized attention state through a watcher so stale focus does not linger invisibly in memory.

The helper intentionally preserves valid focus and does not touch create-mode or route-owned state outside the missing saved-view target case.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
