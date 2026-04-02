# PLM Audit Team View Collaboration Follow-Up Actions Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Turn audit team-view collaboration success states into explicit next-step actions.

## Problem

The previous slice made CTA feedback source-aware, but it still relied on transient status text:

- after `Copy share link`, users still had to infer the next best action
- after `Set as default`, the route moved to matching audit logs, but the page did not present a persistent follow-up entry point

## Design

Extend `apps/web/src/views/plmAuditTeamViewCollaboration.ts` with a follow-up notice model:

- `PlmAuditTeamViewCollaborationFollowup`
- `buildPlmAuditTeamViewCollaborationFollowupNotice(...)`

Then wire `apps/web/src/views/PlmAuditView.vue` so CTA flows produce a structured follow-up block:

- after `share`
  - show `Share link copied`
  - offer `Set as default` when still allowed
  - offer `Done`
- after `set-default`
  - show `Default audit entry updated`
  - offer `Review audit logs`
  - offer `Done`

## Behavior

- follow-up notice is tied to the selected team-view id
- switching to another team view clears the previous follow-up
- successful `set-default` keeps the user in the audit-log route and scrolls to the log results
- successful `share` keeps the user in the team-view controls section and promotes the next likely action

## Scope

Frontend-only slice:

- no backend changes
- no route-contract changes
- no federation or Yuantus changes
