# Multitable Automation Condition Value Widgets Development - 2026-05-11

## Context

PR #1472 filtered automation condition operators by selected field type, but the
condition value control was still a generic text input. That left two practical
authoring gaps:

- numeric fields could show comparison operators while still saving string
  values, which do not satisfy the backend numeric comparison evaluator;
- boolean/select-like fields required hand-typing values instead of choosing from
  the available field metadata.

This slice keeps the existing automation condition payload shape and improves
frontend authoring only.

## Scope

Implemented:

- Numeric condition fields render `<input type="number">` and serialize saved
  values as finite numbers.
- Boolean condition fields render a true/false select and serialize saved values
  as booleans.
- Date condition fields render `<input type="date">`.
- DateTime/system-time condition fields render `<input type="datetime-local">`.
- Select and multiSelect fields with configured options render option pickers.
- `in` / `not_in` conditions over option-backed fields render a multi-select and
  preserve array payloads.
- Existing comma-separated list fallback remains for fields without configured
  options.
- Invalid/empty numeric and boolean values keep the Save button disabled through
  the existing condition completeness gate.

Not implemented:

- Backend field-aware semantic validation.
- Async option hydration for person/link/lookup fields.
- Full nested condition group authoring.
- Timezone normalization for `datetime-local`; the value is preserved as the
  browser-provided local datetime string.

## Design Decisions

### Keep Payload Shape Stable

The backend condition parser already accepts `unknown` values and only requires
arrays for `in` / `not_in`. This change only improves the draft editor and final
payload coercion:

- number-like fields produce `number`;
- boolean fields produce `boolean`;
- date/select/text fields produce trimmed strings;
- list operators produce arrays.

### Prefer Field Metadata When Already Present

The editor receives `fields` in props. For select and multiSelect fields that
already include `options`, the value control uses those options. If options are
missing, the editor falls back to the previous text input path rather than
blocking rule authoring.

### No Backend Coupling In This Slice

The backend evaluator remains generic. This keeps the slice frontend-only and
avoids introducing field lookup into the automation runtime path.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Follow-Ups

- Add backend field-aware validation if automation rules start accepting rules
  from non-UI API clients at higher volume.
- Add async pickers for person/link/lookup/rollup fields once those option
  sources are standardized for automation.
- Add browser smoke coverage after the automation editor gets a stable page-level
  route fixture.
