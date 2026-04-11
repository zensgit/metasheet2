# PLM Product Metadata Panel Design and Verification

Date: 2026-04-11

## Goal

Turn the newly added `plmService.getMetadata(itemType)` surface into a real UI
consumer instead of leaving it only in service and contract tests.

The chosen integration point is the product detail panel in the PLM workspace:

- it already owns `product`, `itemType`, and `loadProduct()`
- it already renders product summary and a static field catalog
- it is the narrowest place to surface AML schema discovery without touching
  BOM, documents, approvals, or CAD panels

## Design

The implementation adds a second, runtime-backed metadata block below the
existing static “字段对照清单”.

Flow:

1. `loadProduct()` fetches the product as before.
2. Once the final item type is known, it triggers `plmService.getMetadata(itemType)`.
3. Metadata loading is independent and non-fatal:
   - metadata failure does not block BOM/documents/approvals loading
   - product detail still renders even when schema discovery fails
4. A small pure helper maps:
   - metadata field definition
   - top-level product field value
   - `product.properties[fieldName]` fallback
   into UI rows with stable display strings

Rendered columns:

- `label`
- `name`
- `type`
- `required`
- `length`
- `defaultValue`
- `currentValue`

## Files

- `apps/web/src/views/PlmProductView.vue`
- `apps/web/src/components/plm/PlmProductPanel.vue`
- `apps/web/src/views/plm/plmPanelModels.ts`
- `apps/web/src/views/plm/usePlmProductPanel.ts`
- `apps/web/src/views/plm/plmProductMetadata.ts`
- `apps/web/tests/plmProductMetadata.spec.ts`
- `apps/web/tests/usePlmProductPanel.spec.ts`

## Key Decisions

- Keep the old static field catalog.
  Reason: it still documents the hard-coded normalization rules for the summary
  card, while the new AML metadata block shows the provider schema and current
  values.
- Do not block `loadProduct()` success on metadata.
  Reason: schema discovery is informative UI, not the primary product fetch.
- Normalize metadata rows in a pure helper module.
  Reason: easier testing and less template logic in the page component.

## Verification

Command:

```bash
pnpm exec vitest run \
  apps/web/tests/plmProductMetadata.spec.ts \
  apps/web/tests/usePlmProductPanel.spec.ts \
  apps/web/tests/plmService.spec.ts
```

Result:

- `3` test files passed
- `16` tests passed
- duration `706ms`

## Limits

- This change only surfaces metadata in the product panel; other panels still
  use their existing field catalogs.
- No browser smoke was added in this step; verification is currently unit-level.
- The metadata block renders provider schema as-is and does not yet support
  richer field widgets or grouping.
