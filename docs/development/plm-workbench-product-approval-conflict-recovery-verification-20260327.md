# PLM Workbench Product Approval Conflict Recovery Verification

## Scope

Verify that product-page approval actions recover from optimistic-lock conflicts and that the SDK
preserves structured conflict metadata.

## Checks

1. Shared approval helper + service regression:
   - `pnpm --filter @metasheet/web exec vitest run tests/plmApprovalInboxFeedback.spec.ts tests/plmService.spec.ts`
2. SDK regression:
   - `pnpm exec vitest run packages/openapi/dist-sdk/tests/client.test.ts`
3. Frontend type-check:
   - `pnpm --filter @metasheet/web type-check`
4. Frontend PLM regression sweep:
   - `cd apps/web && pnpm exec vitest run tests/plm*.spec.ts tests/usePlm*.spec.ts`

## Expected Results

- The SDK throws approval conflict errors with `code` and `currentVersion`.
- `PlmService` preserves that metadata.
- Shared helper can normalize both response payloads and thrown errors.
- Product-page approval actions compile against the new helper contract and no longer rely on
  manual refresh to escape repeated `409` loops.
