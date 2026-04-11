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

1. Manual `loadProduct()` now syncs product identity into the route with
   `autoload=true` whenever the selected panel scope should hydrate product
   context.
2. `loadProduct()` fetches the product as before.
3. Once the final item type is known, it triggers `plmService.getMetadata(itemType)`.
4. Metadata loading is independent and non-fatal:
   - metadata failure does not block BOM/documents/approvals loading
   - product detail still renders even when schema discovery fails
5. A small pure helper maps:
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
- `apps/web/src/views/plm/plmWorkbenchViewState.ts`
- `apps/web/src/components/plm/PlmProductPanel.vue`
- `apps/web/src/views/plm/plmPanelModels.ts`
- `apps/web/src/views/plm/usePlmProductPanel.ts`
- `apps/web/src/views/plm/plmProductMetadata.ts`
- `apps/web/tests/plmWorkbenchViewState.spec.ts`
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
- Fix the manual-load route race at the route-query layer instead of hiding it
  with a deeplink-only workflow.
  Reason: the real user path is “输入产品 ID -> 加载产品”. Before the fix, that path
  wrote `productId` into the URL without `autoload=true`, so `route.fullPath`
  hydration cleared `product` again after the API returned `200`.

## Verification

### Unit

```bash
pnpm exec vitest run \
  --environment jsdom \
  apps/web/tests/plmWorkbenchViewState.spec.ts

pnpm exec vitest run \
  apps/web/tests/plmProductMetadata.spec.ts \
  apps/web/tests/usePlmProductPanel.spec.ts \
  apps/web/tests/plmService.spec.ts
```

Result:

- `apps/web/tests/plmWorkbenchViewState.spec.ts`: `44` passed
- `3` test files passed
- `16` tests passed

### Browser Smoke

Setup:

```bash
# backend token
curl -s http://127.0.0.1:7778/api/auth/dev-token

# one-time federation connect
curl -s -X POST http://127.0.0.1:7778/api/federation/systems/plm/connect \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json"

# UI route exercised after the fix
http://127.0.0.1:8899/plm
```

Manual path verified:

1. Open `/plm`
2. Fill product ID `01H000000000000000000000P1`
3. Keep item type `Part`
4. Click `加载产品`

Observed result:

- URL becomes `/plm?productId=01H000000000000000000000P1&autoload=true&itemType=Part`
- DOM includes product name `Mounting Bracket`
- DOM includes AML summary `模型字段（AML Metadata，6）`
- accessibility snapshot includes:
  - `Mounting Bracket`
  - `P-0001`
  - `Released`
  - `模型字段（AML Metadata，6）`

Artifacts:

- screenshot: `output/playwright/aml-metadata-smoke/.playwright-cli/page-2026-04-11T09-29-25-399Z.png`
- snapshot: `output/playwright/aml-metadata-smoke/.playwright-cli/page-2026-04-11T09-30-41-121Z.yml`

## Limits

- This change only surfaces metadata in the product panel; other panels still
  use their existing field catalogs.
- The metadata block renders provider schema as-is and does not yet support
  richer field widgets or grouping.
