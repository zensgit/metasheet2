# PLM Workbench Audit Saved View Follow-up Feedback Design

## Date
- 2026-03-29

## Goal
- Align audit saved-view follow-up actions with the explicit feedback model already used by audit management, recommendation, saved-view context, and shared-entry actions.

## Problem
- `runAuditSavedViewShareFollowupAction(...)` in [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) only handled the `savedViewId -> missing local saved view` drift case.
- When the follow-up itself had already disappeared, the handler still returned silently.
- That left the saved-view follow-up entry as the remaining audit quick-action path that could still swallow invalid state without surfacing a canonical hint.

## Design
- Add a pure resolver in [plmAuditSavedViewShareFollowup.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewShareFollowup.ts):
  - `resolvePlmAuditSavedViewShareFollowupActionFeedback(...)`
- Resolver rules:
  - missing follow-up -> explicit unavailable feedback
  - missing target after shared-entry local save -> explicit "save shared audit locally again" feedback
  - missing target after scene-context local save -> explicit "save scene audit locally again" feedback
- Route [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) through the resolver before promoting the saved view into audit team views.
- If the follow-up still exists but its saved view has disappeared, clear the follow-up before showing the message so the stale CTA does not linger.

## Implementation
- [plmAuditSavedViewShareFollowup.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewShareFollowup.ts)
  - export feedback type and resolver
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - resolve missing-follow-up and missing-target feedback before promoting
  - clear stale follow-up state only when the saved-view target is gone
- [plmAuditSavedViewShareFollowup.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSavedViewShareFollowup.spec.ts)
  - lock missing-target and missing-follow-up feedback

## Expected Outcome
- Audit saved-view follow-up actions no longer silently no-op when the follow-up or its saved-view target disappears.
- Runtime feedback now matches the explicit-feedback standard already applied across the other audit secondary action surfaces.
