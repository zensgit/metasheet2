# Verification Index

This index groups the most-used verification commands and the corresponding reports/artifacts.

Entry points:
- README: `README.md` (Documentation Quick Links)
- Docs Index: `docs/INDEX.md` (测试和验证)

## Daily / Pre-PR

- Verification summary (latest):
  - Report: `docs/verification-summary-2026-01-05.md`
  - Previous: `docs/verification-summary-2025-12-28.md`

- Core backend typecheck + runtime attempt:
  - Report: `docs/verification-core-backend-typecheck-20260105_1553.md`

- Comments smoke (API + UI):
  - Run: `pnpm verify:comments`
  - Reports: `docs/verification-comments-api-2025-12-22.md`, `docs/verification-comments-ui-2025-12-22.md`
  - Artifacts: `artifacts/comments-ui-grid.png`, `artifacts/comments-ui-kanban.png`

- Comments RBAC enforcement:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Comments RBAC"`
  - Report: `docs/verification-comments-rbac-2025-12-23.md`

- Labs/POC gating (UI):
  - Run: `pnpm verify:labs-gating`
  - Output: `artifacts/labs-gating-verification.json`
  - Report: `docs/verification-labs-gating-2025-12-27.md`

- Real systems adapter probe:
  - Run: `bash scripts/adapter-probe.sh` + `bash scripts/test-real-systems.sh`
  - Report: `docs/verification-real-systems-2025-12-28.md`

- PLM real system verification:
  - Report: `docs/verification-plm-2025-12-28.md`

- Yuantus PLM verification:
  - Script: `scripts/verify-yuantus-plm.sh`
  - Run: `pnpm verify:yuantus`
  - Report: `docs/verification-yuantus-plm-20251231_1507.md`
  - Connection notes: `docs/yuantus-plm-connection.md`

- PLM product detail mapping:
  - Report: `docs/verification-plm-product-detail-20260104_1132.md`
- PLM adapter mapping (product/docs/approvals):
  - Report: `docs/verification-plm-adapter-mapping-20260104_1559.md`
- PLM field mapping API verification:
  - Script: `scripts/verify-plm-field-mapping.sh`
  - Report: `docs/verification-plm-field-mapping-api-20260105_150732.md`
  - Report: `docs/verification-plm-field-mapping-api-20260105_062050.md`
  - Report: `docs/verification-plm-field-mapping-api-20260105_062646.md`
  - Artifact: `artifacts/plm-field-mapping-api-20260105_150732.json`
  - Artifact: `artifacts/plm-field-mapping-api-20260105_062032.json`
  - Artifact: `artifacts/plm-field-mapping-api-20260105_062646.json`

- PLM documents/approvals backend mapping:
  - Report: `docs/verification-plm-docs-approvals-backend-20260101_0201.md`

- PLM documents/approvals UI:
  - Report: `docs/verification-plm-docs-approvals-ui-20260101_0203.md`

- PLM documents/approvals federation:
  - Script: `scripts/verify-plm-docs-approvals.sh`
  - Report: `docs/verification-plm-docs-approvals-federation-20260101_1301.md`
  - Report: `docs/verification-plm-docs-approvals-federation-20260105_062050.md`

- PLM CAD batch import:
  - Script: `scripts/import-plm-cad-files.sh`
  - Report: `docs/verification-plm-cad-import-20260101_1212.md`
  - Artifact: `artifacts/plm-cad-import-20260101_1210.json`

- PLM CAD duplicate cleanup:
  - Script: `scripts/cleanup-plm-duplicate-parts.py`
  - Report: `docs/verification-plm-cad-duplicate-cleanup-20260101_1257.md`
  - Artifact: `artifacts/plm-cad-duplicate-cleanup-20260101_1256.json`

- PLM CAD conversion (preview + geometry):
  - Script: `scripts/verify-plm-cad-conversion.sh`
  - Report: `docs/verification-plm-cad-conversion-20260101_1319.md`
  - Artifact: `artifacts/plm-cad-conversion-20260101_1319.json`

- PLM CADGF 2D pipeline (DWG/DXF):
  - Report: `docs/verification-plm-cadgf-2d-conversion-20260101_1325.md`

