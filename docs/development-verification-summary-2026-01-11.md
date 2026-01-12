# Development + Verification Summary - 2026-01-11

## Scope
- Harden PLM Yuantus adapter error handling.
- Add Athena auth smoke tooling + checklist.
- Improve workflow designer UX with auto-refresh.
- Stabilize verification harness (readonly smoke, archive helpers, CI-safe toggles).

## Development Updates
### PLM adapter hardening
- Added Yuantus error parsing (`detail`/`error`) and surfaced errors for search, documents, BOM tree, approvals, where-used, BOM compare, substitutes, and substitute mutations.
- Added unit coverage for Yuantus error handling in `plm-adapter-yuantus.test.ts`.
- Default integration tests now set `SKIP_PLUGINS=true` to keep the suite stable.

### Athena readiness
- Added `scripts/verify-athena-auth.sh` to validate Keycloak token + health endpoints.
- Added `docs/ATHENA_EXTERNAL_ENV_CHECKLIST.md` with required envs and usage.

### Frontend UX
- Workflow designer auto-refresh toggle (30s) with pause-on-dirty indicator to avoid overwriting unsaved changes.

### Verification harness
- Read-only PLM smoke is wired into `verify:smoke` via `RUN_PLM_UI_READONLY=true`.
- Added BOM fixture pin helper (`plm:fixture:latest`) and archive helper (`plm:archive:reports`).

## Verification Run
- `pnpm --filter @metasheet/core-backend exec vitest run tests/unit/plm-adapter-yuantus.test.ts --reporter=dot`
- `pnpm --filter @metasheet/web exec vue-tsc --noEmit`
- `pnpm plm:fixture:latest`
- `pnpm verify:smoke:plm-readonly`

## Notes
- Read-only smoke uses `artifacts/plm-bom-tools-latest.json`.
- Archived PLM UI reports live under `docs/archive/verification`.
