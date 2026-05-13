# Generic Integration Workbench Frontend Shell Design - 2026-05-12

## Purpose

This slice adds the first user-visible generic integration workbench. It started with the configuration path that must exist before dry-run/run UI:

1. load adapter metadata;
2. load external systems;
3. choose source and target systems;
4. discover source/target objects;
5. discover schemas;
6. edit field mappings;
7. generate a target payload preview;
8. save the mapping as a pipeline;
9. run dry-run or explicitly gated Save-only execution.

The pipeline save/run controls were added by the companion pipeline-run slice documented in `generic-integration-workbench-pipeline-run-design-20260512.md`.

## New Frontend Service

`apps/web/src/services/integration/workbench.ts` wraps the new backend APIs:

- `listIntegrationAdapters()`;
- `listWorkbenchExternalSystems(scope)`;
- `listExternalSystemObjects(systemId, scope)`;
- `getExternalSystemSchema(systemId, { object, tenantId, workspaceId })`;
- `previewIntegrationTemplate(payload)`;
- `getDefaultIntegrationScope()`;
- `canReadFromSystem(system)`;
- `canWriteToSystem(system)`.

The service defaults `tenantId` to `default` for single-tenant on-prem installs and omits blank `workspaceId` from query strings.

## New Route and View

`/integrations/workbench` is registered as:

- route name: `integration-workbench`;
- component: `IntegrationWorkbenchView.vue`;
- permission: `integration:write`;
- title: `Integration Workbench` / `数据集成工作台`.

The view is intentionally dense and operational:

- no landing page;
- no marketing hero;
- source and target panels are side by side;
- SQL channel is surfaced as an advanced adapter badge;
- K3 WISE setup remains reachable through a preset-link button;
- payload preview is shown as JSON for implementation debugging.

## Mapping Behavior

When a target schema loads, the page seeds a small initial mapping set from target fields:

| Target field | Default source guess |
| --- | --- |
| `FNumber` | `code` |
| `FName` | `name` |
| `FModel` | `spec` |
| `FBaseUnitID` / `FUnitID` | `uom` |
| `FQty` | `quantity` |
| `FParentItemNumber` | `parentCode` |
| `FChildItemNumber` | `childCode` |

This keeps the K3 Material/BOM happy path usable while remaining generic.

## Security and Boundaries

- Discovery and preview remain read-only/pure.
- Pipeline save calls the existing `POST /api/integration/pipelines` route.
- Dry-run calls the existing `POST /api/integration/pipelines/:id/dry-run` route.
- Save-only run calls the existing `POST /api/integration/pipelines/:id/run` route only after explicit operator confirmation.
- It does not expose a raw JSON editor for template mutation.
- It does not expose raw SQL.
- The transform input is text for the shell; a stricter whitelist selector is still listed in TODO.

## Non-Goals

- No staging install flow.
- No dead-letter display.
- No custom template authoring UI.
