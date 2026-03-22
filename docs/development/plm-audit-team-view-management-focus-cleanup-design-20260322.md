# PLM Audit Team View Management Focus Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Keep `team-view management focus` transient inside `/plm/audit` so the lifecycle list does not keep highlighting an old team view after the user has already pivoted into a different source or route context.

## Problem

The earlier management-focus slice made recommendation cards and lifecycle controls line up, but the later 2026-03-22 attention cleanup only covered:

- saved-view local followup/focus
- collaboration followup residue
- recommendation-card focus residue

One more residue remained:

- `focusedAuditTeamViewId` could survive `focus-source`, `Apply saved view`, saved-view context quick actions, `Apply filters`, `Reset filters`, and pagination changes

That left an outdated lifecycle card visually focused even though the user had already moved the interaction back to:

- a saved view
- a recommendation card
- a new audit filter/log page

## Design

### 1. Extend the attention helper to cover management focus

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes a small shared reducer for transient audit attention:

- `focusedAuditTeamViewId`
- `focusedRecommendedAuditTeamViewId`
- `focusedSavedViewId`

Supported transitions are:

- `clear-source`
- `clear-management`
- `clear-all`

This keeps the clearing rules out of `PlmAuditView.vue` conditionals and makes the cleanup semantics explicit.

### 2. Clear all transient attention when leaving the current audit source

`PlmAuditView.vue` now clears all transient attention before route/context pivots that leave the management list as the active source:

- saved-view context quick actions
- `Apply saved view`
- `Apply filters`
- `Reset filters`
- pagination changes

These actions no longer leave the old lifecycle row focused.

### 3. Clear only management focus when follow-up source navigation takes over

`focus-source` inside collaboration followups now clears only `focusedAuditTeamViewId` before restoring the source anchor/focus.

This preserves the intended source highlight:

- recommendation focus stays available for recommendation provenance
- saved-view focus stays available for saved-view provenance

while removing the stale team-view management highlight that no longer matches the current source of attention.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Scope

Frontend-only slice:

- no backend changes
- no route-contract changes
- no new persistence or API fields

## Expected Outcome

The audit page now has one consistent transient-attention rule:

- management focus belongs only to the lifecycle-management context
- source focus belongs only to the current saved-view/recommendation source
- explicit route pivots clear outdated visual anchors instead of stacking them
