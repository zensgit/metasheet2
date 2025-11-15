# PR#4: Frontend Dynamic Plugin List

Purpose
- Replace hardcoded plugin list with runtime data from `/api/plugins`.

Changes
- web app
  - `src/composables/usePlugins.ts`: new composable to fetch plugin list from `VITE_API_URL || window.location.origin`.
  - `src/App.vue`: use the composable, remove static fallback, display failed state and error banner.
- core-backend
  - `package.json`: add `dev:core` script to run TS index locally (`tsx src/index.ts`).

Verification
- Backend: `pnpm --filter @metasheet/core-backend dev:core`
- Frontend: `pnpm --filter @metasheet/web dev`
- Browser/Network:
  - Plugin list matches `GET /api/plugins` (status: active/failed/inactive)
  - Disconnect backend → red error banner shown (no static fallback)
- API base: uses `import.meta.env.VITE_API_URL || window.location.origin`

Impact & Rollback
- UI-only change. Roll back by reverting this PR.

References
- Composable: `apps/web/src/composables/usePlugins.ts:1`
- UI: `apps/web/src/App.vue:1`
