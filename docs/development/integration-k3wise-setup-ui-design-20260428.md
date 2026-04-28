# K3 WISE Setup UI Design - 2026-04-28

## Goal

Add an operator-facing ERP/K3 WISE setup page so admins can enter the information currently collected through the K3 WISE GATE packet:

- MetaSheet tenant/workspace scope.
- K3 WISE WebAPI URL, version, environment, endpoint paths, and Save/Submit/Audit flags.
- K3 WISE credential fields: username, password, acctId.
- Optional SQL Server channel metadata: server, database, read allowlist, middle tables, stored procedures, and optional SQL credentials.

## Entry Point

- Frontend route: `/integrations/k3-wise`
- Vue view: `apps/web/src/views/IntegrationK3WiseSetupView.vue`
- Nav entry: admin-only `ERP 对接` / `ERP Integration` in `apps/web/src/App.vue`

The route is intentionally independent from PLM workbench screens. It is an integration control-plane page, not a PLM product-data page.

## API Contract

The page uses the existing plugin control-plane routes:

- `GET /api/integration/external-systems?kind=erp:k3-wise-webapi`
- `GET /api/integration/external-systems?kind=erp:k3-wise-sqlserver`
- `POST /api/integration/external-systems`
- `POST /api/integration/external-systems/:id/test`

Payload construction lives in `apps/web/src/services/integration/k3WiseSetup.ts` so the Vue component remains mostly form state and user feedback.

## Credential Boundary

The public external-system API remains redaction-safe:

- public reads expose `hasCredentials`, `credentialFormat`, and `credentialFingerprint`;
- public reads do not expose plaintext credentials or ciphertext.

This change also fills the internal adapter seam that was already referenced by `pipeline-runner.cjs` and `http-routes.cjs`:

- `plugins/plugin-integration-core/lib/external-systems.cjs#getExternalSystemForAdapter`
- decrypts credentials only for adapter/test/run execution;
- returns adapter-local credentials without public fingerprint fields.

This matters because the UI can now save a K3 WISE external system and then run `testConnection` through the real adapter path instead of only storing metadata.

## Form Behavior

WebAPI setup:

- New systems require `tenantId`, name, version, base URL, username, password, and `acctId`.
- Existing systems with stored credentials can be edited without re-entering the password; omitted credential fields preserve the stored secret.
- If any credential field is re-entered on an existing system, the replacement must include username, password, and `acctId`.
- Endpoint fields must be relative paths, matching the adapter contract.

SQL Server channel:

- Off by default.
- When enabled, requires system name, server, database, and at least one allowed table.
- Writes are represented through middle-table config; the adapter still blocks direct K3 core table writes unless explicitly configured in backend-only object config.

## Out Of Scope

- Creating PLM source systems from this page.
- Creating material/BOM pipelines and field mappings from this page.
- Installing a real SQL Server driver or live `queryExecutor`.
- K3 production auto-submit/audit approval policy.

Those remain part of the K3 live PoC/customer GATE flow and later platformization work.
