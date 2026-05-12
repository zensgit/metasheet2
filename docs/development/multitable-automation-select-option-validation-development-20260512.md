# Multitable Automation Select Option Validation Development

Date: 2026-05-12
Branch: `codex/multitable-automation-select-option-validation-20260512`
Baseline: `origin/main@7a5902f92`

## Context

The previous automation condition hardening validated field existence, operator
compatibility, and primitive value types at the route boundary. Direct API
clients could still save `select` or `multiSelect` condition values that were
not present in the field's configured options.

The frontend already presents configured option pickers when `field.options`
are available, so this slice closes the backend/API gap without changing the
condition payload shape.

## Design

- `preflightAutomationConditionFields()` now reads `property` from
  `meta_fields` in addition to `id` and `type`.
- `AutomationConditionField` carries optional raw `property` data.
- The condition validator resolves option values from
  `property.options[].value` for `select` and `multiSelect` fields.
- When configured options exist, value-bearing operators must reference one of
  those option values.
- The validator reports exact nested paths such as
  `conditions.conditions[0].value[1]` for list operators.

## Compatibility

- Fields without a normalized `options` array keep the previous behavior. This
  avoids breaking historical fields or imported data that lack standardized
  option metadata.
- Empty-state operators (`is_empty`, `is_not_empty`) do not inspect option
  values.
- No migration, frontend change, or execution-time evaluator change is needed.

## Files Changed

- `packages/core-backend/src/multitable/automation-conditions.ts`
- `packages/core-backend/src/multitable/automation-service.ts`
- `packages/core-backend/tests/unit/multitable-automation-conditions.test.ts`
- `packages/core-backend/tests/integration/dingtalk-automation-link-routes.api.test.ts`

## Follow-Ups

- Person/user/link/lookup condition values still only receive primitive type
  validation. Stronger validation would require sheet/user/link target lookup
  and should be handled as a separate, narrower slice.