- PLM UI integration:
  - Report: `docs/verification-plm-ui-20251231_1540.md`
  - Notes: includes substitutes verification and token retry behavior (query/select/insert/update/delete)
- PLM UI update (updatedAt fallback):
  - Report: `docs/verification-plm-ui-20260104_1220.md`
- PLM UI verification (product + docs):
  - Report: `docs/verification-plm-ui-20260105_174643.md`
  - Artifact: `artifacts/plm-ui-product-docs-20260105_174643.png`
- PLM UI empty states:
  - Report: `docs/verification-plm-ui-empty-states-20260105_175520.md`
  - Artifact: `artifacts/plm-ui-empty-hints-20260105_180232.png`
- PLM UI BOM compare field mapping:
  - Report: `docs/verification-plm-ui-bom-compare-fieldmap-20260104_1442.md`
  - Artifact: `artifacts/plm-ui-bom-compare-fieldmap-20260104_1442.png`
- PLM UI field mapping (product/doc/approval):
  - Report: `docs/verification-plm-ui-field-mapping-20260104_1520.md`
  - Artifact: `artifacts/plm-ui-field-mapping-20260104_1520.png`
- PLM UI where-used path view:
  - Report: `docs/verification-plm-ui-where-used-path-20260104_1314.md`
  - Artifacts: `artifacts/where-used-path-20260104_1314.json`, `artifacts/plm-ui-where-used-path-20260104_1330.png`

- PLM BOM tools federation:
  - Script: `scripts/verify-plm-bom-tools.sh`
  - Report: `docs/verification-plm-bom-tools-20260102_0011.md`
  - Artifact: `artifacts/plm-bom-tools-20260102_0011.json`
  - Report: `docs/verification-plm-bom-tools-20260105_0835.md`
  - Artifact: `artifacts/plm-bom-tools-20260105_0835.json`
  - JSON mirror: `docs/verification-plm-bom-tools-20260105_0835.json`
- PLM UI BOM tools:
  - Report: `docs/verification-plm-ui-bom-tools-20260105_175018.md`
  - Artifact: `artifacts/plm-ui-bom-tools-20260105_175018.png`
- PLM UI regression (search → detail → BOM tools):
  - Script: `scripts/verify-plm-ui-regression.sh`
  - Report: `docs/verification-plm-ui-regression-20260105_175324.md`
  - Artifact: `artifacts/plm-ui-regression-20260105_175324.png`
  - Report: `docs/verification-plm-ui-regression-20260105_181443.md`
  - Artifact: `artifacts/plm-ui-regression-20260105_181443.png`
  - Report: `docs/verification-plm-ui-regression-20260105_212131.md`
  - Artifact: `artifacts/smoke/plm-ui-regression-20260105_212131.png`

- Univer POC build (deps restored):
  - Report: `docs/verification-univer-poc-20251231_2233.md`

- Univer POC verify (mock mode):
  - Report: `docs/verification-univer-poc-20251231_2246.md`
  - Artifact: `artifacts/univer-poc/verify-univer-all.json`

- Univer POC verify (core mode):
  - Report: `docs/verification-univer-poc-20251231_2251.md`
  - Artifact: `artifacts/univer-poc/verify-univer-all.json`

- Univer POC verify (core mode, fresh DB):
  - Report: `docs/verification-univer-poc-20251231_2310.md`
  - Artifact: `artifacts/univer-poc/verify-univer-all.json`

- Univer POC UI routes (dev-only):
  - Report: `docs/verification-univer-poc-ui-20251231_2348.md`
- Univer POC UI + PLM (Yuantus) verification:
  - Report: `docs/verification-univer-poc-ui-20260104_1134.md`

- Univer UI smoke (manual):
  - Report: `docs/verification-univer-ui-smoke-20260101_0104.md`

- Univer UI smoke (Playwright):
  - Run: `pnpm verify:univer-ui-smoke`
  - Script: `scripts/verify-univer-ui-smoke.mjs`
  - Report: `docs/verification-univer-ui-smoke-20260101_0122.md`

- Univer POC UI backend connectivity:
  - Report: `docs/verification-univer-poc-ui-20260101_0004.md`

- UI dev proxy smoke (backend + web):
  - Report: `docs/verification-ui-dev-proxy-20260101_1259.md`

