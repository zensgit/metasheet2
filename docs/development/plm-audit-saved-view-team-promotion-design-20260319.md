# PLM Audit Saved View Team Promotion Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Add a direct path from local audit saved views to shared audit team views so users can:

- keep a local audit snapshot
- elevate it into a team-visible audit view
- optionally elevate it as the default team audit view

## Scope

Frontend and client-only slice:

- reuse existing `POST /api/plm-workbench/views/team`
- expose optional `isDefault` in the client
- add saved-view card actions in `/plm/audit`
- clearly explain that `scene/owner` context remains local and is not persisted into the team view snapshot

## Design

### Promotion draft

New helper:

- [plmAuditSavedViewPromotion.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/plmAuditSavedViewPromotion.ts)

Responsibilities:

- convert a `PlmAuditSavedView` into a team-view save draft
- strip route-only local context by using `buildPlmAuditTeamViewState(...)`
- emit a local-context note when `sceneId / sceneName / sceneOwnerUserId` exist

### Client contract

- [plmWorkbenchClient.ts](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/services/plm/plmWorkbenchClient.ts)

`savePlmWorkbenchTeamView(...)` now accepts optional `{ isDefault?: boolean }`, which is passed through to the existing backend route.

### Audit view UX

- [PlmAuditView.vue](/Users/huazhou/Downloads/Github/metasheet2-plm-workbench/apps/web/src/views/PlmAuditView.vue)

Each local saved-view card now supports:

- `Apply`
- `Save to team`
- `Save as default team view`
- `Delete`

Promotion behavior:

- the local saved-view name is reused as the team-view name
- the promoted state stores only team-view route filters
- if the local saved view carries `scene/owner` context, the card shows a note before promotion and the status message repeats that note after promotion
- promoting as default updates the in-memory team-view list so only one audit team view remains marked default

## Why this is better

- closes the gap between local audit exploration and team collaboration
- does not require new backend schema or routes
- makes the local-only nature of `scene/owner` context explicit instead of silently dropping it
