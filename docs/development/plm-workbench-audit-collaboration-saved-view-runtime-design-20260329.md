# PLM Workbench Audit Collaboration Saved-View Runtime Design

## Context

`audit team view` collaboration state supports `saved-view-promotion` provenance through
`sourceSavedViewId`. That provenance is used for:

- follow-up source focus targeting
- collaboration handoff status
- share / set-default follow-up generation

The existing implementation only pruned `sourceSavedViewId` when the user deleted the
source saved view through the local `deleteSavedViewEntry(...)` path.

If the saved view disappeared externally, the runtime state stayed stale:

- collaboration draft still carried the removed `sourceSavedViewId`
- collaboration follow-up still carried the removed `sourceSavedViewId`
- subsequent `share` / `set-default` actions re-emitted the stale provenance
- `focus-source` kept trying to focus a saved view that no longer existed

## Decision

Add a shared runtime normalization layer for audit collaboration state:

- normalize `draft.sourceSavedViewId` against current `savedViews`
- normalize `followup.sourceSavedViewId` against current `savedViews`
- keep scene-context anchor normalization in the same runtime pass
- persist the normalized `draft` and `followup` back into `PlmAuditView` state

This keeps collaboration state aligned with current runtime catalog data without
changing the broader `saved-view-promotion` UX:

- the collaboration draft/follow-up still exists
- the flow still points back to the saved-view area
- only the stale saved-view identity is dropped

## Implementation

### Runtime helpers

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts`:

- add `syncPlmAuditTeamViewCollaborationDraftSavedViewSource(...)`
- add `syncPlmAuditTeamViewCollaborationFollowupSavedViewSource(...)`
- extend `resolvePlmAuditTeamViewCollaborationRuntimeFollowup(...)` to also normalize saved-view provenance
- add `resolvePlmAuditTeamViewCollaborationRuntimeState(...)` to normalize both `draft` and `followup`

### View integration

In `/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue`:

- route collaboration draft target lookup through the runtime-normalized state
- route collaboration notice rendering through the runtime-normalized state
- route collaboration actions through the runtime-normalized state
- watch `savedViews + sceneContext + collaboration draft/followup` and persist normalized state

## Expected Outcome

When a promoted source saved view disappears outside the current delete handler:

- collaboration draft remains usable, but its `sourceSavedViewId` becomes `null`
- collaboration follow-up remains usable, but its `sourceSavedViewId` becomes `null`
- follow-up `focus-source` goes back to the saved-view section without targeting a missing item
- subsequent `share / set-default` actions no longer regenerate stale saved-view provenance
