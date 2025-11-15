# Frontend Dynamic Views

This app renders plugin‑provided views dynamically based on `/api/plugins`.

Key pieces
- `apps/web/src/view-registry.ts` maps `component` strings to async components.
- `apps/web/src/composables/usePlugins.ts` fetches `/api/plugins` and aggregates `contributes.views`.
- `apps/web/src/views/` contains built‑in views (e.g., `KanbanView.vue`).

Contract
- Backend (active plugins only) returns:
  - `contributes.views: Array<{ id: string; name: string; component?: string }>`
- Unknown `component` values show a friendly fallback and log a warning.

Local dev
- Backend: `pnpm -F @metasheet/core-backend dev:core`
- Frontend: `VITE_API_URL=http://localhost:8900 pnpm -F @metasheet/web dev`
- Quick check: `curl -s $VITE_API_URL/api/plugins | jq`.

Notes
- Prefer lazy loading for heavy views.
- Keep the registry minimal; plugins should provide their own bundles in future iterations.
