# PLM Audit Recommendation Management Handoff Cleanup Design

Date: 2026-03-23

## Goal

Keep `recommendation -> team-view management` handoff aligned with the same transient-attention cleanup contract already used by scene-save and saved-view promotion handoffs.

## Problem

`focusAuditTeamViewManagement()` still created a recommendation-driven collaboration handoff directly, without first consuming prior source/local attention.

That left one remaining gap:

1. the audit page could already hold saved-view local followup/highlight or older source focus
2. the user clicked a recommended team-view card to jump into management controls
3. the collaboration handoff appeared, but stale saved-view attention could remain visible underneath it

This broke the “one active transient guidance source at a time” rule that the recent state-closure work has been enforcing elsewhere.

## Design

### 1. Reuse the existing team-view handoff attention helper

`apps/web/src/views/PlmAuditView.vue` now calls `applyAuditTeamViewHandoffAttention()` before applying the recommendation-driven collaboration handoff.

That helper already clears:

- source focus
- local saved-view followup/highlight

while preserving the management focus slot that the new handoff immediately installs.

### 2. Keep recommendation handoff semantics intact

This slice does not change:

- recommendation handoff copy
- selected team-view behavior
- route sync behavior
- followup/draft contracts

It only ensures stale saved-view/source residue does not survive once recommendation-driven management handoff takes over.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `docs/development/plm-audit-recommendation-management-handoff-cleanup-design-20260323.md`
- `docs/development/plm-audit-recommendation-management-handoff-cleanup-verification-20260323.md`

## Expected Outcome

- recommendation management handoff no longer coexists with stale saved-view local guidance
- the recommendation path now matches the same handoff cleanup model as the other team-view handoffs
