# PLM Workbench Audit Transfer Draft Cleanup Design

## Problem

`audit team view transfer` still only cleared the owner input on success. If the page carried a create-mode or rename draft at the same time, that stale draft remained attached to the next canonical target even though transfer is a completed management mutation.

This differs from passive route takeover behavior, which may preserve ownerless drafts.

## Design

Introduce a dedicated transfer cleanup contract:

- `resolvePlmAuditTransferActionTeamViewFormDraftState(...)`

This always resolves to completed lifecycle cleanup. `PlmAuditView.vue` now uses that contract after successful `transferPlmWorkbenchTeamView(...)` for audit team views.

## Scope

- `apps/web/src/views/plmAuditTeamViewOwnership.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`
