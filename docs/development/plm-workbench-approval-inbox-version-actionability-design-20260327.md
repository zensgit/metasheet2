# PLM Workbench Approval Inbox Version Actionability Design

## Background

`Approval Inbox` already enforced optimistic locking in the action payload builder, but the view still treated every pending row as actionable until the click path discovered that `version` was missing. That left a UX gap:

- the pending list could still show enabled `Approve` / `Reject` buttons for rows whose optimistic-lock version was absent or malformed
- the version column rendered the raw value instead of the resolved canonical version label
- conflict recovery already relied on the shared version helper, but the table did not

## Design

Align `ApprovalInboxView.vue` with the same local contract already used by the action payload builder:

1. Keep inbox row typing compatible with `reconcileApprovalInboxConflictVersion(...)` by treating `version` as an optional string-or-number field instead of allowing `null`.
2. Reuse shared helpers from `approvalInboxActionPayload.ts`:
   - `formatApprovalInboxVersion(...)` for the pending version column
   - `canActOnApprovalInboxEntry(...)` for pending row actionability
3. Gate `Approve` / `Reject` buttons on resolved optimistic-lock availability so rows with no usable version become visibly non-actionable before the user clicks.

## Expected Outcome

`Approval Inbox` now localizes the optimistic-lock contract at render time:

- the version column always shows the resolved canonical version or `-`
- rows without a valid version no longer expose clickable mutation buttons
- conflict recovery keeps working with the same shared version semantics
