# Verification Index

This index groups the most-used verification commands and the corresponding reports/artifacts.

Entry points:
- README: `README.md` (Documentation Quick Links)
- Docs Index: `docs/INDEX.md` (测试和验证)

## Daily / Pre-PR

- Verification summary (latest):
  - Report: `docs/verification-summary-2025-12-23.md`

- Comments smoke (API + UI):
  - Run: `pnpm verify:comments`
  - Reports: `docs/verification-comments-api-2025-12-22.md`, `docs/verification-comments-ui-2025-12-22.md`
  - Artifacts: `artifacts/comments-ui-grid.png`, `artifacts/comments-ui-kanban.png`

- Comments RBAC enforcement:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Comments RBAC"`
  - Report: `docs/verification-comments-rbac-2025-12-23.md`

- Approvals + workflow auth guards:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"`
  - Report: `docs/verification-approvals-workflow-auth-2025-12-23.md`

- Approvals + workflow RBAC:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow RBAC"`
  - Report: `docs/verification-approvals-workflow-rbac-2025-12-23.md`

- Approvals history route cleanup:
  - Run: `pnpm --filter @metasheet/core-backend test:integration -- --filter="Approvals + Workflow auth guards"`
  - Report: `docs/verification-approvals-history-route-2025-12-23.md`

- Editable demo smoke (Grid + Kanban drag/write-back):
  - Run: `pnpm verify:editable-demo`
  - Report: `docs/editable-demo-ui-verification-2025-12-23.md`
  - Artifacts: `artifacts/editable-demo-grid.png`, `artifacts/editable-demo-kanban.png`,
    `artifacts/editable-demo-ui-verification.json`

- Combined smoke:
  - Run: `pnpm verify:smoke`
  - Latest report: `docs/verification-smoke-2025-12-23.md`
  - Full local runner: `pnpm verify:smoke:all`
- Smoke verify (local runner update):
  - Run: `scripts/verify-smoke.sh` (uses `scripts/verify-smoke-core.mjs`)
  - Report: `docs/smoke-verify-run-2025-12-23.md`
  - Notes: `web.home` accepts `MetaSheet` or `#app`; adds `univer-meta` checks (`sheets/fields/views/records-summary`)

## Full Regression

- Univer full suite:
  - Run: `bash scripts/verify-univer-all.sh`
  - Outputs under `artifacts/univer-poc/` (see `verification-*.md/json` files)
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
- `univer-meta` checks auto-skip when the DB reports `DB_NOT_READY` (503).
- Latest report: `docs/smoke-verify-run-2025-12-23.md`.
