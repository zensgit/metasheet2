# PLM Workbench Approval History Feedback Parity Design

## Background

`Approval Inbox` already normalizes structured backend errors for `approve` and `reject`, but
history loading still throws raw HTTP status text. When `/api/approvals/:id/history` returns a
JSON error payload, the UI degrades to low-information messages like `409 Conflict`.

## Problem

- `ApprovalInboxView.vue` uses `readApprovalInboxError(...)` for action and refresh flows.
- `loadHistory(...)` still throws ``${response.status} ${response.statusText}``.
- This creates inconsistent feedback for the same backend error contract.

## Design

1. Move response parsing into the shared `approvalInboxFeedback.ts` helper layer.
2. Export `readApprovalInboxError(...)` so both action flows and history loading use the same
   structured error resolution path.
3. Update `loadHistory(...)` to throw the normalized message instead of raw status text.
4. Lock the parity with focused unit coverage in `plmApprovalInboxFeedback.spec.ts`.

## Expected Outcome

- Approval history failures show the same structured backend messages as approve/reject.
- Invalid JSON or non-structured failures still fall back to `status statusText`.
- `ApprovalInboxView.vue` no longer carries duplicate response-error parsing logic.
