# Generic Integration Workbench TODO - 2026-05-12

## M0 - Scope Lock

- [x] Keep MetaSheet multitable as the cleansing and review surface.
- [x] Treat JSON as template/payload preview, not as the primary business data store.
- [x] Keep K3 WISE Material and BOM as v1 built-in templates.
- [x] Allow same source and target external system only when role is `bidirectional`.
- [x] Treat SQL channel as an advanced feature.
- [x] Do not add a v1 template table.
- [x] Do not allow user JavaScript transforms.
- [x] Do not allow raw SQL.
- [x] Keep Save-only as the default write strategy.
- [x] Keep Submit/Audit disabled by default.

## M1 - Backend Discovery API

- [x] Add `GET /api/integration/adapters`.
- [x] Add adapter metadata for labels, roles, supports, and advanced flag.
- [x] Add `GET /api/integration/external-systems/:id/objects`.
- [x] Add `GET /api/integration/external-systems/:id/schema`.
- [x] Merge adapter objects with `config.documentTemplates[]` objects.
- [x] Redact all discovery output.
- [x] Add tenant/workspace scope tests through scoped route invocation.
- [x] Add unknown system test.
- [x] Add missing object test.
- [x] Add SQL advanced metadata test.

## M2 - Same-System Pipeline Support

- [x] Confirm the registry does not forbid `sourceSystemId === targetSystemId`.
- [x] Add test for bidirectional same-system different-object pipeline.
- [x] Add test that source-only same-system pipeline is rejected as target.
- [x] Surface same-system mode in the workbench UI.
- [x] Use copy: "same system, different business object".
- [x] Recommend two logical connections when one physical system uses different protocols.

## M3 - SQL Advanced Channel

- [x] Mark `erp:k3-wise-sqlserver` as `advanced: true` in adapter metadata.
- [x] Hide SQL channel from default business-user connector list.
- [x] Show SQL channel under advanced settings for admins/implementers.
- [x] Require table allowlists for read objects.
- [x] Require middle-table write mode for target objects.
- [x] Keep direct core-table writes out of normal UI.
- [x] Add tests for SQL metadata and allowlist hints.

## M4 - Custom Target Templates

- [x] Define `config.documentTemplates[]` parser.
- [x] Require template `id`, `label`, and `object`.
- [x] Default `bodyKey` to `Data`.
- [x] Reject absolute endpoint paths.
- [x] Reject unsafe endpoint paths.
- [x] Require `schema[].name`.
- [x] Redact secret-like template values.
- [x] Include template objects in object discovery.
- [x] Include template schema in schema discovery.
- [x] Add tests for a custom supplier template.

## M5 - Template Preview API

- [x] Add `POST /api/integration/templates/preview`.
- [x] Reuse transform engine.
- [x] Reuse validator.
- [x] Wrap target record with `bodyKey`.
- [x] Return `valid`, `payload`, and `errors`.
- [x] Do not write DB.
- [x] Do not call target adapter.
- [x] Redact response payload and errors.
- [x] Test K3 Material preview.
- [x] Test K3 BOM preview.
- [x] Test custom template-style schema preview.
- [x] Test missing required fields.
- [x] Test unsupported transform.

## M6 - Frontend Workbench Service

- [x] Add `apps/web/src/services/integration/workbench.ts`.
- [x] Implement list adapters.
- [x] Implement list systems.
- [x] Implement test system.
- [x] Implement list objects.
- [x] Implement get schema.
- [x] Implement preview template.
- [x] Implement upsert pipeline.
- [x] Implement dry-run.
- [x] Implement Save-only run.
- [x] Automatically include tenant ID from app context/local storage.
- [x] Omit blank workspace ID instead of sending an empty string.

## M7 - Frontend Workbench Page

- [x] Add `IntegrationWorkbenchView.vue`.
- [x] Add route `/integrations/workbench`.
- [x] Add source system selector.
- [x] Add target system selector.
- [x] Add connection status badges.
- [x] Add source object selector.
- [x] Add target object/template selector.
- [x] Add staging table selector.
- [x] Add field mapping grid.
- [x] Add transform selector from whitelist.
- [x] Add dictionary mapping editor.
- [x] Add validation rule editor.
- [x] Add payload preview panel.
- [x] Add dry-run button.
- [x] Add Save-only run button.
- [x] Add run result summary.
- [x] Add dead-letter list.

## M8 - K3 WISE Page Convergence

- [x] Keep K3 setup page as a quick-start preset.
- [x] Add link to generic workbench.
- [x] Remove tenant ID from ordinary required input.
- [x] Move workspace ID to advanced context.
- [x] Explain Base URL vs endpoint path clearly.
- [x] Warn when Base URL and endpoint both include `/K3API/`.
- [x] Keep WebAPI connected status after successful test.
- [x] Keep SQL channel as advanced.
- [x] Preserve Material/BOM template preview.
- [x] Preserve current K3 WISE tests.

## M9 - Documentation and Delivery

- [x] Add development MD for backend discovery.
- [x] Add verification MD for backend discovery.
- [x] Add development MD for template preview.
- [x] Add verification MD for template preview.
- [x] Add development MD for frontend workbench shell.
- [x] Add verification MD for frontend workbench shell.
- [x] Add development MD for connection test and status badges.
- [x] Add verification MD for connection test and status badges.
- [x] Add development MD for frontend pipeline run controls.
- [x] Add verification MD for frontend pipeline run controls.
- [x] Add development MD for frontend observation controls.
- [x] Add verification MD for frontend observation controls.
- [x] Add development MD for K3 preset to generic workbench link.
- [x] Add verification MD for K3 preset to generic workbench link.
- [x] Add development MD for advanced connector and same-system UX.
- [x] Add verification MD for advanced connector and same-system UX.
- [x] Add development MD for strict document template contract.
- [x] Add verification MD for strict document template contract.
- [x] Add development MD for backend contract closeout.
- [x] Add verification MD for backend contract closeout.
- [x] Add development MD for SQL advanced guardrails.
- [x] Add verification MD for SQL advanced guardrails.
- [x] Add development MD for Workbench mapping rule editors.
- [x] Add verification MD for Workbench mapping rule editors.
- [x] Add development MD for K3 WISE preset convergence.
- [x] Add verification MD for K3 WISE preset convergence.
- [x] Update Windows on-prem runbook.
- [x] Update K3 WISE runbook.
- [x] Update package verify script if new docs/routes must be included.
- [x] Run K3 offline PoC.
- [x] Run frontend build.
- [x] Generate on-prem package archive for Workbench/K3 docs closeout.
- [x] Verify on-prem package `.tgz` and `.zip` include required K3 runbooks and postdeploy smoke scripts.
- [x] Add package-level verifier proof for packaged Workbench/K3 frontend routes and mapping editor copy.
- [x] Generate customer delivery bundle and confirm K3 runbooks are included.

## Suggested Verification Commands

```bash
pnpm -F plugin-integration-core test
pnpm --filter @metasheet/web exec vitest run apps/web/tests/IntegrationWorkbenchView.spec.ts --watch=false
pnpm --filter @metasheet/web exec vitest run apps/web/tests/k3WiseSetup.spec.ts apps/web/tests/IntegrationK3WiseSetupView.spec.ts --watch=false
pnpm --filter @metasheet/web build
pnpm verify:integration-k3wise:poc
pnpm verify:integration-erp-plm:deploy-readiness
```
