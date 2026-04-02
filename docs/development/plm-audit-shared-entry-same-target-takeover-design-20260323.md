# PLM Audit Shared Entry Same-Target Takeover Design

## Background

`shared-entry` takeover is valid only when a source-aware action is still acting on the same team view that owns the active shared-entry notice.

That rule was already enforced for local saves, but management handoffs and source-aware collaboration actions were still using a broader `Boolean(entry)` check.

## Problem

With the broader check, `/plm/audit?teamViewId=A&auditEntry=share` could incorrectly lose ownership when the user acted on a different team view `B`:

- recommendation `Manage audit team views`
- recommendation/source-aware `Share`
- recommendation/source-aware `Set default`

The page would clear the shared-entry owner for `A` and consume `auditEntry=share`, even though the action target was `B`.

That creates a broken transient handoff:

- `A` loses its shared-entry notice
- the route still belongs to `A`
- the new `B` draft/followup can then be cleared immediately by canonical route guards

## Decision

Use the same rule everywhere:

- shared-entry takeover only applies when the current action target still matches the shared-entry owner

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

Key changes:

- make `shouldTakeOverPlmAuditSharedEntryOnManagementHandoff(...)` require `targetTeamViewId`
- make `shouldTakeOverPlmAuditSharedEntryOnSourceAction(...)` require `targetTeamViewId`
- implement both helpers via `shouldKeepPlmAuditTeamViewShareEntry(...)`
- pass `target.id` / `view.id` from the page call sites

## Expected Behavior

- `shared-entry A + action on B` no longer consumes `A`
- `shared-entry A + action on A` still performs takeover and query cleanup
- local-save, management-handoff, and source-aware collaboration actions now share one consistent ownership rule
