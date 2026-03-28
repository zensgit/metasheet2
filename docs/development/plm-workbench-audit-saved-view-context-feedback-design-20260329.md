# PLM Workbench Audit Saved View Context Feedback Design

## Date
- 2026-03-29

## Goal
- Align `saved view` context quick actions with the rest of the audit feedback surface.
- Remove the last remaining direct silent return in saved-view context actions.

## Problem
- `runSavedViewContextAction(...)` in `PlmAuditView.vue` returned early when the saved-view context badge quick action was disabled.
- The badge model already exposed a canonical `hint`, and the UI rendered that hint below the button, but direct handler invocation still produced no explicit status feedback.
- This left saved-view context actions behind the newer parity model already used by recommendation cards, management actions, and batch actions.

## Design
- Add a pure resolver to `plmAuditSavedViewSummary.ts`:
  - `resolvePlmAuditSavedViewContextActionFeedback(...)`
- Resolver behavior:
  - no badge or no quick action -> explicit unavailable error
  - disabled quick action -> surface the badge quick-action `hint`
  - enabled quick action -> return `null`

## Implementation
- `plmAuditSavedViewSummary.ts`
  - export context-action feedback type
  - export `resolvePlmAuditSavedViewContextActionFeedback(...)`
- `PlmAuditView.vue`
  - run saved-view context actions through the resolver before route mutation
  - keep the actual context takeover logic unchanged after feedback passes
- `plmAuditSavedViewSummary.spec.ts`
  - lock disabled quick-action feedback
  - lock missing-badge unavailable feedback

## Expected Outcome
- Saved-view context quick actions now behave like the rest of the audit surface:
  - no silent return
  - the same canonical hint is used in both the UI and runtime feedback
  - route/state drift does not drop operator guidance
