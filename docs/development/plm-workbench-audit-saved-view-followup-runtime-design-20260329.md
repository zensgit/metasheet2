# PLM Workbench Audit Saved-View Followup Runtime Design

## Problem

`auditSavedViewShareFollowup` only cleared itself when the user explicitly clicked a follow-up action and the target saved view was already gone. The notice path just disappeared silently when the referenced saved view no longer existed, leaving stale followup state persisted in memory.

## Design

- Add `resolvePlmAuditSavedViewShareFollowupRuntimeState(...)` in `plmAuditSavedViewShareFollowup.ts`
  - returns `{ followup, changed }`
  - clears the followup when its `savedViewId` no longer exists in the current saved-view list
- In `PlmAuditView.vue`, add a runtime normalizer that:
  - normalizes the persisted followup against `savedViews`
  - writes back `null` when the target has disappeared
- Use that normalized followup in:
  - followup notice rendering
  - followup action execution
  - a watcher keyed by `savedViews` and the followup ref

## Why This Shape

- It aligns saved-view followups with the collaboration followup runtime contract that now also persists normalized state.
- It removes stale state as soon as the target disappears instead of waiting for a later button click.
- It keeps the user-facing feedback messages unchanged while tightening state correctness.
