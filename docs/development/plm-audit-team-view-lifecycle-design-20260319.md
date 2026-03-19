# PLM Audit Team View Lifecycle Design

Date: 2026-03-19
Branch: `codex/plm-workbench-collab-20260312`

## Goal

Extend `/plm/audit` from a team-view apply/share/default entry into a full lifecycle workspace that supports:

- single-item archive / restore / delete
- batch archive / restore / delete
- explicit management of active vs archived audit team views without leaving the audit workbench

## Design

### 1. Keep existing top-row actions for focused operations

The existing select row remains the place for:

- apply
- share
- set default
- clear default
- delete

This preserves the direct flow for one chosen team view.

### 2. Add a dedicated lifecycle management block

A new management block sits below the recommendation area and save-to-team row. It provides:

- bulk selection of manageable team views
- batch action toolbar
- per-view lifecycle buttons on each card

This separates "open/use a team view" from "manage the lifecycle of team views".

### 3. Centralize lifecycle eligibility in a pure helper

`plmAuditTeamViewManagement.ts` becomes the single source for:

- whether a team view is selectable for lifecycle operations
- which row-level lifecycle buttons should be shown
- which batch actions are currently eligible
- operator-facing hints when a view is read-only or a batch action has no eligible items

This avoids duplicating archive/restore/delete permission logic in `PlmAuditView.vue`.

### 4. Route-state safety

When the currently selected audit team view is archived or deleted:

- clear `teamViewId` from the route state
- keep the current filter state in place
- avoid leaving the page deep-linked to an inactive team view

### 5. Batch action behavior

Use the existing backend/client batch endpoints:

- `archive`
- `restore`
- `delete`

Frontend behavior:

- archive/delete clears processed IDs from selection
- restore keeps the restored items selected so users can immediately continue with the next management step
- skipped IDs remain visible and can remain selected for follow-up action

## Files

- `apps/web/src/views/PlmAuditView.vue`
- `apps/web/src/views/plmAuditTeamViewManagement.ts`
- `apps/web/tests/plmAuditTeamViewManagement.spec.ts`

## Expected Outcome

`/plm/audit` should now support the full lifecycle loop for audit team views:

1. create/promote
2. recommend/default
3. batch manage
4. archive/restore/delete

without forcing users into another page or admin-only screen.
