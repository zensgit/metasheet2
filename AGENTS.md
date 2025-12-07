# Repository Guidelines

## Project Structure & Module Organization
- PNPM workspace: root `package.json` + `pnpm-workspace.yaml` manage all packages.
- Frontend lives in `apps/web` (Vue 3 + Vite + Pinia); app entry at `src/main.ts`, routed views in `src/views`, shared utilities in `src/utils`, and UI/unit specs in `tests`.
- Backend core is `packages/core-backend` (Express + PostgreSQL + Redis). Runtime code under `src`, plugin hosts in `plugins`, DB migrations in `migrations`, and Vitest suites in `tests/{unit,integration}`.
- API contracts and generated SDKs sit in `packages/openapi`; sample/experimental plugins are under top-level `plugins/`.
- Ops assets: `docker/` for compose files, `scripts/` for automation (Phase 5 validation, staging checks), and `docs/`/`claudedocs/` for deep-dives and reports.

## Build, Test, and Development Commands
- Install deps: `pnpm install`.
- Frontend dev server: `pnpm dev` (serves `apps/web` on port 8899).
- Backend dev: `pnpm --filter @metasheet/core-backend dev` (API/WebSocket on port 8900); run migrations with `pnpm --filter @metasheet/core-backend migrate`.
- Build all packages: `pnpm build`; backend-only: `pnpm --filter @metasheet/core-backend build`; frontend-only: `pnpm --filter @metasheet/web build`.
- Tests: workspace-wide `pnpm test`; targeted backend suites with `pnpm --filter @metasheet/core-backend test:unit` or `test:integration`; frontend specs via `pnpm --filter @metasheet/web exec vitest run --watch=false`.
- Quality gates: `pnpm lint` and `pnpm type-check`; use `pnpm validate:all` before PRs.

## Coding Style & Naming Conventions
- TypeScript-first; prefer type-only imports (ESLint enforced) and avoid `any` unless documented. Prefix intentionally unused params with `_`.
- Formatting: 2-space indent, single quotes, trailing commas per existing code; keep modules ESM (`type: "module"`).
- Backend: routes in `src/routes` use kebab-case file names; services/classes are PascalCase; migration files are sequentially numbered to avoid collisions.
- Frontend: components PascalCase in `src/components`/`src/views`; composables `useX` in `src/composables`; store modules in `src/stores` with camelCase keys.

## Testing Guidelines
- Vitest is the shared runner. Backend configs live in `packages/core-backend/vitest*.config.ts`; integration tests spin up the Express app—mock external services instead of hitting real infra.
- Frontend tests run in `jsdom` (see `apps/web/vite.config.ts`); prefer `.spec.ts` naming there and `.test.ts` under backend `tests`.
- Target coverage ≥80% lines/functions as outlined in `packages/core-backend/tests/README.md`; add focused tests for plugins, permissions, and data adapters when touching those areas.
- Keep fixtures in `tests/fixtures` or `tests/utils`; avoid writing to repo paths outside `artifacts/` or `tmp`.

## Commit & Pull Request Guidelines
- Follow conventional commit prefixes seen in history (e.g., `feat(data-adapters): ...`, `perf(phase11): ...`, `chore(deps): ...`, `docs: ...`); include a scope when possible.
- PRs should state what changed, why, and how to verify (commands run, coverage snippets). Link relevant issues or Phase docs; attach UI screenshots/GIFs for frontend changes and note migration/rollback steps for backend DB updates.
- Keep branches small and single-purpose; update checklists in `trigger-checks.md` when relevant.

## Security & Configuration Tips
- Start from `.env.example` (and `.env.phase5.template` for observability); never commit secrets or tokens. Required envs include DB/Redis URLs and observability endpoints like `METRICS_URL` and `ALERT_WEBHOOK_URL`.
- Use `docker/` compose setups for local DB/Redis if you need a clean environment; clean caches with `pnpm clean` when dependencies shift.
- Plugins run inside the microkernel—validate manifests via `pnpm validate:plugins` and keep untrusted plugin code sandboxed during development.
