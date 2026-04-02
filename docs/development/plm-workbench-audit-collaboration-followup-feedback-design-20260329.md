# PLM Workbench Audit Collaboration Follow-up Feedback Design

## Date
- 2026-03-29

## Goal
- Align audit team-view collaboration follow-up actions with the explicit feedback model already used by audit management, batch actions, saved-view context, shared-entry actions, and saved-view promotion follow-ups.

## Problem
- `runAuditTeamViewCollaborationFollowupAction(...)` in [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) still had two direct silent-return paths:
  - the collaboration follow-up itself had already disappeared
  - the follow-up still existed, but its `teamViewId` target had been removed from the catalog
- That left the audit collaboration follow-up banner as another drift-sensitive secondary entrypoint that could still swallow clicks without a canonical hint.

## Design
- Add a pure resolver in [plmAuditTeamViewCollaboration.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts):
  - `resolvePlmAuditTeamViewCollaborationFollowupActionFeedback(...)`
- Resolver rules:
  - missing follow-up -> explicit unavailable feedback
  - missing target -> explicit "recreate the collaboration flow" feedback
- Route [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) through the resolver before executing `view-logs`, `focus-source`, or `set-default`.
- If the follow-up still exists but the target has disappeared, clear the stale follow-up banner before surfacing the feedback.

## Implementation
- [plmAuditTeamViewCollaboration.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCollaboration.ts)
  - export feedback type and resolver
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - resolve collaboration follow-up drift before running the action
  - clear stale follow-up state only when the underlying team view has disappeared
- [plmAuditTeamViewCollaboration.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCollaboration.spec.ts)
  - lock missing-follow-up and missing-target feedback

## Expected Outcome
- Audit collaboration follow-up actions no longer silently no-op when drift removes the follow-up state or its team-view target.
- The collaboration banner now matches the same explicit-feedback standard already enforced on the other audit secondary action surfaces.
