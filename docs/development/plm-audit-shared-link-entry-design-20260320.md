# PLM Audit Shared Link Entry Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make `/plm/audit` explicitly acknowledge when the user entered through a shared team-view link.

## Problem

Before this slice:

- audit team-view share URLs only encoded `auditTeamView`
- `/plm/audit` silently applied the team view
- users had no clear indication that they were looking at a shared team view
- there was no guided next step for consuming a shared entry

## Design

Add a lightweight frontend-only marker to audit share URLs:

- `auditEntry=share`

Then add a dedicated shared-entry helper:

- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`

When `/plm/audit` resolves an explicit `auditTeamView` with `auditEntry=share`, show a shared-entry notice with:

- `Duplicate for my workflow`
- `Set as default` when still valid
- `Dismiss`

## Rules

- this notice only appears for explicit shared-link entry
- internal route transitions do not create the shared-entry notice
- switching away from the shared team view clears the notice
- duplicate and default actions reuse existing team-view flows rather than adding new mutations

## Scope

Frontend-only slice:

- no backend changes
- no federation or Yuantus changes
