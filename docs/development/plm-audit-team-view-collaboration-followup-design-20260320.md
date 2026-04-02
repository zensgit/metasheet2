# PLM Audit Team View Collaboration Follow-Up Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make the audit team-view collaboration CTA flow feel complete after the user clicks it.

## Problem

The previous collaboration CTA slice exposed the right next actions:

- `Copy share link`
- `Set as default`
- `Done`

But the follow-up feedback was still generic:

- `Copy share link` only showed the plain team-view copy status
- `Set as default` already jumped to matching audit logs, but the status message did not explain that the action came from a recommended or promoted team view
- successful default promotion left the collaboration draft visible even though the user had already moved into the audit-log follow-up flow

## Design

Extend `apps/web/src/views/plmAuditTeamViewCollaboration.ts` with a source-aware action status helper:

- `buildPlmAuditTeamViewCollaborationActionStatus(source, action, tr)`

Use it from `apps/web/src/views/PlmAuditView.vue` so:

- share from a recommendation says the copied link came from the recommended team view
- share from saved-view promotion says the copied link came from the promoted team view
- set-default from either source says the selected source is now default and matching audit logs are shown

## Behavior

- `share` keeps the collaboration draft visible, because `Set as default` is still a likely next step
- `set-default` clears the collaboration draft after a successful mutation, because the flow has moved into audit-log follow-up
- failures still use the existing generic error messages

## Scope

Frontend-only slice:

- no backend changes
- no route-contract changes
- no federation or Yuantus changes
