# PLM Audit Team View Share Provenance Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make share follow-up state explain where the copied link came from and let the user return to that source immediately.

## Problem

The previous follow-up-action slice added explicit next steps after collaboration share:

- `Set as default`
- `Done`

But the UI still lost the source trail after copy:

- recommendation-driven share did not offer a quick way back to the recommendation cards
- saved-view-promotion share did not offer a quick way back to the saved-view area
- provenance was implied by the small source label, but not reflected in the actual follow-up actions

## Design

Extend `apps/web/src/views/plmAuditTeamViewCollaboration.ts` so share follow-up state carries:

- `sourceAnchorId`
- a source-aware description
- a `focus-source` action

Then wire `apps/web/src/views/PlmAuditView.vue` so:

- recommendation-driven share follow-up can scroll back to `#plm-audit-recommended-team-views`
- saved-view-promotion share follow-up can scroll back to `#plm-audit-saved-views`

## Behavior

- share follow-up keeps `Set as default` when still allowed
- recommendation share adds `Back to recommendations`
- saved-view-promotion share adds `Back to saved views`
- default-promotion follow-up remains unchanged and still prioritizes `Review audit logs`

## Scope

Frontend-only slice:

- no backend changes
- no route-contract changes
- no federation or Yuantus changes