- Univer dev proxy fallback:
  - Report: `docs/verification-univer-dev-proxy-20260101_0055.md`
  - Script: `scripts/verify-univer-proxy.sh`
  - Report: `docs/verification-univer-proxy-20260101_0057.md`

- Federation config persistence (PLM/Athena):
  - Script: `scripts/verify_federation_config.sh`
  - Report: `docs/verification-federation-config-20251231_1446.md`
- Federation live verification (PLM + Athena):
  - Report: `docs/verification-federation-plm-athena-20260104_0847.md`

- Workflow minimal (deploy/list/start/instances):
  - Script: `scripts/verify_workflow_minimal.sh`
  - Report: `docs/verification-workflow-minimal-20251231.md`

- UI federation (Dashboard):
  - Report: `docs/verification-ui-federation-20251229_1810.md`

- Token auto-refresh (Athena + PLM):
  - Report: `docs/verification-token-refresh-20251229_1827.md`

- Athena Keycloak auth smoke:
  - Report: `docs/verification-athena-keycloak-20251231_1740.md`

- Athena real API verification:
  - Report: `docs/verification-athena-real-20251231_1810.md`
- Athena real API verification (2026-01-04):
  - Report: `docs/verification-athena-real-20260104_0836.md`
- Athena upload + federation verification:
  - Report: `docs/verification-athena-upload-federation-20260104_0855.md`
- Athena UI verification (Swagger UI):
  - Report: `docs/verification-athena-ui-20260104_0923.md`

- PLM (Yuantus) real API verification:
  - Report: `docs/verification-plm-yuantus-real-20260101_1253.md`

- PLM (Yuantus) AML + BOM verification:
  - Report: `docs/verification-plm-yuantus-aml-bom-20260101_2252.md`

- PLM (Yuantus) federation query verification:
  - Report: `docs/verification-plm-yuantus-federation-20260101_2312.md`

- PLM (Yuantus) BOM non-empty verification:
  - Report: `docs/verification-plm-yuantus-bom-nonempty-20260101_2332.md`
- PLM (Yuantus) BOM non-empty verification (local instance):
  - Report: `docs/verification-plm-yuantus-bom-nonempty-20260104_0825.md`
- PLM (Yuantus) BOM compare + where-used (federation):
  - Report: `docs/verification-plm-yuantus-bom-compare-whereused-20260104_0855.md`

- UI verification via MCP:
  - Report: `docs/verification-ui-mcp-access-20260101_2353.md`

- PLM UI API verification:
  - Report: `docs/verification-plm-ui-api-20260104_1216.md`
- PLM UI federation verification:
  - Report: `docs/verification-plm-ui-federation-20260104_0855.md`
- PLM UI a11y (form ids):
  - Report: `docs/verification-plm-ui-a11y-20260104_1144.md`
- PLM UI search selector:
  - Report: `docs/verification-plm-ui-search-20260104_1210.md`
- PLM UI auth status banner:
  - Report: `docs/verification-plm-ui-auth-status-20260105_0842.md`

- PLM (Yuantus) BOM rollback verification:
  - Report: `docs/verification-plm-yuantus-bom-rollback-20260102_0018.md`
- PLM (Yuantus) auth mismatch verification:
  - Report: `docs/verification-plm-yuantus-auth-mismatch-20260102_0034.md`
- PLM (Yuantus) auth recovery verification:
  - Report: `docs/verification-plm-yuantus-auth-recovered-20260102_1148.md`

- Real systems env + UI:
  - Report: `docs/verification-env-real-systems-20251229_1836.md`

- Dashboard default Athena query:
  - Report: `docs/verification-dashboard-athena-default-query-20251229_1859.md`

- Approvals + workflow auth guards:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"`
  - Report: `docs/verification-approvals-workflow-auth-2025-12-23.md`

- Approvals + workflow RBAC:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow RBAC"`
  - Report: `docs/verification-approvals-workflow-rbac-2025-12-23.md`

- Approvals history route cleanup:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"`
  - Report: `docs/verification-approvals-history-route-2025-12-23.md`

- Integration suite (core-backend):
  - Run: `pnpm --filter @metasheet/core-backend test:integration`
  - Report: `docs/verification-integration-2025-12-28.md`

