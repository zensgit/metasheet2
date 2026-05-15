# Integration Staging Install Project Scope Design - 2026-05-15

## Summary

This change fixes the Data Factory / K3 WISE staging-table creation path where
`POST /api/integration/staging/install` could report success with an empty
`sheetIds` map.

The root cause is that multitable provisioning is plugin-scoped. The
`plugin-integration-core` runtime may only provision objects under a project ID
whose namespace suffix is `integration-core` or `plugin-integration-core`.
Operator-facing pages and smoke scripts were allowed to submit ordinary values
such as `default` or `project_1`; every descriptor was rejected by the host
scope guard, and the installer collected those errors as warnings.

## Goals

- Let ordinary users create staging multitable sheets without knowing the
  plugin project namespace rule.
- Preserve the host plugin-scope boundary.
- Make total provisioning failure explicit instead of returning
  `{ sheetIds: {} }`.
- Keep existing scoped project IDs working for operators and tests that already
  pass `tenant:integration-core` or `tenant:plugin-integration-core`.
- Avoid migrations and avoid changing the staging descriptor contract.

## Design

### Route-level project ID resolution

`plugins/plugin-integration-core/lib/http-routes.cjs` now resolves the staging
install project ID like this:

1. Resolve tenant ID using the existing tenant-scope rules.
2. If the submitted `projectId` already ends in `:integration-core` or
   `:plugin-integration-core`, preserve it.
3. Otherwise derive `${tenantId}:integration-core`.

That means:

| Input projectId | Effective projectId |
| --- | --- |
| empty | `tenant:integration-core` |
| `project_1` | `tenant:integration-core` |
| `tenant:integration-core` | `tenant:integration-core` |
| `tenant:plugin-integration-core` | `tenant:plugin-integration-core` |

This keeps the backend compatible with old UI/script payloads while ensuring
the real provisioning call satisfies `createPluginScopedMultitableApi()`.

### Installer total-failure guard

`plugins/plugin-integration-core/lib/staging-installer.cjs` still tolerates
partial descriptor failures. If at least one sheet is provisioned, the route
returns the created targets and warnings.

If no sheets are provisioned, the installer throws:

```text
code=STAGING_INSTALL_EMPTY
message=staging-installer: no staging sheets provisioned; warnings=N
details.attempted=<descriptor count>
details.warnings=<all descriptor warnings>
```

This turns the previous false-positive success into an actionable error.

### UI simplification

The Data Factory workbench and K3 WISE preset page now treat `Project ID` as an
advanced optional field:

- leaving it empty is valid;
- the backend derives the plugin-safe project ID;
- when the API returns `projectId`, the page stores it for follow-up source or
  target registration;
- Base ID remains optional.

## Files Changed

- `plugins/plugin-integration-core/lib/http-routes.cjs`
- `plugins/plugin-integration-core/lib/staging-installer.cjs`
- `plugins/plugin-integration-core/__tests__/http-routes.test.cjs`
- `plugins/plugin-integration-core/__tests__/staging-installer.test.cjs`
- `apps/web/src/services/integration/workbench.ts`
- `apps/web/src/services/integration/k3WiseSetup.ts`
- `apps/web/src/views/IntegrationWorkbenchView.vue`
- `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- `apps/web/tests/IntegrationWorkbenchView.spec.ts`
- `apps/web/tests/k3WiseSetup.spec.ts`

## Deployment Impact

- No database migration.
- No plugin manifest change.
- Existing clients that send a scoped project ID keep the same behavior.
- Existing clients that send an unscoped project ID now succeed under the
  plugin-owned `${tenantId}:integration-core` namespace.
- Existing clients that omit project ID can create staging sheets.

## Follow-up

After this lands and is deployed, rerun the entity-machine staging install flow:

1. Open Data Factory or K3 WISE preset.
2. Leave Project ID empty.
3. Click create/install staging tables.
4. Confirm the response includes non-empty `sheetIds` and open links.
5. Use `standard_materials` as a dry-run source.

