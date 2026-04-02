# PLM Workbench Audit Scene Save Feedback Design

## Date
- 2026-03-29

## Goal
- Align audit scene quick-save actions with the explicit feedback model already used by audit recommendations, shared-entry actions, collaboration draft/follow-up actions, and saved-view follow-ups.

## Problem
- `runAuditSceneSaveAction(...)` in [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) still returned silently when `auditSceneSaveDraft` had disappeared.
- The scene quick-save buttons are rendered from the same transient scene context that can drift during route or ownership changes, so this left another audit side-entry path that could swallow clicks without surfacing a canonical hint.

## Design
- Add a pure resolver in [plmAuditSceneSaveDraft.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSaveDraft.ts):
  - `resolvePlmAuditSceneSaveActionFeedback(...)`
- Resolver rules:
  - missing scene-save draft -> explicit unavailable feedback
- Route [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) through the resolver before running local-save, team-save, or team-default-save actions.

## Implementation
- [plmAuditSceneSaveDraft.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSceneSaveDraft.ts)
  - export save action kind and feedback resolver
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - resolve missing scene-save draft feedback before executing mutations
- [plmAuditSceneSaveDraft.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditSceneSaveDraft.spec.ts)
  - lock explicit unavailable feedback for missing drafts

## Expected Outcome
- Audit scene save buttons no longer silently no-op when the scene-save draft disappears due to route/context drift.
- The scene quick-save surface now matches the same explicit-feedback standard as the rest of the audit secondary action surfaces.
