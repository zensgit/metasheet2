# Generic Integration Workbench Contract Closeout Development - 2026-05-12

## Scope

This slice closes two remaining backend-contract TODOs for the generic integration workbench:

- M1 discovery API: unknown external systems must return a scoped 404 and must not instantiate adapters.
- M5 template preview API: K3 WISE BOM payload preview must be covered alongside the existing Material preview.

No frontend behavior or route shape was changed.

## Design

### Unknown system discovery

The test overrides `externalSystemRegistry.getExternalSystemForAdapter()` to throw `ExternalSystemNotFoundError`.

Covered routes:

- `GET /api/integration/external-systems/:id/objects`
- `GET /api/integration/external-systems/:id/schema`

Acceptance:

- Response status is `404`.
- Error code remains `ExternalSystemNotFoundError`.
- Scoped lookup includes `id`, `tenantId`, and `workspaceId`.
- `adapterRegistry.createAdapter()` is never called after the registry miss.

### K3 BOM template preview

The preview test builds a K3 BOM-style payload with:

- `FParentItemNumber` from `parentCode` using `trim` and `upper`.
- `FChildItemNumber` from `childCode` using `trim` and `upper`.
- `FQty` from `quantity` using `toNumber`.
- `FScrapRate` from `scrapRate` using `toNumber`.
- `bodyKey: Data`.

Acceptance:

- `valid` is `true`.
- Payload is wrapped under `Data`.
- Numeric fields are numbers, not strings.
- Source secret fields are redacted from the response.
- Preview path does not call integration services or target adapters.

## Files

- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/generic-integration-workbench-contract-closeout-development-20260512.md`
- `docs/development/generic-integration-workbench-contract-closeout-verification-20260512.md`
