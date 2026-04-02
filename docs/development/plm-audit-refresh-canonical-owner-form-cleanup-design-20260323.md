# PLM Audit Refresh Canonical Owner Form Cleanup Design

## Background

`233dc7970 fix(plm-audit): clear refresh form residue` already clears rename/transfer drafts when refresh removes the locally selected team view.

One ownership path still sat outside that cleanup: the canonical management owner recovered from route/follow-up state when the local selector is empty.

## Problem

On log or follow-up routes, `PlmAuditView.vue` can keep management controls bound to a canonical team view even when `auditTeamViewKey` is empty.

If refresh removes that canonical owner:

- transient collaboration/share-entry ownership gets pruned
- local selector stays empty
- but `auditTeamViewName` and `auditTeamViewOwnerUserId` can still keep stale drafts from the removed team view

That leaves dead form residue in rename/transfer inputs even though the backing team view is gone.

## Decision

Treat refresh trimming as ownership-aware:

- if a local selector exists, it still owns the drafts
- otherwise the canonical management owner owns the drafts
- if that owner disappears on refresh, clear the drafts
- if there is no selected/canonical owner, preserve create-mode drafts

## Implementation

Files:

- `apps/web/src/views/plmAuditTeamViewOwnership.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`

Key changes:

- extend `trimPlmAuditExistingTeamViewUiState(...)` with `managedTeamViewId`
- preserve drafts based on the active owner:
  - selected team view first
  - canonical management owner second
  - create mode last
- capture the canonical owner id before refresh-driven transient ownership pruning so the trim step can still clear drafts for a just-removed owner

## Expected Behavior

- refresh removing a follow-up/share-entry owned team view clears stale rename/transfer drafts even when the local selector is empty
- refresh removing a different canonical owner does not wipe drafts for an existing local selector
- create-mode drafts remain intact when no managed owner exists
