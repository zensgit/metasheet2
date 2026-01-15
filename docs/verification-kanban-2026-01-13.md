# Kanban Verification (2026-01-13)

## Scope
- Kanban view data fetch via `/api/kanban/board1`
- Dev-only fallback for Kanban data

## Changes Applied
- Frontend uses API base + auth headers:
  - `apps/web/src/views/KanbanView.vue`
- Auth helper now recognizes `auth_token`:
  - `apps/web/src/composables/useAuth.ts`
- Dev-only Kanban fallback endpoint:
  - `packages/core-backend/src/routes/kanban.ts` (`GET /api/kanban/board1`)

## Test Environment
- Backend: `http://127.0.0.1:7778`
- Frontend: `http://127.0.0.1:8899`
- Flags: `RBAC_TOKEN_TRUST=true`, `SKIP_PLUGINS=true`

## Verification Steps
1. Start backend:
   - `DATABASE_URL=postgresql://metasheet:metasheet123@localhost:5432/metasheet_v2 RBAC_TOKEN_TRUST=true SKIP_PLUGINS=true JWT_SECRET=dev-secret-key PORT=7778 pnpm --filter @metasheet/core-backend dev:core`
2. Start frontend:
   - `pnpm --filter @metasheet/web dev -- --host 127.0.0.1 --port 8899`
3. Open Kanban:
   - `http://127.0.0.1:8899/kanban`
4. Confirm Kanban columns and cards render.
5. Confirm Network:
   - `GET /api/kanban/board1` returns **200**.

## Results
- ✅ Kanban view renders columns/cards from backend.
- ✅ `/api/kanban/board1` returns **200** in dev.
- ⚠️ This is a dev-only endpoint (guarded by `NODE_ENV !== 'production'`).

## Notes
- The core Kanban API expects UUID view IDs. `board1` is intentionally a dev-only fallback.
