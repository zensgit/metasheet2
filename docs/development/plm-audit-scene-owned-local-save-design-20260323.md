# PLM Audit Scene-Owned Local Save Design

Date: 2026-03-23

## Goal

Tighten `scene-context` local-save ownership so PLM Audit only labels a saved view as scene-owned when the current route is still in an active scene context, and so the dedicated `Save scene view` action always stores a canonical scene snapshot.

## Problems

Two user-visible inconsistencies remained around scene-aware local save:

1. Generic `Save current view` treated any surviving scene metadata as active `scene-context` ownership, even after users drifted the audit query away from the scene.
2. Source-aware local save installed a new saved-view followup without clearing stale lifecycle management focus, so a fresh local-save notice could coexist with an old team-view management highlight.
3. `Save scene view` promised a scene-focused snapshot, but it actually stored the current route verbatim, including drifted filters that no longer matched the scene query or owner context.

## Decision

Split generic local save from scene-owned local save.

- Generic local save remains unchanged and keeps the existing `buildPlmAuditSavedViewStoreAttentionState(...)` contract.
- Source-aware local save now gets its own attention cleanup, clearing management and source focus before installing the new followup.
- `scene-context` provenance is only assigned when the current route is actively in scene owner/query context.
- The dedicated `Save scene view` action normalizes the current route back to canonical scene state before storing it as a local saved view.

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/plmAuditSavedViewShareFollowup.ts`
- `apps/web/src/views/plmAuditSceneContext.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `apps/web/tests/plmAuditSavedViewShareFollowup.spec.ts`
- `apps/web/tests/plmAuditSceneContext.spec.ts`

Key changes:

- add `buildPlmAuditSourceLocalSaveAttentionState(...)` so source-aware local saves clear stale management/source attention before installing a local followup
- route `saveCurrentLocalViewWithFollowup(...)` through that source-local cleanup instead of relying on the generic saved-view store cleanup
- change `resolvePlmAuditSavedViewLocalSaveFollowupSource(...)` to use `sceneContextActive`, not raw scene metadata presence
- add `buildPlmAuditSceneSavedViewState(...)` to normalize scene saves back to owner-context or scene-query canonical state before persisting them
- update the dedicated `Save scene view` path to save the normalized scene snapshot instead of the drifted current route

## Expected Outcome

- `Save current view` only produces a `scene-context` followup when the audit route still actively reflects the scene
- source-aware local-save followups replace stale team-view management highlights instead of coexisting with them
- `Save scene view` stores a real scene snapshot, so reapplying it returns to canonical scene state instead of a drifted custom query
