# PLM Audit Team View Name Draft Ownership Design

## Background

`PLM Audit` currently uses one input for two different actions:

- `Save to team`
- `Rename`

The previous canonical-owner cleanup treated both the team-view name draft and the transfer-owner draft as the same owner-scoped form state.

## Problem

When canonical team-view ownership changes, `resolvePlmAuditCanonicalTeamViewFormDraftState(...)` clears:

- `auditTeamViewName`
- `auditTeamViewOwnerUserId`

Clearing the owner transfer draft is correct.

Clearing the name draft is not, because the user may be typing a valid `Save to team` name rather than a rename. In that case a route/followup/shared-entry owner pivot silently discards user input.

## Decision

Split the semantics of the shared name input:

- preserve the text draft itself across canonical owner changes
- separately track which canonical owner last authored that name draft
- allow `Rename` only when the name draft still belongs to the current canonical owner
- keep `Save to team` available regardless of owner pivots

This preserves create/save intent without letting a stale rename draft hit the wrong team view.

## Implementation

Files:

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewOwnership.ts`
- `apps/web/src/views/plmAuditTeamViewControlTarget.ts`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`
- `apps/web/tests/plmAuditTeamViewControlTarget.spec.ts`

Key changes:

- add `auditTeamViewNameOwnerId` in `PlmAuditView.vue`
- stamp that owner id whenever the name input is typed or programmatically seeded by a collaboration handoff
- preserve `draftTeamViewName` across canonical owner changes, while still clearing `draftOwnerUserId`
- extend refresh trimming to carry `draftTeamViewNameOwnerId`
- gate `Rename` with `shouldEnablePlmAuditTeamViewRenameAction(...)`

## Expected Behavior

- `Save to team` name drafts survive canonical owner pivots
- transfer-owner drafts still clear on owner pivots
- `Rename` stays disabled once a preserved name draft no longer belongs to the current canonical owner
- typing again under the new canonical owner reclaims the draft for rename
