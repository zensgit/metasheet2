# PLM Workbench List Metadata SDK Parity Design

## Background

`plm-workbench` backend list routes for team views and team presets already return structured `metadata`, and source OpenAPI already documents it. The gap was in the runtime layers above that contract:

- `packages/openapi/dist-sdk/client.ts` collapsed both list routes down to arrays
- `apps/web/src/services/plm/plmWorkbenchClient.ts` re-exposed only `items`

That meant consumers lost totals, archived counts, tenant scoping, and default ids even though the backend was already emitting them.

## Goal

Make list-route metadata first-class across the generated runtime SDK and the web PLM collaborative client, without changing existing item normalization behavior.

## Design

### SDK runtime

Introduce explicit metadata shapes for:

- `PlmTeamViewListMetadata`
- `PlmTeamFilterPresetListMetadata`

Then change:

- `listTeamViews(...)`
- `listTeamFilterPresets(...)`

to return a shared `{ items, metadata }` envelope instead of dropping `metadata`.

### Web client

Keep the existing item mapping logic, but preserve normalized metadata when calling the SDK runtime:

- team views expose `total / activeTotal / archivedTotal / tenantId / kind / defaultViewId`
- team presets expose `total / activeTotal / archivedTotal / tenantId / kind / defaultPresetId`

Unknown or malformed metadata fields still normalize to `undefined` rather than leaking unchecked payloads upward.

## Why this shape

- Preserves backend/OpenAPI semantics instead of inventing a second client-only contract
- Keeps current callers compatible because `items` still exist in the same place
- Unlocks higher-level UI logic that needs counts/default ids without re-fetching or hand-parsing raw responses

## Risk

Primary risk is contract drift between SDK tests and web client tests. The fix is to lock both layers with focused metadata assertions for team views and team presets.
