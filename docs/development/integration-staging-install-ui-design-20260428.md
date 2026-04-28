# Integration Staging Install UI Design

## Context

The integration plugin already had a staging installer for five user-visible multitable objects:

- `plm_raw_items`
- `standard_materials`
- `bom_cleanse`
- `integration_exceptions`
- `integration_run_log`

Before this slice, staging could only be provisioned through plugin activation/internal code paths. The K3 WISE setup page could save systems and create draft pipelines, but operators still had no UI action to create the multitable staging workspace those pipelines write feedback into.

## Design

This slice exposes staging installation as a first-class integration control-plane action.

Backend routes:

- `GET /api/integration/staging/descriptors`
- `POST /api/integration/staging/install`

The install route:

- requires `integration:write`
- requires tenant scope through the existing `scopedInput()` guard
- requires `projectId`
- accepts optional `workspaceId` and `baseId`
- delegates to the existing `installStaging()` implementation

Frontend:

- The K3 WISE setup form now includes `Base ID` alongside `Project ID`.
- The side rail now has `Install Staging Tables`.
- The action sends tenant/workspace/project/base scope to the backend and renders returned `sheetIds` plus any warnings.

The pipeline template still stores logical staging object ids such as `standard_materials` and `bom_cleanse`. The returned physical sheet ids are shown to the operator for traceability; they are not substituted into the pipeline feedback `objectId` fields because feedback writeback resolves logical plugin object ids through the multitable provisioning registry.

## Files

- `plugins/plugin-integration-core/index.cjs`
- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/k3WiseSetup.spec.ts`
