# PLM Audit Shared-Link Local Save Design

## Goal

Let `/plm/audit` team-view share entries provide an immediate `Save as local view` action so a user can retain the shared audit setup without first duplicating it into a team workflow.

## Design

- Extend the shared-link entry action model in `apps/web/src/views/plmAuditTeamViewShareEntry.ts` with `save-local`.
- Make `Save as local view` the primary action for active shared audit team views.
- Generate a deterministic local saved-view name from the shared team-view name:
  - `<team view name> · Local view`
- Handle the action in `apps/web/src/views/PlmAuditView.vue` by:
  - saving the current route state with `savePlmAuditSavedView(...)`
  - clearing the shared-link entry prompt
  - emitting a localized success status
  - scrolling the user to `#plm-audit-saved-views`

## Constraints

- The saved local view must preserve the current route state exactly as seen from the shared entry.
- This action must stay local-only and must not create or mutate a team view.
- Archived shared team views still omit the action.
