# Integration Core Yuantus PLM Wrapper Verification - 2026-04-24

## Scope

Verify M2-T01 and M2-T05 mock coverage:

- Yuantus PLM wrapper registration.
- source-only adapter contract.
- material canonical mapping.
- BOM canonical mapping.
- mock PLM -> mock K3 WISE -> ERP feedback writeback E2E.
- target failure dead-letter behavior.
- dry-run no-write behavior.

## Commands Run

```bash
node -c plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs
node -c plugins/plugin-integration-core/__tests__/plm-yuantus-wrapper.test.cjs
node -c plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs
node -c plugins/plugin-integration-core/lib/pipeline-runner.cjs
pnpm -F plugin-integration-core test:plm-yuantus-wrapper
pnpm -F plugin-integration-core test:k3-wise-adapters
pnpm -F plugin-integration-core test:e2e-plm-k3wise-writeback
```

```bash
pnpm -F plugin-integration-core test
node --import tsx scripts/validate-plugin-manifests.ts
git diff --check
```

## Results

- New PLM wrapper module passes syntax check.
- New PLM wrapper unit test passes.
- K3 adapter test still passes after business-code propagation changes.
- New PLM -> K3 WISE -> feedback E2E passes.
- `plugin-integration-core` package tests pass, including runtime smoke,
  adapter, PLM wrapper, K3, feedback, runner, REST, staging, and migration
  checks.
- Plugin manifest validation passes: 13/13 valid, 0 errors. Existing warnings
  are unrelated plugin metadata/wildcard warnings outside this slice.
- `git diff --check` passes.

## Covered Behaviors

`plm-yuantus-wrapper.test.cjs` covers:

- `testConnection()` succeeds with injected `plmClient.isConnected()`.
- `listObjects()` exposes `materials` and `bom`.
- `getSchema()` returns canonical material fields.
- `read(materials)` calls `getProducts()` with filters and watermark.
- material rows normalize `id/itemCode/itemName/unitName/categoryName` into
  canonical fields.
- pagination metadata produces a next cursor.
- `read(bom)` calls `getProductBOM(productId)` and normalizes BOM lines.
- missing BOM `productId` is rejected.
- `upsert()` rejects with `UnsupportedAdapterOperationError`.
- `system.config.plmClient` is ignored so external-system config remains
  data-only.
- missing PLM client returns `PLM_CLIENT_MISSING`.

`e2e-plm-k3wise-writeback.test.cjs` covers:

- mock PLM emits two material records.
- transform rules trim and uppercase material codes before K3 write.
- mock K3 accepts one material and rejects one with a business code.
- runner metrics report two read, two cleaned, one written, one failed.
- failed K3 write creates a dead letter with the vendor business code.
- partial run does not advance the watermark.
- ERP feedback writes both a synced row and a failed row to staging update
  requests.
- feedback includes `erpSyncStatus`, `erpExternalId`, `erpBillNo`,
  `erpResponseCode`, and `erpResponseMessage`.
- dry-run does not call K3 Save, does not write dead letters, does not write
  feedback, and does not advance the watermark.

Runtime smoke coverage:

- `getStatus().adapters` includes `plm:yuantus-wrapper`.
- `listAdapterKinds()` includes `plm:yuantus-wrapper`.

## Not Covered

- live Yuantus PLM authentication.
- live K3 WISE connectivity.
- customer-specific field mappings.
- complex BOM trees, substitute materials, and approval workflows.
- SQL Server middle database integration.
- frontend operator workflow.

Those remain gated by the M2 customer checklist and production hardening tasks.
