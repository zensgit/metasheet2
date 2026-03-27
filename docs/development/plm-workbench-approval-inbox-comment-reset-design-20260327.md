# PLM Workbench Approval Inbox Comment Reset Design

## Background

`Approval Inbox` and `PLM Product View` both let users approve or reject items with an optional/required comment. `PlmProductView.vue` already clears the local approval comment after a successful mutation, but `ApprovalInboxView.vue` did not.

That left a real behavior gap:

- after a successful reject, the stale reason stayed in the input
- the next approve would silently send that old reject reason as an approve comment
- the next reject could silently reuse the previous approval's reason

## Design

Keep the fix minimal and local to the success path of `performAction(...)`:

1. Preserve the current optimistic-lock, error, and refresh flow.
2. Clear `comment.value` immediately after the success status message is set.
3. Do not clear the comment on failure or conflict, so users can retry with the same text if needed.

## Expected Outcome

`Approval Inbox` now matches `PLM Product View`:

- successful approve/reject consumes the current comment
- failed or conflicted actions preserve the draft comment for retry
- stale reject reasons are no longer carried into later approvals
