# PLM Audit Canonical Notice Target Design

Date: 2026-03-23

## Goal

Keep PLM Audit collaboration notices and shared-entry notices pinned to their canonical target team view, even when the local team-view selector temporarily changes before the user applies a new route.

## Problem

Two transient UI notices were still bound to the local selector instead of the canonical route-owned target:

1. recommendation-driven collaboration drafts disappeared when users changed the local team-view selector before applying the draft target
2. shared-entry notices disappeared under the same local selector change, even though the canonical route still belonged to the shared-entry target

That created a user-visible mismatch:

- draft/share-entry ownership stayed alive in state
- but the notice and its actions vanished because the selector no longer pointed at the same team view

## Decision

Treat both notices as canonical-target UI, not selector UI.

- collaboration notices resolve their target from the active draft `teamViewId`
- shared-entry notices resolve their target from the active shared-entry `teamViewId`
- action handlers and action permissions use that same canonical target instead of the local selector

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/plm/usePlmCollaborativePermissions.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`
- `apps/web/tests/usePlmCollaborativePermissions.spec.ts`

Key changes:

- add `findPlmAuditTeamViewCollaborationDraftView(...)`
- add `findPlmAuditTeamViewShareEntryView(...)`
- export target-based permission helpers `canSharePlmCollaborativeEntry(...)` and `canDuplicatePlmCollaborativeEntry(...)`
- bind `auditTeamViewCollaborationNotice` and `auditTeamViewShareEntryNotice` to resolved canonical targets, not `selectedAuditTeamView`
- route collaboration/share-entry notice actions through those canonical targets so the visible notice and the executed action stay aligned

## Expected Outcome

- recommendation collaboration notices stay visible while their draft is still active, even if users temporarily change the local selector
- shared-entry notices stay visible while canonical shared-entry ownership is still active
- notice permissions and button actions now operate on the same team view the notice is describing
