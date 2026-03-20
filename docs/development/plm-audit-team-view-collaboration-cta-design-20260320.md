# PLM Audit Team View Collaboration CTA Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Turn the audit team-view collaboration draft into an actionable next-step prompt.

## Problem

After the previous slice:

- recommendation cards could prefill the collaboration controls
- saved-view promotion could prefill the collaboration controls

But users still had to infer the next step themselves. The two most valuable follow-up actions were already clear:

- copy the share link
- set the promoted/recommended team view as the default audit entry

## Design

Extend `apps/web/src/views/plmAuditTeamViewCollaboration.ts` so the helper produces:

- entry source label
- title
- description
- quick actions

Quick actions are intentionally small:

- `share`
- `set-default`
- `dismiss`

The notice renders directly inside the audit team-view controls section so users do not need to scroll or switch context again.

## Rules

- `share` is only shown when the selected team view can be shared and is not archived
- `set-default` is only shown when the selected team view can still become default
- `dismiss` is always shown
- switching to another selected team view clears the previous collaboration notice

## Scope

Frontend-only slice:

- no backend changes
- no route-contract changes
- no Yuantus/federation impact
