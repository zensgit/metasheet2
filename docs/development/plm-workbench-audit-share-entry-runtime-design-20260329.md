# PLM Workbench Audit Share Entry Runtime Design

## Background

`auditTeamViewShareEntry` is a transient state installed when an audit team view is opened from a shared link. The UI already had removed-view pruning and action-time stale cleanup, but it did not normalize runtime state when the referenced team view was no longer present in the current catalog.

That left one contract split:

- the shared-entry notice disappeared because the target could not be resolved
- but `auditTeamViewShareEntry` still remained in memory
- and later flows such as `saveCurrentAuditView()` could still treat the current audit as coming from a shared-entry owner

So the state could silently influence followup-source detection even after the underlying shared-entry target was gone.

## Design

Align `share-entry` with the runtime-normalized followup flows:

1. Add a pure helper that resolves `auditTeamViewShareEntry` against the current `auditTeamViews` list.
2. Clear the state immediately when the entry target no longer exists.
3. Route all share-entry-sensitive call-sites through the runtime-normalized state:
   - share-entry notice rendering
   - share-entry action handling
   - local saved-view followup source detection
4. Add a watcher so the normalized state is persisted as catalogs refresh.

## Files

- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`
