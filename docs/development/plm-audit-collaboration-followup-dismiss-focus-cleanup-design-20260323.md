# PLM Audit Collaboration Followup Dismiss Focus Cleanup Design

Date: 2026-03-23

## Goal

Clear stale lifecycle-management and source focus when a collaboration followup is no longer active.

## Problem

`clearAuditTeamViewCollaborationFollowup()` previously removed the followup notice and cleared only source focus.

That left one visible residue:

1. a source-aware or default-promotion followup created a transient `focusedAuditTeamViewId`
2. the user dismissed the followup or a later route/action cleared it
3. the followup disappeared, but the old lifecycle-management card could remain highlighted

Once the followup is gone, that highlight no longer represents an active management handoff or source-return target.

## Design

### 1. Give collaboration-followup cleanup its own attention helper

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditClearedCollaborationFollowupAttentionState(...)`.

This helper clears:

- `focusedAuditTeamViewId`
- `focusedRecommendedAuditTeamViewId`
- `focusedSavedViewId`

The rule is simple: when the collaboration followup disappears, all transient attention anchored to that followup disappears with it.

### 2. Reuse the helper everywhere the followup is cleared

`apps/web/src/views/PlmAuditView.vue` now routes `clearAuditTeamViewCollaborationFollowup()` through that helper instead of only clearing source focus.

That automatically tightens every existing call site:

- explicit `Done`
- route incompatibility cleanup
- saved-view apply/reset flows
- shared-entry takeover and other handoffs

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `docs/development/plm-audit-collaboration-followup-dismiss-focus-cleanup-design-20260323.md`
- `docs/development/plm-audit-collaboration-followup-dismiss-focus-cleanup-verification-20260323.md`

## Expected Outcome

- dismissing a collaboration followup no longer leaves a stale team-view management highlight behind
- route-driven followup cleanup and explicit dismissal now share one cleanup contract
- transient attention semantics stay reducer-driven instead of spreading more page-local ref mutation
