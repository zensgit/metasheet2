# PLM Workbench Audit Recommendation Management Feedback Design

## Date
- 2026-03-29

## Goal
- Align the recommended audit team-view "management" entry with the same explicit feedback model already used by recommended apply/share/set-default actions and the other audit secondary entrypoints.

## Problem
- `focusAuditTeamViewManagement(...)` in [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) still returned silently when the recommended team-view target disappeared.
- The recommendation card's management button is directly clickable, so a stale recommendation card could still swallow the click without surfacing the canonical "current recommendation unavailable" hint already used by the other recommendation actions.

## Design
- Extend [plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts) recommendation feedback handling with a `manage` action kind.
- Resolver rules:
  - missing target -> explicit unavailable feedback
  - existing target -> no feedback, continue to management handoff
- Route [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue) through the same recommendation feedback resolver before performing the management handoff.

## Implementation
- [plmAuditTeamViewCatalog.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditTeamViewCatalog.ts)
  - extend `PlmRecommendedAuditTeamViewActionKind` with `manage`
  - reuse `resolvePlmRecommendedAuditTeamViewActionFeedback(...)`
- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)
  - resolve management target drift before executing the handoff
- [plmAuditTeamViewCatalog.spec.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/tests/plmAuditTeamViewCatalog.spec.ts)
  - lock explicit unavailable feedback for missing management targets

## Expected Outcome
- Recommended audit team-view management buttons no longer silently no-op when the underlying team view disappears.
- Recommendation apply/share/set-default/manage now all share the same feedback contract for stale targets.
