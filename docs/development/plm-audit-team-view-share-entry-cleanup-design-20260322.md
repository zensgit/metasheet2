# PLM Audit Team-View Share-Entry Cleanup Design

Date: 2026-03-22
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Keep the shared-link entry notice transient when explicit filter or pagination navigation takes over the audit page.

## Problem

The audit page already treats most transient notices as entry-time or handoff-time guidance:

- saved-view followups clear when later navigation or promotion takes over
- collaboration followups clear when the route no longer matches their contract

One entry-state banner still leaked past that boundary:

1. a user opened `/plm/audit` from a shared team-view link
2. the page raised the `Opened from a shared audit team view` notice
3. the user then applied filters, reset filters, or paged through logs
4. the shared-link entry notice could still remain visible even though the page had already pivoted into an explicit audit-navigation context

That left an entry notice behaving like durable page state.

## Design

### 1. Add a reducer-backed cleanup action for shared-link entry state

`apps/web/src/views/plmAuditTeamViewShareEntry.ts` should expose a small reducer that clears `PlmAuditTeamViewShareEntry` when explicit filter navigation takes over.

This keeps the cleanup rule testable and avoids scattering direct ref resets through `PlmAuditView.vue`.

### 2. Apply the cleanup on explicit audit navigation actions

`apps/web/src/views/PlmAuditView.vue` should run that reducer when the user:

- applies filters
- resets filters
- changes pagination

These are explicit route/navigation pivots inside `/plm/audit`, so they should retire the original shared-link entry banner.

## Files

- `apps/web/src/views/plmAuditTeamViewShareEntry.ts`
- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/tests/plmAuditTeamViewShareEntry.spec.ts`

## Expected Outcome

- shared-link entry notices disappear after explicit filter navigation takes over
- shared-link entry copy still appears when the page is first opened from a share link
- existing save-local / duplicate / set-default / dismiss behavior remains unchanged

## Non-Goals

- no backend or OpenAPI changes
- no route-key or localStorage-key changes
- no browser-level interaction harness changes
