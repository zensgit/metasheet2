# PLM Audit Team View Collaboration Linkage Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Reduce context switching between:

- recommended audit team-view cards
- saved-view promotion
- the selected team-view collaboration controls

## Problem

After the previous slice, `/plm/audit` exposed:

- duplicate / rename / transfer / archive / restore on the selected team view

But users still had to:

1. click a recommendation card or promote a saved view
2. manually reselect the team view
3. manually re-enter the rename draft
4. manually move back to the collaboration controls

## Design

Introduce a small collaboration draft helper:

- `apps/web/src/views/plmAuditTeamViewCollaboration.ts`

It normalizes:

- selected team-view id
- prefilled team-view name draft
- cleared owner-transfer draft
- focus target id
- status copy

## Entry points

### Recommended team-view cards

`focusAuditTeamViewManagement(...)` now:

- selects the target team view
- preloads the rename draft with the team-view name
- clears transfer-owner input
- preserves lifecycle selection
- scrolls to the main team-view controls section

### Saved view promotion

`promoteSavedViewToTeam(...)` now:

- saves the promoted team view
- selects the new team view immediately
- preloads collaboration drafts
- scrolls to the team-view controls section

## Scope

Frontend-only slice:

- no backend changes
- no Yuantus or federation changes
- no new persistence model
