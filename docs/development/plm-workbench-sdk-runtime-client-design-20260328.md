# PLM Workbench SDK Runtime Client Design

## Background

`packages/openapi/src/paths/plm-workbench.yml` and generated `dist-sdk` path types already exposed the `plm-workbench` team-view and team-preset routes, but the repository still lacked a runtime SDK surface for them.

This left `apps/web/src/services/plm/plmWorkbenchClient.ts` maintaining a second hand-written contract:

- manual `apiFetch` request wiring
- manual `success/error` envelope unwrapping
- manual path/body construction for `list/save/rename/delete/default/archive/restore/duplicate/transfer/batch`

That duplication created a contract drift seam: OpenAPI could move first while Web kept a stale runtime copy.

## Problem

There were two concrete parity gaps:

1. `packages/openapi/dist-sdk/client.ts` only exposed federation helpers and could not call the already-documented `plm-workbench` direct routes.
2. Even after the OpenAPI spec documented `batch.metadata`, the Web client still dropped that part of the response and only preserved `action/processedIds/skippedIds/items`.

## Decision

Add a dedicated `createPlmWorkbenchClient(...)` to `packages/openapi/dist-sdk/client.ts`, rather than extending the federation client.

This keeps the split clear:

- `createPlmFederationClient(...)`: query/mutate federation routes
- `createPlmWorkbenchClient(...)`: direct collaborative `plm-workbench` routes

## Implementation

### SDK

Added a direct-route envelope layer:

- `DirectApiEnvelope<T, M>`
- `buildDirectApiError(...)`
- `unwrapDirectEnvelope(...)`
- `requestDirectApi(...)`
- `requestDirectEnvelope(...)`

Added `createPlmWorkbenchClient(...)` with runtime helpers for:

- team views:
  - list
  - save
  - rename
  - delete
  - duplicate
  - transfer
  - set default
  - clear default
  - archive
  - restore
  - batch
- team filter presets:
  - list
  - save
  - rename
  - delete
  - duplicate
  - transfer
  - set default
  - clear default
  - archive
  - restore
  - batch

Batch helpers now return both:

- `data`
- top-level `metadata`

so the runtime surface finally matches the documented OpenAPI contract.

### Web client adoption

`apps/web/src/services/plm/plmWorkbenchClient.ts` now delegates collaborative team-view/team-preset requests to the SDK helper through a local `RequestClient`.

The Web layer still owns:

- state normalization
- `kind`-aware team-view decoding
- UI-facing batch result shaping
- audit log/export helpers

but it no longer hand-maintains the direct route contract itself.

## Why this is better

- Removes duplicated route/path/body logic from the Web layer.
- Makes `OpenAPI -> dist-sdk runtime -> web client` a single chain.
- Preserves existing Web normalization behavior.
- Unblocks future reuse of `plm-workbench` routes from other packages without copying fetch logic again.
- Exposes already-documented `batch.metadata` to runtime callers instead of silently dropping it.
