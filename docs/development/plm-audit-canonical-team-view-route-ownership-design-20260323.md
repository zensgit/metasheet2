# PLM Audit Canonical Team View Route Ownership Design

Date: 2026-03-23

## Goal

Keep `shared-entry`, `collaboration draft`, and `collaboration followup` owned by the canonical `/plm/audit` route instead of by temporary local selector state.

## Problem

`apps/web/src/views/PlmAuditView.vue` previously cleared transient team-view UI through `watch(auditTeamViewKey, ...)`.

That meant a user could:

1. open `/plm/audit?teamViewId=A&auditEntry=share`
2. temporarily browse the selector to `B` without pressing `Apply`
3. lose the transient notice or followup tied to `A`, even though the canonical route still pointed to `A`

The same ownership bug also affected collaboration drafts and followups when local `applyRouteState(...)` wrote view-model state ahead of the router query.

## Decision

Move transient cleanup from the local selector watcher into the canonical `route.query` watcher.

The route watcher now distinguishes:

- `routeChanged`: the next route differs from the current local modeled state
- `canonicalRouteChanged`: the next route differs from the previous actual URL
- `canonicalTeamViewChanged`: the canonical `teamViewId` changed across real route transitions

This lets the page keep transient UI alive during selector browsing while still cleaning it up when the real route owner changes.

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`

Key changes:

- remove eager cleanup from `watch(auditTeamViewKey, ...)`
- add `shouldKeepPlmAuditTeamViewShareEntry(...)`
- add `shouldKeepPlmAuditTeamViewCollaborationDraft(...)`
- drive share-entry/draft cleanup from `canonicalTeamViewChanged`
- drive followup cleanup from `canonicalRouteChanged` so local `applyRouteState(...)` prewrites do not swallow a real route transition

## Expected Outcome

- browsing the selector no longer destroys transient UI owned by another canonical route
- share-entry, draft, and followup state disappear only when the real `/plm/audit` route stops owning them
- canonical transitions that keep the same `teamViewId` preserve the existing transient UI
