# PLM Workbench Approval Inbox Feedback Design

## Background

`ApprovalInboxView.vue` already gained optimistic-lock version payload support, but its feedback loop still had two user-visible mismatches:

1. `performAction()` set `actionStatus`, then immediately called `refresh()`.
2. `refresh()` always cleared `actionStatus` before reloading pending approvals.
3. Non-2xx approval responses were surfaced as raw `"${status} ${statusText}"`, even when the backend returned structured JSON errors such as `APPROVAL_VERSION_CONFLICT`.

The result was that a successful approve/reject banner disappeared instantly, while stale-version or validation failures lost the backend's real message.

## Design

Introduce a tiny pure helper, `approvalInboxFeedback.ts`, with two contracts:

- `resolveApprovalInboxActionStatusAfterRefresh(currentStatus, preserveActionStatus)`
  - clears status on ordinary/manual refreshes
  - preserves the current success status on action-triggered refreshes
- `resolveApprovalInboxErrorMessage(payload, fallback)`
  - prefers `payload.error.message`
  - falls back to top-level `payload.message`
  - otherwise returns the generic HTTP fallback

`ApprovalInboxView.vue` then uses these helpers to:

- keep the success banner visible during the post-mutation refresh path
- parse backend JSON errors before throwing, so version conflicts and validation details survive to the UI

## Why This Shape

A pure helper keeps the feedback contract testable without adding Vue component mounting infrastructure. It also lets the inbox use the same structured-error behavior for both refresh and mutate flows.
