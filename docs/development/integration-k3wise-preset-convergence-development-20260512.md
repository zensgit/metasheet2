# K3 WISE Preset Convergence Development - 2026-05-12

## Scope

This slice closes the M8 K3 WISE page convergence TODOs for the generic integration workbench plan.

The K3 WISE setup page remains a quick-start preset for WebAPI, SQL Server, staging tables, Material/BOM document templates, and pipeline execution. The page now treats tenant/workspace as advanced context rather than ordinary first-run required inputs.

## Changes

### Scope defaults

- Blank `tenantId` now resolves to `default` in setup, staging install, pipeline creation, pipeline run, and observation payload builders.
- Tenant and workspace fields moved from the primary "基础连接" section into the closed "高级 WebAPI 设置" details section.
- Single-tenant PoC users can follow the quick-start path without editing tenant/workspace.

### Base URL and endpoint path guidance

- Base URL copy now explicitly says it should only contain protocol, host, and port.
- Endpoint paths remain in advanced settings and keep `/K3API/...` defaults.
- The page warns only when Base URL and endpoint paths both contain `/K3API`, because that produces duplicate paths at request time.

### SQL advanced boundary

- The SQL Server section is labeled as an advanced channel.
- The page states the guardrail: read through allowlisted tables/views, write only through middle tables or controlled stored procedures, and no ordinary UI direct K3 core-table writes.

### Existing behavior preserved

- The generic workbench link remains in the page header.
- WebAPI connected status remains visible after a successful test.
- Material and BOM template previews remain available and redaction-safe.

## Files

- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/tests/IntegrationK3WiseSetupView.spec.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`
- `docs/development/generic-integration-workbench-todo-20260512.md`
- `docs/development/integration-k3wise-preset-convergence-development-20260512.md`
- `docs/development/integration-k3wise-preset-convergence-verification-20260512.md`

## Non-Goals

- No K3 API endpoint behavior changed.
- No new SQL direct-write capability was added.
- No runtime backend routes were changed.
