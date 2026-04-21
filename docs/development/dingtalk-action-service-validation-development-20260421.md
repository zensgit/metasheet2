# DingTalk Automation Service Validation Development Notes

Date: 2026-04-21

## Scope

This change moves DingTalk automation action config validation into `AutomationService`, in addition to the existing route-level validation.

Affected paths:

- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/src/routes/univer-meta.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`

## Problem

The HTTP routes already reject invalid DingTalk automation configs before persistence, but callers that use `AutomationService.createRule` or `AutomationService.updateRule` directly could still write invalid DingTalk rules.

That left a gap for internal callers, tests, scripts, or future routes that bypass the current REST handlers.

## Implementation

`AutomationService.createRule` now normalizes and validates DingTalk action inputs before inserting a rule:

- Legacy `title/content` fields are normalized to `titleTemplate/bodyTemplate`.
- Legacy single-action configs are validated through `actionType/actionConfig`.
- V1 multi-action configs are validated through `actions[]`.
- Invalid configs throw `AutomationRuleValidationError` before DB writes.

`AutomationService.updateRule` now validates the effective merged action state for PATCH semantics:

- It only reads the existing rule when `actionType`, `actionConfig`, or `actions` is being changed.
- It merges existing values with incoming values before validation.
- It catches cases where only `actionType` changes to DingTalk but the existing config is not executable.
- It validates changed V1 `actions[]` before update.
- It preserves non-action updates, so enable/name-only updates do not revalidate historical DingTalk configs.

`univer-meta` now maps `AutomationRuleValidationError` to HTTP 400 as a safety net, so future service-level validation failures are not reported as 500.

## Behavior

Service-level validation now rejects:

- DingTalk group messages without static destinations or record destination field paths.
- DingTalk person messages without local users, member groups, record recipient field paths, or record member-group field paths.
- DingTalk actions without `titleTemplate`.
- DingTalk actions without `bodyTemplate`.
- Separator-only values such as `,` or `record.`.

Route-level public form and internal view link validation remains unchanged.
