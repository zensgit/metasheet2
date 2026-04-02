# PLM Workbench Audit Recommendation Feedback Design

## Date
- 2026-03-29

## Goal
- Align the recommended audit team view card handlers with the rest of the audit management surface.
- Remove silent returns from direct `apply / share / set-default` recommendation actions.

## Problem
- `applyRecommendedAuditTeamView(...)` and `runRecommendedAuditTeamViewSecondaryAction(...)` in `PlmAuditView.vue` still returned early when the underlying team view was missing, archived, or no longer actionable.
- The card buttons were usually disabled correctly, but direct handler invocation and state drift after refresh still produced no feedback.
- This created a runtime gap relative to the now-explicit feedback model used by audit team view management and batch actions.

## Design
- Add a pure recommendation action resolver in `plmAuditTeamViewCatalog.ts`:
  - `resolvePlmRecommendedAuditTeamViewActionFeedback(...)`
- Resolver covers:
  - `apply`
  - `share`
  - `set-default`
- Resolver rules:
  - missing target -> explicit unavailable error
  - archived target -> restore-first error for `apply / share / set-default`
  - non-actionable live target -> explicit cannot-apply/share/set-default feedback
  - already-default `set-default` -> informational no-op feedback

## Implementation
- `plmAuditTeamViewCatalog.ts`
  - export recommendation feedback types
  - export `resolvePlmRecommendedAuditTeamViewActionFeedback(...)`
- `PlmAuditView.vue`
  - route recommendation handlers through the pure resolver before mutation
  - keep existing success path unchanged after feedback passes
- `plmAuditTeamViewCatalog.spec.ts`
  - lock missing/apply/share/set-default feedback outcomes

## Expected Outcome
- Recommended audit team view cards now match the audit management surface:
  - no silent returns
  - restore-first semantics are explicit
  - recommendation handlers tolerate route/catalog drift without dropping user feedback
