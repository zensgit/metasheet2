# PLM Audit Saved View Scene Reapply Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Align saved-view scene-context quick actions with the new audit summary-card behavior.

Before this slice, saved-view context badges still mirrored the token primary action:

- owner-context badges restored scene query
- active scene-context badges pivoted to owner

That made saved-view context actions behave differently from the summary card, which now treats scene recovery as a first-class action.

## Design

### 1. Keep token actions unchanged

`plmAuditSceneToken.ts` still models the low-level local pivot actions used by:

- inline scene token
- filter highlight
- local context note

Saved-view quick actions no longer mirror that primary action blindly.

## 2. Add `reapply-scene` to the shared copy contract

`plmAuditSceneCopy.ts` now recognizes:

- `reapply-scene`

for shared labels and disabled hints.

This keeps saved-view and summary-card copy consistent.

## 3. Prefer scene reapply for scene-driven saved views

`plmAuditSavedViewSummary.ts` now emits `quickAction.kind = 'reapply-scene'` when the saved view carries a meaningful scene query target and the badge is representing:

- active owner-context with scene linkage
- active scene-context
- inactive scene-only context

Inactive owner-shortcut saved views still keep the owner-pivot quick action.

## 4. Route saved-view quick action to scene-query restore

`PlmAuditView.vue` now treats saved-view quick actions with:

- `owner` -> owner context
- `scene` or `reapply-scene` -> scene query context

This keeps saved-view quick actions aligned with the summary-card semantics without widening the rest of the route-flow logic.

## Result

Saved-view context badges now behave like stable scene-recovery entry points whenever the saved view is fundamentally scene-driven, instead of unexpectedly switching into owner-pivot behavior.
