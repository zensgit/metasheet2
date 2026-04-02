# PLM Workbench Team-Scope List SDK Parity Design

Date: 2026-03-29
Commit: pending

## Context

The PLM workbench team-scope list routes already support an omitted `kind` query and return canonical aggregate metadata:

- `GET /api/plm-workbench/views/team`
- `GET /api/plm-workbench/filter-presets/team`

Current backend/runtime behavior:

- `kind` query is optional
- omitting `kind` returns all team-scope entries
- response metadata uses `kind: 'all'`

Source OpenAPI already matched that behavior because the `kind` query parameter was optional on both routes.

The remaining contract split lived in the handwritten SDK runtime and SDK-local metadata types:

- `createPlmWorkbenchClient().listTeamViews(kind)` required `kind`
- `createPlmWorkbenchClient().listTeamFilterPresets(kind)` required `kind`
- `PlmTeamViewListMetadata.kind` excluded `'all'`
- `PlmTeamFilterPresetListMetadata.kind` excluded `'all'`

That forced SDK consumers into a narrower contract than the real server and published OpenAPI.

## Decision

Widen only the handwritten SDK surface to match the already-correct backend and OpenAPI contract:

- make `kind` optional in `listTeamViews(...)`
- make `kind` optional in `listTeamFilterPresets(...)`
- widen list metadata kinds to `... | 'all'`

## Why This Fix

- It removes a real runtime/type mismatch without changing server behavior.
- It keeps the smallest safe write scope: SDK runtime + SDK tests only.
- It makes the SDK capable of representing the canonical team-scope aggregate list already supported by backend routes.
- It prevents future consumers from re-encoding `?kind=` when they actually want the whole team catalog.

## Scope

Included:

- `packages/openapi/dist-sdk/client.ts`
- `packages/openapi/dist-sdk/tests/client.test.ts`
- generated `packages/openapi/dist-sdk/client.d.ts`

Not included:

- no backend route change
- no OpenAPI source change
- no web runtime behavior change beyond inheriting the widened SDK types
