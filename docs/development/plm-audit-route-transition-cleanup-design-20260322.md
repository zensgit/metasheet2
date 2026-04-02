# PLM Audit Route-Transition Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Close the remaining gap between modeled audit route transitions and transient PLM audit UI state.

## Problem

Two cleanup gaps still remained after the earlier shared-entry consumption slice:

1. `Apply` on a shared entry could clear the local notice but leave `auditEntry=share` in the URL when the selected team view was already canonical
2. saved-view followup/attention state could survive generic modeled-route pivots because the main `route.query` watcher only cleaned collaboration followups, not saved-view attention

That left transient UI residue alive after the page had already pivoted into a different audit context.

## Design

### 1. Make shared-entry route-sync decisions explicit

`apps/web/src/views/plmAuditTeamViewShareEntry.ts` should expose a small helper for deciding when shared-entry cleanup must still force a route sync.

This keeps the rule out of `PlmAuditView.vue`:

- if the modeled audit route changed, sync normally
- if the modeled audit route did not change but the caller explicitly wants to consume `auditEntry=share`, still sync with `replace`

### 2. Let `Apply` consume stale shared-entry markers

`applyAuditTeamViewEntry()` should pass `consumeSharedEntry: true` into the shared route-sync helper path.

This ensures the shared-entry banner and the URL are consumed together.

### 3. Clear saved-view attention on real modeled-route pivots

Inside the main `route.query` watcher, when `PlmAuditRouteState` actually changes, clear the saved-view attention slice before applying the next route state.

This keeps saved-view followup/highlight cleanup aligned with the existing collaboration-followup cleanup behavior.

The guard is important:

- modeled-route changes should clear the stale saved-view attention
- share-marker-only cleanup should not clear a freshly created saved-view followup

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- applying a shared-entry team view consumes the shared marker even when the stable audit state was already canonical
- saved-view followup/highlight state no longer leaks across scene/team-view/browser route pivots
- transient UI state stays aligned with the modeled audit route

## Non-Goals

- no backend or OpenAPI changes
- no changes to the stable `PlmAuditRouteState` contract
- no browser-level interaction harness changes
