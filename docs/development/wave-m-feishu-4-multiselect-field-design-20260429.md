# Wave M-Feishu-4 Multi-Select Field Design — 2026-04-29

## Scope

Add true multitable `multiSelect` field support as a field-types batch-2
slice. This closes the previous aliasing gap where `multiselect` input fell
back to single `select` semantics.

## Design

- Canonical field type is `multiSelect`.
- Backward-compatible aliases are accepted server-side:
  `multiselect`, `multi-select`, and `multi_select`.
- Field property reuses the existing select option shape:
  `{ options: [{ value, color? }] }`.
- Record values are normalized to a de-duplicated `string[]`.
- Empty input (`null`, `undefined`, `''`) is stored as `[]`.
- Scalar values are rejected instead of being silently coerced, so callers do
  not accidentally write single-select payloads to a multi-select field.
- Unknown option values are rejected against the field option whitelist.

## Backend Touchpoints

- `field-codecs.ts`
  - maps aliases to `multiSelect`;
  - sanitizes select-style options;
  - exposes `normalizeMultiSelectValue()`.
- `record-write-service.ts`
  - validates and normalizes `multiSelect` in the shared authoritative write
    path used by REST and Yjs bridge callers.
- `record-service.ts` and `records.ts`
  - normalize create/patch helper paths to the same array contract.
- `univer-meta.ts`
  - accepts `multiSelect` in field create/update schemas;
  - keeps search/filter and public form submission aligned.
- `field-validation-engine.ts`
  - treats `multiSelect` default enum validation as an array-aware enum check.
- `conditional-formatting-service.ts`
  - lets select-style equality rules match any selected option.
- `contracts.ts`, `provisioning.ts`, and OpenAPI sources
  - expose the new field type to provisioning and API contract consumers.

## Frontend Touchpoints

- `MetaFieldManager.vue`
  - lists `multiSelect` as a creatable/configurable field type;
  - reuses the existing option editor and validation panel.
- `MetaCellRenderer.vue`
  - renders each selected value as a select-style chip.
- `MetaCellEditor.vue`
  - uses a multiple `<select>` editor and confirms with Ctrl/Cmd+Enter.
- `MetaFormView.vue` and `MetaRecordDrawer.vue`
  - submit/patch arrays from multiple selects.
- `field-display.ts`, `ConditionalFormattingDialog.vue`, and
  `conditional-formatting.ts`
  - align display and conditional formatting with array values.
- `useMultitableGrid.ts`
  - exposes `contains`/`doesNotContain`/empty operators for filter builder
    metadata.

## Out of Scope

- Kanban grouping by `multiSelect` is not enabled in this slice; grouping a row
  into multiple columns needs a separate view-level decision.
- Backend SQL shortcut filters in `query-service.ts` still accept scalar filter
  values only. The primary multitable view path uses `filterInfo` evaluation.
- No migration is required because field type lives in `meta_fields.type` and
  values live in JSONB.
