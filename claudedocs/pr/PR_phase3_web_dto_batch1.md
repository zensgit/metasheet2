# feat(web): Phase 3 – DTO typing (batch1)

## Purpose
Introduce lightweight DTO types for key web flows to improve type safety while keeping build and CI stable.

## Scope (batch1)
- Add `/api/plugins` DTO (`PluginInfoDTO`, `ContributedView`) and wire in `usePlugins`.
- Standardize API base logic via `utils/api` across App, Kanban, ViewManager.
- Keep vue-tsc in non-blocking workflow; ensure zero new type errors.

## Verification
- Local: `pnpm -F @metasheet/web build` (runs `vue-tsc -b && vite build`).
- CI: `v2-web-typecheck` runs (non-blocking) and uploads logs.
- Manual: navigate to app, verify plugin views render when backend is up.

## Rollout
- Batch2: add DTOs for view data/state endpoints and types in ViewManager.
- Batch3: re-enable lint (warn→error) after DTO coverage reaches baseline.

## Notes
- No API shape changes; types reflect current payloads.
- Shims remain to avoid third-party type noise.

