# PR: CI Hardening + Guides + Views Contract Guard

## Summary
Low-risk improvements across CI, docs/guides, frontend UX, and backend API contract:
- Add AGENTS.md (EN) and AGENTS.zh-CN; link from README.
- Frontend: Retry/Refresh UI for plugin list; health check uses `VITE_API_URL`.
- Backend: Sanitize `contributes.views` in `/api/plugins`.
- Tests: New `/api/plugins` contract test.
- CI: Upload pnpm install logs on failure; add lockfile checklist to CONTRIBUTING and PR templates.

## Changes
- Docs/Guides
  - `AGENTS.md`, `AGENTS.zh-CN.md`
  - `README.md` cross-links to guides and dynamic views doc
  - `CONTRIBUTING.md` adds lockfile sync reminder (frozen-lockfile)
  - `docs/PR_TEMPLATES/*` add lockfile validation checklist
- Frontend
  - `apps/web/src/App.vue`: Retry + Refresh buttons; health base via `VITE_API_URL`
- Backend
  - `packages/core-backend/src/utils/views.ts`: `sanitizeViews()`
  - `packages/core-backend/src/index.ts`: apply sanitizer in `/api/plugins`
- Tests
  - `packages/core-backend/tests/integration/plugins-api.contract.test.ts`
- CI
  - `.github/workflows/plugin-tests.yml`: tee install logs; upload on failure
  - `.github/workflows/observability-strict.yml`: tee install logs; upload on failure

## Validation
- Local quick check
  - `pnpm install`
  - Backend: `pnpm -F @metasheet/core-backend test` && `pnpm -F @metasheet/core-backend test:integration`
  - Frontend: `pnpm -F @metasheet/web dev` (set `VITE_API_URL=http://localhost:8900` if needed)
  - API: `curl -s http://localhost:8900/api/plugins | jq`
- CI
  - Re-run Plugin System Tests and Observability Strict; if install fails, fetch `install.log` artifact

## Risks / Rollback
- Risk: minimal. Runtime change only sanitizes malformed `views` entries into a safe subset.
- Rollback: revert this PR; no migrations or persistent state changes.

## Notes
- Aligns with PR#84 CI learnings (lockfile drift). Checklists enforce local `pnpm install` prior to push.
- Keeps dynamic views contract stable for the web app.

