# PLM Audit Shared-Link Team Promotion Design

## Goal

After a user opens `/plm/audit` from a shared team-view link and saves that setup locally, provide an immediate path to promote the new local saved view into audit team views.

## Design

- Keep the first shared-link action local:
  - `Save as local view`
- Add a dedicated saved-view follow-up notice after local save:
  - `Save to team`
  - `Save as default team view`
  - `Done`
- Reuse the existing `promoteSavedViewToTeam(...)` flow so the new follow-up:
  - creates a team view from the local saved view
  - strips local-only scene context through the current promotion draft helper
  - hands off to the existing collaboration draft / recommendation / default-entry chain
- Highlight the newly created local saved view card until the follow-up is dismissed or promoted.

## Constraints

- The local saved view remains the first durable checkpoint.
- Team-view promotion semantics must stay identical to the existing saved-view promotion path.
- Follow-up state must clear if the saved view is deleted or promoted.
