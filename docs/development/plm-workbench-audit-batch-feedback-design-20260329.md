# PLM Workbench Audit Batch Feedback Design

## Date
- 2026-03-29

## Goal
- Eliminate the remaining silent-return gap in `audit team view` batch lifecycle actions.
- Keep the batch-action model as the single source of truth for availability and operator guidance.

## Problem
- `runAuditTeamViewBatchAction(...)` in `PlmAuditView.vue` returned early when the selected batch action was missing or disabled.
- The UI button state was correct, but direct handler calls and edge-path invocations produced no feedback.
- The batch model already computed canonical `hint` text, so the feedback gap was caused by the view layer bypassing that model.

## Design
- Add a pure resolver in `plmAuditTeamViewManagement.ts`:
  - `resolvePlmAuditTeamViewBatchActionFeedback(...)`
- Resolver contract:
  - returns `null` when the batch action is enabled and execution may continue
  - returns `{ kind: 'error', message }` when the batch action is missing or disabled
- Feedback source:
  - prefer the existing batch action `hint` for disabled states
  - fall back to a generic action-unavailable message when the action record is missing

## Implementation
- `plmAuditTeamViewManagement.ts`
  - export `PlmAuditTeamViewBatchActionFeedback`
  - export `resolvePlmAuditTeamViewBatchActionFeedback(...)`
- `PlmAuditView.vue`
  - replace batch-action silent return with resolver-driven `setStatus(...)`
  - keep actual batch mutation flow unchanged once feedback is `null`
- `plmAuditTeamViewManagement.spec.ts`
  - lock disabled-action feedback
  - lock missing-action fallback feedback

## Expected Outcome
- `audit team view` batch `archive / restore / delete` now behave like the rest of the management surface:
  - no silent returns
  - canonical guidance always shown
  - view logic consumes batch model output instead of duplicating availability rules
