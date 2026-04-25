# Integration Core Yuantus PLM Wrapper Design - 2026-04-24

## Context

The MVP plan keeps the kernel `PLMAdapter.ts` in place while the integration
pipeline moves toward plugin-owned adapters. This slice adds a source-side
wrapper that exposes host PLM data through the plugin-local adapter contract
without importing or replacing the kernel adapter.

## Module

Added:

- `plugins/plugin-integration-core/lib/adapters/plm-yuantus-wrapper.cjs`
- `plugins/plugin-integration-core/__tests__/plm-yuantus-wrapper.test.cjs`
- `plugins/plugin-integration-core/__tests__/e2e-plm-k3wise-writeback.test.cjs`

Changed:

- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/lib/pipeline-runner.cjs`
- `plugins/plugin-integration-core/lib/adapters/k3-wise-webapi-adapter.cjs`

## Adapter Kind

```text
plm:yuantus-wrapper
```

The name is deliberate: this is a facade over host PLM capability, not a new
direct Yuantus connector.

Runtime registration uses:

```js
createYuantusPlmWrapperAdapterFactory({ context })
```

The adapter resolves its PLM client in this order:

1. injected `plmClient` for tests.
2. `context.api.plm` at runtime.

It does not import `packages/core-backend/src/data-adapters/PLMAdapter.ts`, does
not read env vars, does not access the DI container, and does not accept an
executable client object from `system.config`. External system `config` stays
data-only.

## Contract

The adapter implements the existing five-method contract:

- `testConnection()`
- `listObjects()`
- `getSchema()`
- `read()`
- `upsert()`

`upsert()` always returns `UnsupportedAdapterOperationError`. PLM is source-only
for this MVP flow.

Supported read objects:

- `materials`
- `bom`

`materials` uses `plmClient.getProducts(options)`.

`bom` uses `plmClient.getProductBOM(productId, options)`. It accepts
`filters.productId`, `options.productId`, or `system.config.defaultProductId`.

## Canonical Output

Material records normalize to:

```js
{
  sourceSystemId,
  sourceId,
  objectType: 'material',
  code,
  name,
  revision,
  uom,
  category,
  status,
  updatedAt,
  rawPayload
}
```

BOM records normalize to:

```js
{
  sourceSystemId,
  sourceId,
  objectType: 'bom',
  parentId,
  parentCode,
  childId,
  childCode,
  quantity,
  uom,
  sequence,
  revision,
  updatedAt,
  rawPayload
}
```

This canonical shape is intentionally small. Customer-specific PLM fields remain
in `rawPayload` until field mapping rules are confirmed through the M2 GATE.

## PLM To K3 Mock E2E

The new E2E verifies this path:

```text
mock Yuantus PLM getProducts()
  -> plm:yuantus-wrapper read(materials)
  -> transform/validate
  -> erp:k3-wise-webapi upsert(material)
  -> target dead-letter on K3 business failure
  -> ERP feedback writeback to standard_materials
```

The test intentionally uses mock PLM and mock K3 WebAPI. It proves contract
composition and failure handling, not live customer connectivity.

## K3 Business Code Propagation

`k3-wise-webapi-adapter.cjs` now preserves K3 business response codes when a
Save/Submit/Audit business response fails. The fallback remains
`K3_WISE_*_FAILED` when the response does not provide a vendor code.

This lets dead letters and feedback show customer-facing K3 error codes such as
`K3_MATERIAL_INVALID`.

## Deferred

- direct Yuantus authentication and HTTP transport inside the plugin.
- complete material/BOM/metadata coverage.
- substitute materials and complex BOM trees.
- live PLM/K3 WISE connectivity.
- deletion of kernel `PLMAdapter.ts`.

Kernel `PLMAdapter.ts` deletion remains an M4 task after the wrapper has run in
production for at least two releases and all core PLM routes have moved to the
adapter/gateway contract with feature-flag rollback.
