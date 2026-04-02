# PLM Audit Team View Management Focus Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Close the gap between:

- recommended audit team view cards
- lifecycle management list

Users should be able to move from a recommended card directly into the lifecycle controls for that same team view, without manually searching for it again in the management section.

## Design

### 1. Add a management action to recommended cards

`plmAuditTeamViewCatalog.ts` now exposes a dedicated `managementActionLabel` for each recommended team view.

This keeps the recommendation helper responsible for the card's action language, alongside:

- primary action
- secondary action
- recommendation note

### 2. Keep lifecycle execution inside the management list

The recommended card does not execute archive/restore/delete directly.

Instead, it:

- selects the corresponding team view
- scrolls the lifecycle card into view
- visually highlights that management row

This avoids duplicating lifecycle buttons on recommendation cards and preserves one clear location for destructive actions.

### 3. Align recommendation and management state

When the user clicks the new management action:

- `auditTeamViewKey` switches to that team view
- selectable rows are auto-selected in the batch manager
- the management card receives a focused highlight

This makes the team-view dropdown, recommended cards, and lifecycle manager agree on the same target.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewCatalog.ts`
- `apps/web/tests/plmAuditTeamViewCatalog.spec.ts`

## Expected Outcome

Recommended audit team view cards become an entry point into lifecycle management, not just apply/share/default actions.
