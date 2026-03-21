# PLM Audit Team View Scene Reapply Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Align audit team-view context actions with the scene-reapply behavior already added to:

- the audit scene summary card
- saved-view scene context badges

Before this slice, the team-view local context note still mirrored raw token actions, so the three audit entry points did not expose the same scene-recovery behavior.

## Design

### 1. Keep raw token semantics unchanged

`plmAuditSceneToken.ts` still models the low-level context pivots used by:

- inline scene token
- filter highlight
- context banner

This slice does not widen token emission itself.

## 2. Promote `reapply-scene` at the team-view context surface

`plmAuditTeamViewContext.ts` now transforms token actions for the local-only team-view context note.

It emits `reapply-scene` when the note represents:

- active owner context with scene linkage
- active scene context
- inactive scene-only context

Inactive owner-shortcut context still keeps the owner-pivot action.

## 3. Let the shared scene-token handler recognize `reapply-scene`

`PlmAuditView.vue` now treats:

- `scene`
- `reapply-scene`

as the same route effect:

- restore the scene query context

This keeps team-view context actions compatible without introducing a separate execution path.

## Result

The audit page now exposes the same scene-recovery intent across:

- summary card
- saved-view badge
- team-view local context note

instead of mixing scene recovery and owner pivot semantics by entry point.
