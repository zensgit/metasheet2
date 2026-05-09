# Multitable Barcode Field Design - 2026-05-05

## Context

`docs/development/multitable-feishu-rc-todo-20260430.md` tracks `Barcode field` as a remaining Feishu-parity RC item. The existing multitable runtime already supports text-like custom field types through the shared batch-1 codec seam, but `barcode` was not recognized in backend contracts, frontend field creation, cell rendering, or OpenAPI.

## Goals

- Add a first-class `barcode` multitable field type across backend, frontend, and OpenAPI.
- Store barcode values as plain text in record `data`, with deterministic trimming.
- Accept numeric scanner payloads by converting them to strings.
- Preserve existing write paths through `RecordWriteService`, direct route writes, public form writes, and record-service helpers.
- Provide copy-friendly UI rendering and text-backed editing.

## Non-Goals

- No camera/scanner integration.
- No barcode image generation.
- No uniqueness constraint.
- No checksum validation for EAN/UPC/Code128 variants.
- No export-specific barcode formatting.

## Runtime Contract

`barcode` is a text-backed field type:

```json
{
  "id": "fld_barcode",
  "name": "Barcode",
  "type": "barcode",
  "property": {}
}
```

Value coercion rules:

- `null`, `undefined`, and empty string become `null`.
- String values are trimmed.
- Number values are converted to strings.
- Other value types are rejected.
- Persisted value length is capped at 256 characters.

Default validation rules also cap `barcode` at 256 characters, matching backend write coercion.

## Implementation

- Backend field codecs: `packages/core-backend/src/multitable/field-codecs.ts`
  - Adds `barcode` to `MultitableFieldType` and `BATCH1_FIELD_TYPES`.
  - Maps `barcode`, `bar_code`, and `bar-code` aliases.
  - Adds `validateBarcodeValue()` and routes `coerceBatch1Value()` through it.
- Backend write surfaces:
  - `packages/core-backend/src/routes/univer-meta.ts`
  - `packages/core-backend/src/multitable/record-service.ts`
  - `packages/core-backend/src/multitable/record-write-service.ts`
  - These paths now recognize `barcode` and reuse the shared batch-1 coercion seam.
- Backend validation:
  - `packages/core-backend/src/multitable/field-validation-engine.ts`
  - Adds default `maxLength: 256` for `barcode`.
- Frontend type and UI:
  - `apps/web/src/multitable/types.ts`
  - `MetaFieldManager.vue` and `MetaFieldHeader.vue` expose the field type and icon.
  - `MetaCellRenderer.vue` renders barcode values as monospace copy-friendly text.
  - `MetaCellEditor.vue`, `MetaFormView.vue`, and `MetaRecordDrawer.vue` use text inputs.
  - `useMultitableGrid.ts` gives barcode string-like filter operators.
- OpenAPI:
  - `packages/openapi/src/base.yml` adds `barcode` to `MultitableFieldType`.
  - Generated `packages/openapi/dist/*` was refreshed.
  - `scripts/ops/multitable-openapi-parity.test.mjs` now checks `barcode`.

## Compatibility

Existing records are unaffected. `barcode` uses the same JSON `data` storage model as other text-backed fields and does not require a migration. Clients that do not know `barcode` will still see a string-like value in record payloads, but should update their field-type enum to avoid treating the field as unknown.

