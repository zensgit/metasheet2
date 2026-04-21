# DingTalk Automation Service Link Validation Development Notes

Date: 2026-04-21

## Scope

This change moves DingTalk automation public-form and internal-view link validation into `AutomationService`.

Affected paths:

- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/tests/unit/automation-v1.test.ts`

## Problem

The HTTP automation routes already validate DingTalk public form and internal processing links before persistence. However, direct service callers could still bypass those route checks and persist rules that reference missing, disabled, expired, or cross-sheet views.

This was the remaining service-layer gap after adding service-level DingTalk action config validation.

## Implementation

`AutomationService.createRule` now runs `validateDingTalkAutomationLinks` after config validation and before DB insert.

`AutomationService.updateRule` now validates the effective merged action state when action fields change:

- `actionType`
- `actionConfig`
- `actions`

The update path still avoids link validation for unrelated PATCH operations such as name or enabled changes. This preserves the existing behavior that allows toggling or renaming historical rules without revalidating view state.

Validation failures throw `AutomationRuleValidationError`, which is already mapped to HTTP 400 by the route layer.

## Behavior

Service-level callers now reject DingTalk rules that reference:

- Missing public form views.
- Public links that point to non-form views.
- Disabled or unshared public form views.
- Expired public form views.
- Missing internal processing views.

The validation uses the service `queryFn`, so it applies to both legacy single-action configs and V1 `actions[]`.
