# PLM Audit Team View Collaboration Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Expose the same team-view collaboration controls inside `/plm/audit` that already exist in other PLM workbench panels:

- duplicate a team view
- rename a team view
- transfer team-view ownership
- expose direct archive / restore actions from the selected-view control row

## Rationale

`/plm/audit` already supported:

- save to team
- apply
- share
- set / clear default
- lifecycle management from the recommendation/management area

But the top-level selected-view controls still lagged behind the rest of the PLM workbench. Backend routes and the shared client already supported `duplicate / rename / transfer`, so the highest-value next step was to expose those existing collaboration capabilities instead of adding new storage or API behavior.

## Design

### Shared permissions model

The audit page now uses the existing shared helper:

- `apps/web/src/views/plm/usePlmCollaborativePermissions.ts`

That keeps action enablement aligned with other PLM surfaces for:

- `canDuplicate`
- `canRename`
- `canTransfer`
- `canArchive`
- `canRestore`
- `canDelete`
- `canShare`
- `canSetDefault`
- `canClearDefault`

### Audit view controls

`apps/web/src/views/PlmAuditView.vue` now exposes:

- selected-view row:
  - apply
  - duplicate
  - share
  - set default
  - clear default
  - delete
  - archive
  - restore
- draft-name row:
  - save to team
  - rename
- owner-transfer row:
  - transfer owner

### Behavioral rules

- duplicate applies the duplicated audit team view immediately and syncs the route
- rename keeps the selected team view active and updates the current list entry
- transfer updates the selected team view owner in-place and clears the owner draft field
- archive / restore reuse the existing lifecycle flow instead of creating a second implementation path

## Scope

Frontend-only slice:

- no federation changes
- no Yuantus changes
- no backend route changes

