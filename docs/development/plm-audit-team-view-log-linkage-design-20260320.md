# PLM Audit Team View Log Linkage Design

Date: 2026-03-20
Branch: `codex/plm-workbench-collab-20260312`

## Goal

When a user changes an audit team view lifecycle or default state, the audit page should immediately pivot to the matching audit logs instead of only showing a toast.

## Problem

Before this slice:

- `set-default / clear-default` changed the team view and stayed on the view snapshot
- `archive / restore / delete` changed local UI state only
- single-item lifecycle routes did not write collaborative audit rows, so the page had nothing reliable to filter to

## Design

### 1. Persist audit rows for single lifecycle actions

Backend now writes `operation_audit_logs` entries for single:

- `archive`
- `restore`
- `delete`

using resource type `plm-team-view-batch`, matching the existing collaborative audit taxonomy.

### 2. Build explicit audit route state after actions

A new helper `plmAuditTeamViewAudit.ts` generates route state that:

- clears `teamViewId`
- clears local scene context
- resets to page 1
- sets `q` to the affected team view id
- sets `action` and `resourceType` to the corresponding audit bucket

This is necessary because leaving `teamViewId` in the route would cause team-view refresh logic to overwrite explicit log filters.

### 3. Apply the linkage after lifecycle/default actions

Frontend actions now pivot the route after successful:

- set default
- clear default
- archive
- restore
- delete
- batch archive / restore / delete

Batch actions anchor the query to the first processed id so the matching audit row stays visible at the top of the log stream.

## Files

- `packages/core-backend/src/routes/plm-workbench.ts`
- `packages/core-backend/tests/unit/plm-workbench-routes.test.ts`
- `apps/web/src/views/plmAuditTeamViewAudit.ts`
- `apps/web/tests/plmAuditTeamViewAudit.spec.ts`
- `apps/web/src/views/PlmAuditView.vue`

## Expected Outcome

Team-view management in `/plm/audit` becomes a closed loop:

1. change team view lifecycle/default state
2. route pivots to the matching audit filter
3. user immediately sees the corresponding log evidence
