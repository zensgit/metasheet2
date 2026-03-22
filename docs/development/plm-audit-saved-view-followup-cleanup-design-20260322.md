# PLM Audit Saved-View Followup Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Keep local saved-view followups transient when a saved-view promotion handoff takes over the audit page.

## Problem

The earlier 2026-03-22 attention cleanup slice already cleared saved-view local followups when:

- `Apply saved view`
- saved-view scene-context quick actions
- `Reset filters`
- delete flows

One promotion path still leaked UI residue:

1. a shared-link local save or scene quick-save created a saved-view followup
2. the user then promoted a saved view into team views from the card actions
3. the audit page created the new team-view collaboration handoff, but the old saved-view followup could remain on screen

That left two competing transient notices active at once even though the promotion handoff had already replaced the local saved-view next step.

## Design

### 1. Extend saved-view attention with a promotion-handoff action

`apps/web/src/views/plmAuditSavedViewAttention.ts` should treat successful saved-view promotion the same way it already treats other saved-view takeovers:

- clear `shareFollowup`
- clear `focusedSavedViewId`

This keeps the cleanup contract in the reducer instead of reintroducing ad hoc UI conditionals in `PlmAuditView.vue`.

### 2. Clear saved-view attention only after promotion succeeds

`apps/web/src/views/PlmAuditView.vue` should trigger that reducer action only after `savePlmWorkbenchTeamView(...)` returns successfully.

This preserves the existing failure behavior:

- if promotion fails, the saved-view followup remains available
- if promotion succeeds, the new team-view collaboration draft/followup becomes the only active transient guidance

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- saved-view local followups disappear once any successful saved-view promotion handoff takes over
- saved-view focus does not linger under a new team-view collaboration handoff
- failed promotions do not discard the previous saved-view followup

## Non-Goals

- no backend or OpenAPI changes
- no route key or localStorage key changes
- no browser-level interaction harness changes
