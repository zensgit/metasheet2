# Multitable Location Field Design - 2026-05-06

## Context

`docs/development/multitable-feishu-rc-todo-20260430.md` keeps `Location field` as a remaining optional Feishu-parity item. The previous `number` and `barcode` slices established the pattern for adding small, first-class field types across backend codecs, frontend editors/renderers, OpenAPI, and focused verification.

## Goals

- Add a first-class `location` multitable field type.
- Persist location values as a structured JSON object in record `data`.
- Accept both address-only input and optional coordinates through API write paths.
- Provide basic frontend creation, rendering, cell editing, form editing, record drawer editing, and filtering.
- Keep the slice dependency-free and safe for RC use.

## Non-Goals

- No map picker.
- No browser geolocation prompt.
- No reverse geocoding or address normalization through external services.
- No distance/radius filter operators.
- No export-specific location formatting.

## Value Contract

Canonical persisted shape:

```json
{
  "address": "Shanghai Tower",
  "latitude": 31.2335,
  "longitude": 121.5055
}
```

Rules:

- Empty input becomes `null`.
- A string or number is treated as an address and normalized to `{ "address": "..." }`.
- An object may use `address`, `name`, or `fullAddress` as the address source.
- Coordinates may use `latitude`/`longitude` or aliases `lat`/`lng`/`lon`.
- Coordinates must be provided together.
- Latitude must be in `[-90, 90]`; longitude must be in `[-180, 180]`.
- Address text is trimmed and capped at 512 characters.
- Coordinate-only objects are allowed and display as `latitude, longitude`.

## Implementation

- Backend field codecs: `packages/core-backend/src/multitable/field-codecs.ts`
  - Adds `location` to `MultitableFieldType` and `BATCH1_FIELD_TYPES`.
  - Maps aliases: `geo`, `geolocation`, `geo_location`, and `geo-location`.
  - Adds `validateLocationValue()` for address/coordinate normalization.
- Backend write surfaces:
  - `packages/core-backend/src/routes/univer-meta.ts`
  - `packages/core-backend/src/multitable/record-service.ts`
  - `packages/core-backend/src/multitable/record-write-service.ts`
  - These paths reuse existing batch field coercion, so direct route, public form, record service, and `RecordWriteService` writes share the same semantics.
- Frontend type and UI:
  - `apps/web/src/multitable/types.ts` adds `location`.
  - `MetaFieldManager.vue` and `MetaFieldHeader.vue` expose the field type and map-pin icon.
  - `MetaCellRenderer.vue` displays a pin-prefixed location label.
  - `MetaCellEditor.vue`, `MetaFormView.vue`, and `MetaRecordDrawer.vue` provide address-only text inputs.
  - `useMultitableGrid.ts` gives `location` string-like filter operators for address matching.
  - `field-display.ts` centralizes display and address-input helpers.
- OpenAPI:
  - `packages/openapi/src/base.yml` adds `location` to `MultitableFieldType`.
  - Generated `packages/openapi/dist/*` was refreshed.
  - `scripts/ops/multitable-openapi-parity.test.mjs` now checks `location`.

## Compatibility

No migration is required. Existing records are unaffected. Unknown clients that read a location field will receive a JSON value in the existing record `data` object; updated clients should use the OpenAPI enum to treat `location` as first-class.

## Deferred

- Map picker and browser geolocation.
- Reverse geocoding and coordinate lookup.
- Distance-based filtering.
- Location-specific XLSX/CSV formatting.

