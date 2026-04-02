# PLM Audit Strict Notice Action Targets Design

## Background

Recent `PLM Audit` cleanup work pinned collaboration notices and shared-entry notices to canonical targets instead of the local selector.

That alignment was still incomplete in the click handlers.

## Problem

Two notice-action paths still fell back to `selectedAuditTeamView` when their canonical target disappeared:

- collaboration notice actions in `runAuditTeamViewCollaborationAction(...)`
- shared-entry notice actions through `resolvePlmAuditTeamViewShareEntryActionTarget(...)`

This leaves a mismatch window where the visible notice still describes team view `A`, but the click handler can execute on local selector `B`.

## Decision

Treat notice actions as strict canonical-target actions:

- if the canonical notice target exists, run the action against it
- if the canonical notice target is gone, do nothing and let the notice disappear through normal reactive cleanup

No fallback to the local selector is allowed.

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/tests/plmAuditTeamViewCollaboration.spec.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Key changes:

- add `resolvePlmAuditTeamViewCollaborationActionTarget(...)` and make it return only the draft target
- tighten `resolvePlmAuditTeamViewShareEntryActionTarget(...)` to return only the entry target
- update both notice handlers in `PlmAuditView.vue` to use the strict target contract

## Expected Behavior

- collaboration and shared-entry notice actions always execute on the same canonical target the notice is rendering for
- if refresh or route cleanup removes that target, the action no longer retargets another selected team view
- stale notice clicks degrade to a no-op instead of mutating the wrong team view
