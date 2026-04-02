# PLM Workbench Audit Collaboration Draft Feedback Design

## Date
- 2026-03-29

## Goal
- Align audit team-view collaboration draft actions with the same explicit feedback model already enforced on audit collaboration follow-ups, share-entry actions, saved-view follow-ups, recommendations, and management actions.

## Problem
- `runAuditTeamViewCollaborationAction(...)` in [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) still had a direct silent-return path when:
  - the collaboration draft had already disappeared
  - the collaboration draft still existed, but its team-view target had disappeared from the catalog
- That left the primary collaboration banner as the remaining audit secondary surface that could still swallow `share / set-default` clicks after route/catalog drift.

## Design
- Add a pure resolver in [plmAuditTeamViewCollaboration.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts):
  - `resolvePlmAuditTeamViewCollaborationActionFeedback(...)`
- Resolver rules:
  - missing draft -> explicit unavailable feedback
  - missing target -> explicit "recreate the collaboration flow" feedback
- Route [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) through the resolver before running `share` or `set-default`.
- If the draft still exists but the target has disappeared, clear the stale collaboration draft before surfacing the feedback.

## Implementation
- [plmAuditTeamViewCollaboration.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts)
  - export draft-action feedback type and resolver
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - resolve collaboration draft drift before executing mutations
  - clear stale draft state only when the underlying team view has disappeared
- [plmAuditTeamViewCollaboration.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCollaboration.spec.ts)
  - lock missing-draft and missing-target feedback

## Expected Outcome
- Audit collaboration draft actions no longer silently no-op when the draft entry itself has already been cleared.
- Stale collaboration draft banners are cleared before surfacing missing-target feedback.
- Audit collaboration banners now match the same explicit-feedback standard as the rest of the audit side-entry surfaces.
