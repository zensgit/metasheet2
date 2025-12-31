# Verification Index

This index groups the most-used verification commands and the corresponding reports/artifacts.

Entry points:
- README: `README.md` (Documentation Quick Links)
- Docs Index: `docs/INDEX.md` (测试和验证)

## Daily / Pre-PR

- Verification summary (latest):
  - Report: `docs/verification-summary-2025-12-28.md`

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

- PLM product detail mapping:
  - Report: `docs/verification-plm-product-detail-20251231_1535.md`

- PLM UI integration:
  - Report: `docs/verification-plm-ui-20251231_1540.md`
  - Notes: includes substitutes verification and token retry behavior (query/select/insert/update/delete)

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

- Univer UI smoke (manual):
  - Report: `docs/verification-univer-ui-smoke-20260101_0104.md`

- Univer UI smoke (Playwright):
  - Run: `pnpm verify:univer-ui-smoke`
  - Script: `scripts/verify-univer-ui-smoke.mjs`
  - Report: `docs/verification-univer-ui-smoke-20260101_0110.md`

- Univer POC UI backend connectivity:
  - Report: `docs/verification-univer-poc-ui-20260101_0004.md`

- Univer dev proxy fallback:
  - Report: `docs/verification-univer-dev-proxy-20260101_0055.md`
  - Script: `scripts/verify-univer-proxy.sh`
  - Report: `docs/verification-univer-proxy-20260101_0057.md`

- Federation config persistence (PLM/Athena):
  - Script: `scripts/verify_federation_config.sh`
  - Report: `docs/verification-federation-config-20251231_1446.md`

- Workflow minimal (deploy/list/start/instances):
  - Script: `scripts/verify_workflow_minimal.sh`
  - Report: `docs/verification-workflow-minimal-20251231.md`

- UI federation (Dashboard):
  - Report: `docs/verification-ui-federation-20251229_1810.md`

- Token auto-refresh (Athena + PLM):
  - Report: `docs/verification-token-refresh-20251229_1827.md`

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
  - Latest report: `docs/verification-smoke-2025-12-27.md`
  - Full local runner: `pnpm verify:smoke:all`
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
