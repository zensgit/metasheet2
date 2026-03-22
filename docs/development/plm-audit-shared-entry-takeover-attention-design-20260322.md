# PLM Audit Shared-Entry Takeover Attention Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Make shared-link entry takeover the only active transient guidance when `/plm/audit` resolves a new `auditEntry=share` target.

## Problem

The recent shared-entry slices already fixed two problems:

- stale shared-entry notices could survive filter navigation
- `auditEntry=share` could survive in the URL after explicit cleanup

One UI residue still remained during same-page shared-entry takeover:

1. the page could already hold a saved-view followup notice or saved/recommended/team-view attention highlight from an earlier flow
2. `/plm/audit` could then resolve a new shared-link entry for a team view
3. the shared-entry notice would appear, but the older saved-view notice or source-management highlight could still remain visible

That left the new entry notice competing with stale transient attention from a different source.

## Design

### 1. Treat shared-entry resolution as a full transient-attention takeover

When `refreshAuditTeamViews()` resolves an explicit shared-link entry, that path should clear prior transient attention before installing the new shared-entry notice.

This includes:

- source highlights
- management highlights
- saved-view followup notice and saved-view focus

### 2. Reuse reducer-backed saved-view cleanup

`apps/web/src/views/plmAuditSavedViewAttention.ts` should add a dedicated `share-entry-takeover` cleanup action.

This keeps the saved-view followup cleanup aligned with the other takeover actions:

- `apply`
- `context-action`
- `filter-navigation`
- `promotion-handoff`
- `reset-filters`

### 3. Keep collaboration cleanup unchanged

The earlier same-view takeover cleanup for collaboration draft/followup remains in place.

This slice only extends takeover cleanup so shared-entry also clears:

- stale saved-view followup state
- stale transient focus state

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditSavedViewAttention.ts`
- `apps/web/tests/plmAuditSavedViewAttention.spec.ts`

## Expected Outcome

- a new shared-entry notice no longer coexists with old saved-view followup notices
- stale recommendation, saved-view, or management highlights do not survive a shared-entry takeover
- shared-entry remains the single active transient guidance for the current entry context

## Non-Goals

- no backend or OpenAPI changes
- no stable route contract changes
- no browser-level interaction harness changes
