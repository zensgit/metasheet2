# PLM Audit Local Team-View Pivot Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make local team-view pivots consume stale saved-view attention even when they update local route state before the router watcher runs.

## Problem

The recent route-transition cleanup slice taught the main `route.query` watcher to clear saved-view attention on real modeled-route pivots.

One local pivot gap still remained:

- `Apply` and `Duplicate` both update local audit state before calling `syncRouteState(...)`
- by the time the router watcher observes the new query, `readCurrentRouteState()` already matches it
- the watcher therefore sees no modeled-route delta and skips its saved-view attention cleanup

That lets a saved-view followup or saved-view highlight survive after the page has already pivoted into a different team-view context.

## Design

### 1. Treat local team-view pivots as saved-view attention takeovers

`Apply` and `Duplicate` should explicitly run the existing saved-view `apply` cleanup before they install the next team-view route state.

### 2. Reuse the existing reducer contract

Do not add a new reducer action for this slice.

The existing `apply` action in `apps/web/src/views/plmAuditSavedViewAttention.ts` already means:

- clear saved-view followup
- clear saved-view focus

This slice just wires that cleanup into the missing local pivot paths.

### 3. Keep source-focus clearing aligned with the pivot

`Duplicate` should also clear source focus before applying the duplicated team-view state, so the new view does not inherit stale recommendation/saved-view highlight residue from the previous context.

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

## Expected Outcome

- saved-view followup/highlight no longer survives `Apply`
- saved-view followup/highlight no longer survives `Duplicate`
- local team-view pivots stay consistent with the existing route-watcher cleanup semantics

## Non-Goals

- no backend or OpenAPI changes
- no new route keys
- no browser-level interaction harness changes
