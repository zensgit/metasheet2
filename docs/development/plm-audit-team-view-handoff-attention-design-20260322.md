# PLM Audit Team-View Handoff Attention Design

Date: 2026-03-22

## Goal

Keep `team-view handoff` as the only active transient guidance after the audit page pivots from local saved-view flow into team-view collaboration flow.

This applies to:

- `scene-context -> Save to team`
- `scene-context -> Save as default team view`
- `saved-view -> Save to team`
- `saved-view -> Save as default team view`

## Problem

The saved-view side of the page already models local followups and source focus as transient state, but the handoff into team-view collaboration did not use one shared cleanup contract.

That left one gap:

1. a local saved-view followup or old source focus could still be active
2. the user saved the same audit setup into a team view
3. the page created the team-view collaboration handoff, but the older saved-view/source attention could survive underneath it

The state looked partially updated:

- team-view collaboration controls/followup were active
- old saved-view local guidance could still remain visible
- old recommendation/saved-view source focus could still stay highlighted

## Design

### 1. Add one pure helper for team-view handoff attention

`apps/web/src/views/plmAuditSavedViewAttention.ts` now exposes `buildPlmAuditTeamViewHandoffAttentionState(...)`.

Its contract is:

- clear source focus (`focusedRecommendedAuditTeamViewId`, `focusedSavedViewId`)
- clear local saved-view followup/highlight
- preserve management focus so the new team-view handoff can immediately install its own target focus

This gives the audit page one testable rule for “team-view handoff takes over”.

### 2. Reuse the helper in both handoff entry points

`apps/web/src/views/PlmAuditView.vue` now applies the same handoff cleanup before creating collaboration state in both places:

- scene quick-save team-view/default path
- saved-view promotion path

That keeps the scene-save path aligned with the already-hardened saved-view promotion flow instead of leaving them with slightly different transient cleanup semantics.

### 3. Keep the change local to transient UI state

This slice does not change:

- route query contracts
- saved-view persistence format
- team-view API calls
- collaboration notice copy

It only tightens the takeover boundary between local saved-view guidance and team-view collaboration guidance.

## Files

- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- scene quick-save into team-view/default no longer coexists with stale local saved-view followups
- saved-view promotion and scene-save handoffs now obey the same transient-attention contract
- recommendation/saved-view source residue does not survive once team-view collaboration takes over
