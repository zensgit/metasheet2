# PLM Audit Shared-Link Recommendation Handoff Design

## Goal

After a shared audit team-view link is saved locally and then promoted into team views, automatically connect the new team view into the existing recommendation/default entry system.

## Design

- Reuse the existing audit team-view recommendation model in `plmAuditTeamViewCatalog.ts`.
- Add a small helper to resolve which recommendation bucket a team view belongs to:
  - `default`
  - `recent-default`
  - `recent-update`
- When `saved view -> team view` promotion is triggered from the shared-link follow-up:
  - keep the existing collaboration draft behavior
  - switch the recommendation chip filter to the new team view's bucket
  - highlight the new recommended card
  - scroll to `#plm-audit-recommended-team-views`
- For promotions from all other entry points, keep the previous behavior and scroll to the collaboration controls.

## Constraints

- Do not fork a second promotion flow; continue to reuse `promoteSavedViewToTeam(...)`.
- Do not break the existing recommendation actions or collaboration draft flow.
- Recommended-card focus is view-local UI state and should clear if the underlying team view disappears.
