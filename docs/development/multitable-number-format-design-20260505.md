# Multitable Number Format Design - 2026-05-05

## Context

`docs/development/multitable-feishu-rc-todo-20260430.md` keeps `Number format: decimals, thousands, unit` as an optional Feishu-parity RC item. Existing `number` fields already store raw numeric values and can carry validation rules, but the UI had no first-class display-format property and rendered numbers with `String(value)`.

## Goals

- Add field-level display formatting for `number` fields: decimal precision, thousands separator, and unit suffix.
- Preserve raw numeric storage and write validation semantics.
- Preserve existing `number` fields that have no format property.
- Keep number validation rules round-tripping with the new display-format keys.

## Non-Goals

- No locale-specific formatting selector.
- No XLSX/CSV export formatting changes.
- No formula/rollup result formatting changes.
- No backend numeric coercion change for record values.

## Property Contract

`number` field property now accepts these display keys:

```json
{
  "decimals": 2,
  "thousands": true,
  "unit": "kg",
  "validation": []
}
```

Rules:

- `decimals` is optional. If absent or invalid, rendering preserves the raw numeric precision.
- `decimals` is normalized to an integer in `[0, 6]`.
- `thousands` is normalized to a boolean and defaults to `false`.
- `unit` is trimmed and capped at 24 characters.
- `validation` keeps the existing field-validation engine shape.

## Implementation

- Backend canonical sanitizer: `packages/core-backend/src/multitable/field-codecs.ts`
  - Normalizes `number.decimals`, `number.thousands`, and `number.unit`.
  - Leaves record values untouched.
- Legacy route sanitizer: `packages/core-backend/src/routes/univer-meta.ts`
  - Mirrors the same `number` property normalization for route paths still using local sanitize logic.
- Frontend config helpers: `apps/web/src/multitable/utils/field-config.ts`
  - Adds `resolveNumberFieldProperty()` and `formatNumberValue()`.
  - Rendering is deterministic and avoids locale-dependent assertions.
- Frontend display: `apps/web/src/multitable/utils/field-display.ts`
  - Routes `number` values through the new formatter.
  - If no display-format property is set, output remains `String(value)`.
- Field manager: `apps/web/src/multitable/components/MetaFieldManager.vue`
  - Adds number config UI for decimals, thousands separator, and unit.
  - Keeps validation rules alongside display-format keys.
- Cell editor: `apps/web/src/multitable/components/cells/MetaCellEditor.vue`
  - Uses configured `decimals` as the numeric input step when present.

## Compatibility

Existing number fields without `decimals`, `thousands`, or `unit` render exactly as before. New formatting is opt-in by field property and does not convert persisted values into formatted strings.

