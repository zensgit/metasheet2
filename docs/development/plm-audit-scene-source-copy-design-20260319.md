# PLM Audit Scene Source Copy Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Unify the wording that explains where `scene/owner` context comes from across the PLM audit experience:

- summary card
- local saved views
- team-view local-only note

The user should not see three slightly different phrasings for the same concept.

## Change

Add a shared helper:

- `apps/web/src/views/plmAuditSceneSourceCopy.ts`

This helper exposes a small surface-based copy contract:

- `summary`
- `saved-view`
- `team-view`

Each surface returns:

- `label`
- `description`

## Wiring

The helper is consumed by:

- `apps/web/src/views/plmAuditSceneSummary.ts`
- `apps/web/src/views/plmAuditSavedViewSummary.ts`
- `apps/web/src/views/plmAuditTeamViewContext.ts`
- `apps/web/src/views/PlmAuditView.vue`

## Expected UX

- Summary cards show `Local context`.
- Saved-view badges show `Saved view context`.
- Team-view note shows `Local-only context`.
- All three surfaces now communicate persistence semantics consistently.

