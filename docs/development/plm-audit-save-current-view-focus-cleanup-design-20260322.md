# PLM Audit Save-Current-View Focus Cleanup Design

Date: 2026-03-22

## Goal

Keep `Save current view` aligned with the rest of the PLM audit transient-attention model so a direct local save does not leave old saved-view source focus behind.

## Problem

The audit page already cleared local saved-view followups and source focus for:

- followup installation
- team-view handoff
- filter navigation
- reset flows

But the generic `Save current view` path still used `storeAuditSavedView()` with only `clearAuditSavedViewShareFollowup()`.

That left one gap:

1. a prior collaboration `focus-source` could leave `focusedSavedViewId` active
2. the user directly saved the current audit filters as a new local saved view
3. the new save succeeded, but the old saved-view card could remain highlighted

The UI then showed a stale saved-view source highlight even though the user had already moved into a new local-save action.

## Design

### 1. Add a pure helper for local saved-view store cleanup

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditSavedViewStoreAttentionState(...)`.

Its contract is:

- clear source focus (`focusedRecommendedAuditTeamViewId`, `focusedSavedViewId`)
- clear local saved-view followup/highlight
- preserve management focus

That makes `Save current view` use the same reducer-owned cleanup model as the other saved-view transitions.

### 2. Route `storeAuditSavedView()` through the helper

`apps/web/src/views/PlmAuditView.vue` now applies the shared store-cleanup helper immediately after persisting the local saved view.

This fixes both:

- direct `Save current view`
- scene quick-save local-save path, because it reuses `storeAuditSavedView()`

### 3. Avoid duplicate page-level cleanup

Since `storeAuditSavedView()` now owns the source-focus cleanup, the scene quick-save local-save path no longer needs an extra `clearAuditSourceFocus()` before installing its new followup.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- direct local saves no longer leave an unrelated saved-view card highlighted
- local save now obeys the same transient-attention rules as the other saved-view flows
- scene quick-save local save stays behaviorally identical but loses the duplicated cleanup branch
