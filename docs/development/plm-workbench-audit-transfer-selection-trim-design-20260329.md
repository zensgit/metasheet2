# PLM Workbench Audit Transfer Selection Trim Design

## Problem

After a successful audit team-view transfer, the saved target may immediately become readonly in the current account. The page already cleared completed form drafts, but it still left that transferred view inside the batch-selection set.

That produced a stale management state:

- the current selector still pointed at the transferred view
- the batch selection still counted that view as selected
- batch action availability only corrected itself after later refresh/trim cycles

## Design

Reuse the existing audit ownership trimming contract immediately after transfer success:

- keep the current selector on the transferred view
- trim `selectedIds` against the latest selectable/manageable state

`PlmAuditView.vue` now calls `trimAuditTeamViewSelection(saved.id)` right after the successful transfer handoff.

## Scope

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewOwnership.spec.ts`
