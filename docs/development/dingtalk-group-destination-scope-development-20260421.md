# DingTalk Group Destination Scope Development - 2026-04-21

## Background

`AutomationExecutor` supports `send_dingtalk_group_message` actions that resolve one or more DingTalk group destination IDs before sending robot messages. Those IDs can come from static action config (`destinationId` / `destinationIds`) or dynamic record fields (`destinationIdFieldPath` / `destinationIdFieldPaths`).

The execution path must not allow an automation rule from one sheet to send through a DingTalk group destination that belongs to another sheet. Without an executor-side scope check, a rule could reference a destination ID directly and bypass the intended sheet boundary.

This document covers the backend executor hardening implemented in this branch. It does not require schema, migration, or frontend changes.

## Desired Behavior

When `AutomationExecutor` executes a DingTalk group action, destination lookup should be limited to destinations visible to the rule:

- shared destinations for the current rule sheet: `sheet_id = rule.sheetId`
- legacy private destinations created before sheet scoping: `sheet_id IS NULL AND created_by = rule.createdBy`

Any destination outside that scope must behave exactly like a missing destination:

- the cross-sheet destination is not returned by the lookup
- the action step fails with a not-found style error
- no DingTalk webhook call is made for the out-of-scope destination
- error output should not reveal the destination name, webhook URL, or secret

## Design

The scope belongs in the executor destination query, not in caller-side validation. Automation actions can be triggered by scheduler, API, and future event sources, so the safety boundary needs to live where delivery is resolved.

The DingTalk group destination lookup now applies these filters together:

- `id IN (...)` for the requested destination IDs after normalization/deduplication
- `(sheet_id = rule.sheetId OR (sheet_id IS NULL AND created_by = rule.createdBy))`

The rule context should be the source of truth for `sheetId` and `createdBy`. Do not trust values from record payloads or action config for ownership checks.

Static and dynamic destination paths should share the same scoped lookup path:

- collect static destination IDs from action config
- collect dynamic destination IDs from record field paths
- normalize nested shapes such as `{ destinationId: "..." }`
- deduplicate before querying
- fail the step if any requested destination ID is missing after scoped lookup

Legacy private destinations remain supported only when they are unscoped (`sheet_id IS NULL`) and owned by the rule creator. This preserves existing private automation setups without allowing a rule creator to borrow another user's legacy destination.

The existing enabled-state validation remains after scoped lookup. A scoped but disabled destination is still reported as disabled, while an out-of-scope destination is reported as not found.

## Non-Goals

- No schema migration is required for this slice.
- No frontend destination picker changes are required.
- No change is expected for DingTalk person-message recipients.
- No partial-success delivery mode is introduced; unresolved or out-of-scope destinations should still fail the action.

## Risks

- Existing automations that intentionally referenced a destination from another sheet will start failing. That is expected and should be treated as a security hardening behavior change.
- Legacy private destinations depend on `rule.createdBy`. Rules with missing or incorrect creator metadata may lose access to legacy unscoped destinations.
- Dynamic record fields may contain stale or cross-sheet IDs. These should fail as not found, which can surface as new automation failures after rollout.
- Error messages and logs must avoid leaking details about out-of-scope destinations. Treat them as not found rather than forbidden.
- Delivery history should only be written for attempted, in-scope sends. A failed scoped lookup should not create misleading delivery records.

## Verification Expectations

This branch added or kept focused backend coverage for:

- successful send to a destination with `sheet_id = rule.sheetId`
- successful send using the same scoped lookup path
- failure when a requested destination is excluded by sheet/creator scope and therefore resolves as not found
- dynamic record destination IDs following the same scope rules

Suggested commands are listed in the companion verification note:

- `docs/development/dingtalk-group-destination-scope-verification-20260421.md`
