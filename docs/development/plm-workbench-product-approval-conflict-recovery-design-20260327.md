# PLM Workbench Product Approval Conflict Recovery Design

## Background

`Approval Inbox` already recovers from `APPROVAL_VERSION_CONFLICT` by parsing
`error.currentVersion`, reconciling the stale row locally, and refreshing the inbox.

`PLM Product View` approval actions still lag behind that contract.

## Problem

- Product-page `approve/reject` only surface `error.message`.
- The SDK currently collapses structured approval errors into plain `Error`.
- A stale approval row keeps its old `version`, so repeated clicks can loop on `409` until the
  user manually refreshes approvals.

## Design

1. Preserve structured `ApiEnvelope.error` metadata in `packages/openapi/dist-sdk/client.ts`
   instead of throwing plain `Error(message)`.
2. Keep that metadata intact through the localized federation client and `PlmService`.
3. Extend the shared approval feedback helper with `resolveApprovalInboxThrownErrorRecord(...)`
   so product-page approval actions can reuse the same conflict parsing path as `Approval Inbox`.
4. On `APPROVAL_VERSION_CONFLICT` in `PlmProductView.vue`:
   - reconcile the row version with `currentVersion`
   - reload approvals
   - reload approval history if the conflicted approval is currently selected
   - preserve the conflict message after refresh

## Expected Outcome

- Product-page approval actions recover from stale versions without manual refresh.
- Conflict metadata survives the SDK/service boundary.
- `Approval Inbox` and product-page approvals now share one conflict-recovery contract.
