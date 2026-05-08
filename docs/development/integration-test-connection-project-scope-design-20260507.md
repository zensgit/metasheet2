# Integration Test Connection Project Scope Preservation Design - 2026-05-07

## Context

The integration control plane lets an operator test a configured PLM or ERP
external system through:

```text
POST /api/integration/external-systems/:id/test
```

After the adapter test finishes, the route persists `status`, `lastTestedAt`,
and `lastError` back to `integration_external_systems` by calling
`upsertExternalSystem()`.

K3 WISE and PLM setup records can be scoped to a MetaSheet project through
`projectId`. The status-only writeback did not include the loaded system's
`projectId`, so the registry normalized it as absent. On real storage this can
clear `project_id` while merely testing a connection.

## Change

`persistExternalSystemTestResult()` now carries the existing system project
scope into the status writeback:

```js
projectId: system.projectId
```

No new route, schema, permission, or adapter contract is introduced. This is a
route-layer preservation fix: the adapter test result is still the only thing
that changes status and last-test metadata.

## Behavior

- Existing project-scoped external systems keep their `projectId` after a
  successful test.
- Existing project-scoped external systems keep their `projectId` after a
  failed test.
- Inactive systems still remain inactive after a successful test.
- Failed tests still persist `status: "error"` and `lastError`.
- Systems without a project scope continue to pass `undefined`, which preserves
  the current no-project behavior.

## Why It Matters

ERP/PLM connections are often configured per project, base, or workspace during
customer PoC setup. A harmless "Test connection" click should not detach the K3
WISE or PLM endpoint from its owning project. Losing that scope makes later
pipeline setup harder to reason about and can make frontend pages show the
connection outside the expected project context.

## Files

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`

