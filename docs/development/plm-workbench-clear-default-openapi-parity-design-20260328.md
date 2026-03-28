# PLM Workbench Clear Default OpenAPI Parity Design

## Context

The runtime SDK client and backend routes already clear defaults through:

- `DELETE /api/plm-workbench/views/team/{id}/default`
- `DELETE /api/plm-workbench/filter-presets/team/{id}/default`

But source OpenAPI still declared those `delete` operations under the corresponding `/restore` paths.

## Problem

- Generated `paths` types exposed `delete` on `/restore` instead of `/default`.
- Typed SDK consumers saw the wrong endpoint contract.
- Documentation and generated artifacts diverged from the real backend/runtime behavior.

## Decision

Move the `clear default` `delete` operations in source OpenAPI:

1. Add `delete` to each `/default` path.
2. Remove `delete` from each `/restore` path.
3. Rebuild generated OpenAPI artifacts and SDK types.
4. Lock the result with type-level path assertions.

## Expected Result

- OpenAPI source, generated `paths` types, runtime SDK client, and backend routes all point to the same `DELETE .../default` contract.
- `/restore` remains restore-only.