- Plugin integration (Kanban):
  - Run: `SKIP_PLUGINS=false pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/kanban-plugin.test.ts tests/integration/kanban.mvp.api.test.ts tests/integration/plugins-api.contract.test.ts --reporter=dot`
  - Report: `docs/verification-kanban-plugins-2025-12-28.md`

- Plugin scan suppression (non-plugin tests):
  - Run: `SKIP_PLUGINS=false pnpm --filter @metasheet/core-backend exec vitest --config vitest.integration.config.ts run tests/integration/rooms.basic.test.ts tests/integration/snapshot-protection.test.ts tests/integration/kanban-plugin.test.ts tests/integration/kanban.mvp.api.test.ts tests/integration/plugins-api.contract.test.ts --reporter=dot`
  - Report: `docs/verification-plugin-scan-suppression-2025-12-28.md`

- Editable demo smoke (Grid + Kanban drag/write-back):
  - Run: `pnpm verify:editable-demo`
  - Report: `docs/editable-demo-ui-verification-2025-12-23.md`
  - Artifacts: `artifacts/editable-demo-grid.png`, `artifacts/editable-demo-kanban.png`,
    `artifacts/editable-demo-ui-verification.json`

- Combined smoke:
  - Run: `pnpm verify:smoke`
  - Latest report: `docs/verification-smoke-20260105_212131.md`
  - Previous report: `docs/verification-smoke-20260101_0126.md`
  - Full local runner: `pnpm verify:smoke:all`
  - Notes: `verify:smoke:all` runs Univer UI smoke; set `RUN_UNIVER_UI_SMOKE=false` to skip. Output: `artifacts/smoke/verify-univer-ui-smoke.json`.
- Smoke verify (local runner update):
  - Run: `scripts/verify-smoke.sh` (uses `scripts/verify-smoke-core.mjs`)
  - Report: `docs/smoke-verify-run-2025-12-23.md`
  - Notes: `web.home` accepts `MetaSheet` or `#app`; adds `univer-meta` checks (`sheets/fields/views/records-summary`)

- Labs/POC gating + production safeguard:
  - Report: `docs/local-smoke-verification.md`
  - Smoke UI check: `artifacts/labs-gating-verification.json`

## Full Regression

- Univer full suite:
  - Run: `bash scripts/verify-univer-all.sh`
  - Outputs under `artifacts/univer-poc/` (see `verification-*.md/json` files)
  - Latest report: `docs/verification-univer-all-20260101_0103.md`
  - Report: `docs/verification-univer-all-2025-12-27.md`
  - Core mode attempt (blocked in automation): `docs/verification-univer-all-core-2025-12-27.md`
  - Core mode + windowing: `docs/verification-univer-all-core-windowing-2025-12-27.md`
  - Optional flags:
    - `BACKEND_MODE=core` (use Meta(DB))
    - `RUN_WINDOWING=true`
    - `RUN_EDITABLE_DEMO=false` (skip editable demo)

## CI / Nightly

- Comments nightly smoke: `.github/workflows/comments-nightly.yml`
  - Runs `pnpm verify:comments` + `pnpm verify:editable-demo`
  - Set `RUN_EDITABLE_DEMO_SMOKE=false` to skip editable demo
- Smoke verify (manual): `.github/workflows/smoke-verify.yml`
  - Runs `pnpm verify:smoke:all` with Playwright + Postgres service
  - CI trigger template: `docs/verification-ci-smoke-trigger-template.md`

## Troubleshooting

- Playwright not found:
  - Run `pnpm install` in `apps/web-react`
  - Use `NODE_PATH=apps/web-react/node_modules`

- Editable demo missing:
  - The script auto-initializes via `scripts/setup-editable-demo.sh`
  - To skip setup: `SKIP_SETUP=true pnpm verify:editable-demo`

- WebSocket/metrics noise:
  - Ensure `.env.local` contains `VITE_API_URL=http://127.0.0.1:7778`
  - Admin realtime metrics uses Socket.IO via `/socket.io`

## Recent Smoke Updates

- Local smoke runner now uses `scripts/verify-smoke-core.mjs` with `web.home` tolerant of `MetaSheet` or `#app`.
- `univer-meta` smoke checks added: `sheets`, `fields`, `views`, `records-summary`.
- Latest report: `docs/smoke-verify-run-2025-12-23.md`.
