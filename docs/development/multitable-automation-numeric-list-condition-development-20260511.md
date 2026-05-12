# Multitable Automation Numeric List Condition Development - 2026-05-11

## Context

Backend condition validation now accepts numeric list operators only when every
entry can be interpreted as a finite number. The frontend still serialized
numeric `in` / `not_in` condition values through the generic comma-list parser,
which produced string arrays such as `["1", "2"]`.

That payload passes JSON shape validation but does not match the runtime
evaluator's strict equality check for numeric record values. A record value `1`
will not match a condition list entry `"1"`.

## Scope

Implemented:

- Numeric fields using `in` / `not_in` now render a text input, not
  `<input type="number">`, so comma-separated lists are actually authorable.
- Numeric list values are parsed into finite `number[]` payloads during save.
- Invalid numeric list entries keep the Save button disabled.
- Existing scalar numeric operators still use `<input type="number">`.
- Non-numeric list operators keep the existing string-array behavior.

Not implemented:

- No backend changes.
- No evaluator changes.
- No async option hydration for person/link/lookup fields.
- No browser smoke.

## Design Decisions

### Coerce At Payload Boundary

Draft state remains compatible with the existing editor input model. Coercion
happens only when building the API payload, where scalar numeric values were
already converted.

### Text Input For Numeric Lists

Comma-separated lists cannot be represented with `type="number"`. The list
operator path uses a text input with the existing "Comma-separated values"
placeholder, then validates each entry with the same finite-number parser used
for scalar numeric values.

### Disable Save On Partial Invalid Lists

The editor does not silently drop invalid list entries. If any entry fails
numeric parsing, the condition is incomplete and Save remains disabled.

## Files Changed

- `apps/web/src/multitable/components/MetaAutomationRuleEditor.vue`
- `apps/web/tests/multitable-automation-rule-editor.spec.ts`

## Follow-Ups

- Add boolean `in` / `not_in` authoring if product wants multi-value boolean
  conditions; today boolean equality remains the practical UI path.
- Add async option/value validation for person/link/lookup once those option
  sources are standardized.
