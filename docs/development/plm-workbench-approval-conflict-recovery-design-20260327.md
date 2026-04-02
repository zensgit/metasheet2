# PLM Workbench Approval Conflict Recovery Design

## Background

`Approval Inbox` already sends optimistic-lock `version` for `approve/reject`, and the backend
returns `APPROVAL_VERSION_CONFLICT` with `error.currentVersion` on stale requests.

## Problem

- `ApprovalInboxView.vue` currently turns non-OK action responses into plain error strings.
- The client ignores `error.currentVersion`.
- Failed actions do not refresh inbox state.

This means a stale row can keep its old `version` in the table and repeat `409` until the user
manually clicks `Refresh`.

## Design

1. Extend the shared approval feedback helper to expose structured error metadata:
   - `code`
   - `currentVersion`
   - `message`
2. Reuse that helper in `ApprovalInboxView.vue` for approve/reject failures.
3. On `APPROVAL_VERSION_CONFLICT`:
   - reconcile the stale row version locally with `currentVersion`
   - trigger `refreshInboxState()` to recover canonical pending/history state
   - preserve the conflict message when refresh succeeds
4. Keep non-conflict failures on the existing string error path.

## Expected Outcome

- Repeated `409` loops are broken without requiring manual refresh.
- If the approval is still pending, the row version is updated to the latest value.
- If another actor already resolved the approval, refresh removes it from the pending table.
