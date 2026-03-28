# PLM Workbench Audit Share Entry Feedback Design

## Date
- 2026-03-29

## Goal
- Align audit `shared-entry` follow-up actions with the explicit feedback model already used by management, batch, recommendation, and saved-view context flows.

## Problem
- `runAuditTeamViewShareEntryAction(...)` in `PlmAuditView.vue` still relied on lower-level helpers such as `duplicateAuditTeamViewEntry(...)` and `setAuditTeamViewDefaultEntry(...)` to reject invalid states.
- When the shared-entry target disappeared or became non-actionable, the handler could still silently return before any status feedback was shown.
- The `shared-entry` notice already encoded the allowed actions, but runtime fallback behavior still diverged when state drift happened after the notice was rendered.

## Design
- Add a pure `shared-entry` action resolver in `plmAuditTeamViewShareEntry.ts`:
  - `resolvePlmAuditTeamViewShareEntryActionFeedback(...)`
- Covered action kinds:
  - `save-local`
  - `duplicate`
  - `set-default`
- Resolver rules:
  - missing target -> explicit unavailable error
  - archived target -> restore-first error for local-save / duplicate / set-default
  - default target on `set-default` -> informational no-op feedback
  - non-duplicable target -> explicit duplicate denial
  - non-defaultable target -> explicit set-default denial

## Implementation
- `plmAuditTeamViewShareEntry.ts`
  - export feedback type and resolver
  - reuse collaborative permission helpers for duplicate/default checks
- `PlmAuditView.vue`
  - route `shared-entry` actions through the resolver before executing mutations
  - keep the actual save-local / duplicate / set-default success paths unchanged
- `plmAuditTeamViewShareEntry.spec.ts`
  - lock unavailable target feedback
  - lock archived/no-op feedback

## Expected Outcome
- Shared-entry actions no longer silently no-op when route/catalog drift makes the target invalid.
- Runtime feedback now matches the intended actionability contract of the share-entry notice.
